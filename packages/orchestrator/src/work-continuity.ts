/**
 * Work-level liveness and stranded-state reconciliation coordinator (NEST-137 / GitHub #147).
 *
 * Scope: for every supported active `WorkKey`, re-observe authoritative facts, derive the
 * expected next action and its owner, validate ownership/liveness/generation, choose one
 * bounded recovery class, and delegate the mutation to the authority that already owns it.
 * Then re-observe to confirm convergence.
 *
 * Deliberate boundaries (root `AGENTS.md`, issue #147 "Authority boundary"):
 *
 * - **No second lifecycle.** This module owns no durable work state; it derives verdicts
 *   from facts that the tracker, orchestrator runtime, Decision store, executor and Delivery
 *   already own.
 * - **No source mutation.** `recover()` is always called on an injected authority port. The
 *   coordinator never writes a runtime `Map`, a Decision store, or a Delivery file.
 * - **No blind replay.** Every delegation carries `requiresReobserve: true`; the coordinator
 *   re-reads the same facts immediately before acting and abandons the plan when anything
 *   changed. A failed post-action read is reported `unverified`, never retried here.
 * - **No duplicate recovery.** An already-scheduled retry/recovery is `retry_scheduled` and
 *   is never enqueued twice; concurrent reconciliations of the same key are single-flight.
 * - **Fail safe.** An unavailable required source keeps current ownership untouched.
 *
 * The pure derivation itself lives in `@symphony/domain` (`deriveWorkContinuity`) so the
 * classification stays provider-neutral and reusable by read-only consumers.
 */
import type {
  UtcTimestampMs,
  WorkContinuityObservation,
  WorkContinuityVerdict,
  WorkKey,
  WorkRecoveryClass,
  WorkRecoveryDecision,
} from "@symphony/domain";
import {
  DEFAULT_WORK_CONTINUITY_POLICY,
  deriveWorkContinuity,
  validateWorkContinuityObservation,
  workContinuityFingerprint,
  type WorkContinuityPolicy,
} from "@symphony/domain";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Work items that reconciliation must cover on this pass. */
export interface WorkContinuityScanSource {
  /**
   * Returns the current active work set. Implementations MUST include work that has no
   * running worker (that is the whole point of work-level reconciliation) and MUST NOT
   * return cached projections as if they were fresh facts.
   */
  listWorkKeys(): Promise<readonly WorkKey[]>;
}

/** Fresh authoritative observation for one work item. */
export interface WorkContinuityObservationSource {
  /**
   * Reads every source needed for the work item. May throw; throwing is treated as a
   * failed observation (fail safe), never as "there is no owner".
   */
  observe(workKey: WorkKey): Promise<WorkContinuityObservation>;
}

/** A recovery delegation handed to the authority that owns the mutation. */
export interface WorkRecoveryRequest {
  readonly workKey: WorkKey;
  readonly recovery: WorkRecoveryDecision;
  /** Verdict that produced this request (already re-validated against fresh facts). */
  readonly verdict: WorkContinuityVerdict;
  /** Stable key derived from the verdict; lets an authority deduplicate repeats. */
  readonly idempotencyKey: string;
}

/**
 * Result of one delegation attempt.
 *
 * `refused` means the authority's own commit-time fence rejected the request (stale
 * generation, lease renewed, concurrent owner). That is a healthy outcome, not an error:
 * the coordinator must not retry it in the same pass.
 */
export type WorkRecoveryOutcome =
  | { readonly kind: "applied"; readonly detail?: string | undefined }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Source-authority recovery port. One instance per authority name. */
