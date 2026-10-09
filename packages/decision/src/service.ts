import crypto from "node:crypto";
import {
  decisionSessionId,
  decisionTaskId,
  claimDecisionTask,
  startDecisionTask,
  heartbeatDecisionTask,
  completeDecisionTask,
  failDecisionTask,
  releaseExpiredDecisionTask,
  cancelDecisionTask,
  supersedeDecisionTask,
  rebindDecisionSession,
  breakDecisionBinding,
  completeDecisionSession,
  reopenDecisionSession,
  validateDecisionResultForTask,
  parseDecisionReviewTarget,
  type DecisionSession,
  type DecisionTask,
  type DecisionResult,
  type DecisionLease,
  type DecisionReviewTarget,
  type DecisionWorkItemRef,
  type UtcTimestampMs,
} from "@symphony/domain";
import { canonicalJsonEqual } from "./canonical-json";
import {
  DecisionConflictError,
  DecisionNotFoundError,
  DecisionValidationError,
} from "./errors";
import type { DurableDecisionStore } from "./store";
import type {
  DecisionStoreConfig,
  DecisionTaskFailure,
  SubmissionReceipt,
  OperationReceipt,
  ClaimTaskResponse,
  HeartbeatTaskResponse,
  SubmitResultResponse,
  SubmitFailureResponse,
  NextTaskResponse,
} from "./types";

export class DecisionService {
  private readonly store: DurableDecisionStore;
  private readonly clock: () => UtcTimestampMs;
  readonly defaultClaimTtlMs: number;

  constructor(store: DurableDecisionStore, config: Partial<DecisionStoreConfig> = {}) {
    this.store = store;
    this.clock = config.clock ?? (() => Date.now());
    this.defaultClaimTtlMs = config.defaultClaimTtlMs ?? 120_000;
  }

  getStore(): DurableDecisionStore {
    return this.store;
  }

  async createSession(root: DecisionWorkItemRef): Promise<DecisionSession> {
    const id = decisionSessionId(root);
    const existing = this.store.getSession(id);
    if (existing) {
      return existing;
    }

    return await this.store.transaction((draft) => {
      const current = draft.sessions[id];
      if (current) return current;

      const now = this.clock();
      const session: DecisionSession = {
        schemaVersion: 1,
        id,
        root,
        status: "active",
        binding: null,
        bindingGeneration: 0,
        createdAtMs: now,
        updatedAtMs: now,
      };
      draft.sessions[id] = session;
      return session;
    });
  }

  getSession(id: string): DecisionSession | null {
    return this.store.getSession(id);
  }

  getAllSessions(): DecisionSession[] {
    return this.store.getAllSessions();
  }

  async putBinding(
    sessionId: string,
    params: { adapter: string; externalSessionRef: string; resumeUri: string | null }
  ): Promise<DecisionSession> {
    return await this.store.transaction((draft) => {
      const session = draft.sessions[sessionId];
      if (!session) {
        throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      }

      if (session.binding !== null) {
        if (
          session.binding.adapter === params.adapter &&
          session.binding.externalSessionRef === params.externalSessionRef &&
          session.binding.resumeUri === params.resumeUri
        ) {
          // Idempotent retry with identical binding
          return session;
        }
        throw new DecisionConflictError(
          "Session is already bound. To replace with a new generation, use POST /v1/sessions/:id/rebind"
        );
      }

      if (session.status === "completed") {
        throw new DecisionConflictError("Cannot bind a completed session; reopen first");
      }

      const now = this.clock();
      const nextGen = session.bindingGeneration === 0 ? 1 : session.bindingGeneration + 1;
      const updated: DecisionSession = {
        ...session,
        binding: {
          schemaVersion: 1,
          adapter: params.adapter,
          externalSessionRef: params.externalSessionRef,
          resumeUri: params.resumeUri,
          generation: nextGen,
        },
        bindingGeneration: nextGen,
        status: "active",
        updatedAtMs: now,
      };

      draft.sessions[sessionId] = updated;
      return updated;
    });
  }

