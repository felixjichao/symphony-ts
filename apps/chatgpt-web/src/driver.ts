import type { DriverDiagnostic } from "./diagnostics";
import type { DecisionContinuityWork } from "@symphony/domain";
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
  type DecisionAdapterErrorCode,
  type DecisionSessionCreationResult,
  DecisionAdapterError,
} from "@symphony/domain/decision";
import {
  executeTaskWithAdapter,
  DecisionConflictError,
  type DecisionTaskController,
  type TaskExecutionOutcome,
  type TaskExecutionSupersededOutcome,
  type SubmissionReceipt,
  type DecisionTaskFailure,
} from "@symphony/decision/adapter";
import { BridgeHttpError, type BridgeTransport } from "./transport";
import {
  type CheckpointStore,
  type DriverCheckpoint,
  type DriverStep,
  GmCheckpointStore,
} from "./checkpoint";
import { ChatGptWebAdapter, type ChatGptWebAdapterOptions } from "./adapter";
import {
  findStopButton,
  getAllAssistantTurns,
  buildConversationUrl,
  extractFormalConversationIdFromUrl,
  isTemporaryConversationRoute,
  waitForStreamingCompletion,
  detectConversationNotFound,
  detectAuthRequired,
  isConversationAssociatedWithBootstrap,
} from "./probes";
import { DECISION_MAX_TRANSPORT_RECOVERIES, mapDecisionAdapterFailure, type DecisionExecution } from "@symphony/domain/decision";
import { canonicalJsonEqual } from "./canonical-json";

export class DriverInterruption extends Error {
  constructor(readonly reason: "heartbeat_denied" | "lease_expired" | "manual_stop", readonly status?: number) {
    super(`Driver interrupted: ${reason}`);
  }
}

