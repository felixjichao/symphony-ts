import type { DecisionContinuityWork, ReclaimDecisionClaim, UnblockDecisionExecution } from "./continuity";
import crypto from "node:crypto";
import {
  DECISION_PROGRESS_TIMEOUT_MS,
  DECISION_EXECUTION_PHASES,
  DECISION_MAX_RECOVERY_ATTEMPTS,
  type DecisionExecution,
  decisionSessionId,
  decisionTaskId,
  claimDecisionTask,
  startDecisionTask,
  heartbeatDecisionTask,
  completeDecisionTask,
  failDecisionTask,
  releaseExpiredDecisionTask,
  releaseDecisionTaskForBindingInvalidation,
  cancelDecisionTask,
  supersedeDecisionTask,
  rebindDecisionSession,
  breakDecisionBinding,
  completeDecisionSession,
  reopenDecisionSession,
  validateDecisionResultForTask,
  parseDecisionReviewTarget,
  parseDecisionContextBundle,
  validateDecisionContextForTask,
  isDecisionReviewApproved,
  type DecisionReviewTask,
  type DeliveryReviewApprovalResult,
  type PlanningEligibilityResult,
  type DecisionSession,
  type DecisionTask,
  type DecisionResult,
  type DecisionLease,
  type DecisionReviewTarget,
  type DecisionWorkItemRef,
  type DecisionContextBundle,
  type DecisionMaterializedContext,
  type DecisionMaterializedPlan,
  type UtcTimestampMs,
} from "@symphony/domain";
import { canonicalJsonEqual, computeRequirementFingerprint } from "./canonical-json";
import {
  DecisionConflictError,
  DecisionNotFoundError,
  DecisionValidationError,
} from "./errors";
import type { DurableDecisionStore } from "./store";
import type {
  DecisionStoreRecord,
  DecisionStoreConfig,
  DecisionPlanRecord,
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
  private readonly authorizeExecution: DecisionStoreConfig["authorizeExecution"];

  constructor(store: DurableDecisionStore, config: Partial<DecisionStoreConfig> = {}) {
    this.store = store;
    this.clock = config.clock ?? (() => Date.now());
    this.defaultClaimTtlMs = config.defaultClaimTtlMs ?? 120_000;
    this.authorizeExecution = config.authorizeExecution;
  }

  /** Read-only operational view from the already-open store. */
  observeWork(root: DecisionWorkItemRef) {
    return this.store.observeWork(root);
  }

  /** Read current tasks from the already-open authoritative store; never expose lease tokens. */
  continuityWork(): readonly DecisionContinuityWork[] {
    const state = this.store.getState();
    const claimBindings = state.claimBindingGenerations;
    return this.store.getAllSessions().map(session => ({
      workKey: session.root, sessionId: session.id, bindingGeneration: session.bindingGeneration,
      tasks: this.getTasksForSession(session.id).map(task => ({
        id: task.id, revision: task.revision, kind: task.kind, status: task.status,
        claimBindingGeneration: claimBindings[task.id] ?? null,
        claimGeneration: task.claimGeneration, createdAtMs: task.createdAtMs,
        owner: task.lease?.owner ?? null, leaseExpiresAtMs: task.lease?.expiresAtMs ?? null,
        verdict: this.getResult(task.id)?.verdict ?? null,
        target: task.kind === "review" ? task.target : null,
        execution: state.executions?.[task.id] ?? null,
      })),
    }));
  }

  /** Authority commit: renewal, completion, rebinding and competing reclaim all win over stale callers. */
  async reclaimExpiredClaim(expected: ReclaimDecisionClaim): Promise<boolean> {
    return this.store.transaction(draft => {
      const task = draft.tasks[expected.taskId];
      const session = task ? draft.sessions[task.sessionId] : undefined;
      const now = this.clock();
      if (!task || !session || session.status === "completed"
        || task.revision !== expected.revision || task.claimGeneration !== expected.claimGeneration
        || session.bindingGeneration !== expected.bindingGeneration
        || (task.status !== "claimed" && task.status !== "running") || !task.lease
        || task.lease.expiresAtMs !== expected.leaseExpiresAtMs || now < task.lease.expiresAtMs) return false;
      // Old stores cannot prove that a missing browser never clicked Send.
      const execution = draft.executions?.[task.id] ?? { revision: task.revision, startedAtMs: task.createdAtMs,
        lastProgressAtMs: task.createdAtMs, deadlineAtMs: now, phase: "unknown", responseLength: 0,
        recoveryAttempts: 0, blocked: null };
      if (execution?.blocked) return false;
      if (execution && (execution.phase === "unknown" || execution.phase === "prompt_submitting" || execution.phase === "waiting_response" || execution.phase === "result_extracted" || execution.phase === "bootstrap_submitting" || execution.phase === "bootstrap_waiting")) {
        this.writeExecution(draft, task.id, { ...execution, blocked: { reason: "human_required",
          unblock: "Verify conversation/result receipt before authorizing another prompt", atMs: now } });
        return true;
      }
      if (execution && execution.recoveryAttempts >= DECISION_MAX_RECOVERY_ATTEMPTS) {
        this.writeExecution(draft, task.id, { ...execution, blocked: { reason: "recovery_exhausted",
          unblock: "Operator must inspect execution and authorize recovery", atMs: now } });
        return true;
      }
      if (execution) this.writeExecution(draft, task.id, { ...execution, recoveryAttempts: execution.recoveryAttempts + 1 });
      draft.tasks[task.id] = releaseExpiredDecisionTask(task, now);
      delete draft.claimBindingGenerations?.[task.id];
      return true;
    });
  }

  private writeExecution(draft: DecisionStoreRecord, id: string, execution: DecisionExecution): void {
    if (!draft.executions) Object.assign(draft, { executions: {} });
    draft.executions![id] = execution;
  }

  getExecution(taskId: string): DecisionExecution | null {
    return this.store.getState().executions?.[taskId] ?? null;
  }

  async blockExecution(taskId: string, params: { owner: string; token: string; generation: number; reason: string }): Promise<void> {
    await this.store.transaction(draft => {
      const task = draft.tasks[taskId];
      const session = task ? draft.sessions[task.sessionId] : undefined;
      const now = this.clock();
      if (!task || !session || (task.status !== "claimed" && task.status !== "running")
        || !task.lease || task.lease.owner !== params.owner || task.lease.token !== params.token
        || task.claimGeneration !== params.generation || now >= task.lease.expiresAtMs
        || draft.claimBindingGenerations[taskId] !== session.bindingGeneration) throw new DecisionConflictError("Invalid execution fence");
      if (!["auth_required", "human_required", "recovery_exhausted", "invariant_violation"].includes(params.reason)) throw new DecisionValidationError("Invalid block reason");
      const e = draft.executions?.[taskId];
      if (!e) throw new DecisionConflictError("Missing execution facts");
      if (e.blocked) return;
      this.writeExecution(draft, taskId, { ...e, blocked: { reason: params.reason,
        unblock: "Resolve the cause, inspect conversation/receipt, then explicitly authorize recovery via continuity/unblock", atMs: now } });
    });
  }

  /**
   * Explicit operator authorization after inspecting uncertain side effects. Never used by polling.
   * Two fenced shapes exist because two checked states can be blocked:
   * - leased (`claimed`/`running`): the exact lease expiry identifies the blocked execution and is
   *   released, so the incumbent fails closed on its next fenced action;
   * - lease-less `pending`: recovery budgets can be exhausted by rebind, which releases the claim
   *   before it blocks, so there is no lease to quote. The fence is then the asserted absence of a
   *   lease plus the exact task/claim/binding generation, and the block timestamp.
   */
  async unblockExecution(expected: UnblockDecisionExecution): Promise<boolean> {
    return this.store.transaction(draft => {
      const task = draft.tasks[expected.taskId];
      const session = task ? draft.sessions[task.sessionId] : undefined;
      const e = draft.executions?.[expected.taskId];
      if (!task || !session || !e?.blocked || task.revision !== expected.revision
        || task.claimGeneration !== expected.claimGeneration || session.bindingGeneration !== expected.bindingGeneration
        || e.blocked.atMs !== expected.blockedAtMs || draft.receipts[task.id]?.type === "result") return false;
      const isLeased = task.status === "claimed" || task.status === "running";
      if (isLeased) {
        if (!task.lease || expected.leaseExpiresAtMs === null
          || task.lease.expiresAtMs !== expected.leaseExpiresAtMs) return false;
      } else if (task.status !== "pending" || task.lease !== null || expected.leaseExpiresAtMs !== null) {
        return false;
      }
      const now = this.clock();
      this.writeExecution(draft, task.id, { ...e, blocked: null, phase: "claimed", responseLength: 0,
        recoveryAttempts: 0, lastProgressAtMs: now, deadlineAtMs: now + DECISION_PROGRESS_TIMEOUT_MS });
      if (isLeased) draft.tasks[task.id] = releaseDecisionTaskForBindingInvalidation(task, now);
      delete draft.claimBindingGenerations[task.id];
      return true;
    });
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
    params: {
      adapter: string;
      externalSessionRef: string;
      resumeUri: string | null;
      owner?: string | undefined;
      token?: string | undefined;
      generation?: number | undefined;
    }
  ): Promise<DecisionSession> {
    return await this.store.transaction((draft) => {
      const session = draft.sessions[sessionId];
      if (!session) {
        throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      }

      const now = this.clock();

      if (params.owner !== undefined || params.token !== undefined || params.generation !== undefined) {
        const activeLeaseTask = Object.values(draft.tasks).find(
          (t) =>
            t.sessionId === sessionId &&
            (t.status === "claimed" || t.status === "running") &&
            t.lease !== null &&
            now < t.lease.expiresAtMs
        );
        if (!activeLeaseTask || !activeLeaseTask.lease) {
          throw new DecisionConflictError("No active lease found on session matching credentials for binding update");
        }
        if (draft.executions?.[activeLeaseTask.id]?.blocked) throw new DecisionConflictError("Execution is blocked");
        if (
          activeLeaseTask.lease.owner !== params.owner ||
          activeLeaseTask.lease.token !== params.token ||
          activeLeaseTask.lease.generation !== params.generation
        ) {
          throw new DecisionConflictError("Stale or invalid lease credentials for binding update");
        }
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

      if (session.bindingGeneration === 0 && nextGen === 1) {
        if (!draft.claimBindingGenerations) {
          (draft as { claimBindingGenerations: Record<string, number> }).claimBindingGenerations = {};
        }
        for (const t of Object.values(draft.tasks)) {
          if (
            t.sessionId === sessionId &&
            (t.status === "claimed" || t.status === "running") &&
            draft.claimBindingGenerations[t.id] === 0
          ) {
            draft.claimBindingGenerations[t.id] = 1;
          }
        }
      }

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
      owner?: string | undefined;
      token?: string | undefined;
      generation?: number | undefined;
    }
  ): Promise<DecisionSession> {
    const checkRebindOp = (op: OperationReceipt): DecisionSession => {
      const genMatches =
        params.expectedGeneration === op.expectedGeneration ||
        params.expectedGeneration === op.bindingGeneration;

      if (
        op.kind !== "rebind-session" ||
        op.sessionId !== sessionId ||
        !genMatches ||
        op.adapter !== params.adapter ||
        op.externalSessionRef !== params.externalSessionRef ||
        op.resumeUri !== params.resumeUri ||
        !op.resultingSession
      ) {
        throw new DecisionConflictError(
          `Operation key "${params.operationKey}" was already used for a different operation`
        );
      }
      return op.resultingSession;
    };

    if (params.operationKey) {
      const op = this.store.getOperationReceipt(params.operationKey);
      if (op) {
        return checkRebindOp(op);
      }
    }

    if (this.authorizeExecution) {
      for (const task of this.getTasksForSession(sessionId).filter(t => t.status === "pending" || t.status === "claimed" || t.status === "running")) {
        if (!await this.authorizeExecution(task)) throw new DecisionConflictError("Recovery target is no longer current");
      }
    }
    const result = await this.store.transaction((draft) => {
      if (params.operationKey) {
        const op = draft.operationReceipts[params.operationKey];
        if (op) {
          return checkRebindOp(op);
        }
      }

      const session = draft.sessions[sessionId];
      if (!session) {
        throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      }

      const now = this.clock();

      if (params.owner !== undefined || params.token !== undefined || params.generation !== undefined) {
        const activeLeaseTask = Object.values(draft.tasks).find(
          (t) =>
            t.sessionId === sessionId &&
            (t.status === "claimed" || t.status === "running") &&
            t.lease !== null &&
            now < t.lease.expiresAtMs
        );
        if (!activeLeaseTask || !activeLeaseTask.lease) {
          throw new DecisionConflictError("No active lease found on session matching credentials for binding update");
        }
        if (draft.executions?.[activeLeaseTask.id]?.blocked) throw new DecisionConflictError("Execution is blocked");
        if (
          activeLeaseTask.lease.owner !== params.owner ||
          activeLeaseTask.lease.token !== params.token ||
          activeLeaseTask.lease.generation !== params.generation
        ) {
          throw new DecisionConflictError("Stale or invalid lease credentials for binding update");
        }
      }

      if (session.bindingGeneration !== params.expectedGeneration) {
        throw new DecisionConflictError(
          `Compare-and-swap failed: expected bindingGeneration ${params.expectedGeneration}, but current is ${session.bindingGeneration}`
        );
      }

      for (const t of Object.values(draft.tasks).filter(t => t.sessionId === sessionId && (t.status === "running" || t.status === "claimed" || t.status === "pending"))) {
        const e = draft.executions?.[t.id];
        if (e?.blocked) return session;
        if (e && e.recoveryAttempts >= DECISION_MAX_RECOVERY_ATTEMPTS) {
          this.writeExecution(draft, t.id, { ...e, blocked: { reason: "recovery_exhausted",
            unblock: "Operator must inspect conversation and authorize recovery", atMs: now } });
          return session;
        }
      }
      for (const t of Object.values(draft.tasks).filter(t => t.sessionId === sessionId && (t.status === "running" || t.status === "claimed" || t.status === "pending"))) {
        const e = draft.executions?.[t.id];
        if (e) this.writeExecution(draft, t.id, { ...e, recoveryAttempts: e.recoveryAttempts + 1, phase: "claimed", responseLength: 0 });
      }
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

      if (!draft.claimBindingGenerations) {
        (draft as { claimBindingGenerations: Record<string, number> }).claimBindingGenerations = {};
      }
      for (const t of Object.values(draft.tasks)) {
        if (
          t.sessionId === sessionId &&
          (t.status === "claimed" || t.status === "running")
        ) {
          draft.tasks[t.id] = releaseDecisionTaskForBindingInvalidation(t, now);
          delete draft.claimBindingGenerations[t.id];
        }
      }

      if (params.operationKey) {
        const receipt: OperationReceipt = {
          schemaVersion: 1,
          operationKey: params.operationKey,
          kind: "rebind-session",
          sessionId,
          bindingGeneration: nextGen,
          expectedGeneration: params.expectedGeneration,
          adapter: params.adapter,
          externalSessionRef: params.externalSessionRef,
          resumeUri: params.resumeUri,
          resultingSession: updated,
          entityId: sessionId,
          createdAtMs: now,
        };
        draft.operationReceipts[params.operationKey] = receipt;
      }

      return updated;
    });
    if (result.bindingGeneration === params.expectedGeneration) throw new DecisionConflictError("Execution blocked by recovery budget");
    return result;
  }

  async breakBinding(
    sessionId: string,
    params?: {
      owner?: string | undefined;
      token?: string | undefined;
      generation?: number | undefined;
      expectedGeneration?: number | undefined;
    }
  ): Promise<DecisionSession> {
    return await this.store.transaction((draft) => {
      const session = draft.sessions[sessionId];
      if (!session) throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      const now = this.clock();

      if (params?.owner !== undefined || params?.token !== undefined || params?.generation !== undefined) {
        const activeLeaseTask = Object.values(draft.tasks).find(
          (t) =>
            t.sessionId === sessionId &&
            (t.status === "claimed" || t.status === "running") &&
            t.lease !== null &&
            now < t.lease.expiresAtMs
        );
        if (!activeLeaseTask || !activeLeaseTask.lease) {
          throw new DecisionConflictError("No active lease found on session matching credentials for break binding");
        }
        if (draft.executions?.[activeLeaseTask.id]?.blocked) throw new DecisionConflictError("Execution is blocked");
        if (
          activeLeaseTask.lease.owner !== params.owner ||
          activeLeaseTask.lease.token !== params.token ||
          activeLeaseTask.lease.generation !== params.generation
        ) {
          throw new DecisionConflictError("Stale or invalid lease credentials for break binding");
        }
      }

      if (params?.expectedGeneration !== undefined) {
        if (session.bindingGeneration > params.expectedGeneration) {
          throw new DecisionConflictError(
            `Stale breakBinding request: expectedGeneration was ${params.expectedGeneration}, but session is at ${session.bindingGeneration}`
          );
        }
        if (session.status === "broken-binding" && session.bindingGeneration === params.expectedGeneration) {
          return session;
        }
      }

      if (session.status === "broken-binding") {
        return session;
      }

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
    params: {
      operationKey?: string | undefined;
      context?: DecisionContextBundle | undefined;
      triggerKind?: "initial" | "requirements_changed" | "clarification" | "retry" | undefined;
      requirements?: { readonly title: string; readonly body: string; readonly clarifications?: readonly string[] | undefined } | undefined;
      previousTaskId?: string | null | undefined;
    } = {}
  ): Promise<DecisionTask> {
    const title =
      params.requirements?.title?.trim() ||
      (params.context?.strategy === "materialized" ? params.context.issue.title : "") ||
      "Issue Requirements";
    const body =
      params.requirements?.body ??
      (params.context?.strategy === "materialized" ? params.context.issue.body : "");
    const clarifications = params.requirements?.clarifications ?? [];
    const fingerprint = computeRequirementFingerprint(title, body, clarifications);
    const triggerKind = params.triggerKind ?? "initial";
    const previousTaskId = params.previousTaskId ?? null;

    if (params.operationKey) {
      const op = this.store.getOperationReceipt(params.operationKey);
      if (op) {
        if (op.kind !== "create-plan-task" || op.sessionId !== sessionId) {
          throw new DecisionConflictError(
            `Operation key "${params.operationKey}" was already used for a different operation`
          );
        }
        if (
          (op.fingerprint !== undefined && op.fingerprint !== fingerprint) ||
          (op.triggerKind !== undefined && op.triggerKind !== triggerKind) ||
          (op.previousTaskId !== undefined && op.previousTaskId !== previousTaskId)
        ) {
          throw new DecisionConflictError(
            `Operation key "${params.operationKey}" was already used with different parameters`
          );
        }
        const existing = this.store.getTask(op.entityId);
        if (existing) {
          return existing;
        }
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
          if (
            (op.fingerprint !== undefined && op.fingerprint !== fingerprint) ||
            (op.triggerKind !== undefined && op.triggerKind !== triggerKind) ||
            (op.previousTaskId !== undefined && op.previousTaskId !== previousTaskId)
          ) {
            throw new DecisionConflictError(
              `Operation key "${params.operationKey}" was already used with different parameters`
            );
          }
          const existing = draft.tasks[op.entityId];
          if (existing) {
            return existing;
          }
        }
      }

      const session = draft.sessions[sessionId];
      if (!session) throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      if (session.status !== "active" && session.status !== "broken-binding") {
        throw new DecisionConflictError(`Cannot create task for session in status "${session.status}"`);
      }

      const now = this.clock();
      const revKey = `plan:${sessionId}`;
      const rev = (draft.revisions[revKey] ?? 0) + 1;
      draft.revisions[revKey] = rev;

      // Supersede previous plan tasks and active plan records for this session
      for (const t of Object.values(draft.tasks)) {
        if (t.sessionId === sessionId && t.kind === "plan" && t.status !== "superseded") {
          draft.tasks[t.id] = supersedeDecisionTask(t, now);
        }
      }
      for (const p of Object.values(draft.plans)) {
        if (p.sessionId === sessionId && (p.status === "pending" || p.status === "running")) {
          draft.plans[p.taskId] = {
            ...p,
            status: "superseded",
            updatedAtMs: now,
          };
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

      if (params.context) {
        const parsed = parseDecisionContextBundle(params.context);
        validateDecisionContextForTask(parsed, task, session);
        draft.contexts[id] = parsed;
      } else {
        const root = session.root;
        const match = /^(.*)#([1-9][0-9]*)$/.exec(root.key);
        let repo = match ? match[1]! : (root.key.includes("/") ? root.key.split("#")[0]! : "symphony/repo");
        if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9_.-]+$/.test(repo)) {
          repo = "symphony/repo";
        }
        const issueNumber = match ? Number(match[2]) : 1;

        let priorMaterializedPlan: DecisionMaterializedPlan | null = null;
        if (previousTaskId) {
          const prevPlan = draft.plans[previousTaskId];
          if (prevPlan && prevPlan.result?.kind === "plan") {
            priorMaterializedPlan = {
              taskId: prevPlan.taskId,
              revision: prevPlan.revision,
              plan: prevPlan.result.content.plan,
              acceptanceCriteria: prevPlan.result.content.acceptanceCriteria,
              risks: prevPlan.result.content.risks,
              clarifications: prevPlan.result.content.clarifications,
            };
          }
        } else {
          const prevPlans = Object.values(draft.plans)
            .filter((p) => p.sessionId === sessionId && p.status === "completed" && p.result !== null)
            .sort((a, b) => b.createdAtMs - a.createdAtMs || b.revision - a.revision);
          const prev = prevPlans[0];
          if (prev && prev.result?.kind === "plan") {
            priorMaterializedPlan = {
              taskId: prev.taskId,
              revision: prev.revision,
              plan: prev.result.content.plan,
              acceptanceCriteria: prev.result.content.acceptanceCriteria,
              risks: prev.result.content.risks,
              clarifications: prev.result.content.clarifications,
            };
          }
        }

        let enrichedBody = body;
        if (clarifications.length > 0) {
          enrichedBody += `\n\n### Clarifications\n` + clarifications.map((c) => `- ${c}`).join("\n");
        }

        const autoContext: DecisionMaterializedContext = {
          strategy: "materialized",
          workItem: root,
          repository: repo,
          issue: {
            repository: repo,
            number: issueNumber,
            title,
            body: enrichedBody,
          },
          plan: priorMaterializedPlan,
          pullRequest: null,
          diff: null,
          ci: null,
          repositoryInstructions: null,
          previousReviews: [],
          unresolvedFindings: [],
        };
        draft.contexts[id] = autoContext;
      }

      const planRecord: DecisionPlanRecord = {
        schemaVersion: 1,
        sessionId,
        taskId: id,
        revision: rev,
        triggerKind: params.triggerKind ?? (rev === 1 ? "initial" : "clarification"),
        requirements: {
          title,
          body,
          clarifications,
          fingerprint,
        },
        previousTaskId,
        status: "pending",
        result: null,
        publishedCommentId: null,
        publishedAtMs: null,
        createdAtMs: now,
        updatedAtMs: now,
      };

      draft.plans[id] = planRecord;

      if (params.operationKey) {
        draft.operationReceipts[params.operationKey] = {
          schemaVersion: 1,
          operationKey: params.operationKey,
          kind: "create-plan-task",
          sessionId,
          triggerKind,
          fingerprint,
          previousTaskId,
          entityId: id,
          createdAtMs: now,
        };
      }

      return task;
    });
  }

  async createReviewTask(
    sessionId: string,
    params: {
      target: DecisionReviewTarget;
      context?: DecisionContextBundle | undefined;
      operationKey?: string | undefined;
      supersedeSessionReviews?: boolean | undefined;
      forceNewRevision?: boolean | undefined;
    }
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
        if (existing && existing.status !== "superseded" && existing.status !== "failed" && existing.status !== "cancelled") {
          return existing;
        }
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
          if (existing && existing.status !== "superseded" && existing.status !== "failed" && existing.status !== "cancelled") {
            return existing;
          }
        }
      }

      const session = draft.sessions[sessionId];
      if (!session) throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      if (session.status !== "active" && session.status !== "broken-binding") {
        throw new DecisionConflictError(`Cannot create task for session in status "${session.status}"`);
      }

      const now = this.clock();

      // Check if an active or reusable review task already exists for this exact target in this session.
      // If forceNewRevision is requested or if a new operationKey is explicitly specified,
      // we do not reuse a completed task, treating it as an explicit advancement to a new round.
      const isExplicitNewRound = Boolean(params.forceNewRevision || (params.operationKey && !draft.operationReceipts[params.operationKey]));

      const existingTask = Object.values(draft.tasks).find(
        (t): t is DecisionReviewTask => {
          if (
            t.sessionId !== sessionId ||
            t.kind !== "review" ||
            t.target.repository.toLowerCase() !== params.target.repository.toLowerCase() ||
            t.target.prNumber !== params.target.prNumber ||
            t.target.headSha !== params.target.headSha
          ) {
            return false;
          }
          if (t.status === "superseded" || t.status === "failed" || t.status === "cancelled") {
            return false;
          }
          if (t.status === "pending" || t.status === "claimed" || t.status === "running") {
            const existingCtx = draft.contexts[t.id];
            if (params.context?.strategy === "materialized" && params.context.plan) {
              if (
                !existingCtx ||
                existingCtx.strategy !== "materialized" ||
                !existingCtx.plan ||
                existingCtx.plan.taskId !== params.context.plan.taskId ||
                existingCtx.plan.revision !== params.context.plan.revision
              ) {
                return false;
              }
            }
            return true;
          }
          if (t.status === "completed") {
            if (isExplicitNewRound) return false;
            const existingCtx = draft.contexts[t.id];
            if (params.context?.strategy === "materialized" && params.context.plan) {
              if (
                !existingCtx ||
                existingCtx.strategy !== "materialized" ||
                !existingCtx.plan ||
                existingCtx.plan.taskId !== params.context.plan.taskId ||
                existingCtx.plan.revision !== params.context.plan.revision
              ) {
                return false;
              }
            }
            const res = draft.results[t.id];
            return Boolean(res && res.kind === "review");
          }
          return false;
        }
      );
      if (existingTask) {
        if (params.operationKey && !draft.operationReceipts[params.operationKey]) {
          draft.operationReceipts[params.operationKey] = {
            schemaVersion: 1,
            operationKey: params.operationKey,
            kind: "create-review-task",
            sessionId,
            target: params.target,
            entityId: existingTask.id,
            createdAtMs: now,
          };
        }
        return existingTask;
      }

      const revKey = `review:${sessionId}:${params.target.repository}:${params.target.prNumber}`;
      const rev = (draft.revisions[revKey] ?? 0) + 1;
      draft.revisions[revKey] = rev;

      // Supersede previous review tasks (for all session reviews if requested, or same PR by default)
      const shouldSupersede = Boolean(params.supersedeSessionReviews);
      for (const t of Object.values(draft.tasks)) {
        if (
          t.sessionId === sessionId &&
          t.kind === "review" &&
          (shouldSupersede ||
            (t.target.repository === params.target.repository && t.target.prNumber === params.target.prNumber)) &&
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

      if (params.context) {
        const parsed = parseDecisionContextBundle(params.context);
        validateDecisionContextForTask(parsed, task, session);
        draft.contexts[id] = parsed;
      }

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

  getTasksForSession(sessionId: string): DecisionTask[] {
    return this.store.getAllTasks().filter((t) => t.sessionId === sessionId);
  }

  getLatestReviewTask(sessionId: string): DecisionTask | null {
    const tasks = this.getTasksForSession(sessionId)
      .filter((t): t is DecisionTask & { kind: "review" } => t.kind === "review")
      .sort((a, b) => b.createdAtMs - a.createdAtMs || b.revision - a.revision);
    return tasks[0] ?? null;
  }

  verifyReviewApproval(
    sessionId: string,
    target: DecisionReviewTarget,
    requirements?: { readonly title: string; readonly body: string; readonly clarifications?: readonly string[] | undefined } | undefined,
  ): DeliveryReviewApprovalResult {
    const latestPlan = this.store.getLatestPlanForSession(sessionId);
    if (latestPlan !== null) {
      if (latestPlan.status !== "completed") {
        return {
          approved: false,
          reason: `Session plan is not completed (status: ${latestPlan.status}, task: ${latestPlan.taskId})`,
          sessionId,
          headSha: target.headSha,
        };
      }
      if (latestPlan.result?.verdict !== "ready") {
        return {
          approved: false,
          reason: `Session plan verdict is not ready (verdict: ${latestPlan.result?.verdict ?? "unknown"})`,
          sessionId,
          headSha: target.headSha,
        };
      }
      if (latestPlan.publishedCommentId === null) {
        return {
          approved: false,
          reason: `Session plan is not published to GitHub`,
          sessionId,
          headSha: target.headSha,
        };
      }
      // A session plan exists, so approval is bound to those requirements. Refuse
      // to fall open when the caller omits the current requirements: an
      // unreadable/stale Issue must block the merge rather than silently reuse an
      // old approval.
      if (!requirements) {
        return {
          approved: false,
          reason: "Current requirements not provided; cannot verify approval against the session plan",
          sessionId,
          headSha: target.headSha,
        };
      }
      const curFp = computeRequirementFingerprint(
        requirements.title,
        requirements.body,
        // Clarifications are durable operator input from the plan; fall back to
        // the saved set when the caller only supplies GitHub Issue facts.
        requirements.clarifications ?? latestPlan.requirements.clarifications
      );
      if (curFp !== latestPlan.requirements.fingerprint) {
        return {
          approved: false,
          reason: `Requirements changed since plan was created`,
          sessionId,
          headSha: target.headSha,
        };
      }
    }

    const tasks = this.getTasksForSession(sessionId)
      .filter(
        (t): t is DecisionReviewTask =>
          t.kind === "review" &&
          t.target.repository === target.repository &&
          t.target.prNumber === target.prNumber &&
          t.target.headSha === target.headSha,
      )
      .sort((a, b) => b.createdAtMs - a.createdAtMs || b.revision - a.revision);

    const task = tasks[0];
    if (!task) {
      return {
        approved: false,
        reason: `No review task found for target PR #${target.prNumber} @ ${target.headSha}`,
        headSha: target.headSha,
        sessionId,
      };
    }

    if (latestPlan !== null) {
      const reviewCtx = this.store.getContext(task.id);
      if (
        !reviewCtx ||
        reviewCtx.strategy !== "materialized" ||
        !reviewCtx.plan ||
        reviewCtx.plan.taskId !== latestPlan.taskId ||
        reviewCtx.plan.revision !== latestPlan.revision
      ) {
        return {
          approved: false,
          reason: `Review was evaluated against plan revision ${reviewCtx && reviewCtx.strategy === "materialized" ? (reviewCtx.plan?.revision ?? "none") : "none"}, but latest plan is revision ${latestPlan.revision} (${latestPlan.taskId})`,
          taskId: task.id,
          sessionId,
          headSha: target.headSha,
        };
      }
    }

    if (task.status !== "completed") {
      return {
        approved: false,
        reason: `Review task ${task.id} is not completed (status: ${task.status})`,
        taskId: task.id,
        sessionId,
        headSha: target.headSha,
      };
    }

    const result = this.store.getResult(task.id);
    if (!result) {
      return {
        approved: false,
        reason: `No result found for completed review task ${task.id}`,
        taskId: task.id,
        sessionId,
        headSha: target.headSha,
      };
    }

    const approved = isDecisionReviewApproved(task, result, {
      sessionId,
      repository: target.repository,
      prNumber: target.prNumber,
      headSha: target.headSha,
    });

    if (approved) {
      return {
        approved: true,
        reason: "Review approved",
        taskId: task.id,
        sessionId,
        headSha: target.headSha,
        verdict: "approve",
      };
    }

    const reviewResult = result.kind === "review" ? result : undefined;
    return {
      approved: false,
      reason: `Review is not approved (task status: ${task.status}, verdict: ${reviewResult?.verdict ?? "unknown"})`,
      taskId: task.id,
      sessionId,
      headSha: target.headSha,
      verdict: reviewResult?.verdict,
    };
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

  async putTaskContext(taskId: string, context: DecisionContextBundle): Promise<DecisionContextBundle> {
    const parsed = parseDecisionContextBundle(context);
    return await this.store.transaction((draft) => {
      const task = draft.tasks[taskId];
      if (!task) throw new DecisionNotFoundError(`Task "${taskId}" not found`);

      const session = draft.sessions[task.sessionId];
      if (!session) throw new DecisionNotFoundError(`Session "${task.sessionId}" not found`);

      validateDecisionContextForTask(parsed, task, session);

      draft.contexts[taskId] = parsed;
      return parsed;
    });
  }

  getTaskContext(taskId: string): DecisionContextBundle | null {
    return this.store.getContext(taskId);
  }

  async getNextTask(): Promise<NextTaskResponse | null> {
    // Selection is read-only. Only the work-aware coordinator delegates fenced reclaim.
    // Stable selection: pending task in active session, sorted by createdAtMs ascending, then ID
    const executions = this.store.getState().executions;
    const candidates = this.store
      .getAllTasks()
      .filter((t) => {
        if (t.status !== "pending" || executions?.[t.id]?.blocked) return false;
        const s = this.store.getSession(t.sessionId);
        return s !== null && (s.status === "active" || s.status === "broken-binding");
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
      const task = draft.tasks[taskId];
      if (!task) throw new DecisionNotFoundError(`Task "${taskId}" not found`);

      const session = draft.sessions[task.sessionId];
      if (!session) throw new DecisionNotFoundError(`Session "${task.sessionId}" not found`);
      if (session.status !== "active" && session.status !== "broken-binding") {
        throw new DecisionConflictError(`Cannot claim task for session in status "${session.status}"`);
      }

      const now = this.clock();

      // An unsettled lease remains owned until explicit fenced reclaim/cancellation, even after expiry.
      for (const otherTask of Object.values(draft.tasks)) {
        if (
          otherTask.sessionId === task.sessionId &&
          otherTask.id !== taskId &&
          (otherTask.status === "claimed" || otherTask.status === "running") &&
          otherTask.lease
        ) {
          throw new DecisionConflictError(
            `Session "${task.sessionId}" already has an actively executing task "${otherTask.id}" under lease`
          );
        }
      }

      if (task.status !== "pending") {
        throw new DecisionConflictError(`Task "${taskId}" is in status "${task.status}" and cannot be claimed`);
      }

      const execution = draft.executions?.[taskId];
      if (execution?.blocked) throw new DecisionConflictError(`Execution blocked: ${execution.blocked.reason}`);
      if (!execution) this.writeExecution(draft, taskId, { revision: task.revision,
        startedAtMs: now, lastProgressAtMs: now, deadlineAtMs: now + DECISION_PROGRESS_TIMEOUT_MS,
        phase: "claimed", responseLength: 0, recoveryAttempts: 0, blocked: null });
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
      if (!draft.claimBindingGenerations) {
        (draft as { claimBindingGenerations: Record<string, number> }).claimBindingGenerations = {};
      }
      draft.claimBindingGenerations[taskId] = session.bindingGeneration;

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

      const session = draft.sessions[task.sessionId];
      const claimBindingGen = draft.claimBindingGenerations?.[taskId];
      if (session && claimBindingGen !== undefined && session.bindingGeneration !== claimBindingGen) {
        throw new DecisionConflictError(
          `Task claim belongs to stale binding generation ${claimBindingGen}, but session is at generation ${session.bindingGeneration}`
        );
      }

      if (draft.executions?.[taskId]?.blocked) throw new DecisionConflictError("Execution is blocked");

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
    params: { owner: string; token: string; generation: number; ttlMs?: number | undefined; progress?: { phase: string; responseLength: number } | undefined }
  ): Promise<HeartbeatTaskResponse> {
    if (this.authorizeExecution) {
      const task = this.store.getTask(taskId);
      if (task && this.authorizeExecution && !await this.authorizeExecution(task)) throw new DecisionConflictError("Execution target is no longer current");
    }
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

      const session = draft.sessions[task.sessionId];
      const claimBindingGen = draft.claimBindingGenerations?.[taskId];
      if (session && claimBindingGen !== undefined && session.bindingGeneration !== claimBindingGen) {
        throw new DecisionConflictError(
          `Task claim belongs to stale binding generation ${claimBindingGen}, but session is at generation ${session.bindingGeneration}`
        );
      }

      if (draft.executions?.[taskId]?.blocked) throw new DecisionConflictError("Execution is blocked");

      const now = this.clock();
      if (now >= task.lease.expiresAtMs) {
        throw new DecisionConflictError("Claim lease has already expired");
      }

      if (!draft.executions?.[taskId]) this.writeExecution(draft, taskId, {
        revision: task.revision, startedAtMs: now, lastProgressAtMs: now,
        deadlineAtMs: now + DECISION_PROGRESS_TIMEOUT_MS, phase: "unknown", responseLength: 0,
        recoveryAttempts: 0, blocked: null,
      });
      const execution = draft.executions?.[taskId];
      if (execution?.blocked) throw new DecisionConflictError(`Execution blocked: ${execution.blocked.reason}`);
      if (execution && now > execution.deadlineAtMs) throw new DecisionConflictError("Execution progress deadline exceeded; lease cannot renew");
      const progress = params.progress;
      if (progress && (!(DECISION_EXECUTION_PHASES.includes(progress.phase) || progress.phase === "rebind_submitting") || !Number.isSafeInteger(progress.responseLength) || progress.responseLength < 0)) {
        throw new DecisionValidationError("Invalid execution progress");
      }
      if (execution && progress) {
        // Phase rank only increases within a task; repeated navigation/heartbeat isn't progress.
        const advanced = DECISION_EXECUTION_PHASES.indexOf(progress.phase) > DECISION_EXECUTION_PHASES.indexOf(execution.phase);
        const grew = progress.phase === "waiting_response" && progress.responseLength > execution.responseLength;
        this.writeExecution(draft, taskId, { ...execution,
          phase: advanced ? progress.phase : execution.phase,
          responseLength: Math.max(execution.responseLength, progress.responseLength),
          ...(advanced || grew ? { lastProgressAtMs: now, deadlineAtMs: now + DECISION_PROGRESS_TIMEOUT_MS } : {}) });
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
    // Receipt readback remains idempotent even after the external target changes.
    if (this.authorizeExecution && !this.store.getReceipt(taskId)) {
      const task = this.store.getTask(taskId);
      if (task && !await this.authorizeExecution(task)) throw new DecisionConflictError("Execution target is no longer current");
    }
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

      const session = draft.sessions[task.sessionId];
      const claimBindingGen = draft.claimBindingGenerations?.[taskId];
      if (session && claimBindingGen !== undefined && session.bindingGeneration !== claimBindingGen) {
        throw new DecisionConflictError(
          `Task claim belongs to stale binding generation ${claimBindingGen}, but session is at generation ${session.bindingGeneration}`
        );
      }

      if (draft.executions?.[taskId]?.blocked) throw new DecisionConflictError("Execution is blocked");

      const now = this.clock();
      if (now >= task.lease.expiresAtMs) {
        throw new DecisionConflictError("Claim lease has already expired");
      }

      validateDecisionResultForTask(task, params.result);

      const completed = completeDecisionTask(task, params.result, task.lease, now);
      draft.tasks[taskId] = completed;
      delete draft.claimBindingGenerations?.[taskId];
      draft.results[taskId] = params.result;

      if (task.kind === "plan" && params.result.kind === "plan") {
        const planRecord = draft.plans[taskId];
        if (planRecord) {
          draft.plans[taskId] = {
            ...planRecord,
            status: "completed",
            result: params.result,
            updatedAtMs: now,
          };
        }
      }

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

      const session = draft.sessions[task.sessionId];
      const claimBindingGen = draft.claimBindingGenerations?.[taskId];
      if (session && claimBindingGen !== undefined && session.bindingGeneration !== claimBindingGen) {
        throw new DecisionConflictError(
          `Task claim belongs to stale binding generation ${claimBindingGen}, but session is at generation ${session.bindingGeneration}`
        );
      }

      if (draft.executions?.[taskId]?.blocked) throw new DecisionConflictError("Execution is blocked");

      const now = this.clock();
      if (now >= task.lease.expiresAtMs) {
        throw new DecisionConflictError("Claim lease has already expired");
      }

      const failed = failDecisionTask(task, task.lease, now);
      draft.tasks[taskId] = failed;
      delete draft.claimBindingGenerations?.[taskId];

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

      if (task.kind === "plan") {
        const planRecord = draft.plans[taskId];
        if (planRecord) {
          draft.plans[taskId] = {
            ...planRecord,
            status: "failed",
            updatedAtMs: now,
          };
        }
      }

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

      if (task.kind === "plan") {
        const planRecord = draft.plans[taskId];
        if (planRecord) {
          draft.plans[taskId] = {
            ...planRecord,
            status: "superseded",
            updatedAtMs: now,
          };
        }
      }

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

      if (task.kind === "plan") {
        const planRecord = draft.plans[taskId];
        if (planRecord) {
          draft.plans[taskId] = {
            ...planRecord,
            status: "superseded",
            updatedAtMs: now,
          };
        }
      }

      return updated;
    });
  }

  getPlan(taskId: string): DecisionPlanRecord | null {
    return this.store.getPlan(taskId);
  }

  getLatestPlan(sessionId: string): DecisionPlanRecord | null {
    return this.store.getLatestPlanForSession(sessionId);
  }

  getLatestPlanForSession(sessionId: string): DecisionPlanRecord | null {
    return this.store.getLatestPlanForSession(sessionId);
  }

  getAllPlans(): DecisionPlanRecord[] {
    return this.store.getAllPlans();
  }

  async markPlanPublished(
    taskId: string,
    published: { commentId?: number | string | undefined; publishedAtMs?: number | undefined } = {}
  ): Promise<DecisionPlanRecord> {
    if (
      published.commentId === undefined ||
      published.commentId === null ||
      (typeof published.commentId !== "number" && typeof published.commentId !== "string") ||
      (typeof published.commentId === "string" && published.commentId.trim() === "") ||
      (typeof published.commentId === "number" && (!Number.isFinite(published.commentId) || published.commentId <= 0))
    ) {
      throw new DecisionValidationError("markPlanPublished requires valid non-empty commentId");
    }

    return await this.store.transaction((draft) => {
      const planRecord = draft.plans[taskId];
      if (!planRecord) {
        throw new DecisionNotFoundError(`Plan record for task "${taskId}" not found`);
      }
      const now = this.clock();
      const updated: DecisionPlanRecord = {
        ...planRecord,
        publishedCommentId: published.commentId ?? null,
        publishedAtMs: published.publishedAtMs !== undefined ? published.publishedAtMs : now,
        updatedAtMs: now,
      };
      draft.plans[taskId] = updated;
      return updated;
    });
  }

  verifyPlanEligibility(
    sessionId: string,
    requirements?: { readonly title: string; readonly body: string; readonly clarifications?: readonly string[] | undefined } | undefined
  ): PlanningEligibilityResult {
    const planRecord = this.store.getLatestPlanForSession(sessionId);
    if (!planRecord) {
      return {
        eligible: false,
        sessionId,
        reason: "no_plan",
      };
    }

    if (planRecord.status !== "completed") {
      return {
        eligible: false,
        sessionId,
        reason: `plan_status_${planRecord.status}`,
      };
    }

    const result = planRecord.result;
    if (!result || result.kind !== "plan") {
      return {
        eligible: false,
        sessionId,
        reason: "no_plan_result",
      };
    }

    if (result.verdict !== "ready") {
      return {
        eligible: false,
        sessionId,
        reason: `verdict_${result.verdict}`,
        verdict: result.verdict,
      };
    }

    // Fail closed if verdict is ready but clarifications contains items
    if (result.content.clarifications && result.content.clarifications.length > 0) {
      return {
        eligible: false,
        sessionId,
        reason: "unresolved_clarifications",
        verdict: "ready",
      };
    }

    if (requirements) {
      // The durable plan persists the authoritative answered clarifications (they
      // are operator input, not GitHub facts). Callers supply the current Issue
      // title/body; when they do not carry clarifications, fall back to the saved
      // set so the clarification loop does not produce a permanent fingerprint
      // mismatch. Explicit clarifications still take precedence.
      const clarifications = requirements.clarifications ?? planRecord.requirements.clarifications;
      const currentFingerprint = computeRequirementFingerprint(
        requirements.title,
        requirements.body,
        clarifications
      );
      if (currentFingerprint !== planRecord.requirements.fingerprint) {
        return {
          eligible: false,
          sessionId,
          reason: "requirements_changed",
          verdict: "ready",
          fingerprint: planRecord.requirements.fingerprint,
        };
      }
    }

    if (planRecord.publishedCommentId === null) {
      return {
        eligible: false,
        sessionId,
        reason: "plan_not_published_to_github",
        verdict: "ready",
      };
    }

    return {
      eligible: true,
      sessionId,
      verdict: "ready",
      fingerprint: planRecord.requirements.fingerprint,
      publishedCommentId: planRecord.publishedCommentId,
      plan: {
        taskId: planRecord.taskId,
        revision: planRecord.revision,
        plan: result.content.plan,
        acceptanceCriteria: result.content.acceptanceCriteria,
        risks: result.content.risks,
        clarifications: result.content.clarifications,
      },
    };
  }
}