  async rebindSession(
    sessionId: string,
    params: {
      adapter: string;
      externalSessionRef: string;
      resumeUri: string | null;
      expectedGeneration: number;
      operationKey?: string | undefined;
    }
  ): Promise<DecisionSession> {
    if (params.operationKey) {
      const op = this.store.getOperationReceipt(params.operationKey);
      if (op) {
        if (
          op.kind !== "rebind-session" ||
          op.sessionId !== sessionId ||
          (op.bindingGeneration !== undefined &&
            op.bindingGeneration !== params.expectedGeneration &&
            op.bindingGeneration !== params.expectedGeneration + 1)
        ) {
          throw new DecisionConflictError(
            `Operation key "${params.operationKey}" was already used for a different operation`
          );
        }
        const existing = this.store.getSession(sessionId);
        if (existing) return existing;
      }
    }

    return await this.store.transaction((draft) => {
      if (params.operationKey) {
        const op = draft.operationReceipts[params.operationKey];
        if (op) {
          if (
            op.kind !== "rebind-session" ||
            op.sessionId !== sessionId ||
            (op.bindingGeneration !== undefined &&
              op.bindingGeneration !== params.expectedGeneration &&
              op.bindingGeneration !== params.expectedGeneration + 1)
          ) {
            throw new DecisionConflictError(
              `Operation key "${params.operationKey}" was already used for a different operation`
            );
          }
          const current = draft.sessions[sessionId];
          if (current) return current;
        }
      }

      const session = draft.sessions[sessionId];
      if (!session) {
        throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      }

      if (session.bindingGeneration !== params.expectedGeneration) {
        throw new DecisionConflictError(
          `Compare-and-swap failed: expected bindingGeneration ${params.expectedGeneration}, but current is ${session.bindingGeneration}`
        );
      }

      const now = this.clock();
      const nextGen = session.bindingGeneration + 1;
      const binding = {
        schemaVersion: 1 as const,
        adapter: params.adapter,
        externalSessionRef: params.externalSessionRef,
        resumeUri: params.resumeUri,
        generation: nextGen,
      };

      const updated = rebindDecisionSession(session, binding, now);
      draft.sessions[sessionId] = updated;

      if (params.operationKey) {
        const receipt: OperationReceipt = {
          schemaVersion: 1,
          operationKey: params.operationKey,
          kind: "rebind-session",
          sessionId,
          bindingGeneration: nextGen,
          entityId: sessionId,
          createdAtMs: now,
        };
        draft.operationReceipts[params.operationKey] = receipt;
      }

      return updated;
    });
  }

  async breakBinding(sessionId: string): Promise<DecisionSession> {
    return await this.store.transaction((draft) => {
      const session = draft.sessions[sessionId];
      if (!session) throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      const now = this.clock();
      const updated = breakDecisionBinding(session, now);
      draft.sessions[sessionId] = updated;
      return updated;
    });
  }

  async completeSession(sessionId: string): Promise<DecisionSession> {
    return await this.store.transaction((draft) => {
      const session = draft.sessions[sessionId];
      if (!session) throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      const tasks = Object.values(draft.tasks).filter((t) => t.sessionId === sessionId);
      const now = this.clock();
      const updated = completeDecisionSession(session, tasks, now);
      draft.sessions[sessionId] = updated;
      return updated;
    });
  }

  async reopenSession(sessionId: string): Promise<DecisionSession> {
    return await this.store.transaction((draft) => {
      const session = draft.sessions[sessionId];
      if (!session) throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      const now = this.clock();
      const updated = reopenDecisionSession(session, now);
      draft.sessions[sessionId] = updated;
      return updated;
    });
  }