export interface WorkRecoveryAuthority {
  /** Authority name this adapter mutates (`orchestrator`, `decision`, `delivery`). */
  readonly authority: string;
  recover(request: WorkRecoveryRequest): Promise<WorkRecoveryOutcome>;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type WorkContinuityEntryAction =
  | "none"
  | "delegated"
  | "skipped_concurrent"
  | "skipped_stopped"
  | "skipped_facts_changed"
  | "skipped_duplicate"
  | "authority_unavailable"
  | "refused"
  | "unverified"
  | "observation_failed";

export interface WorkContinuityEntryResult {
  readonly workKey: WorkKey;
  readonly diagnosis: WorkContinuityVerdict["diagnosis"];
  readonly strandedReason: WorkContinuityVerdict["strandedReason"];
  readonly recoveryClass: WorkRecoveryClass | null;
  readonly authority: string | null;
  readonly action: WorkContinuityEntryAction;
  readonly detail: string;
}

export interface WorkContinuityReconciliationResult {
  readonly observedAt: UtcTimestampMs;
  readonly scannedWorkKeys: readonly WorkKey[];
  readonly entries: readonly WorkContinuityEntryResult[];
  /** Work items classified stranded on first observation. */
  readonly strandedWorkKeys: readonly WorkKey[];
  /** Delegations actually attempted (one per key at most). */
  readonly recoveryAttempts: number;
  readonly failures: number;
}

/** Operator-visible diagnostic; never a control path. */
export interface WorkContinuityDiagnostic {
  readonly kind:
    | "scan_failed"
    | "observation_failed"
    | "observation_invalid"
    | "recovery_refused"
    | "recovery_unavailable"
    | "reobserve_failed"
    | "post_action_unverified";
  readonly workKey: WorkKey | null;
  readonly message: string;
}

export interface WorkContinuityCoordinatorOptions {
  readonly scan: WorkContinuityScanSource;
  readonly observer: WorkContinuityObservationSource;
  /** Authority adapters keyed by `authority`. Missing authority = no safe action. */
  readonly authorities: readonly WorkRecoveryAuthority[];
  readonly now: () => UtcTimestampMs;
  readonly policy?: WorkContinuityPolicy | undefined;
  readonly onDiagnostic?: ((diagnostic: WorkContinuityDiagnostic) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

/**
 * Thin reconciliation coordinator. `reconcileOnce()` is safe to call repeatedly and
 * concurrently: repeated calls over unchanged facts classify identically and produce no
 * further delegations once the owning authority has changed the facts.
 */
export class WorkContinuityCoordinator {
  private readonly scan: WorkContinuityScanSource;
  private readonly observer: WorkContinuityObservationSource;
  private readonly authorities: ReadonlyMap<string, WorkRecoveryAuthority>;
  private readonly now: () => UtcTimestampMs;
  private readonly policy: WorkContinuityPolicy;
  private readonly onDiagnostic: ((diagnostic: WorkContinuityDiagnostic) => void) | undefined;

  /**
   * Per-work-item in-flight guard. A second reconciliation of the same key while one is
   * running is skipped, so two passes can never both decide to recover the same work item
   * and race to create two owners.
   */
  private readonly inFlight = new Map<
    string,
    Promise<{
      readonly result: WorkContinuityEntryResult;
      readonly attempted: boolean;
      readonly failed: boolean;
    }>
  >();

  /**
   * Set **synchronously** by {@link stop}. Once closed, no new work item is scanned and no
   * delegation is started; delegations already in flight are awaited by `stop()`.
   */
  private closed = false;

  /**
   * Last delegation per work item. An identical fingerprint inside
   * `policy.repeatSuppressionMs` is not re-issued: the authority has not yet published
   * changed facts, so repeating the same command can only create duplicate scheduling.
   */
  private readonly recentDelegations = new Map<
    string,
    { readonly fingerprint: string; readonly at: UtcTimestampMs }
  >();

  public constructor(options: WorkContinuityCoordinatorOptions) {
    this.scan = options.scan;
    this.observer = options.observer;
    this.authorities = new Map(
      options.authorities.map((authority) => [authority.authority, authority]),
    );
    this.now = options.now;
    this.policy = options.policy ?? DEFAULT_WORK_CONTINUITY_POLICY;
    this.onDiagnostic = options.onDiagnostic;
  }

  /**
   * Closes recovery admission synchronously and waits for in-flight delegations.
   *
   * Called from `OrchestratorLoop.stop()` before the in-flight tick is awaited, so a
   * `stop()` racing with an in-progress reconciliation cannot start a new recovery after
   * shutdown was requested. Idempotent.
   */
  public async stop(): Promise<void> {
    this.closed = true;
    const pending = [...this.inFlight.values()];
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
  }

  /** Whether recovery admission has been closed by {@link stop}. */
  public get stopped(): boolean {
    return this.closed;
  }

  public async reconcileOnce(): Promise<WorkContinuityReconciliationResult> {
    const observedAt = this.now();
    const entries: WorkContinuityEntryResult[] = [];
    const strandedWorkKeys: WorkKey[] = [];
    let scannedWorkKeys: readonly WorkKey[] = [];

    try {
      scannedWorkKeys = await this.scan.listWorkKeys();
    } catch (error) {
      this.emit({
        kind: "scan_failed",
        workKey: null,
        message: describeError(error),
      });
      return {
        observedAt,
        scannedWorkKeys: [],
        entries,
        strandedWorkKeys,
        recoveryAttempts: 0,
        failures: 1,
      };
    }

    let recoveryAttempts = 0;
    let failures = 0;

    for (const workKey of scannedWorkKeys) {
      if (this.closed) {
        break;
      }
      const entry = await this.reconcileWorkKey(workKey);
      entries.push(entry.result);
      // A recovery decision only exists for genuinely stranded work, so it marks the
      // work item as stranded even when the post-action verdict has already converged.
      if (entry.result.diagnosis === "stranded" || entry.result.recoveryClass !== null) {
        strandedWorkKeys.push(workKey);
      }
      if (entry.attempted) {
        recoveryAttempts += 1;
      }
      if (entry.failed) {
        failures += 1;
      }
    }

    return { observedAt, scannedWorkKeys, entries, strandedWorkKeys, recoveryAttempts, failures };
  }

  /**
   * One work item: observe → derive → (if stranded) re-observe → delegate → re-observe.
   *
   * Every step is isolated so a single failing work item cannot abort the pass.
   */
  private async reconcileWorkKey(workKey: WorkKey): Promise<{
    readonly result: WorkContinuityEntryResult;
    readonly attempted: boolean;
    readonly failed: boolean;
  }> {
    const keyId = workKeyId(workKey);
    if (this.closed) {
      return stoppedEntry(workKey);
    }
    if (this.inFlight.has(keyId)) {
      return {
        result: {
          workKey,
          diagnosis: "healthy",
          strandedReason: null,
          recoveryClass: null,
          authority: null,
          action: "skipped_concurrent",
          detail: "another reconciliation for this work item is already in flight",
        },
        attempted: false,
        failed: false,
      };
    }

    const running = this.runWorkKey(workKey);
    this.inFlight.set(keyId, running);
    try {
      return await running;
    } finally {
      if (this.inFlight.get(keyId) === running) {
        this.inFlight.delete(keyId);
      }
    }
  }

  private async runWorkKey(workKey: WorkKey): Promise<{
    readonly result: WorkContinuityEntryResult;
    readonly attempted: boolean;
    readonly failed: boolean;
  }> {
    const first = await this.observeAndDerive(workKey);
    if (!first.ok) {
      return {
        result: entryResult(workKey, null, "observation_failed", first.detail),
        attempted: false,
        failed: true,
      };
    }

    const verdict = first.verdict;
    if (verdict.recovery === null) {
      return {
        result: entryResult(workKey, verdict, "none", verdict.detail),
        attempted: false,
        failed: false,
      };
    }

    const authority = this.authorities.get(verdict.recovery.authority);
    if (authority === undefined) {
      this.emit({
        kind: "recovery_unavailable",
        workKey,
        message: `no recovery authority adapter registered for '${verdict.recovery.authority}'`,
      });
      return {
        result: entryResult(
          workKey,
          verdict,
          "authority_unavailable",
          `no safe recovery path: authority '${verdict.recovery.authority}' is not wired`,
        ),
        attempted: false,
        failed: true,
      };
    }

    // Re-observe immediately before acting: a fact change (owner heartbeat, new retry,
    // newer generation, HEAD change) invalidates the stale plan instead of replaying it.
    const second = await this.observeAndDerive(workKey);
    if (!second.ok) {
      this.emit({ kind: "reobserve_failed", workKey, message: second.detail });
      return {
        result: entryResult(
          workKey,
          verdict,
          "unverified",
          `pre-action re-observation failed: ${second.detail}; no recovery attempted`,
        ),
        attempted: false,
        failed: true,
      };
    }
    if (second.verdict.recovery === null) {
      return {
        result: entryResult(
          workKey,
          second.verdict,
          "skipped_facts_changed",
          `facts changed before action: ${second.verdict.detail}`,
        ),
        attempted: false,
        failed: false,
      };
    }
    const firstFingerprint = workContinuityFingerprint(verdict);
    const secondFingerprint = workContinuityFingerprint(second.verdict);
    if (firstFingerprint !== secondFingerprint) {
      return {
        result: entryResult(
          workKey,
          second.verdict,
          "skipped_facts_changed",
          "facts changed between decision and action; the stale recovery plan was abandoned",
        ),
        attempted: false,
        failed: false,
      };
    }

    const recovery = second.verdict.recovery;

    // `stop()` may have run while the pre-action re-observation was awaiting.
    if (this.closed) {
      return stoppedEntry(workKey);
    }

    const now = this.now();
    const previous = this.recentDelegations.get(workKeyId(workKey));
    if (
      previous !== undefined &&
      previous.fingerprint === secondFingerprint &&
      now - previous.at < Math.max(0, this.policy.repeatSuppressionMs)
    ) {
      return {
        result: entryResult(
          workKey,
          second.verdict,
          "skipped_duplicate",
          "an identical recovery was already delegated for unchanged facts; not repeated",
        ),
        attempted: false,
        failed: false,
      };
    }

    // Record **before** calling: the side effect may commit while the response is lost.
    // An uncertain outcome must never be replayed just because the promise rejected.
    this.recentDelegations.set(workKeyId(workKey), { fingerprint: secondFingerprint, at: now });

    let outcome: WorkRecoveryOutcome;
    try {
      outcome = await authority.recover({
        workKey,
        recovery,
        verdict: second.verdict,
        idempotencyKey: secondFingerprint,
      });
    } catch (error) {
      this.emit({
        kind: "recovery_refused",
        workKey,
        message: `authority '${authority.authority}' threw: ${describeError(error)}`,
      });
      // The mutation may have committed before the failure surfaced. Re-read the
      // authority's facts to report honestly, but never replay the side effect here.
      const afterThrow = await this.observeAndDerive(workKey);
      const observed = afterThrow.ok
        ? `post-failure observation: ${afterThrow.verdict.diagnosis}`
        : `post-failure observation also failed: ${afterThrow.detail}`;
      if (!afterThrow.ok) {
        this.emit({ kind: "post_action_unverified", workKey, message: afterThrow.detail });
      }
      return {
        result: entryResult(
          workKey,
          second.verdict,
          "unverified",
          `authority '${authority.authority}' failed: ${describeError(error)}; result is unverified; ${observed}; the same delegation will not be repeated before the suppression window elapses`,
        ),
        attempted: true,
        failed: true,
      };
    }

    if (outcome.kind === "refused" || outcome.kind === "unavailable") {
      this.emit({
        kind: outcome.kind === "refused" ? "recovery_refused" : "recovery_unavailable",
        workKey,
        message: outcome.reason,
      });
      return {
        result: entryResult(
          workKey,
          second.verdict,
          outcome.kind === "refused" ? "refused" : "authority_unavailable",
          outcome.reason,
        ),
        attempted: true,
        failed: outcome.kind === "unavailable",
      };
    }
    if (outcome.kind === "skipped") {
      return {
        result: entryResult(workKey, second.verdict, "skipped_facts_changed", outcome.reason),
        attempted: true,
        failed: false,
      };
    }

    // Post-action re-observation: report convergence honestly. A failed read is
    // `unverified`; the coordinator never replays the side effect to "confirm" it.
    const third = await this.observeAndDerive(workKey);
    if (!third.ok) {
      this.emit({
        kind: "post_action_unverified",
        workKey,
        message: third.detail,
      });
      return {
        result: entryResult(
          workKey,
          second.verdict,
          "unverified",
          `recovery delegated to '${authority.authority}' but post-action re-observation failed: ${third.detail}`,
        ),
        attempted: true,
        failed: true,
      };
    }

    return {
      result: entryResult(
        workKey,
        second.verdict,
        "delegated",
        `recovery '${recovery.class}' delegated to '${authority.authority}'; now ${third.verdict.diagnosis}`,
      ),
      attempted: true,
      failed: false,
    };
  }

  private async observeAndDerive(
    workKey: WorkKey,
  ): Promise<
    | { readonly ok: true; readonly verdict: WorkContinuityVerdict }
    | { readonly ok: false; readonly detail: string }
  > {
    let observation: WorkContinuityObservation;
    try {
      observation = await this.observer.observe(workKey);
    } catch (error) {
      this.emit({ kind: "observation_failed", workKey, message: describeError(error) });
      return { ok: false, detail: describeError(error) };
    }

    const validation = validateWorkContinuityObservation(observation);
    if (!validation.valid) {
      this.emit({ kind: "observation_invalid", workKey, message: validation.reason });
      return { ok: false, detail: `invalid observation: ${validation.reason}` };
    }

    return { ok: true, verdict: deriveWorkContinuity(observation, this.policy) };
  }

  private emit(diagnostic: WorkContinuityDiagnostic): void {
    try {
      this.onDiagnostic?.(diagnostic);
    } catch {
      /* Observation never changes control flow. */
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function workKeyId(workKey: WorkKey): string {
  return `${workKey.provider}:${workKey.key}`;
}

function stoppedEntry(workKey: WorkKey): {
  readonly result: WorkContinuityEntryResult;
  readonly attempted: boolean;
  readonly failed: boolean;
} {
  return {
    result: {
      workKey,
      diagnosis: "healthy",
      strandedReason: null,
      recoveryClass: null,
      authority: null,
      action: "skipped_stopped",
      detail: "reconciliation was stopped before this work item could be recovered",
    },
    attempted: false,
    failed: false,
  };
}

function entryResult(
  workKey: WorkKey,
  verdict: WorkContinuityVerdict | null,
  action: WorkContinuityEntryAction,
  detail: string,
): WorkContinuityEntryResult {
  return {
    workKey,
    diagnosis: verdict?.diagnosis ?? "observation_unavailable",
    strandedReason: verdict?.strandedReason ?? null,
    recoveryClass: verdict?.recovery?.class ?? null,
    authority: verdict?.recovery?.authority ?? null,
    action,
    detail,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
