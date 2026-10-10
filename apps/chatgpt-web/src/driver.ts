/**
 * Decision Tab Driver.
 * Manages the client-side execution loop: polling, claim, lease heartbeat,
 * checkpointing, task execution via ChatGptWebAdapter, and receipt submission.
 */
import {
  type DecisionTask,
  type DecisionSession,
  type DecisionLease,
  type DecisionContextBundle,
  type DecisionResult,
} from "@symphony/domain/decision";
import {
  executeTaskWithAdapter,
  type DecisionTaskController,
  type TaskExecutionOutcome,
  type SubmissionReceipt,
  type DecisionTaskFailure,
} from "@symphony/decision/adapter";
import { type BridgeTransport } from "./transport";
import {
  type CheckpointStore,
  type DriverCheckpoint,
  type DriverStep,
  GmCheckpointStore,
  isCheckpointExpired,
} from "./checkpoint";
import { ChatGptWebAdapter, type ChatGptWebAdapterOptions } from "./adapter";

export interface DecisionTabDriverOptions {
  readonly transport: BridgeTransport;
  readonly checkpointStore?: CheckpointStore | undefined;
  readonly adapter?: ChatGptWebAdapter | undefined;
  readonly adapterOptions?: ChatGptWebAdapterOptions | undefined;
  readonly ownerId?: string | undefined;
  readonly heartbeatIntervalMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly defaultClaimTtlMs?: number | undefined;
  readonly onError?: ((error: Error) => void) | undefined;
}

export class DecisionTabDriver implements DecisionTaskController {
  readonly transport: BridgeTransport;
  readonly checkpointStore: CheckpointStore;
  readonly adapter: ChatGptWebAdapter;
  readonly ownerId: string;
  readonly heartbeatIntervalMs: number;
  readonly pollIntervalMs: number;
  readonly defaultClaimTtlMs: number;
  readonly onError?: ((error: Error) => void) | undefined;

  private isRunning = false;
  private activeAbortController: AbortController | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private activeTask: DecisionTask | null = null;
  private activeSession: DecisionSession | null = null;
  private activeLease: DecisionLease | null = null;

  constructor(options: DecisionTabDriverOptions) {
    this.transport = options.transport;
    this.checkpointStore = options.checkpointStore ?? new GmCheckpointStore();
    this.adapter = options.adapter ?? new ChatGptWebAdapter(options.adapterOptions);
    this.ownerId = options.ownerId ?? `chatgpt-web-driver-${Math.random().toString(36).slice(2, 8)}`;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 20_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.defaultClaimTtlMs = options.defaultClaimTtlMs ?? 120_000;
    this.onError = options.onError;
  }

  // --- DecisionTaskController implementation for executeTaskWithAdapter ---

  async startTask(
    taskId: string,
    params: { owner: string; token: string; generation: number }
  ): Promise<unknown> {
    const cp = this.checkpointStore.get();
    if (
      cp &&
      cp.taskId === taskId &&
      (cp.step === "started" || cp.step === "waiting_response" || cp.step === "result_extracted")
    ) {
      // Idempotent start recovery: task was already started in this lease attempt
      return { taskId, status: "running" };
    }

    try {
      const res = await this.transport.request(
        "POST",
        `/v1/tasks/${encodeURIComponent(taskId)}/start`,
        params
      );
      this.updateCheckpointStep("started");
      return res;
    } catch (err: unknown) {
      // If error is 409 and task is already running under the same lease credentials, treat as idempotent success
      const taskRes = await this.transport
        .request<{ task: DecisionTask }>("GET", `/v1/tasks/${encodeURIComponent(taskId)}`)
        .catch(() => null);
      if (
        taskRes?.task?.status === "running" &&
        taskRes.task.lease?.owner === params.owner &&
        taskRes.task.lease?.token === params.token &&
        taskRes.task.lease?.generation === params.generation
      ) {
        this.updateCheckpointStep("started");
        return { taskId, status: "running" };
      }
      throw err;
    }
  }

  async submitResult(
    taskId: string,
    params: { owner: string; token: string; generation: number; result: DecisionResult }
  ): Promise<{ receipt: SubmissionReceipt; result: DecisionResult; superseded: boolean }> {
    // Persist candidate result before making network submission call
    this.updateCheckpointStep("result_extracted", params.result);

    const res = await this.transport.request<{
      receipt: SubmissionReceipt;
      result: DecisionResult;
      superseded: boolean;
    }>("POST", `/v1/tasks/${encodeURIComponent(taskId)}/result`, params);

    // Upon confirmed receipt from bridge, checkpoint can safely be cleared
    this.checkpointStore.delete();
    return res;
  }