  async createPlanTask(
    sessionId: string,
    params: { operationKey: string }
  ): Promise<DecisionTask> {
    if (params.operationKey) {
      const op = this.store.getOperationReceipt(params.operationKey);
      if (op) {
        if (op.kind !== "create-plan-task" || op.sessionId !== sessionId) {
          throw new DecisionConflictError(
            `Operation key "${params.operationKey}" was already used for a different operation`
          );
        }
        const existing = this.store.getTask(op.entityId);
        if (existing) return existing;
      }
    }

    return await this.store.transaction((draft) => {
      if (params.operationKey) {
        const op = draft.operationReceipts[params.operationKey];
        if (op) {
          if (op.kind !== "create-plan-task" || op.sessionId !== sessionId) {
            throw new DecisionConflictError(
              `Operation key "${params.operationKey}" was already used for a different operation`
            );
          }
          const existing = draft.tasks[op.entityId];
          if (existing) return existing;
        }
      }

      const session = draft.sessions[sessionId];
      if (!session) throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      if (session.status !== "active") {
        throw new DecisionConflictError(`Cannot create task for session in status "${session.status}"`);
      }

      const now = this.clock();
      const revKey = `plan:${sessionId}`;
      const rev = (draft.revisions[revKey] ?? 0) + 1;
      draft.revisions[revKey] = rev;

      // Supersede previous plan tasks for this session
      for (const t of Object.values(draft.tasks)) {
        if (t.sessionId === sessionId && t.kind === "plan" && t.status !== "superseded") {
          draft.tasks[t.id] = supersedeDecisionTask(t, now);
        }
      }

      const id = decisionTaskId({ sessionId, kind: "plan", revision: rev });
      const task: DecisionTask = {
        schemaVersion: 1,
        id,
        sessionId,
        kind: "plan",
        revision: rev,
        status: "pending",
        lease: null,
        claimGeneration: 0,
        lastClaimToken: null,
        createdAtMs: now,
        updatedAtMs: now,
      };

      draft.tasks[id] = task;

      if (params.operationKey) {
        draft.operationReceipts[params.operationKey] = {
          schemaVersion: 1,
          operationKey: params.operationKey,
          kind: "create-plan-task",
          sessionId,
          entityId: id,
          createdAtMs: now,
        };
      }

      return task;
    });
  }

  async createReviewTask(
    sessionId: string,
    params: { target: DecisionReviewTarget; operationKey: string }
  ): Promise<DecisionTask> {
    parseDecisionReviewTarget(params.target);

    if (params.operationKey) {
      const op = this.store.getOperationReceipt(params.operationKey);
      if (op) {
        if (
          op.kind !== "create-review-task" ||
          op.sessionId !== sessionId ||
          !canonicalJsonEqual(op.target, params.target)
        ) {
          throw new DecisionConflictError(
            `Operation key "${params.operationKey}" was already used for a different operation`
          );
        }
        const existing = this.store.getTask(op.entityId);
        if (existing) return existing;
      }
    }

    return await this.store.transaction((draft) => {
      if (params.operationKey) {
        const op = draft.operationReceipts[params.operationKey];
        if (op) {
          if (
            op.kind !== "create-review-task" ||
            op.sessionId !== sessionId ||
            !canonicalJsonEqual(op.target, params.target)
          ) {
            throw new DecisionConflictError(
              `Operation key "${params.operationKey}" was already used for a different operation`
            );
          }
          const existing = draft.tasks[op.entityId];
          if (existing) return existing;
        }
      }

      const session = draft.sessions[sessionId];
      if (!session) throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      if (session.status !== "active") {
        throw new DecisionConflictError(`Cannot create task for session in status "${session.status}"`);
      }

      const now = this.clock();
      const revKey = `review:${sessionId}:${params.target.repository}:${params.target.prNumber}`;
      const rev = (draft.revisions[revKey] ?? 0) + 1;
      draft.revisions[revKey] = rev;

      // Supersede previous review tasks for the same PR (including previously approved ones)
      for (const t of Object.values(draft.tasks)) {
        if (
          t.sessionId === sessionId &&
          t.kind === "review" &&
          t.target.repository === params.target.repository &&
          t.target.prNumber === params.target.prNumber &&
          t.status !== "superseded"
        ) {
          draft.tasks[t.id] = supersedeDecisionTask(t, now);
        }
      }

      const id = decisionTaskId({
        sessionId,
        kind: "review",
        revision: rev,
        target: params.target,
      });

      const task: DecisionTask = {
        schemaVersion: 1,
        id,
        sessionId,
        kind: "review",
        revision: rev,
        target: params.target,
        status: "pending",
        lease: null,
        claimGeneration: 0,
        lastClaimToken: null,
        createdAtMs: now,
        updatedAtMs: now,
      };

      draft.tasks[id] = task;

      if (params.operationKey) {
        draft.operationReceipts[params.operationKey] = {
          schemaVersion: 1,
          operationKey: params.operationKey,
          kind: "create-review-task",
          sessionId,
          target: params.target,
          entityId: id,
          createdAtMs: now,
        };
      }

      return task;
    });
  }