class ExecutionBlocked extends Error {
  constructor(readonly session: DecisionSession, readonly reason: string) { super(reason); }
}

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
  readonly navigationTimeoutMs?: number | undefined;
  readonly maxNavigationAttempts?: number | undefined;
  readonly shouldRun?: (() => boolean) | undefined;
  readonly onDiagnostic?: ((entry: DriverDiagnostic) => void) | undefined;
  /** Read-only idle facts; transport supplies Bridge authentication.
   * No task lease credentials are exposed or adopted; this never authorizes recovery. */
  readonly onContinuity?: ((work: readonly DecisionContinuityWork[]) => void) | undefined;
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
  readonly navigationTimeoutMs: number;
  readonly maxNavigationAttempts: number;
  readonly shouldRun?: (() => boolean) | undefined;
  readonly onError?: ((error: Error) => void) | undefined;

  private readonly onDiagnostic: DecisionTabDriverOptions["onDiagnostic"];
  private readonly onContinuity: DecisionTabDriverOptions["onContinuity"];
  private isRunning = false;
  private activeAbortController: AbortController | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private activeTask: DecisionTask | null = null;
  private activeSession: DecisionSession | null = null;
  private activeLease: DecisionLease | null = null;
  private activeInterruption: DriverInterruption | null = null;
  private heartbeatAuthError: BridgeHttpError | null = null;

  constructor(options: DecisionTabDriverOptions) {
    this.transport = options.transport;
    this.checkpointStore = options.checkpointStore ?? new GmCheckpointStore();
    this.adapter = options.adapter ?? new ChatGptWebAdapter(options.adapterOptions);
    this.ownerId = options.ownerId ?? `chatgpt-web-driver-${Math.random().toString(36).slice(2, 8)}`;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 20_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.defaultClaimTtlMs = options.defaultClaimTtlMs ?? 120_000;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 180_000;
    this.maxNavigationAttempts = options.maxNavigationAttempts ?? 3;
    this.onError = options.onError;
    this.shouldRun = options.shouldRun;
    this.onDiagnostic = options.onDiagnostic;
    this.onContinuity = options.onContinuity;

    if (this.adapter instanceof ChatGptWebAdapter) {
      this.adapter.setStepListener((step, meta) => {
        this.updateCheckpointStep(step, meta);
        if (this.activeTask) this.diagnose({ stage: step, taskId: this.activeTask.id, kind: this.activeTask.kind, revision: this.activeTask.revision });
        // Persist the possible side effect before clicking Send, so a lost tab cannot replay it.
        if (step === "prompt_submitting" || step === "bootstrap_submitting" || step === "navigating") return this.publishProgress(step);
      });
    }
  }

  private diagnose(entry: DriverDiagnostic): void {
    try { this.onDiagnostic?.(entry); } catch { /* Local diagnostics cannot affect delivery. */ }
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
        .catch((error: unknown) => { if (error instanceof ExecutionBlocked) throw error; return null; });
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
    this.diagnose({ stage: "result_submitting", taskId, kind: params.result.kind, revision: params.result.revision });

    try {
      const res = await this.transport.request<{
        receipt: SubmissionReceipt;
        result: DecisionResult;
        superseded: boolean;
      }>("POST", `/v1/tasks/${encodeURIComponent(taskId)}/result`, params);

      // Upon confirmed valid result receipt from bridge, checkpoint can safely be cleared
      if (res.receipt?.type === "result" && !res.superseded) {
        this.diagnose({ stage: "result_accepted", taskId, kind: params.result.kind, revision: params.result.revision });
        this.checkpointStore.delete();
      }
      return res;
    } catch (err: unknown) {
      this.diagnose({ stage: "result_submit_error", taskId, kind: params.result.kind, revision: params.result.revision });
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
    },
    options: {
      /**
       * Keep the checkpoint when the failure becomes a block. Recovery exhaustion of an
       * already-extracted candidate must not discard the candidate or the duty to verify its
       * receipt: a later run still holds the evidence the operator is asked to check.
       */
      retainCheckpoint?: boolean | undefined;
    } = {}
  ): Promise<{ receipt: SubmissionReceipt; failure: DecisionTaskFailure; superseded: boolean }> {
    if (this.heartbeatAuthError) throw this.heartbeatAuthError;
    const details = params.details && typeof params.details === "object" ? params.details as Record<string, unknown> : {};
    const mapping = mapDecisionAdapterFailure({ code: params.error as DecisionAdapterErrorCode,
      message: params.error, retryable: params.retryable,
      suggestedAction: details["suggestedAction"] as "retry" | "rebind" | "human_intervention" | "fail_closed" | undefined });
    const blockedError = params.error === "binding_broken" ? "recovery_exhausted" : params.error === "recovery_exhausted" ? "recovery_exhausted" : !mapping.mapped || mapping.diagnostic.category === "invariant_violation"
      ? "human_required" : mapping.diagnostic.category === "blocked_external" ? "human_required" : params.error;
    if (blockedError === "human_required" || blockedError === "auth_required" || blockedError === "recovery_exhausted") {
      await this.transport.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/block`, {
        owner: params.owner, token: params.token, generation: params.generation, reason: blockedError,
        recoveryCount: this.checkpointStore.get()?.recoveryFailures ?? 0,
      });
      const session = this.activeSession ?? (await this.transport.request<{ session: DecisionSession }>("GET", `/v1/sessions/${encodeURIComponent(this.checkpointStore.get()?.sessionId ?? "")}`)).session;
      if (!options.retainCheckpoint) this.checkpointStore.delete();
      this.stopHeartbeat();
      throw new ExecutionBlocked(session, blockedError);
    }
    const res = await this.transport.request<{
      receipt: SubmissionReceipt;
      failure: DecisionTaskFailure;
      superseded: boolean;
    }>("POST", `/v1/tasks/${encodeURIComponent(taskId)}/fail`, params);

    this.checkpointStore.delete();
    return res;
  }

  /**
   * Authoritative receipt check for an already-extracted candidate result. It runs before any
   * further submission and before the recovery budget ends the attempt: a submission whose
   * response was lost may already have been accepted, so the candidate is neither replayed nor
   * discarded without reading the receipt the bridge recorded for it.
   */
  private async verifyCandidateReceipt(
    cp: DriverCheckpoint,
    session: DecisionSession | null,
    knownTask?: DecisionTask | null
  ): Promise<{ state: "unconfirmed" } | { state: "confirmed"; outcome: TaskExecutionOutcome | null }> {
    const candidate = cp.candidateResult as DecisionResult;
    const lease = { owner: cp.leaseOwner, token: cp.leaseToken, generation: cp.leaseGeneration };
    const outcomeSession = session ?? ({} as DecisionSession);
    try {
      const task = knownTask ?? (await this.transport
        .request<{ task: DecisionTask }>("GET", `/v1/tasks/${encodeURIComponent(cp.taskId)}`)
        .catch((error: unknown) => { if (error instanceof ExecutionBlocked) throw error; return null; }))?.task ?? null;
      const receipt = (await this.transport
        .request<{ receipt: SubmissionReceipt }>("GET", `/v1/tasks/${encodeURIComponent(cp.taskId)}/receipt`)
        .catch((error: unknown) => { if (error instanceof ExecutionBlocked) throw error; return null; }))?.receipt ?? null;
      if (!receipt) {
        if (task?.status === "superseded" || task?.status === "cancelled") {
          return { state: "confirmed", outcome: null };
        }
        return { state: "unconfirmed" };
      }
      const isSuperseded = typeof receipt.supersededAtMs === "number" && receipt.supersededAtMs > 0;
      if (isValidMatchingResultReceipt(receipt, lease, candidate) && !isSuperseded) {
        return { state: "confirmed", outcome: { status: "completed", result: receipt.payload as DecisionResult,
          receipt, superseded: false, session: outcomeSession } };
      }
      if (receipt.type === "result" && !isValidMatchingResultReceipt(receipt, lease, candidate)) {
        // A different payload accepted for this task is an explicit conflict, never a retry.
        throw new BridgeHttpError(
          `Conflict: task "${cp.taskId}" already accepted a different result receipt than candidate result`,
          "conflict",
          409
        );
      }
      if (receipt.type === "failure" || task?.status === "failed") {
        return { state: "confirmed", outcome: { status: "failed",
          failure: (receipt.type === "failure" ? receipt.payload : undefined) as DecisionTaskFailure,
          receipt, superseded: isSuperseded, session: outcomeSession, error: new Error("Task failed on bridge") } };
      }
      if (isSuperseded || task?.status === "superseded") {
        return { state: "confirmed", outcome: null };
      }
      return { state: "unconfirmed" };
    } catch (err: unknown) {
      if (err instanceof ExecutionBlocked) throw err;
      if (err instanceof BridgeHttpError && err.status === 409) throw err;
      // Authoritative source unreadable: acceptance is unconfirmed, not refuted.
      return { state: "unconfirmed" };
    }
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
    if (this.activeSession && this.activeSession.id === sessionId) {
      this.activeSession = res.session;
    }
    return res.session;
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
    const res = await this.transport.request<{ session: DecisionSession }>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/break-binding`,
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
    this.updateCheckpointStep("rebind_submitting", {
      rebindState: {
        newExternalSessionRef: params.externalSessionRef,
        newResumeUri: params.resumeUri,
        expectedGeneration: params.expectedGeneration,
        ...(params.operationKey ? { operationKey: params.operationKey } : {}),
      },
    });
    const res = await this.transport.request<{ session: DecisionSession }>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/rebind`,
      params
    );
    if (res.session.bindingGeneration <= params.expectedGeneration) {
      this.checkpointStore.delete();
      throw new DecisionConflictError("Rebind blocked by authoritative recovery budget");
    }
    if (this.activeSession && this.activeSession.id === sessionId) {
      this.activeSession = res.session;
    }
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
      rebindState?: {
        readonly newExternalSessionRef: string;
        readonly newResumeUri: string | null;
        readonly expectedGeneration: number;
        readonly operationKey?: string | undefined;
      };
      navigationStartedAtMs?: number;
      navigationDeadlineMs?: number;
      navigationAttempts?: number;
    }
  ): void {
    const isNavigating = step === "navigating";
    const navStarted =
      meta?.navigationStartedAtMs ?? (isNavigating ? Date.now() : undefined);
    const navDeadline =
      meta?.navigationDeadlineMs ??
      (isNavigating ? Date.now() + this.navigationTimeoutMs : undefined);
    const navAttempts =
      meta?.navigationAttempts ?? (isNavigating ? 1 : undefined);

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
      ...(navStarted !== undefined ? { navigationStartedAtMs: navStarted } : {}),
      ...(navDeadline !== undefined ? { navigationDeadlineMs: navDeadline } : {}),
      ...(navAttempts !== undefined ? { navigationAttempts: navAttempts } : {}),
      ...(meta?.rebindState !== undefined
        ? {
            rebindState: meta.rebindState.operationKey
              ? meta.rebindState
              : {
                  ...meta.rebindState,
                  operationKey: `driver:${this.ownerId}:${session.id}:rebind:${meta.rebindState.expectedGeneration + 1}`,
                },
          }
        : {}),
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
      rebindState?: {
        readonly newExternalSessionRef: string;
        readonly newResumeUri: string | null;
        readonly expectedGeneration: number;
        readonly operationKey?: string | undefined;
      };
      navigationStartedAtMs?: number;
      navigationDeadlineMs?: number;
      navigationAttempts?: number;
    }
  ): void {
    let rebindState = meta?.rebindState;
    if (rebindState && !rebindState.operationKey) {
      const sid = this.activeSession?.id ?? this.checkpointStore.get()?.sessionId ?? "";
      rebindState = {
        ...rebindState,
        operationKey: `driver:${this.ownerId}:${sid}:rebind:${rebindState.expectedGeneration + 1}`,
      };
    }
    const existing = this.checkpointStore.get();
    if (existing) {
      const isSameTarget =
        Boolean(meta?.targetUri && existing.targetUri === meta.targetUri) ||
        Boolean(meta?.targetConvId && existing.targetConvId === meta.targetConvId);
      const isEnteringNavigating = step === "navigating" && existing.step !== "navigating" && !isSameTarget;
      const navStarted =
        meta?.navigationStartedAtMs ??
        (isEnteringNavigating ? Date.now() : (existing.navigationStartedAtMs ?? (step === "navigating" ? Date.now() : undefined)));
      const navDeadline =
        meta?.navigationDeadlineMs ??
        (isEnteringNavigating
          ? Date.now() + this.navigationTimeoutMs
          : (existing.navigationDeadlineMs ?? (step === "navigating" ? Date.now() + this.navigationTimeoutMs : undefined)));
      const navAttempts =
        meta?.navigationAttempts ??
        (isEnteringNavigating
          ? 1
          : (isSameTarget && existing.step !== "navigating"
              ? (existing.navigationAttempts ?? 1) + 1
              : existing.navigationAttempts));

      this.checkpointStore.set({
        ...existing,
        step,
        savedAtMs: Date.now(),
        ...(meta?.candidateResult !== undefined ? { candidateResult: meta.candidateResult } : {}),
        ...(meta?.baselineCount !== undefined ? { baselineCount: meta.baselineCount } : {}),
        ...(meta?.targetUri !== undefined
          ? { targetUri: meta.targetUri }
          : (existing.targetUri !== undefined ? { targetUri: existing.targetUri } : {})),
        ...(meta?.targetConvId !== undefined
          ? { targetConvId: meta.targetConvId }
          : (existing.targetConvId !== undefined ? { targetConvId: existing.targetConvId } : {})),
        ...(rebindState !== undefined ? { rebindState } : {}),
        ...(navStarted !== undefined ? { navigationStartedAtMs: navStarted } : {}),
        ...(navDeadline !== undefined ? { navigationDeadlineMs: navDeadline } : {}),
        ...(navAttempts !== undefined ? { navigationAttempts: navAttempts } : {}),
      });
      return;
    }
    if (this.activeTask && this.activeSession && this.activeLease) {
      this.saveCheckpoint(step, this.activeTask, this.activeSession, this.activeLease, {
        ...meta,
        ...(rebindState !== undefined ? { rebindState } : {}),
      });
    }
  }

  private executionProgress(phase?: string): { phase: string; responseLength: number } {
    const cp = this.checkpointStore.get();
    let responseLength = 0;
    const doc = this.adapter instanceof ChatGptWebAdapter ? this.adapter.getDocument() :
      (typeof document !== "undefined" ? document : null);
    if (cp?.step === "waiting_response" && doc) {
      if (this.adapter instanceof ChatGptWebAdapter) {
        responseLength = this.adapter.getResponseLength(cp.taskId, cp.baselineCount ?? 0);
      } else {
        const turns = getAllAssistantTurns(doc);
        if (turns.length > (cp.baselineCount ?? turns.length)) responseLength = turns.at(-1)?.textContent?.length ?? 0;
      }
    }
    return { phase: phase ?? cp?.step ?? "claimed", responseLength };
  }

  private async publishProgress(phase: string): Promise<void> {
    if (this.shouldRun && !this.shouldRun()) { this.stop(); throw new Error("Driver disabled"); }
    const cp = this.checkpointStore.get();
    if (!cp) throw new Error("Cannot authorize prompt without a checkpoint");
    await this.transport.request("POST", `/v1/tasks/${encodeURIComponent(cp.taskId)}/heartbeat`, {
      owner: cp.leaseOwner, token: cp.leaseToken, generation: cp.leaseGeneration,
      ttlMs: this.defaultClaimTtlMs, progress: this.executionProgress(phase),
    });
    // Re-read the durable run intent after the authorization round trip. Another tab may have
    // written a persisted Stop while this request was in flight; that Stop does not abort this
    // page's signal, so the pre-request check alone would still allow the Send or navigation
    // the adapter performs once this listener resolves.
    if (this.shouldRun && !this.shouldRun()) {
      this.stop();
      throw new Error("Driver disabled while authorizing the page action");
    }
  }

  startHeartbeat(task: DecisionTask, lease: DecisionLease, onExpired?: () => void): void {
    this.stopHeartbeat();
    this.heartbeatAuthError = null;
    this.activeInterruption = null;
    this.heartbeatTimer = setInterval(async () => {
      if (this.shouldRun && !this.shouldRun()) { this.stop(); return; }
      try {
        const hbRes = await this.transport.request<{ expiresAtMs: number; ttlMs: number }>(
          "POST",
          `/v1/tasks/${encodeURIComponent(task.id)}/heartbeat`,
          {
            owner: lease.owner,
            token: lease.token,
            generation: lease.generation,
            ttlMs: this.defaultClaimTtlMs,
            progress: this.executionProgress(),
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
        if (hbErr instanceof BridgeHttpError && (hbErr.status === 401 || hbErr.status === 403)) {
          this.recordInterruption(task, new DriverInterruption("heartbeat_denied", hbErr.status));
          this.heartbeatAuthError = hbErr;
          this.stopHeartbeat();
          if (onExpired) onExpired();
          this.onError?.(hbErr);
          return;
        }
        if (
          hbErr instanceof BridgeHttpError &&
          (hbErr.status === 404 || hbErr.status === 409 || hbErr.status === 410)
        ) {
          // Authoritative lease lost or superseded on bridge
          this.recordInterruption(task, new DriverInterruption("heartbeat_denied", hbErr.status));
          this.stopHeartbeat();
          if (onExpired) onExpired();
          return;
        }
        this.recordInterruption(task, new DriverInterruption("heartbeat_denied", hbErr instanceof BridgeHttpError ? hbErr.status : undefined));
        // Transient network failure during heartbeat:
        // Only stop heartbeat and abort if local lease has actually expired
        const currentExpiry = this.activeLease?.expiresAtMs ?? lease.expiresAtMs;
        if (Date.now() >= currentExpiry) {
          this.recordInterruption(task, new DriverInterruption("lease_expired"));
          this.stopHeartbeat();
          if (onExpired) onExpired();
        }
      }
    }, this.heartbeatIntervalMs);
  }

  private recordInterruption(task: DecisionTask, interruption: DriverInterruption): void {
    this.activeInterruption = interruption;
    const cp = this.checkpointStore.get();
    this.diagnose({ stage: "interrupted", taskId: task.id, kind: task.kind, revision: task.revision,
      interruption: { reason: interruption.reason, status: interruption.status,
        claimGeneration: cp?.leaseGeneration ?? task.claimGeneration,
        bindingGeneration: cp?.bindingGeneration ?? 0 } });
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
    try { return await this.resumeObservedCheckpoint(); }
    catch (err) {
      if (err instanceof ExecutionBlocked) return { status: "blocked", session: err.session, reason: err.reason };
      throw err;
    }
  }

  private async resumeObservedCheckpoint(): Promise<TaskExecutionOutcome | null> {
    const cp = this.checkpointStore.get();
    if (!cp) return null;

    // Checkpoint tab ownership validation
    if (cp.tabId !== this.checkpointStore.tabId) {
      return null;
    }

    // 1. Check task status and session on bridge FIRST without requiring heartbeat/lease renewal!
    let taskRes: { task: DecisionTask; execution?: DecisionExecution | null } | null = null;
    try {
      taskRes = await this.transport.request<{ task: DecisionTask; execution?: DecisionExecution | null }>(
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

    const currentTask = taskRes?.task;
    const currentSession = sessionRes?.session;
    if (!currentTask || !currentSession) {
      this.checkpointStore.delete();
      return null;
    }

    const currentLease = currentTask.lease;
    const isClaimValid =
      currentLease !== null &&
      currentLease !== undefined &&
      (currentTask.status === "claimed" || currentTask.status === "running") &&
      currentLease.owner === cp.leaseOwner &&
      currentLease.token === cp.leaseToken &&
      currentLease.generation === cp.leaseGeneration &&
      currentLease.expiresAtMs > Date.now();

    const isStaleRollover =
      cp.bindingGeneration > 0
        ? currentSession.bindingGeneration > cp.bindingGeneration
        : currentSession.bindingGeneration > 1;
    if (isStaleRollover) {
      this.checkpointStore.delete();
      return null;
    }

    if (taskRes?.execution?.blocked && (currentTask.status === "claimed" || currentTask.status === "running")) {
      const blockedReason = taskRes.execution.blocked.reason;
      if (cp.candidateResult) {
        // The block may have been recorded after an ambiguous result submission. The extracted
        // candidate is the only copy of what this tab tried to submit, so it outlives the polling
        // cycle: only an authoritative receipt or an explicit operator resolution may retire it.
        // Repeated polls and page rebuilds keep re-checking the receipt and keep the evidence.
        const verified = await this.verifyCandidateReceipt(cp, sessionRes?.session ?? null, currentTask);
        if (verified.state === "confirmed") {
          this.checkpointStore.delete();
          return verified.outcome;
        }
        return { status: "blocked", session: sessionRes!.session, reason: blockedReason };
      }
      if (cp.step !== "waiting_response" && cp.step !== "prompt_submitting") this.checkpointStore.delete();
      return { status: "blocked", session: sessionRes!.session, reason: blockedReason };
    }

    if (cp.step === "rebind_submitting") {
      if (cp.rebindState) {
        if (
          cp.rebindState.expectedGeneration > 0 &&
          currentSession.bindingGeneration > cp.rebindState.expectedGeneration
        ) {
          this.checkpointStore.delete();
          return null;
        }
        if (
          cp.rebindState.expectedGeneration === 0 &&
          currentSession.bindingGeneration > 1
        ) {
          this.checkpointStore.delete();
          return null;
        }
        if (
          cp.rebindState.expectedGeneration === 0 &&
          currentSession.bindingGeneration === 1
        ) {
          if (!isClaimValid) {
            this.checkpointStore.delete();
            return null;
          }
          const lease: DecisionLease = {
            owner: cp.leaseOwner,
            token: cp.leaseToken,
            generation: cp.leaseGeneration,
            expiresAtMs: cp.leaseExpiresAtMs,
          };
          this.saveCheckpoint("claimed", currentTask, currentSession, lease);
          const context = await this.fetchContext(currentTask.id);
          return await this.executeClaimedTask(currentTask, currentSession, lease, context);
        }
        try {
          if (cp.rebindState.expectedGeneration === 0) {
            if (!isClaimValid) {
              this.checkpointStore.delete();
              return null;
            }
            const updatedSession = await this.putBinding(cp.sessionId, {
              adapter: this.adapter?.name ?? "chatgpt-web",
              externalSessionRef: cp.rebindState.newExternalSessionRef,
              resumeUri: cp.rebindState.newResumeUri,
              owner: cp.leaseOwner,
              token: cp.leaseToken,
              generation: cp.leaseGeneration,
            });
            const lease: DecisionLease = {
              owner: cp.leaseOwner,
              token: cp.leaseToken,
              generation: cp.leaseGeneration,
              expiresAtMs: cp.leaseExpiresAtMs,
            };
            this.saveCheckpoint("claimed", currentTask, updatedSession, lease);
            const context = await this.fetchContext(currentTask.id);
            return await this.executeClaimedTask(currentTask, updatedSession, lease, context);
          } else {
            await this.rebindSession(cp.sessionId, {
              adapter: this.adapter?.name ?? "chatgpt-web",
              externalSessionRef: cp.rebindState.newExternalSessionRef,
              resumeUri: cp.rebindState.newResumeUri,
              expectedGeneration: cp.rebindState.expectedGeneration,
              ...(cp.rebindState.operationKey ? { operationKey: cp.rebindState.operationKey } : {}),
              owner: cp.leaseOwner,
              token: cp.leaseToken,
              generation: cp.leaseGeneration,
            });
          }
          this.checkpointStore.delete();
          return null;
        } catch (err: unknown) {
          if (
            err instanceof BridgeHttpError &&
            (err.status === 404 || err.status === 409 || err.status === 410)
          ) {
            this.checkpointStore.delete();
            return null;
          }
          // Transient network or server outage (e.g. HTTP 503): preserve checkpoint with full rebindState
          // and throw error upward to prevent polling/claiming new work from other sessions while this operation is pending
          throw err;
        }
      }
      this.checkpointStore.delete();
      return null;
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
        .catch((error: unknown) => { if (error instanceof ExecutionBlocked) throw error; return null; });
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

    // 2. If candidateResult was extracted, verify its receipt before re-submitting it. The
    // recovery budget is applied here, ahead of the submission: this branch used to throw from
    // the submission before the shared budget check below was ever reached, so a persistently
    // failing result POST could re-submit forever without ever blocking.
    if (cp.candidateResult && (cp.step === "result_extracted" || cp.step === "waiting_response")) {
      if ((cp.recoveryFailures ?? 0) >= DECISION_MAX_TRANSPORT_RECOVERIES) {
        const verified = await this.verifyCandidateReceipt(cp, sessionRes?.session ?? null, currentTask);
        if (verified.state === "confirmed") {
          this.checkpointStore.delete();
          return verified.outcome;
        }
        if (!isClaimValid) {
          this.checkpointStore.delete();
          return null;
        }
        // Acceptance is unconfirmed and the budget is exhausted: block instead of resubmitting.
        // The checkpoint is retained so the candidate and the receipt verification stay available
        // to the operator who explicitly unblocks this execution.
        await this.submitFailure(cp.taskId, {
          owner: cp.leaseOwner,
          token: cp.leaseToken,
          generation: cp.leaseGeneration,
          error: "recovery_exhausted",
          retryable: false,
        }, { retainCheckpoint: true });
        // submitFailure throws ExecutionBlocked for recovery_exhausted. Reaching this point means
        // no block was recorded, and resubmitting would bypass the exhausted budget.
        throw new Error("Recovery budget exhausted and the execution block was not recorded");
      }
      try {
        const submitRes = await this.submitResult(cp.taskId, {
          owner: cp.leaseOwner,
          token: cp.leaseToken,
          generation: cp.leaseGeneration,
          result: cp.candidateResult as DecisionResult,
        });
        this.checkpointStore.delete();
        return {
          status: "completed",
          result: submitRes.result,
          receipt: submitRes.receipt,
          superseded: submitRes.superseded,
          session: sessionRes?.session ?? ({} as DecisionSession),
        };
      } catch (submitErr: unknown) {
        if (submitErr instanceof BridgeHttpError && submitErr.status === 409) {
          // Task may have been superseded/cancelled between the status check above and
          // submission; resolve the expected terminal race instead of surfacing a fatal error
          const supersededOutcome = await this.resolveSupersededOutcome(
            cp.taskId,
            sessionRes?.session ?? ({} as DecisionSession),
            submitErr
          );
          if (supersededOutcome) {
            return supersededOutcome;
          }
          throw submitErr;
        }
        // Re-submission failed. Check whether bridge recorded it or if it failed/superseded
        const freshTask = await this.transport
          .request<{ task: DecisionTask }>("GET", `/v1/tasks/${encodeURIComponent(cp.taskId)}`)
          .catch((error: unknown) => { if (error instanceof ExecutionBlocked) throw error; return null; });
        const receiptRes = await this.transport
          .request<{ receipt: SubmissionReceipt }>("GET", `/v1/tasks/${encodeURIComponent(cp.taskId)}/receipt`)
          .catch((error: unknown) => { if (error instanceof ExecutionBlocked) throw error; return null; });

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


    if ((cp.recoveryFailures ?? 0) >= DECISION_MAX_TRANSPORT_RECOVERIES && isClaimValid) {
      await this.submitFailure(cp.taskId, { owner: cp.leaseOwner, token: cp.leaseToken,
        generation: cp.leaseGeneration, error: "recovery_exhausted", retryable: false });
    }

    // 3. For ongoing uncompleted execution, verify checkpoint expiry & lease validity via heartbeat
    if (!isClaimValid) {
      if ((cp.step === "waiting_response" || cp.step === "prompt_submitting") &&
        currentLease?.owner === cp.leaseOwner && currentLease.token === cp.leaseToken &&
        currentLease.generation === cp.leaseGeneration &&
        (currentTask.status === "claimed" || currentTask.status === "running")) {
        // An expired credential cannot authorize extraction submission or another Send.
        // Retain the local evidence while native continuity decides the blocked claim.
        return { status: "blocked", session: currentSession, reason: "human_required" };
      }
      this.checkpointStore.delete();
      return null;
    }

    let renewedExpiry = currentLease?.expiresAtMs ?? cp.leaseExpiresAtMs;
    try {
      const hbRes = await this.transport.request<{ expiresAtMs: number; ttlMs: number }>(
        "POST",
        `/v1/tasks/${encodeURIComponent(cp.taskId)}/heartbeat`,
        {
          owner: cp.leaseOwner,
          token: cp.leaseToken,
          generation: cp.leaseGeneration,
          ttlMs: this.defaultClaimTtlMs,
          progress: this.executionProgress(),
        }
      );
      if (hbRes && typeof hbRes.expiresAtMs === "number") {
        renewedExpiry = hbRes.expiresAtMs;
        const currentStored = this.checkpointStore.get() ?? cp;
        this.checkpointStore.set({
          ...currentStored,
          leaseExpiresAtMs: renewedExpiry,
          savedAtMs: Date.now(),
        });
      }
    } catch (hbErr: unknown) {
      this.recordInterruption(currentTask, new DriverInterruption("heartbeat_denied", hbErr instanceof BridgeHttpError ? hbErr.status : undefined));
      // Keep sent attempts/candidates intact. A denied renewal never authorizes page actions,
      // a new Send, or a human verdict. Next poll must re-observe native authority.
      throw hbErr;
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
      const doc =
        (this.adapter instanceof ChatGptWebAdapter ? this.adapter.getDocument() : null) ??
        (globalThis as unknown as { document?: Document }).document;

      const currentUrl = win?.location?.href ?? "";
      const currentConvId = currentUrl ? extractFormalConversationIdFromUrl(currentUrl) : null;
      const isAtTarget =
        (cp.targetConvId && currentConvId === cp.targetConvId) ||
        (cp.targetUri && currentUrl === cp.targetUri);

      const isNotFound = doc ? detectConversationNotFound(doc) : false;
      if (isNotFound) {
        return await this.rebindUnrecoverableSession(
          taskRes.task,
          sessionRes.session,
          lease,
          `ChatGPT conversation "${cp.targetConvId ?? cp.targetUri ?? "unknown"}" is unrecoverable (conversation not found)`
        );
      }

      if (!isAtTarget) {
        const attempts = cp.navigationAttempts ?? 1;
        const startedAt = cp.navigationStartedAtMs ?? cp.savedAtMs ?? Date.now();
        const deadline = cp.navigationDeadlineMs ?? (startedAt + this.navigationTimeoutMs);
        const isBudgetExhausted = attempts >= this.maxNavigationAttempts || Date.now() >= deadline;

        if (isBudgetExhausted) {
          return await this.rebindUnrecoverableSession(
            taskRes.task,
            sessionRes.session,
            lease,
            `ChatGPT conversation "${cp.targetConvId ?? cp.targetUri ?? "unknown"}" is unrecoverable (navigation budget exhausted after ${attempts} attempts)`
          );
        }

        const nextAttempts = attempts + 1;
        const currentStored = this.checkpointStore.get() ?? cp;
        this.checkpointStore.set({
          ...currentStored,
          leaseExpiresAtMs: renewedExpiry,
          navigationAttempts: nextAttempts,
          navigationStartedAtMs: startedAt,
          navigationDeadlineMs: deadline,
          savedAtMs: Date.now(),
        });

        if (win && cp.targetUri && win.location && win.location.href !== cp.targetUri) {
          win.location.assign(cp.targetUri);
        }

        const afterAssignUrl = win?.location?.href ?? "";
        const afterAssignConvId = afterAssignUrl ? extractFormalConversationIdFromUrl(afterAssignUrl) : null;
        const nowAtTarget =
          (cp.targetConvId && afterAssignConvId === cp.targetConvId) ||
          (cp.targetUri && afterAssignUrl === cp.targetUri);

        if (!nowAtTarget) {
          return null;
        }
      }

      // Do NOT demote navigating checkpoint to "claimed" solely on URL match, which
      // would erase the accumulated navigation attempt budget and deadlines before
      // the adapter confirms route stability and composer readiness.
    }

    if (cp.step === "bootstrap_submitting") {
      this.activeTask = taskRes.task;
      this.activeSession = sessionRes.session;
      this.activeLease = lease;
      this.activeAbortController = new AbortController();
      const signal = this.activeAbortController.signal;

      this.startHeartbeat(taskRes.task, lease, () => {
        this.activeAbortController?.abort(this.activeInterruption ?? new DriverInterruption("lease_expired"));
      });

      try {
        const doc =
          (this.adapter instanceof ChatGptWebAdapter ? this.adapter.getDocument() : null) ??
          (globalThis as unknown as { document?: Document }).document;

        if (doc && (detectConversationNotFound(doc) || detectAuthRequired(doc))) {
          this.checkpointStore.delete();
          if (detectConversationNotFound(doc)) {
            throw new DecisionAdapterError({
              code: "binding_broken",
              message: "Conversation not found during bootstrap_submitting recovery",
              suggestedAction: "rebind",
            });
          } else {
            throw new DecisionAdapterError({
              code: "human_required",
              message: "Authentication required during bootstrap_submitting recovery",
              suggestedAction: "human_intervention",
            });
          }
        }

        // A recorded created-conversation reference is the only attempt-unique evidence.
        // Without it — or with the tab showing a different conversation — this attempt's
        // conversation cannot be identified: fail closed instead of reading a reply,
        // binding, or re-sending.
        const isAssociated = this.isBootstrapConversationAssociated(cp);
        if (isAssociated) {
          this.updateCheckpointStep("bootstrap_waiting", { baselineCount: cp.baselineCount ?? 0 });
          return await this.resumeBootstrapWaiting(
            taskRes.task,
            sessionRes.session,
            lease,
            cp.baselineCount ?? 0,
            signal,
            cp
          );
        } else {
          // Cannot identify the conversation this attempt created: hand off to a human to
          // prevent duplicate execution or binding an unrelated conversation.
          const failRes = await this.submitFailure(taskRes.task.id, {
            owner: lease.owner,
            token: lease.token,
            generation: lease.generation,
            error: "human_required",
            details: {
              message:
                "Cannot confirm the loaded ChatGPT conversation was created by this bootstrap attempt during bootstrap_submitting recovery (no matching recorded created conversation); manual intervention required to prevent duplicate execution",
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
            error: new Error("Unconfirmed bootstrap conversation association during recovery"),
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

    if (cp.step === "bootstrap_waiting") {
      this.activeTask = taskRes.task;
      this.activeSession = sessionRes.session;
      this.activeLease = lease;
      this.activeAbortController = new AbortController();
      const signal = this.activeAbortController.signal;

      this.startHeartbeat(taskRes.task, lease, () => {
        this.activeAbortController?.abort(this.activeInterruption ?? new DriverInterruption("lease_expired"));
      });

      try {
        return await this.resumeBootstrapWaiting(
          taskRes.task,
          sessionRes.session,
          lease,
          cp.baselineCount ?? 0,
          signal,
          cp
        );
      } finally {
        this.stopHeartbeat();
        this.activeAbortController = null;
        this.activeTask = null;
        this.activeSession = null;
        this.activeLease = null;
      }
    }

    if (cp.step === "prompt_submitting") {
      this.activeTask = taskRes.task;
      this.activeSession = sessionRes.session;
      this.activeLease = lease;
      this.activeAbortController = new AbortController();
      const signal = this.activeAbortController.signal;

      this.startHeartbeat(taskRes.task, lease, () => {
        this.activeAbortController?.abort(this.activeInterruption ?? new DriverInterruption("lease_expired"));
      });

      try {
        const adapterWithProbes = this.adapter as unknown as {
          confirmPromptSubmitted?: (opts: { baselineCount: number; task?: DecisionTask; signal?: AbortSignal }) => Promise<boolean>;
          isPromptConfirmedSent?: (doc?: unknown, baselineCount?: number, task?: DecisionTask) => boolean;
        };
        let isConfirmedSent = false;
        if (typeof adapterWithProbes.confirmPromptSubmitted === "function") {
          isConfirmedSent = await adapterWithProbes.confirmPromptSubmitted({
            baselineCount: cp.baselineCount ?? 0,
            task: taskRes.task,
            signal,
          }).catch(() => false);
        } else if (typeof adapterWithProbes.isPromptConfirmedSent === "function") {
          isConfirmedSent = adapterWithProbes.isPromptConfirmedSent(undefined, cp.baselineCount ?? 0, taskRes.task);
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
        this.activeAbortController?.abort(this.activeInterruption ?? new DriverInterruption("lease_expired"));
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

  private async resumeBootstrapWaiting(
    task: DecisionTask,
    session: DecisionSession,
    lease: DecisionLease,
    baselineCount: number,
    signal: AbortSignal,
    cp: DriverCheckpoint
  ): Promise<TaskExecutionOutcome> {
    const adapterWithBootstrap = this.adapter as unknown as {
      waitForBootstrapResponse?: (opts: {
        baselineCount: number;
        signal?: AbortSignal;
      }) => Promise<string>;
    };

    let convId: string;
    const win =
      (this.adapter instanceof ChatGptWebAdapter ? this.adapter.getWindow() : null) ??
      (globalThis as unknown as { window?: Window }).window;
    const doc =
      (this.adapter instanceof ChatGptWebAdapter ? this.adapter.getDocument() : null) ??
      (globalThis as unknown as { document?: Document }).document;
    try {
      // Page health takes precedence: an explicitly deleted conversation or an auth
      // interstitial must keep its existing recovery classification.
      if (doc && detectConversationNotFound(doc)) {
        throw new DecisionAdapterError({
          code: "binding_broken",
          message: "Conversation not found during bootstrap waiting recovery",
          suggestedAction: "rebind",
        });
      }
      if (doc && detectAuthRequired(doc)) {
        throw new DecisionAdapterError({
          code: "human_required",
          message: "Authentication required during bootstrap waiting recovery",
          suggestedAction: "human_intervention",
        });
      }

      // Never read a reply, or bind, a conversation that cannot be tied back to this
      // bootstrap attempt: the tab must show the exact conversation recorded for this
      // attempt (the only attempt-unique evidence).
      const isAssociated = this.isBootstrapConversationAssociated(cp);
      if (!isAssociated) {
        const failRes = await this.submitFailure(task.id, {
          owner: lease.owner,
          token: lease.token,
          generation: lease.generation,
          error: "human_required",
          details: {
            message:
              "Cannot confirm the loaded ChatGPT conversation was created by this bootstrap attempt during recovery (no matching recorded created conversation); manual intervention required to avoid reading or binding an unrelated conversation",
          },
          retryable: false,
        });
        this.checkpointStore.delete();
        return {
          status: "failed",
          failure: failRes.failure,
          receipt: failRes.receipt,
          superseded: failRes.superseded,
          session,
          error: new Error("Unconfirmed bootstrap conversation association during recovery"),
        };
      }

      if (typeof adapterWithBootstrap.waitForBootstrapResponse === "function") {
        convId = await adapterWithBootstrap.waitForBootstrapResponse({
          baselineCount,
          signal,
        });
      } else {
        await waitForStreamingCompletion({
          doc,
          baselineCount,
          baselineTurn: null,
          timeoutMs: this.adapter instanceof ChatGptWebAdapter ? this.adapter.getTimeoutMs() : 60_000,
          stabilizationMs: 1,
          checkIntervalMs: 50,
          signal,
        });

        if (doc && detectConversationNotFound(doc)) {
          throw new DecisionAdapterError({
            code: "binding_broken",
            message: "Conversation not found after bootstrap waiting recovery",
            suggestedAction: "rebind",
          });
        }
        if (doc && detectAuthRequired(doc)) {
          throw new DecisionAdapterError({
            code: "human_required",
            message: "Authentication required after bootstrap waiting recovery",
            suggestedAction: "human_intervention",
          });
        }

        convId = win?.location ? extractFormalConversationIdFromUrl(win.location.href) ?? "" : "";
        if (!convId) {
          throw new DecisionAdapterError({
            code: "execution_failed",
            message: "Failed to extract authoritative conversation ID after bootstrap waiting recovery",
            suggestedAction: "retry",
          });
        }
      }
    } catch (bootstrapErr) {
      if (!signal.aborted) {
        const failure = this.classifyRecoveryFailure(bootstrapErr, {
          message: "Failed waiting for bootstrap response during checkpoint recovery",
        });
        const failRes = await this.submitFailure(task.id, {
          owner: lease.owner,
          token: lease.token,
          generation: lease.generation,
          error: failure.error,
          details: failure.details,
          retryable: failure.retryable,
        }).catch((error: unknown) => { if (error instanceof ExecutionBlocked) throw error; return null; });

        this.checkpointStore.delete();
        if (failRes) {
          return {
            status: "failed",
            failure: failRes.failure,
            receipt: failRes.receipt,
            superseded: failRes.superseded,
            session,
            error: bootstrapErr,
          };
        }
      }
      throw bootstrapErr;
    }

    if (doc) {
      if (detectConversationNotFound(doc)) {
        throw new DecisionAdapterError({
          code: "binding_broken",
          message: "Conversation not found before rebind in resumeBootstrapWaiting",
          suggestedAction: "rebind",
        });
      }
      if (detectAuthRequired(doc)) {
        throw new DecisionAdapterError({
          code: "human_required",
          message: "Authentication required before rebind in resumeBootstrapWaiting",
          suggestedAction: "human_intervention",
        });
      }
    }

    // The reply was read while the tab must still show the conversation this attempt
    // created: a route change during the wait must never re-target the binding.
    const recordedConvId = cp.targetConvId ?? cp.rebindState?.newExternalSessionRef ?? null;
    if (!recordedConvId || isTemporaryConversationRoute(recordedConvId) || convId !== recordedConvId) {
      const failRes = await this.submitFailure(task.id, {
        owner: lease.owner,
        token: lease.token,
        generation: lease.generation,
        error: "human_required",
        details: {
          message: `Bootstrap recovery read a reply from "${convId}" but this attempt recorded "${recordedConvId ?? "no conversation"}"; manual intervention required to avoid binding another conversation`,
        },
        retryable: false,
      });
      this.checkpointStore.delete();
      return {
        status: "failed",
        failure: failRes.failure,
        receipt: failRes.receipt,
        superseded: failRes.superseded,
        session,
        error: new Error("Bootstrap recovery conversation drifted from the recorded created conversation"),
      };
    }

    const origin =
      (this.adapter instanceof ChatGptWebAdapter ? this.adapter.getOrigin() : null) ?? "https://chatgpt.com";
    const resumeUri = buildConversationUrl(convId, origin);
    const expectedGen = session.bindingGeneration;
    const opKey = `driver:${this.ownerId}:${session.id}:rebind:${expectedGen + 1}`;

    this.updateCheckpointStep("rebind_submitting", {
      rebindState: {
        newExternalSessionRef: convId,
        newResumeUri: resumeUri,
        expectedGeneration: expectedGen,
        operationKey: opKey,
      },
    });

    if (expectedGen === 0) {
      const updatedSession = await this.putBinding(session.id, {
        adapter: this.adapter.name,
        externalSessionRef: convId,
        resumeUri,
        owner: lease.owner,
        token: lease.token,
        generation: lease.generation,
      });
      this.saveCheckpoint("claimed", task, updatedSession, lease);
      const context = await this.fetchContext(task.id);
      return await this.executeClaimedTask(task, updatedSession, lease, context);
    } else {
      const updatedSession = await this.rebindSession(session.id, {
        adapter: this.adapter.name,
        externalSessionRef: convId,
        resumeUri,
        expectedGeneration: expectedGen,
        operationKey: opKey,
        owner: lease.owner,
        token: lease.token,
        generation: lease.generation,
      });

      this.checkpointStore.delete();
      return {
        status: "superseded",
        session: updatedSession,
        error: new Error(
          `Task "${task.id}" lease invalidated by session rebind (generation ${updatedSession.bindingGeneration})`
        ),
      };
    }
  }

  private async rebindUnrecoverableSession(
    task: DecisionTask,
    session: DecisionSession,
    lease: DecisionLease,
    reason: string
  ): Promise<TaskExecutionOutcome> {
    this.activeTask = task;
    this.activeSession = session;
    this.activeLease = lease;
    this.activeAbortController = new AbortController();
    const signal = this.activeAbortController.signal;

    this.startHeartbeat(task, lease, () => {
      this.activeAbortController?.abort(this.activeInterruption ?? new DriverInterruption("lease_expired"));
    });

    try {
      try {
        await this.breakBinding(session.id, {
          owner: lease.owner,
          token: lease.token,
          generation: lease.generation,
          expectedGeneration: session.bindingGeneration,
        });
      } catch {
        // CAS/conflict ignored; rebindSession will enforce authority
      }

      let created: DecisionSessionCreationResult;
      try {
        created = await this.adapter.createSession(session, { signal });
      } catch (createErr: unknown) {
        const failure = this.classifyRecoveryFailure(createErr, {
          message: `Failed to create new session during unrecoverable rebind: ${reason}`,
        });
        const failRes = await this.submitFailure(task.id, {
          owner: lease.owner,
          token: lease.token,
          generation: lease.generation,
          error: failure.error,
          details: failure.details,
          retryable: failure.retryable,
        }).catch((error: unknown) => { if (error instanceof ExecutionBlocked) throw error; return null; });

        this.checkpointStore.delete();
        if (failRes) {
          return {
            status: "failed",
            failure: failRes.failure,
            receipt: failRes.receipt,
            superseded: failRes.superseded,
            session,
            error: createErr instanceof Error ? createErr : new Error(String(createErr)),
          };
        }
        throw createErr;
      }

      const expectedGen = session.bindingGeneration;
      const opKey = `driver:${this.ownerId}:${session.id}:rebind:${expectedGen + 1}`;

      const reboundSession = await this.rebindSession(session.id, {
        adapter: created.binding.adapter,
        externalSessionRef: created.binding.externalSessionRef,
        resumeUri: created.binding.resumeUri,
        expectedGeneration: expectedGen,
        operationKey: opKey,
        owner: lease.owner,
        token: lease.token,
        generation: lease.generation,
      });

      this.checkpointStore.delete();

      return {
        status: "superseded",
        session: reboundSession,
        error: new DecisionConflictError(
          `Task "${task.id}" lease invalidated by unrecoverable conversation rebind (${reason}, generation ${reboundSession.bindingGeneration})`
        ),
      };
    } finally {
      this.stopHeartbeat();
      this.activeAbortController = null;
      this.activeTask = null;
      this.activeSession = null;
      this.activeLease = null;
    }
  }

  /**
   * Maps an error raised during checkpoint recovery to the structured failure fields the
   * Decision protocol expects. Typed `DecisionAdapterError` failures keep their own code,
   * suggested action and retryability — the same classification the coordinator applies —
   * so upstream keeps e.g. `human_required` / `human_intervention` as a non-retryable human
   * handoff and `binding_broken` as a rebind signal. Ordinary wait/network errors remain a
   * retryable `execution_failed`.
   */
  private classifyRecoveryFailure(
    err: unknown,
    fallbackDetails: Record<string, unknown>
  ): { error: DecisionAdapterErrorCode; retryable: boolean; details: Record<string, unknown> } {
    if (err instanceof DecisionAdapterError) {
      return {
        error: err.code,
        retryable: err.retryable,
        details: {
          code: err.code,
          message: err.message,
          suggestedAction: err.suggestedAction,
        },
      };
    }
    return { error: "execution_failed", retryable: true, details: fallbackDetails };
  }

  /**
   * Confirms the tab currently shows the exact conversation recorded for this bootstrap
   * attempt. Only a recorded, attempt-specific conversation reference proves association:
   * page content (including the bootstrap prompt) is shared by every Symphony-created
   * conversation, so recovery fails closed without a matching reference.
   */
  private isBootstrapConversationAssociated(cp: DriverCheckpoint): boolean {
    const recordedConvId = cp.targetConvId ?? cp.rebindState?.newExternalSessionRef ?? null;
    const adapterWithAssociation = this.adapter as unknown as {
      isBootstrapConversationAssociated?: (recordedConvId: string | null) => boolean;
    };
    if (typeof adapterWithAssociation.isBootstrapConversationAssociated === "function") {
      return adapterWithAssociation.isBootstrapConversationAssociated(recordedConvId);
    }
    const win =
      (this.adapter instanceof ChatGptWebAdapter ? this.adapter.getWindow() : null) ??
      (globalThis as unknown as { window?: Window }).window;
    return isConversationAssociatedWithBootstrap(win?.location?.href ?? null, recordedConvId);
  }

  private async assertResponseConversation(session: DecisionSession): Promise<void> {
    if (!(this.adapter instanceof ChatGptWebAdapter)) return;
    const doc = this.adapter.getDocument();
    const current = extractFormalConversationIdFromUrl(this.adapter.getWindow()?.location.href ?? "");
    if (session.binding && current === session.binding.externalSessionRef && !detectConversationNotFound(doc) && !detectAuthRequired(doc)) return;
    const cp = this.checkpointStore.get();
    if (!cp) throw new Error("Missing response checkpoint");
    const reason = detectAuthRequired(doc) ? "auth_required" : "human_required";
    await this.transport.request("POST", `/v1/tasks/${encodeURIComponent(cp.taskId)}/block`, {
      owner: cp.leaseOwner, token: cp.leaseToken, generation: cp.leaseGeneration, reason,
    });
    throw new ExecutionBlocked(session, reason);
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

    await this.assertResponseConversation(session);
    let execution: { result: DecisionResult };
    try {
      execution = await adapterWithWait.waitForExistingResponse!(task, {
        baselineCount,
        signal,
      });
    } catch (modelErr) {
      if (!signal.aborted) {
        const failure = this.classifyRecoveryFailure(modelErr, {
          message: "Failed waiting for response during checkpoint recovery",
        });
        const failRes = await this.submitFailure(task.id, {
          owner: lease.owner,
          token: lease.token,
          generation: lease.generation,
          error: failure.error,
          details: failure.details,
          retryable: failure.retryable,
        }).catch((error: unknown) => { if (error instanceof ExecutionBlocked) throw error; return null; });

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
      throw signal.aborted ? signal.reason ?? modelErr : modelErr;
    }

    await this.assertResponseConversation(session);
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
        .catch((error: unknown) => { if (error instanceof ExecutionBlocked) throw error; return null; });

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
      this.activeAbortController?.abort(this.activeInterruption ?? new DriverInterruption("lease_expired"));
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

      if (outcome.status === "failed") this.diagnose({ stage: "task_failed", taskId: task.id, kind: task.kind, revision: task.revision });

      // Clear checkpoint only on terminal success or recorded failure
      this.checkpointStore.delete();
      return outcome;
    } catch (err: unknown) {
      if (err instanceof ExecutionBlocked) return { status: "blocked", session: err.session, reason: err.reason };
      // Expected supersede/cancel race: the bridge rejected the result or failure
      // submission because the task became non-actionable while executing (e.g. a
      // newer PR HEAD superseded this review task). The stale outcome is correctly
      // not accepted; recover by dropping local state and letting newer tasks take
      // over, instead of surfacing the conflict as a fatal driver error.
      const supersededOutcome = await this.resolveSupersededOutcome(task.id, session, err);
      if (supersededOutcome) {
        return supersededOutcome;
      }
      // If error is an abort (e.g. from page navigation or timeout), preserve checkpoint for reload recovery
      if (signal.aborted) {
        throw err;
      }
      // If candidate result exists, currently navigating, or submitting rebind, DO NOT delete checkpoint so it can be recovered
      const currentCp = this.checkpointStore.get();
      if (
        currentCp?.step === "waiting_response" ||
        currentCp?.step === "prompt_submitting" ||
        currentCp?.candidateResult ||
        currentCp?.step === "result_extracted" ||
        currentCp?.step === "navigating" ||
        currentCp?.step === "rebind_submitting" ||
        currentCp?.step === "bootstrap_submitting" ||
        currentCp?.step === "bootstrap_waiting"
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

  /**
   * After a 409 conflict from result/failure submission, verify the authoritative task
   * status on the bridge. If the task is superseded or cancelled, the conflict is the
   * expected terminal race and resolves to a superseded outcome; otherwise returns null
   * so the original error propagates.
   */
  private async resolveSupersededOutcome(
    taskId: string,
    session: DecisionSession,
    err: unknown
  ): Promise<TaskExecutionSupersededOutcome | null> {
    if (!(err instanceof BridgeHttpError) || err.status !== 409) {
      return null;
    }
    let fresh: DecisionTask | null = null;
    try {
      const res = await this.transport.request<{ task: DecisionTask }>(
        "GET",
        `/v1/tasks/${encodeURIComponent(taskId)}`
      );
      fresh = res?.task ?? null;
    } catch {
      // Authoritative status unverifiable; treat the conflict as unexpected
      return null;
    }
    if (fresh?.status !== "superseded" && fresh?.status !== "cancelled") {
      return null;
    }
    this.checkpointStore.delete();
    return { status: "superseded", session, error: err };
  }

  async runOnce(): Promise<TaskExecutionOutcome | null> {
    try { return await this.runOnceObserved(); }
    catch (err) {
      if (err instanceof ExecutionBlocked) return { status: "blocked", session: err.session, reason: err.reason };
      const cp = this.checkpointStore.get();
      if (cp) this.checkpointStore.set({ ...cp, recoveryFailures: Math.min(DECISION_MAX_TRANSPORT_RECOVERIES, (cp.recoveryFailures ?? 0) + 1) });
      throw err;
    }
  }

  private async runOnceObserved(): Promise<TaskExecutionOutcome | null> {
    // 1. Check for recoverable checkpoint first
    const resumed = await this.resumeCheckpointIfAvailable();
    if (resumed) return resumed;

    // If an in-progress or retryable checkpoint is still retained in the store (e.g. rebind retry, navigating),
    // prevent claiming new tasks which would overwrite or corrupt the tab checkpoint
    if (this.checkpointStore.get()) {
      return null;
    }

    // 2. Poll & claim next task
    const claimed = await this.claimNextTask();
    if (!claimed) {
      // #162 / SPEC §13 adjacent: a restored page can have no checkpoint while
      // native work still owns a lease or a durable block. Surface facts without adoption.
      if (this.onContinuity) {
        const response = await this.transport.request<{ work: DecisionContinuityWork[] }>("GET", "/v1/continuity");
        this.onContinuity(response.work);
      }
      return null;
    }

    // 3. Fetch context
    const context = await this.fetchContext(claimed.task.id);

    // 4. Execute
    const outcome = await this.executeClaimedTask(claimed.task, claimed.session, claimed.lease, context);
    if (outcome && outcome.status === "superseded") {
      // Rollover invalidation fences the current task; immediately re-poll to reclaim under new generation
      this.checkpointStore.delete();
      this.stopHeartbeat();
      const nextClaimed = await this.claimNextTask();
      if (nextClaimed) {
        const nextContext = await this.fetchContext(nextClaimed.task.id);
        return await this.executeClaimedTask(nextClaimed.task, nextClaimed.session, nextClaimed.lease, nextContext);
      }
    }
    return outcome;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    while (this.isRunning) {
      if (this.shouldRun && !this.shouldRun()) { this.stop(); break; }
      try {
        const outcome = await this.runOnce();
        if (outcome?.status === "blocked") this.onError?.(new Error(`Blocked: ${outcome.reason}`));
      } catch (err: unknown) {
        if (!this.isRunning) break;
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
    if (this.activeTask && !this.activeAbortController?.signal.aborted) this.recordInterruption(this.activeTask, new DriverInterruption("manual_stop"));
    this.stopHeartbeat();
    this.activeAbortController?.abort(this.activeInterruption ?? new DriverInterruption("lease_expired"));
    this.activeAbortController = null;
    this.activeTask = null;
    this.activeSession = null;
    this.activeLease = null;
  }
}