  async submitFailure(
    taskId: string,
    params: {
      owner: string;
      token: string;
      generation: number;
      error: string;
      details?: unknown;
      retryable?: boolean;
    }
  ): Promise<{ receipt: SubmissionReceipt; failure: DecisionTaskFailure; superseded: boolean }> {
    const res = await this.transport.request<{
      receipt: SubmissionReceipt;
      failure: DecisionTaskFailure;
      superseded: boolean;
    }>("POST", `/v1/tasks/${encodeURIComponent(taskId)}/fail`, params);

    this.checkpointStore.delete();
    return res;
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
    const res = await this.transport.request<{ session: DecisionSession }>(
      "PUT",
      `/v1/sessions/${encodeURIComponent(sessionId)}/binding`,
      params
    );
    return res.session;
  }

  async rebindSession(
    sessionId: string,
    params: {
      adapter: string;
      externalSessionRef: string;
      resumeUri: string | null;
      expectedGeneration: number;
      operationKey?: string;
      owner?: string | undefined;
      token?: string | undefined;
      generation?: number | undefined;
    }
  ): Promise<DecisionSession> {
    const res = await this.transport.request<{ session: DecisionSession }>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/rebind`,
      params
    );
    return res.session;
  }

  // --- Driver orchestration methods ---

  async fetchContext(taskId: string): Promise<DecisionContextBundle> {
    const res = await this.transport.request<{ context: DecisionContextBundle }>(
      "GET",
      `/v1/tasks/${encodeURIComponent(taskId)}/context`
    );
    return res.context;
  }

  private saveCheckpoint(
    step: DriverStep,
    task: DecisionTask,
    session: DecisionSession,
    lease: DecisionLease,
    candidateResult?: unknown
  ): void {
    const cp: DriverCheckpoint = {
      schemaVersion: 1,
      tabId: this.checkpointStore.tabId,
      taskId: task.id,
      sessionId: session.id,
      leaseOwner: lease.owner,
      leaseToken: lease.token,
      leaseGeneration: lease.generation,
      leaseExpiresAtMs: lease.expiresAtMs,
      bindingGeneration: session.bindingGeneration,
      step,
      attemptId: `${task.id}-${lease.generation}`,
      savedAtMs: Date.now(),
      ...(candidateResult !== undefined ? { candidateResult } : {}),
    };
    this.checkpointStore.set(cp);
  }

  private updateCheckpointStep(step: DriverStep, candidateResult?: unknown): void {
    if (!this.activeTask || !this.activeSession || !this.activeLease) {
      const existing = this.checkpointStore.get();
      if (existing) {
        this.checkpointStore.set({
          ...existing,
          step,
          savedAtMs: Date.now(),
          ...(candidateResult !== undefined ? { candidateResult } : {}),
        });
      }
      return;
    }
    this.saveCheckpoint(step, this.activeTask, this.activeSession, this.activeLease, candidateResult);
  }

  startHeartbeat(task: DecisionTask, lease: DecisionLease, onExpired?: () => void): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.transport.request(
          "POST",
          `/v1/tasks/${encodeURIComponent(task.id)}/heartbeat`,
          {
            owner: lease.owner,
            token: lease.token,
            generation: lease.generation,
            ttlMs: this.defaultClaimTtlMs,
          }
        );
      } catch {
        // Heartbeat failed: lease lost, expired, or superseded
        this.stopHeartbeat();
        if (onExpired) onExpired();
      }
    }, this.heartbeatIntervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async claimNextTask(): Promise<{ task: DecisionTask; session: DecisionSession; lease: DecisionLease } | null> {
    const next = await this.transport.request<{ task: DecisionTask; session: DecisionSession } | null>(
      "GET",
      "/v1/tasks/next",
      undefined,
      { allow204: true }
    );
    if (!next) return null;

    const claimRes = await this.transport.request<{
      task: DecisionTask;
      session: DecisionSession;
      lease: DecisionLease;
    }>("POST", `/v1/tasks/${encodeURIComponent(next.task.id)}/claim`, {
      owner: this.ownerId,
      ttlMs: this.defaultClaimTtlMs,
    });

    return claimRes;
  }

  async resumeCheckpointIfAvailable(): Promise<TaskExecutionOutcome | null> {
    const cp = this.checkpointStore.get();
    if (!cp) return null;

    // Checkpoint tab ownership validation
    if (cp.tabId !== this.checkpointStore.tabId) {
      return null;
    }

    if (isCheckpointExpired(cp, Date.now())) {
      this.checkpointStore.delete();
      return null;
    }

    // Verify task status and active lease with bridge via heartbeat
    try {
      await this.transport.request(
        "POST",
        `/v1/tasks/${encodeURIComponent(cp.taskId)}/heartbeat`,
        {
          owner: cp.leaseOwner,
          token: cp.leaseToken,
          generation: cp.leaseGeneration,
          ttlMs: this.defaultClaimTtlMs,
        }
      );
    } catch {
      // Stale or expired lease
      this.checkpointStore.delete();
      return null;
    }

    const taskRes = await this.transport.request<{ task: DecisionTask }>(
      "GET",
      `/v1/tasks/${encodeURIComponent(cp.taskId)}`
    );
    const sessionRes = await this.transport.request<{ session: DecisionSession }>(
      "GET",
      `/v1/sessions/${encodeURIComponent(cp.sessionId)}`
    );

    // 1. If task is already completed on the bridge, fetch and return receipt idempotently
    if (taskRes.task.status === "completed") {
      try {
        const receiptRes = await this.transport.request<{ receipt: SubmissionReceipt }>(
          "GET",
          `/v1/tasks/${encodeURIComponent(cp.taskId)}/receipt`
        );
        this.checkpointStore.delete();
        return {
          status: "completed",
          result: (cp.candidateResult ?? receiptRes.receipt.payload) as DecisionResult,
          receipt: receiptRes.receipt,
          superseded: false,
          session: sessionRes.session,
        };
      } catch {
        // Receipt fetch failed, proceed to normal flow
      }
    }

    // 2. If candidateResult was extracted, idempotently re-submit result
    if (cp.candidateResult && cp.step === "result_extracted") {
      const submitRes = await this.submitResult(cp.taskId, {
        owner: cp.leaseOwner,
        token: cp.leaseToken,
        generation: cp.leaseGeneration,
        result: cp.candidateResult as DecisionResult,
      });
      return {
        status: "completed",
        result: submitRes.result,
        receipt: submitRes.receipt,
        superseded: submitRes.superseded,
        session: sessionRes.session,
      };
    }

    const lease: DecisionLease = {
      owner: cp.leaseOwner,
      token: cp.leaseToken,
      generation: cp.leaseGeneration,
      expiresAtMs: cp.leaseExpiresAtMs,
    };

    const context = await this.fetchContext(taskRes.task.id);

    return await this.executeClaimedTask(taskRes.task, sessionRes.session, lease, context);
  }

  async executeClaimedTask(
    task: DecisionTask,
    session: DecisionSession,
    lease: DecisionLease,
    context: DecisionContextBundle
  ): Promise<TaskExecutionOutcome> {
    this.activeTask = task;
    this.activeSession = session;
    this.activeLease = lease;
    this.activeAbortController = new AbortController();
    const signal = this.activeAbortController.signal;

    // Start background lease heartbeat
    this.startHeartbeat(task, lease, () => {
      this.activeAbortController?.abort();
    });

    // Save checkpoint if not already saved
    const existing = this.checkpointStore.get();
    if (!existing || existing.taskId !== task.id) {
      this.saveCheckpoint("claimed", task, session, lease);
    }

    try {
      const outcome = await executeTaskWithAdapter({
        controller: this,
        adapter: this.adapter,
        task,
        session,
        lease,
        context,
        signal,
        operationKeyPrefix: `driver:${this.ownerId}`,
      });

      // Clear checkpoint only on terminal success or recorded failure
      this.checkpointStore.delete();
      return outcome;
    } catch (err: unknown) {
      // If error is an abort (e.g. from page navigation or timeout), preserve checkpoint for reload recovery
      if (signal.aborted) {
        throw err;
      }
      // For other unhandled fatal errors, clean up
      this.checkpointStore.delete();
      throw err;
    } finally {
      this.stopHeartbeat();
      this.activeAbortController = null;
      this.activeTask = null;
      this.activeSession = null;
      this.activeLease = null;
    }
  }

  async runOnce(): Promise<TaskExecutionOutcome | null> {
    // 1. Check for recoverable checkpoint first
    const resumed = await this.resumeCheckpointIfAvailable();
    if (resumed) return resumed;

    // 2. Poll & claim next task
    const claimed = await this.claimNextTask();
    if (!claimed) return null;

    // 3. Fetch context
    const context = await this.fetchContext(claimed.task.id);

    // 4. Execute
    return await this.executeClaimedTask(claimed.task, claimed.session, claimed.lease, context);
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    while (this.isRunning) {
      try {
        await this.runOnce();
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (this.onError) {
          this.onError(error);
        }
      }
      if (!this.isRunning) break;
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  stop(): void {
    this.isRunning = false;
    this.stopHeartbeat();
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.activeTask = null;
    this.activeSession = null;
    this.activeLease = null;
  }
}