  getTask(id: string): DecisionTask | null {
    return this.store.getTask(id);
  }

  getResult(taskId: string): DecisionResult | null {
    return this.store.getResult(taskId);
  }

  getFailure(taskId: string): DecisionTaskFailure | null {
    return this.store.getFailure(taskId);
  }

  getReceipt(taskId: string): SubmissionReceipt | null {
    return this.store.getReceipt(taskId);
  }

  getAllTasks(): DecisionTask[] {
    return this.store.getAllTasks();
  }

  async getNextTask(): Promise<NextTaskResponse | null> {
    // Perform lazy expiry cleanup in a lightweight transaction if needed
    const now = this.clock();
    let hasExpired = false;
    for (const t of this.store.getAllTasks()) {
      if ((t.status === "claimed" || t.status === "running") && t.lease && now >= t.lease.expiresAtMs) {
        hasExpired = true;
        break;
      }
    }

    if (hasExpired) {
      await this.store.transaction((draft) => {
        const txNow = this.clock();
        for (const t of Object.values(draft.tasks)) {
          if ((t.status === "claimed" || t.status === "running") && t.lease && txNow >= t.lease.expiresAtMs) {
            draft.tasks[t.id] = releaseExpiredDecisionTask(t, txNow);
          }
        }
      });
    }

    // Stable selection: pending task in active session, sorted by createdAtMs ascending, then ID
    const candidates = this.store
      .getAllTasks()
      .filter((t) => {
        if (t.status !== "pending") return false;
        const s = this.store.getSession(t.sessionId);
        return s !== null && s.status === "active";
      })
      .sort((a, b) => {
        if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
        return a.id.localeCompare(b.id);
      });

    const next = candidates[0];
    if (!next) return null;

    const session = this.store.getSession(next.sessionId)!;
    return { task: next, session };
  }

  async claimTask(taskId: string, params: { owner: string; ttlMs?: number | undefined }): Promise<ClaimTaskResponse> {
    if (!params.owner || params.owner.trim() === "") {
      throw new DecisionValidationError("Claim owner must be a nonempty string");
    }

    return await this.store.transaction((draft) => {
      let task = draft.tasks[taskId];
      if (!task) throw new DecisionNotFoundError(`Task "${taskId}" not found`);

      const session = draft.sessions[task.sessionId];
      if (!session) throw new DecisionNotFoundError(`Session "${task.sessionId}" not found`);
      if (session.status !== "active") {
        throw new DecisionConflictError(`Cannot claim task for session in status "${session.status}"`);
      }

      const now = this.clock();
      // Lazy release if expired
      if ((task.status === "claimed" || task.status === "running") && task.lease && now >= task.lease.expiresAtMs) {
        task = releaseExpiredDecisionTask(task, now);
        draft.tasks[taskId] = task;
      }

      if (task.status !== "pending") {
        throw new DecisionConflictError(`Task "${taskId}" is in status "${task.status}" and cannot be claimed`);
      }

      const ttl = params.ttlMs ?? this.defaultClaimTtlMs;
      const expiresAtMs = now + ttl;
      const token = crypto.randomUUID();
      const lease: DecisionLease = {
        owner: params.owner,
        token,
        generation: task.claimGeneration + 1,
        expiresAtMs,
      };

      const updated = claimDecisionTask(task, lease, now);
      draft.tasks[taskId] = updated;

      return { task: updated, session, lease };
    });
  }

