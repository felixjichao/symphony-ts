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
import { BridgeHttpError, type BridgeTransport } from "./transport";
import {
  type CheckpointStore,
  type DriverCheckpoint,
  type DriverStep,
  GmCheckpointStore,
  isCheckpointExpired,
} from "./checkpoint";
import { ChatGptWebAdapter, type ChatGptWebAdapterOptions } from "./adapter";
import { findStopButton, getAllAssistantTurns } from "./probes";
import { canonicalJsonEqual } from "./canonical-json";

function isValidMatchingResultReceipt(
  receipt: SubmissionReceipt,
  lease: { owner: string; token: string; generation: number },
  expectedResult?: DecisionResult | null
): boolean {
  if (!receipt || receipt.type !== "result") return false;
  if (receipt.claimOwner !== lease.owner) return false;
  if (receipt.claimToken !== lease.token) return false;
  if (receipt.claimGeneration !== lease.generation) return false;
  if (expectedResult) {
    if (!canonicalJsonEqual(receipt.payload, expectedResult)) return false;
  }
  return true;
}

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

    if (this.adapter instanceof ChatGptWebAdapter) {
      this.adapter.setStepListener((step, meta) => {
        this.updateCheckpointStep(step, meta);
      });
    }
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
    this.updateCheckpointStep("result_extracted", { candidateResult: params.result });

    try {
      const res = await this.transport.request<{
        receipt: SubmissionReceipt;
        result: DecisionResult;
        superseded: boolean;
      }>("POST", `/v1/tasks/${encodeURIComponent(taskId)}/result`, params);

      // Upon confirmed valid result receipt from bridge, checkpoint can safely be cleared
      if (res.receipt?.type === "result" && !res.superseded) {
        this.checkpointStore.delete();
      }
      return res;
    } catch (err: unknown) {
      // In case of network packet loss on return, query authoritative receipt before failing
      try {
        const receiptRes = await this.transport.request<{ receipt: SubmissionReceipt }>(
          "GET",
          `/v1/tasks/${encodeURIComponent(taskId)}/receipt`
        );
        if (receiptRes?.receipt) {
          const receipt = receiptRes.receipt;
          const isSuperseded = typeof receipt.supersededAtMs === "number" && receipt.supersededAtMs > 0;
          if (
            isValidMatchingResultReceipt(receipt, params, params.result) &&
            !isSuperseded
          ) {
            this.checkpointStore.delete();
            return {
              receipt,
              result: receipt.payload as DecisionResult,
              superseded: false,
            };
          }
          if (receipt.type === "result" && !isValidMatchingResultReceipt(receipt, params, params.result)) {
            // Explicit conflict: bridge already accepted a different result receipt
            throw new BridgeHttpError(
              `Conflict: bridge already accepted a different result receipt for task "${taskId}"`,
              "conflict",
              409
            );
          }
        }
      } catch (receiptErr: unknown) {
        if (receiptErr instanceof BridgeHttpError && receiptErr.status === 409) {
          throw receiptErr;
        }
        // Receipt fetch also failed (transient network failure), keep candidateResult in checkpoint for retry
      }
      throw err;
    }
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
    meta?: {
      candidateResult?: unknown;
      baselineCount?: number;
      targetUri?: string;
      targetConvId?: string | null;
    }
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
      ...(meta?.candidateResult !== undefined ? { candidateResult: meta.candidateResult } : {}),
      ...(meta?.baselineCount !== undefined ? { baselineCount: meta.baselineCount } : {}),
      ...(meta?.targetUri !== undefined ? { targetUri: meta.targetUri } : {}),
      ...(meta?.targetConvId !== undefined ? { targetConvId: meta.targetConvId } : {}),
    };
    this.checkpointStore.set(cp);
  }

  private updateCheckpointStep(
    step: DriverStep,
    meta?: {
      candidateResult?: unknown;
      baselineCount?: number;
      targetUri?: string;
      targetConvId?: string | null;
    }
  ): void {
    const existing = this.checkpointStore.get();
    if (existing) {
      this.checkpointStore.set({
        ...existing,
        step,
        savedAtMs: Date.now(),
        ...(meta?.candidateResult !== undefined ? { candidateResult: meta.candidateResult } : {}),
        ...(meta?.baselineCount !== undefined ? { baselineCount: meta.baselineCount } : {}),
        ...(meta?.targetUri !== undefined ? { targetUri: meta.targetUri } : {}),
        ...(meta?.targetConvId !== undefined ? { targetConvId: meta.targetConvId } : {}),
      });
      return;
    }
    if (this.activeTask && this.activeSession && this.activeLease) {
      this.saveCheckpoint(step, this.activeTask, this.activeSession, this.activeLease, meta);
    }
  }

  startHeartbeat(task: DecisionTask, lease: DecisionLease, onExpired?: () => void): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      try {
        const hbRes = await this.transport.request<{ expiresAtMs: number; ttlMs: number }>(
          "POST",
          `/v1/tasks/${encodeURIComponent(task.id)}/heartbeat`,
          {
            owner: lease.owner,
            token: lease.token,
            generation: lease.generation,
            ttlMs: this.defaultClaimTtlMs,
          }
        );
        if (hbRes && typeof hbRes.expiresAtMs === "number") {
          const cp = this.checkpointStore.get();
          if (cp && cp.taskId === task.id) {
            this.checkpointStore.set({
              ...cp,
              leaseExpiresAtMs: hbRes.expiresAtMs,
              savedAtMs: Date.now(),
            });
          }
          if (this.activeLease && this.activeLease.owner === lease.owner) {
            (this.activeLease as { expiresAtMs: number }).expiresAtMs = hbRes.expiresAtMs;
          }
        }
      } catch (hbErr: unknown) {
        if (
          hbErr instanceof BridgeHttpError &&
          (hbErr.status === 404 || hbErr.status === 409 || hbErr.status === 410)
        ) {
          // Authoritative lease lost or superseded on bridge
          this.stopHeartbeat();
          if (onExpired) onExpired();
          return;
        }
        // Transient network failure during heartbeat:
        // Only stop heartbeat and abort if local lease has actually expired
        const currentExpiry = this.activeLease?.expiresAtMs ?? lease.expiresAtMs;
        if (Date.now() >= currentExpiry) {
          this.stopHeartbeat();
          if (onExpired) onExpired();
        }
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

    // 1. Check task status and session on bridge FIRST without requiring heartbeat/lease renewal!
    let taskRes: { task: DecisionTask } | null = null;
    try {
      taskRes = await this.transport.request<{ task: DecisionTask }>(
        "GET",
        `/v1/tasks/${encodeURIComponent(cp.taskId)}`
      );
    } catch (err: unknown) {
      if (err instanceof BridgeHttpError && (err.status === 404 || err.status === 410)) {
        this.checkpointStore.delete();
        return null;
      }
      if (err instanceof BridgeHttpError && err.status === 409) {
        this.checkpointStore.delete();
        return null;
      }
      // Transient network or server error: preserve checkpoint and throw to allow retry
      throw err;
    }

    let sessionRes: { session: DecisionSession } | null = null;
    try {
      sessionRes = await this.transport.request<{ session: DecisionSession }>(
        "GET",
        `/v1/sessions/${encodeURIComponent(cp.sessionId)}`
      );
    } catch (err: unknown) {
      if (err instanceof BridgeHttpError && (err.status === 404 || err.status === 410)) {
        this.checkpointStore.delete();
        return null;
      }
      if (err instanceof BridgeHttpError && err.status === 409) {
        this.checkpointStore.delete();
        return null;
      }
      // Transient network or server error: preserve checkpoint and throw to allow retry
      throw err;
    }

    if (taskRes?.task?.status === "completed") {
      const receiptRes = await this.transport.request<{ receipt: SubmissionReceipt }>(
        "GET",
        `/v1/tasks/${encodeURIComponent(cp.taskId)}/receipt`
      );
      if (receiptRes?.receipt) {
        const receipt = receiptRes.receipt;
        const isSuperseded = typeof receipt.supersededAtMs === "number" && receipt.supersededAtMs > 0;
        if (
          isValidMatchingResultReceipt(
            receipt,
            { owner: cp.leaseOwner, token: cp.leaseToken, generation: cp.leaseGeneration },
            cp.candidateResult as DecisionResult | undefined
          )
        ) {
          this.checkpointStore.delete();
          return {
            status: "completed",
            result: receipt.payload as DecisionResult,
            receipt,
            superseded: isSuperseded,
            session: sessionRes?.session ?? ({} as DecisionSession),
          };
        }
        if (isSuperseded) {
          this.checkpointStore.delete();
          return null;
        }
        if (
          cp.candidateResult &&
          receipt.type === "result" &&
          !isValidMatchingResultReceipt(
            receipt,
            { owner: cp.leaseOwner, token: cp.leaseToken, generation: cp.leaseGeneration },
            cp.candidateResult as DecisionResult
          )
        ) {
          // Explicit conflict: task completed on bridge with a different result payload!
          // Do NOT delete checkpoint, report conflict!
          throw new BridgeHttpError(
            `Conflict: task "${cp.taskId}" completed on bridge with a different result payload than candidate result`,
            "conflict",
            409
          );
        }
      }
    }

    if (taskRes?.task?.status === "failed") {
      const receiptRes = await this.transport
        .request<{ receipt: SubmissionReceipt }>("GET", `/v1/tasks/${encodeURIComponent(cp.taskId)}/receipt`)
        .catch(() => null);
      this.checkpointStore.delete();
      if (receiptRes?.receipt && receiptRes.receipt.type === "failure") {
        return {
          status: "failed",
          failure: receiptRes.receipt.payload as DecisionTaskFailure,
          receipt: receiptRes.receipt,
          superseded: typeof receiptRes.receipt.supersededAtMs === "number" && receiptRes.receipt.supersededAtMs > 0,
          session: sessionRes?.session ?? ({} as DecisionSession),
          error: new Error("Task failed on bridge"),
        };
      }
      return null;
    }

    if (taskRes?.task?.status === "superseded") {
      this.checkpointStore.delete();
      return null;
    }

    // 2. If candidateResult was extracted, idempotently re-submit result
    if (cp.candidateResult && (cp.step === "result_extracted" || cp.step === "waiting_response")) {
      try {
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
          session: sessionRes?.session ?? ({} as DecisionSession),
        };
      } catch (submitErr: unknown) {
        if (submitErr instanceof BridgeHttpError && submitErr.status === 409) {
          throw submitErr;
        }
        // Re-submission failed. Check whether bridge recorded it or if it failed/superseded
        const freshTask = await this.transport
          .request<{ task: DecisionTask }>("GET", `/v1/tasks/${encodeURIComponent(cp.taskId)}`)
          .catch(() => null);
        const receiptRes = await this.transport
          .request<{ receipt: SubmissionReceipt }>("GET", `/v1/tasks/${encodeURIComponent(cp.taskId)}/receipt`)
          .catch(() => null);

        if (receiptRes?.receipt) {
          const receipt = receiptRes.receipt;
          const isSuperseded = typeof receipt.supersededAtMs === "number" && receipt.supersededAtMs > 0;
          if (
            isValidMatchingResultReceipt(
              receipt,
              { owner: cp.leaseOwner, token: cp.leaseToken, generation: cp.leaseGeneration },
              cp.candidateResult as DecisionResult
            ) &&
            !isSuperseded
          ) {
            this.checkpointStore.delete();
            return {
              status: "completed",
              result: receipt.payload as DecisionResult,
              receipt,
              superseded: false,
              session: sessionRes?.session ?? ({} as DecisionSession),
            };
          }
          if (receipt.type === "failure" || freshTask?.task?.status === "failed") {
            this.checkpointStore.delete();
            return {
              status: "failed",
              failure: (receipt.type === "failure" ? receipt.payload : undefined) as DecisionTaskFailure,
              receipt,
              superseded: isSuperseded,
              session: sessionRes?.session ?? ({} as DecisionSession),
              error: submitErr instanceof Error ? submitErr : new Error(String(submitErr)),
            };
          }
          if (isSuperseded || freshTask?.task?.status === "superseded") {
            this.checkpointStore.delete();
            return null;
          }
          if (
            receipt.type === "result" &&
            !isValidMatchingResultReceipt(
              receipt,
              { owner: cp.leaseOwner, token: cp.leaseToken, generation: cp.leaseGeneration },
              cp.candidateResult as DecisionResult
            )
          ) {
            throw new BridgeHttpError(
              `Conflict: task "${cp.taskId}" already accepted a different result receipt than candidate result`,
              "conflict",
              409
            );
          }
        }
        // Transport error while task remains active; keep candidateResult in checkpoint for retry
        throw submitErr;
      }
    }

    // 3. For ongoing uncompleted execution, verify checkpoint expiry & lease validity via heartbeat
    if (isCheckpointExpired(cp, Date.now())) {
      this.checkpointStore.delete();
      return null;
    }

    let renewedExpiry = cp.leaseExpiresAtMs;
    try {
      const hbRes = await this.transport.request<{ expiresAtMs: number; ttlMs: number }>(
        "POST",
        `/v1/tasks/${encodeURIComponent(cp.taskId)}/heartbeat`,
        {
          owner: cp.leaseOwner,
          token: cp.leaseToken,
          generation: cp.leaseGeneration,
          ttlMs: this.defaultClaimTtlMs,
        }
      );
      if (hbRes && typeof hbRes.expiresAtMs === "number") {
        renewedExpiry = hbRes.expiresAtMs;
        this.checkpointStore.set({
          ...cp,
          leaseExpiresAtMs: renewedExpiry,
          savedAtMs: Date.now(),
        });
      }
    } catch (hbErr: unknown) {
      if (
        hbErr instanceof BridgeHttpError &&
        (hbErr.status === 404 || hbErr.status === 409 || hbErr.status === 410)
      ) {
        // Authoritative lease lost or superseded on bridge
        this.checkpointStore.delete();
        return null;
      }
      // Transient network or server error during heartbeat:
      // If local lease is still valid (not expired), do NOT delete checkpoint!
      if (isCheckpointExpired(cp, Date.now())) {
        this.checkpointStore.delete();
        return null;
      }
      // Local lease is unexpired: renewedExpiry stays cp.leaseExpiresAtMs
    }

    if (!taskRes?.task || !sessionRes?.session) {
      this.checkpointStore.delete();
      return null;
    }

    const lease: DecisionLease = {
      owner: cp.leaseOwner,
      token: cp.leaseToken,
      generation: cp.leaseGeneration,
      expiresAtMs: renewedExpiry,
    };

    // 4. Handle checkpoint steps
    if (cp.step === "navigating") {
      const win =
        (this.adapter instanceof ChatGptWebAdapter ? this.adapter.getWindow() : null) ??
        (globalThis as unknown as { window?: Window }).window;
      if (win && cp.targetUri && win.location && win.location.href !== cp.targetUri) {
        win.location.assign(cp.targetUri);
      }
    }

    if (cp.step === "prompt_submitting") {
      this.activeTask = taskRes.task;
      this.activeSession = sessionRes.session;
      this.activeLease = lease;
      this.activeAbortController = new AbortController();
      const signal = this.activeAbortController.signal;

      this.startHeartbeat(taskRes.task, lease, () => {
        this.activeAbortController?.abort();
      });

      try {
        const adapterWithProbes = this.adapter as unknown as {
          confirmPromptSubmitted?: (opts: { baselineCount: number; signal?: AbortSignal }) => Promise<boolean>;
          isPromptConfirmedSent?: (doc?: unknown, baselineCount?: number) => boolean;
        };
        let isConfirmedSent = false;
        if (typeof adapterWithProbes.confirmPromptSubmitted === "function") {
          isConfirmedSent = await adapterWithProbes.confirmPromptSubmitted({
            baselineCount: cp.baselineCount ?? 0,
            signal,
          }).catch(() => false);
        } else if (typeof adapterWithProbes.isPromptConfirmedSent === "function") {
          isConfirmedSent = adapterWithProbes.isPromptConfirmedSent(undefined, cp.baselineCount ?? 0);
        } else if (typeof (globalThis as unknown as { document?: Document }).document !== "undefined") {
          const doc = (globalThis as unknown as { document: Document }).document;
          const count = cp.baselineCount ?? 0;
          isConfirmedSent = findStopButton(doc) !== null || getAllAssistantTurns(doc).length > count;
        }

        if (isConfirmedSent) {
          this.updateCheckpointStep("waiting_response", { baselineCount: cp.baselineCount ?? 0 });
          return await this.resumeWaitingResponse(
            taskRes.task,
            sessionRes.session,
            lease,
            cp.baselineCount ?? 0,
            signal
          );
        } else {
          // Cannot confirm prompt was sent! Fail safely and hand off to human to prevent duplicate execution
          const failRes = await this.submitFailure(taskRes.task.id, {
            owner: lease.owner,
            token: lease.token,
            generation: lease.generation,
            error: "human_required",
            details: {
              message:
                "Uncertain prompt submission state during recovery (prompt_submitting could not be confirmed as sent); manual intervention required to prevent duplicate execution",
            },
            retryable: false,
          });
          this.checkpointStore.delete();
          return {
            status: "failed",
            failure: failRes.failure,
            receipt: failRes.receipt,
            superseded: failRes.superseded,
            session: sessionRes.session,
            error: new Error("Uncertain prompt submission state during recovery"),
          };
        }
      } finally {
        this.stopHeartbeat();
        this.activeAbortController = null;
        this.activeTask = null;
        this.activeSession = null;
        this.activeLease = null;
      }
    }

    if (
      cp.step === "waiting_response" &&
      typeof cp.baselineCount === "number" &&
      typeof (this.adapter as unknown as { waitForExistingResponse?: unknown }).waitForExistingResponse === "function"
    ) {
      this.activeTask = taskRes.task;
      this.activeSession = sessionRes.session;
      this.activeLease = lease;
      this.activeAbortController = new AbortController();
      const signal = this.activeAbortController.signal;

      this.startHeartbeat(taskRes.task, lease, () => {
        this.activeAbortController?.abort();
      });

      try {
        return await this.resumeWaitingResponse(
          taskRes.task,
          sessionRes.session,
          lease,
          cp.baselineCount,
          signal
        );
      } finally {
        this.stopHeartbeat();
        this.activeAbortController = null;
        this.activeTask = null;
        this.activeSession = null;
        this.activeLease = null;
      }
    }

    // 5. Normal claimed / started execution
    const context = await this.fetchContext(taskRes.task.id);
    return await this.executeClaimedTask(taskRes.task, sessionRes.session, lease, context);
  }

  private async resumeWaitingResponse(
    task: DecisionTask,
    session: DecisionSession,
    lease: DecisionLease,
    baselineCount: number,
    signal: AbortSignal
  ): Promise<TaskExecutionOutcome> {
    const adapterWithWait = this.adapter as unknown as {
      waitForExistingResponse?: (
        task: DecisionTask,
        opts: { baselineCount: number; signal?: AbortSignal }
      ) => Promise<{ result: DecisionResult }>;
    };
    if (typeof adapterWithWait.waitForExistingResponse !== "function") {
      throw new Error("Adapter does not support waitForExistingResponse");
    }

    let execution: { result: DecisionResult };
    try {
      execution = await adapterWithWait.waitForExistingResponse!(task, {
        baselineCount,
        signal,
      });
    } catch (modelErr) {
      if (!signal.aborted) {
        const failRes = await this.submitFailure(task.id, {
          owner: lease.owner,
          token: lease.token,
          generation: lease.generation,
          error: "execution_failed",
          details: { message: "Failed waiting for response during checkpoint recovery" },
          retryable: true,
        }).catch(() => null);

        this.checkpointStore.delete();
        if (failRes) {
          return {
            status: "failed",
            failure: failRes.failure,
            receipt: failRes.receipt,
            superseded: failRes.superseded,
            session,
            error: modelErr,
          };
        }
      }
      throw modelErr;
    }

    // Model extraction succeeded! Immediately persist candidateResult in checkpoint!
    this.updateCheckpointStep("result_extracted", { candidateResult: execution.result });

    // Submit candidate result (separate try-catch from model execution)
    try {
      const submitRes = await this.submitResult(task.id, {
        owner: lease.owner,
        token: lease.token,
        generation: lease.generation,
        result: execution.result,
      });

      return {
        status: "completed",
        result: submitRes.result,
        receipt: submitRes.receipt,
        superseded: submitRes.superseded,
        session,
      };
    } catch (submitErr) {
      // Transport error during submission! DO NOT mark failed! DO NOT delete checkpoint!
      // Check if bridge already accepted it (authoritative receipt):
      const receiptRes = await this.transport
        .request<{ receipt: SubmissionReceipt }>("GET", `/v1/tasks/${encodeURIComponent(task.id)}/receipt`)
        .catch(() => null);

      if (receiptRes?.receipt) {
        const receipt = receiptRes.receipt;
        const isSuperseded = typeof receipt.supersededAtMs === "number" && receipt.supersededAtMs > 0;
        if (
          isValidMatchingResultReceipt(receipt, lease, execution.result) &&
          !isSuperseded
        ) {
          this.checkpointStore.delete();
          return {
            status: "completed",
            result: receipt.payload as DecisionResult,
            receipt,
            superseded: false,
            session,
          };
        }
        if (receipt.type === "failure") {
          this.checkpointStore.delete();
          return {
            status: "failed",
            failure: receipt.payload as DecisionTaskFailure,
            receipt,
            superseded: isSuperseded,
            session,
            error: submitErr,
          };
        }
        if (isSuperseded) {
          this.checkpointStore.delete();
          throw new Error("Task was superseded on bridge during result submission");
        }
        if (receipt.type === "result" && !isValidMatchingResultReceipt(receipt, lease, execution.result)) {
          throw new BridgeHttpError(
            `Conflict: task "${task.id}" already accepted a different result receipt than extracted result`,
            "conflict",
            409
          );
        }
      }
      // Re-throw so driver can retry submitting candidateResult on next runOnce/polling cycle!
      throw submitErr;
    }
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
      // If candidate result exists or currently navigating, DO NOT delete checkpoint so it can be recovered
      const currentCp = this.checkpointStore.get();
      if (
        currentCp?.candidateResult ||
        currentCp?.step === "result_extracted" ||
        currentCp?.step === "navigating"
      ) {
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