  async startTask(taskId: string, params: { owner: string; token: string; generation: number }): Promise<DecisionTask> {
    return await this.store.transaction((draft) => {
      const task = draft.tasks[taskId];
      if (!task) throw new DecisionNotFoundError(`Task "${taskId}" not found`);

      if (task.status !== "claimed") {
        throw new DecisionConflictError(`Task "${taskId}" is in status "${task.status}", expected "claimed"`);
      }

      if (
        !task.lease ||
        task.lease.owner !== params.owner ||
        task.lease.token !== params.token ||
        task.lease.generation !== params.generation
      ) {
        throw new DecisionConflictError("Stale or invalid claim credentials");
      }

      const now = this.clock();
      if (now >= task.lease.expiresAtMs) {
        throw new DecisionConflictError("Claim lease has already expired");
      }

      const updated = startDecisionTask(task, task.lease, now);
      draft.tasks[taskId] = updated;
      return updated;
    });
  }

  async heartbeatTask(
    taskId: string,
    params: { owner: string; token: string; generation: number; ttlMs?: number | undefined }
  ): Promise<HeartbeatTaskResponse> {
    return await this.store.transaction((draft) => {
      const task = draft.tasks[taskId];
      if (!task) throw new DecisionNotFoundError(`Task "${taskId}" not found`);

      if (task.status !== "claimed" && task.status !== "running") {
        throw new DecisionConflictError(`Task "${taskId}" is in status "${task.status}", expected leased state`);
      }

      if (
        !task.lease ||
        task.lease.owner !== params.owner ||
        task.lease.token !== params.token ||
        task.lease.generation !== params.generation
      ) {
        throw new DecisionConflictError("Stale or invalid claim credentials");
      }

      const now = this.clock();
      if (now >= task.lease.expiresAtMs) {
        throw new DecisionConflictError("Claim lease has already expired");
      }

      const ttl = params.ttlMs ?? this.defaultClaimTtlMs;
      const newExpiry = now + ttl;
      const updated = heartbeatDecisionTask(task, task.lease, newExpiry, now);
      draft.tasks[taskId] = updated;

      return { expiresAtMs: newExpiry, ttlMs: ttl };
    });
  }

  async submitResult(
    taskId: string,
    params: { owner: string; token: string; generation: number; result: DecisionResult }
  ): Promise<SubmitResultResponse> {
    return await this.store.transaction((draft) => {
      const task = draft.tasks[taskId];
      if (!task) throw new DecisionNotFoundError(`Task "${taskId}" not found`);

      const receipt = draft.receipts[taskId];
      if (receipt) {
        if (
          receipt.type === "result" &&
          receipt.claimOwner === params.owner &&
          receipt.claimGeneration === params.generation &&
          receipt.claimToken === params.token &&
          canonicalJsonEqual(receipt.payload, params.result)
        ) {
          return {
            receipt,
            result: receipt.payload as DecisionResult,
            superseded: task.status === "superseded",
          };
        }
        throw new DecisionConflictError("Submission conflict: task already has a conflicting result or failure");
      }

      if (task.status === "superseded" || task.status === "cancelled") {
        throw new DecisionConflictError(`Cannot submit result for ${task.status} task`);
      }

      if (task.status !== "running") {
        throw new DecisionConflictError(`Task "${taskId}" must be in "running" state to complete`);
      }

      if (
        !task.lease ||
        task.lease.owner !== params.owner ||
        task.lease.token !== params.token ||
        task.lease.generation !== params.generation
      ) {
        throw new DecisionConflictError("Stale or invalid claim credentials");
      }

      const now = this.clock();
      if (now >= task.lease.expiresAtMs) {
        throw new DecisionConflictError("Claim lease has already expired");
      }

      validateDecisionResultForTask(task, params.result);

      const completed = completeDecisionTask(task, params.result, task.lease, now);
      draft.tasks[taskId] = completed;
      draft.results[taskId] = params.result;

      const newReceipt: SubmissionReceipt = {
        schemaVersion: 1,
        taskId,
        type: "result",
        claimGeneration: params.generation,
        claimOwner: params.owner,
        claimToken: params.token,
        acceptedAtMs: now,
        payload: params.result,
      };
      draft.receipts[taskId] = newReceipt;

      return {
        receipt: newReceipt,
        result: params.result,
        superseded: false,
      };
    });
  }

  async submitFailure(
    taskId: string,
    params: {
      owner: string;
      token: string;
      generation: number;
      error: string;
      details?: unknown;
      retryable?: boolean | undefined;
    }
  ): Promise<SubmitFailureResponse> {
    return await this.store.transaction((draft) => {
      const task = draft.tasks[taskId];
      if (!task) throw new DecisionNotFoundError(`Task "${taskId}" not found`);

      const receipt = draft.receipts[taskId];
      if (receipt) {
        if (
          receipt.type === "failure" &&
          receipt.claimOwner === params.owner &&
          receipt.claimGeneration === params.generation &&
          receipt.claimToken === params.token &&
          (receipt.payload as DecisionTaskFailure).error === params.error &&
          (receipt.payload as DecisionTaskFailure).retryable === (params.retryable ?? false) &&
          canonicalJsonEqual(
            (receipt.payload as DecisionTaskFailure).details,
            params.details ?? null
          )
        ) {
          return {
            receipt,
            failure: receipt.payload as DecisionTaskFailure,
            superseded: task.status === "superseded",
          };
        }
        throw new DecisionConflictError("Submission conflict: task already has a conflicting result or failure");
      }

      if (task.status === "superseded" || task.status === "cancelled") {
        throw new DecisionConflictError(`Cannot fail ${task.status} task`);
      }

      if (task.status !== "claimed" && task.status !== "running") {
        throw new DecisionConflictError(`Task "${taskId}" is not in claimed or running state`);
      }

      if (
        !task.lease ||
        task.lease.owner !== params.owner ||
        task.lease.token !== params.token ||
        task.lease.generation !== params.generation
      ) {
        throw new DecisionConflictError("Stale or invalid claim credentials");
      }

      const now = this.clock();
      if (now >= task.lease.expiresAtMs) {
        throw new DecisionConflictError("Claim lease has already expired");
      }

      const failed = failDecisionTask(task, task.lease, now);
      draft.tasks[taskId] = failed;

      const failure: DecisionTaskFailure = {
        schemaVersion: 1,
        taskId,
        sessionId: task.sessionId,
        revision: task.revision,
        error: params.error,
        details: params.details ?? null,
        retryable: params.retryable ?? false,
        createdAtMs: now,
      };
      draft.failures[taskId] = failure;

      const newReceipt: SubmissionReceipt = {
        schemaVersion: 1,
        taskId,
        type: "failure",
        claimGeneration: params.generation,
        claimOwner: params.owner,
        claimToken: params.token,
        acceptedAtMs: now,
        payload: failure,
      };
      draft.receipts[taskId] = newReceipt;

      return {
        receipt: newReceipt,
        failure,
        superseded: false,
      };
    });
  }

  async cancelTask(taskId: string): Promise<DecisionTask> {
    return await this.store.transaction((draft) => {
      const task = draft.tasks[taskId];
      if (!task) throw new DecisionNotFoundError(`Task "${taskId}" not found`);
      const now = this.clock();
      const updated = cancelDecisionTask(task, now);
      draft.tasks[taskId] = updated;
      return updated;
    });
  }

  async supersedeTask(taskId: string): Promise<DecisionTask> {
    return await this.store.transaction((draft) => {
      const task = draft.tasks[taskId];
      if (!task) throw new DecisionNotFoundError(`Task "${taskId}" not found`);
      const now = this.clock();
      const updated = supersedeDecisionTask(task, now);
      draft.tasks[taskId] = updated;
      return updated;
    });
  }
}
