/**
 * @symphony/domain — Work-level liveness and stranded-state derivation (NEST-137 / GitHub #147).
 *
 * Builds on the continuity contracts from NEST-130 / GitHub #146. This module adds the
 * minimum provider-neutral observation and derivation vocabulary needed to answer, for one
 * active {@link WorkKey}:
 *
 * - what must happen next;
 * - which authority owns it;
 * - whether that owner is observable and making measurable progress;
 * - whether a recovery is already scheduled;
 * - whether the work is explicitly blocked or legitimately waiting externally;
 * - whether the current state is stranded or contradictory.
 *
 * Everything here is a **pure derivation over authoritative facts**. No source store is
 * mutated, no second workflow lifecycle is introduced, and no provider-specific object
 * leaks into the model. Recovery is delegated to the authority that already owns the
 * mutation; this module only classifies.
 *
 * Liveness rule: process existence and heartbeats are **not** progress. When the progress
 * evidence available cannot prove forward movement the result is `"unknown"`; it is never
 * fabricated from `observedAt` or from a heartbeat timestamp.
 */

import type { UtcTimestampMs } from "./time";
import type { WorkKey } from "./operations-facts";
import type { DecisionReviewTarget, DecisionTaskStatus } from "./decision";
import type {
  ActionAuthority,
  BlockedReasonDetails,
  ExpectedNextAction,
  RecoveryAction,
  SafeOwnershipFence,
} from "./execution-continuity";

// ---------------------------------------------------------------------------
// 1. Observation sources
// ---------------------------------------------------------------------------

/**
 * Provider-neutral source classes that can contribute authoritative work facts.
 * `tracker` is the work-item source of truth; the others are stage-owned authorities.
 */
export type WorkObservationSourceKind =
  | "tracker"
  | "github"
  | "runtime"
  | "decision"
  | "executor"
  | "delivery";

export const WORK_OBSERVATION_SOURCE_KINDS = [
  "tracker",
  "github",
  "runtime",
  "decision",
  "executor",
  "delivery",
] as const satisfies readonly WorkObservationSourceKind[];

/**
 * Result of trying to read one source. `unavailable` never means "nothing there"; it means
 * the read failed, so any derivation that needs it MUST fail safe instead of inventing an
 * absence of ownership.
 */
export interface WorkSourceObservation {
  readonly source: WorkObservationSourceKind;
  readonly status: "ok" | "unavailable";
  readonly observedAt: UtcTimestampMs;
  /** Stable machine-readable reason when `status === "unavailable"`. */
  readonly reason?: string | undefined;
}

// ---------------------------------------------------------------------------
// 2. Stage and owner facts
// ---------------------------------------------------------------------------

/** Supported active stages that can own work-level continuation. */
export type WorkStage = "planning" | "coding" | "ci" | "review" | "repair" | "delivery" | "merge";

export const WORK_STAGES = [
  "planning",
  "coding",
  "ci",
  "review",
  "repair",
  "delivery",
  "merge",
] as const satisfies readonly WorkStage[];

/**
 * Whether the execution surface behind an owner was actually observed.
 *
 * `present` only proves the surface exists. It is deliberately NOT progress evidence.
 */
export type WorkOwnerPresence = "present" | "absent" | "unknown";

/**
 * The authority that currently holds execution responsibility for a work item.
 * The fence carries the credentials a recovery must present at commit time.
 */
export interface WorkOwnerFacts {
  /** Subsystem authority, e.g. `orchestrator`, `decision`, `delivery`. */
  readonly authority: string;
  /** Optional concrete executor, e.g. `codex-agent`, `chatgpt-web`. */
  readonly executor?: string | undefined;
  readonly presence: WorkOwnerPresence;
  readonly fence: SafeOwnershipFence;
}

// ---------------------------------------------------------------------------
// 3. Liveness facts
// ---------------------------------------------------------------------------

/**
 * Objective liveness inputs for the currently owned action.
 *
 * `lastProgressAt` is the last **forward progress** instant, not the last heartbeat and not
 * the last poll. `deadlineAt` is the instant after which the owner is considered to have
 * stopped making meaningful progress (strictly greater means expired).
 */
export interface WorkLivenessFacts {
  readonly startedAt: UtcTimestampMs;
  readonly lastProgressAt: UtcTimestampMs | "unknown";
  /** Stable evidence kind that produced `lastProgressAt` (diagnostics only). */
  readonly progressSource?: string | undefined;
  readonly deadlineAt?: UtcTimestampMs | undefined;
}

/** Evaluated liveness for one owned action. */
export interface WorkLivenessEvaluation {
  /** Whether the available evidence can measure forward progress at all. */
  readonly measured: boolean;
  readonly lastProgressAt: UtcTimestampMs | "unknown";
  readonly elapsedSinceProgressMs: number | null;
  /** Strictly past `deadlineAt` at observation time. */
  readonly deadlineExceeded: boolean;
}

// ---------------------------------------------------------------------------
// 4. Scheduled recovery facts
// ---------------------------------------------------------------------------

/**
 * A recovery that an authority has **already scheduled**, proven by a live scheduler
 * credential. Reconciliation must not enqueue a second one.
 */
export interface ScheduledRecoveryFacts {
  readonly kind: "retry" | "recovery" | "lease_reclaim" | "compensation";
  readonly authority: string;
  readonly scheduledAt: UtcTimestampMs;
  /** Wall-clock due instant when the authority can expose one; `null` when only "armed". */
  readonly dueAt: UtcTimestampMs | null;
  /** Opaque scheduler credential; presence proves a real entry exists. */
  readonly credential: string;
}

/** Evaluated scheduled-recovery state, distinguishing armed / due / overdue. */
export interface ScheduledRecoveryEvaluation {
  readonly kind: ScheduledRecoveryFacts["kind"];
  readonly authority: string;
  readonly dueAt: UtcTimestampMs | null;
  readonly due: boolean;
  /** Due for longer than the caller-supplied grace window. */
  readonly overdue: boolean;
}

// ---------------------------------------------------------------------------
// 5. Legitimate external waits
// ---------------------------------------------------------------------------

/** A legitimate wait on an external system or a human, distinct from `blocked`. */
export interface WorkExternalWaitFacts {
  readonly authority: Extract<ActionAuthority, { kind: "external" } | { kind: "human" }>;
  readonly since: UtcTimestampMs;
  readonly deadlineAt?: UtcTimestampMs | undefined;
}

// ---------------------------------------------------------------------------
// 6. Contradictions
// ---------------------------------------------------------------------------

export type WorkContradictionCode =
  | "missing_expected_action"
  | "multiple_owners"
  | "owner_stage_mismatch"
  | "blocked_with_live_owner"
  | "progress_without_owner"
  | "stale_generation_progress";

export const WORK_CONTRADICTION_CODES = [
  "missing_expected_action",
  "multiple_owners",
  "owner_stage_mismatch",
  "blocked_with_live_owner",
  "progress_without_owner",
  "stale_generation_progress",
] as const satisfies readonly WorkContradictionCode[];

export interface WorkContradiction {
  readonly code: WorkContradictionCode;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// 7. Observation
// ---------------------------------------------------------------------------

/**
 * The complete authoritative-fact snapshot for one work item at one instant.
 *
 * Callers MUST build this from a fresh read of each source; cached projections are not a
 * substitute. `requiredSources` names the sources whose availability is a precondition for
 * deriving anything safe about this work item.
 */
export interface WorkContinuityObservation {
  readonly workKey: WorkKey;
  readonly observedAt: UtcTimestampMs;
  /** Whether the tracker still reports the work item as active. */
  readonly active: boolean;
  readonly stage: WorkStage;
  readonly expectedAction: ExpectedNextAction | null;
  readonly owner: WorkOwnerFacts | null;
  readonly liveness: WorkLivenessFacts;
  readonly scheduledRecovery: ScheduledRecoveryFacts | null;
  readonly externalWait: WorkExternalWaitFacts | null;
  readonly blocked: BlockedReasonDetails | null;
  readonly sources: readonly WorkSourceObservation[];
  readonly requiredSources: readonly WorkObservationSourceKind[];
  readonly contradictions?: readonly WorkContradiction[] | undefined;
  /** Work-level fence (e.g. expected HEAD) used to bind recovery requests. */
  readonly fence?: SafeOwnershipFence | undefined;
}

// ---------------------------------------------------------------------------
// 8. Diagnosis
// ---------------------------------------------------------------------------

/**
 * Provider-neutral work-level diagnosis.
 *
 * `blocked`, `awaiting_external`, `retry_scheduled` and `stranded` are deliberately
 * distinct: only `stranded` permits an automatic recovery delegation.
 */
export type WorkContinuityDiagnosis =
  | "healthy"
  | "awaiting_external"
  | "blocked"
  | "retry_scheduled"
  | "stranded"
  | "contradictory"
  | "observation_unavailable"
  | "terminal";

export const WORK_CONTINUITY_DIAGNOSES = [
  "healthy",
  "awaiting_external",
  "blocked",
  "retry_scheduled",
  "stranded",
  "contradictory",
  "observation_unavailable",
  "terminal",
] as const satisfies readonly WorkContinuityDiagnosis[];

/** Why an active work item is stranded. */
export type StrandedReason =
  | "missing_owner"
  | "owner_not_observable"
  | "owner_progress_timeout"
  | "owner_stage_mismatch"
  | "unowned_next_stage";

export const STRANDED_REASONS = [
  "missing_owner",
  "owner_not_observable",
  "owner_progress_timeout",
  "owner_stage_mismatch",
  "unowned_next_stage",
] as const satisfies readonly StrandedReason[];

/**
 * Bounded recovery class. Every class is executed by the authority that already owns the
 * corresponding mutation — the coordinator never writes a source store itself.
 */
export type WorkRecoveryClass =
  | "dispatch"
  | "resume"
  | "retry"
  | "rebind"
  | "reclaim"
  | "compensate"
  | "await_external"
  | "require_human";

export const WORK_RECOVERY_CLASSES = [
  "dispatch",
  "resume",
  "retry",
  "rebind",
  "reclaim",
  "compensate",
  "await_external",
  "require_human",
] as const satisfies readonly WorkRecoveryClass[];

/** The bounded recovery a stranded work item should have delegated. */
export interface WorkRecoveryDecision {
  readonly class: WorkRecoveryClass;
  /** Name of the authority that must perform the mutation. */
  readonly authority: string;
  readonly reason: StrandedReason;
  /** Expected fence the authority re-validates at commit time. */
  readonly expectedFence: SafeOwnershipFence;
  /** Re-observe and re-decide instructions; never a blind replay of a prior command. */
  readonly requiresReobserve: true;
}

// ---------------------------------------------------------------------------
// 9. Verdict
// ---------------------------------------------------------------------------

export interface WorkContinuityVerdict {
  readonly workKey: WorkKey;
  readonly observedAt: UtcTimestampMs;
  readonly stage: WorkStage;
  readonly diagnosis: WorkContinuityDiagnosis;
  readonly strandedReason: StrandedReason | null;
  readonly expectedAction: ExpectedNextAction | null;
  readonly owner: WorkOwnerFacts | null;
  readonly liveness: WorkLivenessEvaluation;
  readonly scheduledRecovery: ScheduledRecoveryEvaluation | null;
  readonly contradictions: readonly WorkContradiction[];
  /** Non-null only for `stranded`; `contradictory` never auto-selects an owner. */
  readonly recovery: WorkRecoveryDecision | null;
  /** Human-readable explanation of the diagnosis. */
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// 10. Derivation policy
// ---------------------------------------------------------------------------

export interface WorkContinuityPolicy {
  /**
   * Grace window after `scheduledRecovery.dueAt` before the entry is reported `overdue`.
   * An overdue entry is still "already scheduled" and MUST NOT be duplicated.
   */
  readonly scheduledRecoveryGraceMs: number;
  /**
   * Maximum age of `lastProgressAt` when no explicit `deadlineAt` exists. `0` disables the
   * fallback so progress evidence stays `unknown` instead of being guessed.
   */
  readonly progressTimeoutMs: number;
  /**
   * How long a coordinator suppresses an identical recovery delegation for the same work
   * item. Protects against repeated passes re-issuing the same command while the owning
   * authority has not yet published changed facts. `0` disables suppression; the authority
   * commit-time fence always remains the real guarantee.
   */
  readonly repeatSuppressionMs: number;
}

export const DEFAULT_WORK_CONTINUITY_POLICY: WorkContinuityPolicy = {
  scheduledRecoveryGraceMs: 30_000,
  progressTimeoutMs: 0,
  repeatSuppressionMs: 30_000,
};

// ---------------------------------------------------------------------------
// 11. Pure evaluation helpers
// ---------------------------------------------------------------------------

/** Sources that returned `unavailable` in this observation. */
export function unavailableSources(
  observation: WorkContinuityObservation,
): readonly WorkSourceObservation[] {
  return observation.sources.filter((source) => source.status === "unavailable");
}

/**
 * Required sources that were never observed at all.
 *
 * A key source that was not read is not evidence that the work has no owner. Missing
 * required sources are therefore treated exactly like an unavailable read.
 */
export function missingRequiredSources(
  observation: WorkContinuityObservation,
): readonly WorkObservationSourceKind[] {
  const observed = new Set(observation.sources.map((source) => source.source));
  return observation.requiredSources.filter((kind) => !observed.has(kind));
}

/**
 * Evaluates liveness without inventing evidence.
 *
 * `measured` is true only when a real progress instant exists or an explicit deadline was
 * supplied. A heartbeat-only owner therefore evaluates to `measured: false`.
 */
export function evaluateWorkLiveness(
  liveness: WorkLivenessFacts,
  observedAt: UtcTimestampMs,
  policy: WorkContinuityPolicy = DEFAULT_WORK_CONTINUITY_POLICY,
): WorkLivenessEvaluation {
  const hasProgress = typeof liveness.lastProgressAt === "number";
  const hasDeadline = typeof liveness.deadlineAt === "number";
  const measured = hasProgress || hasDeadline;

  const elapsedSinceProgressMs = hasProgress
    ? Math.max(0, observedAt - liveness.lastProgressAt)
    : null;

  let deadlineExceeded = false;
  if (hasDeadline) {
    deadlineExceeded = observedAt > liveness.deadlineAt;
  } else if (
    elapsedSinceProgressMs !== null &&
    Number.isFinite(policy.progressTimeoutMs) &&
    policy.progressTimeoutMs > 0
  ) {
    deadlineExceeded = elapsedSinceProgressMs > policy.progressTimeoutMs;
  }

  return {
    measured,
    lastProgressAt: liveness.lastProgressAt,
    elapsedSinceProgressMs,
    deadlineExceeded,
  };
}

/** Evaluates an already-scheduled recovery without creating a second one. */
export function evaluateScheduledRecovery(
  scheduled: ScheduledRecoveryFacts,
  observedAt: UtcTimestampMs,
  policy: WorkContinuityPolicy = DEFAULT_WORK_CONTINUITY_POLICY,
): ScheduledRecoveryEvaluation {
  const due = scheduled.dueAt !== null && observedAt >= scheduled.dueAt;
  const overdue =
    scheduled.dueAt !== null &&
    observedAt - scheduled.dueAt > Math.max(0, policy.scheduledRecoveryGraceMs);
  return {
    kind: scheduled.kind,
    authority: scheduled.authority,
    dueAt: scheduled.dueAt,
    due,
    overdue,
  };
}

/** Maps an expected forward action onto a bounded recovery class. */
export function recoveryClassForAction(action: RecoveryAction): WorkRecoveryClass | null {
  switch (action) {
    case "dispatch":
      return "dispatch";
    case "resume":
      return "resume";
    case "retry":
      return "retry";
    case "rebind":
      return "rebind";
    case "reclaim":
      return "reclaim";
    case "compensate":
      return "compensate";
    case "await_external":
      return "await_external";
    case "require_human":
      return "require_human";
    case "none":
      return null;
  }
}

function describeAuthority(authority: ActionAuthority): string {
  switch (authority.kind) {
    case "internal":
      return `internal:${authority.authority}`;
    case "external":
      return `external:${authority.system}`;
    case "human":
      return `human:${authority.role}`;
  }
}

function capContradictions(
  explicit: readonly WorkContradiction[],
  derived: readonly WorkContradiction[],
): readonly WorkContradiction[] {
  const seen = new Set<WorkContradictionCode>();
  const merged: WorkContradiction[] = [];
  for (const contradiction of [...explicit, ...derived]) {
    if (seen.has(contradiction.code)) {
      continue;
    }
    seen.add(contradiction.code);
    merged.push(contradiction);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 12. Derivation
// ---------------------------------------------------------------------------

/**
 * Derives the work-level continuity verdict from an authoritative observation.
 *
 * Order is significant and encodes the required semantics:
 *
 * 1. observation failure fails safe before anything else;
 * 2. terminal work needs no continuation;
 * 3. contradictions are reported, never resolved by picking a winner;
 * 4. `blocked` is evaluated before ownership (blocked work is never auto-retried);
 * 5. a legitimate external/human wait is not stranded;
 * 6. an already-scheduled recovery is not duplicated (due / overdue included);
 * 7. only then is ownership / liveness evaluated and `stranded` selected.
 */
export function deriveWorkContinuity(
  observation: WorkContinuityObservation,
  policy: WorkContinuityPolicy = DEFAULT_WORK_CONTINUITY_POLICY,
): WorkContinuityVerdict {
  const liveness = evaluateWorkLiveness(observation.liveness, observation.observedAt, policy);
  const scheduledRecovery =
    observation.scheduledRecovery === null
      ? null
      : evaluateScheduledRecovery(observation.scheduledRecovery, observation.observedAt, policy);

  const base = {
    workKey: observation.workKey,
    observedAt: observation.observedAt,
    stage: observation.stage,
    expectedAction: observation.expectedAction,
    owner: observation.owner,
    liveness,
    scheduledRecovery,
  } as const;

  const unavailable = unavailableSources(observation);
  const requiredUnavailable = unavailable.filter((source) =>
    observation.requiredSources.includes(source.source),
  );
  const missingRequired = missingRequiredSources(observation);
  if (requiredUnavailable.length > 0 || missingRequired.length > 0) {
    const parts: string[] = [];
    if (missingRequired.length > 0) {
      parts.push(`not observed: ${missingRequired.join(", ")}`);
    }
    if (requiredUnavailable.length > 0) {
      parts.push(
        `unavailable: ${requiredUnavailable
          .map((source) => `${source.source}${source.reason === undefined ? "" : `(${source.reason})`}`)
          .join(", ")}`,
      );
    }
    return {
      ...base,
      diagnosis: "observation_unavailable",
      strandedReason: null,
      contradictions: observation.contradictions ?? [],
      recovery: null,
      detail: `required source(s) ${parts.join("; ")}; no ownership change is safe`,
    };
  }

  if (!observation.active) {
    return {
      ...base,
      diagnosis: "terminal",
      strandedReason: null,
      contradictions: observation.contradictions ?? [],
      recovery: null,
      detail: "work is not active in the tracker; no continuation is required",
    };
  }

  const derivedContradictions: WorkContradiction[] = [];
  // Explicitly blocked work does not need an actionable next step; its continuation is the
  // documented unblock condition, so the missing-action invariant does not apply.
  if (observation.expectedAction === null && observation.blocked === null) {
    derivedContradictions.push({
      code: "missing_expected_action",
      message: "active work has no derivable expected next action",
    });
  }
  const contradictions = capContradictions(
    observation.contradictions ?? [],
    derivedContradictions,
  );
  if (contradictions.length > 0) {
    return {
      ...base,
      diagnosis: "contradictory",
      strandedReason: null,
      contradictions,
      recovery: null,
      detail: `conflicting work facts: ${contradictions.map((c) => c.code).join(", ")}`,
    };
  }

  if (observation.blocked !== null) {
    return {
      ...base,
      diagnosis: "blocked",
      strandedReason: null,
      contradictions,
      recovery: null,
      detail: `work is explicitly blocked on ${describeAuthority(observation.blocked.waitingOn)} until ${observation.blocked.unblockCondition}`,
    };
  }

  const expectedAction = observation.expectedAction as ExpectedNextAction;

  if (observation.externalWait !== null) {
    return {
      ...base,
      diagnosis: "awaiting_external",
      strandedReason: null,
      contradictions,
      recovery: null,
      detail: `work is legitimately waiting on ${describeAuthority(observation.externalWait.authority)}`,
    };
  }

  if (scheduledRecovery !== null) {
    const timing =
      scheduledRecovery.dueAt === null
        ? "armed"
        : scheduledRecovery.overdue
          ? "overdue and awaiting its authority"
          : scheduledRecovery.due
            ? "due and awaiting its authority"
            : "not yet due";
    return {
      ...base,
      diagnosis: "retry_scheduled",
      strandedReason: null,
      contradictions,
      recovery: null,
      detail: `${scheduledRecovery.kind} already scheduled by ${scheduledRecovery.authority} (${timing}); not duplicated`,
    };
  }

  const owner = observation.owner;

  // A next action owned by an external system or a human is a legitimate wait by
  // construction; absence of a local process never makes it stranded.
  if (expectedAction.authority.kind !== "internal") {
    return {
      ...base,
      diagnosis: "awaiting_external",
      strandedReason: null,
      contradictions,
      recovery: null,
      detail: `next action ${expectedAction.action} waits on ${describeAuthority(expectedAction.authority)}`,
    };
  }

  const expectedAuthority = expectedAction.authority.authority;

  if (owner === null) {
    return {
      ...base,
      diagnosis: "stranded",
      strandedReason: "missing_owner",
      contradictions,
      recovery: buildRecovery(
        expectedAction,
        expectedAuthority,
        "missing_owner",
        observation.fence,
      ),
      detail: `active work has no owner; next action ${expectedAction.action} is owned by ${expectedAuthority}`,
    };
  }

  if (expectedAuthority !== owner.authority) {
    return {
      ...base,
      diagnosis: "stranded",
      strandedReason: "owner_stage_mismatch",
      contradictions,
      recovery: buildRecovery(
        expectedAction,
        expectedAuthority,
        "owner_stage_mismatch",
        owner.fence,
      ),
      detail: `owner ${owner.authority} does not match the authority expected for the next stage (${expectedAuthority})`,
    };
  }

  if (owner.presence === "absent") {
    return {
      ...base,
      diagnosis: "stranded",
      strandedReason: "owner_not_observable",
      contradictions,
      recovery: buildRecovery(
        expectedAction,
        owner.authority,
        "owner_not_observable",
        owner.fence,
      ),
      detail: `owner ${owner.authority} is not observable and has no scheduled recovery`,
    };
  }

  if (liveness.deadlineExceeded) {
    return {
      ...base,
      diagnosis: "stranded",
      strandedReason: "owner_progress_timeout",
      contradictions,
      recovery: buildRecovery(
        expectedAction,
        owner.authority,
        "owner_progress_timeout",
        owner.fence,
      ),
      detail: `owner ${owner.authority} exceeded its progress deadline without a scheduled recovery`,
    };
  }

  return {
    ...base,
    diagnosis: "healthy",
    strandedReason: null,
    contradictions,
    recovery: null,
    detail:
      owner.presence === "unknown"
        ? `owner ${owner.authority} holds valid ownership; progress is unknown and is not treated as failure`
        : `owner ${owner.authority} holds valid ownership and has not exceeded its progress deadline`,
  };
}

function buildRecovery(
  expectedAction: ExpectedNextAction,
  authority: string,
  reason: StrandedReason,
  fence: SafeOwnershipFence | undefined,
): WorkRecoveryDecision {
  // A dead or unobservable owner is reclaimed from its own authority; a missing owner is
  // re-dispatched. "none" is not a recovery, so it can only fall back to `reclaim` when an
  // owner exists to reclaim from, otherwise a human must decide.
  const fallback: WorkRecoveryClass =
    reason === "owner_progress_timeout" || reason === "owner_not_observable"
      ? "reclaim"
      : "require_human";
  const recoveryClass = recoveryClassForAction(expectedAction.action) ?? fallback;
  return {
    class: recoveryClass,
    authority,
    reason,
    expectedFence: fence ?? { hasLeaseToken: false },
    requiresReobserve: true,
  };
}

// ---------------------------------------------------------------------------
// 13. Idempotency fingerprint
// ---------------------------------------------------------------------------

/**
 * Deterministic fingerprint of everything a recovery decision depends on.
 *
 * The coordinator re-observes before acting and compares fingerprints: any change in the
 * facts cancels the stale plan instead of replaying it. Two identical observations always
 * produce the same fingerprint, which is what makes repeated reconciliation idempotent.
 *
 * `observedAt` is deliberately excluded: reading the same facts twice a moment later is
 * still the same decision. Time-derived changes surface through `diagnosis` /
 * `strandedReason` / liveness evaluation instead.
 */
export function workContinuityFingerprint(verdict: WorkContinuityVerdict): string {
  const parts: string[] = [
    verdict.workKey.provider,
    verdict.workKey.key,
    verdict.stage,
    verdict.diagnosis,
    verdict.strandedReason ?? "",
    verdict.expectedAction?.action ?? "",
    verdict.expectedAction === null ? "" : describeAuthority(verdict.expectedAction.authority),
    verdict.owner?.authority ?? "",
    verdict.owner?.executor ?? "",
    verdict.owner?.presence ?? "",
    verdict.recovery?.class ?? "",
    verdict.recovery?.authority ?? "",
    verdict.recovery?.reason ?? "",
    fenceFingerprint(verdict.owner?.fence ?? { hasLeaseToken: false }),
    fenceFingerprint(verdict.recovery?.expectedFence ?? { hasLeaseToken: false }),
    verdict.expectedAction?.taskRef?.taskId ?? "",
    verdict.expectedAction?.taskRef === undefined
      ? ""
      : String(verdict.expectedAction.taskRef.revision),
    verdict.expectedAction?.target?.repository ?? "",
    verdict.expectedAction?.target === undefined
      ? ""
      : String(verdict.expectedAction.target.prNumber),
    verdict.expectedAction?.target?.headSha ?? "",
    verdict.expectedAction?.handoffRef?.handoffId ?? "",
    verdict.scheduledRecovery?.kind ?? "",
    verdict.scheduledRecovery?.authority ?? "",
    verdict.scheduledRecovery?.dueAt === null || verdict.scheduledRecovery === null
      ? ""
      : String(verdict.scheduledRecovery.dueAt),
  ];
  return parts.join("|");
}

function fenceFingerprint(fence: SafeOwnershipFence): string {
  return [
    fence.retryToken ?? "",
    fence.lifecycleGeneration ?? "",
    fence.reconciliationEpoch ?? "",
    fence.leaseGeneration ?? "",
    fence.bindingGeneration ?? "",
    fence.expectedHeadSha ?? "",
    fence.hasLeaseToken ? "lease" : "",
  ].join(",");
}

// ---------------------------------------------------------------------------
// 14. Observation validation
// ---------------------------------------------------------------------------

export type WorkObservationValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

/**
 * Structural validation of an observation before derivation.
 *
 * This is a caller-defect guard, not a substitute for authority-side commit-time fencing.
 */
export function validateWorkContinuityObservation(
  observation: WorkContinuityObservation,
): WorkObservationValidationResult {
  if (observation.requiredSources.length === 0) {
    return { valid: false, reason: "observation must declare at least one required source" };
  }
  if (!Number.isFinite(observation.observedAt) || observation.observedAt <= 0) {
    return { valid: false, reason: "observedAt must be a positive UTC timestamp" };
  }
  if (observation.liveness.startedAt > observation.observedAt) {
    return { valid: false, reason: "liveness.startedAt cannot be after observedAt" };
  }
  if (
    typeof observation.liveness.lastProgressAt === "number" &&
    observation.liveness.lastProgressAt > observation.observedAt
  ) {
    return { valid: false, reason: "liveness.lastProgressAt cannot be after observedAt" };
  }
  if (
    observation.scheduledRecovery !== null &&
    observation.scheduledRecovery.credential.trim() === ""
  ) {
    return {
      valid: false,
      reason: "scheduledRecovery requires a non-empty scheduler credential",
    };
  }
  if (observation.owner !== null && observation.owner.authority.trim() === "") {
    return { valid: false, reason: "owner.authority must be non-empty" };
  }
  const sourceKinds = new Set<WorkObservationSourceKind>();
  for (const source of observation.sources) {
    if (sourceKinds.has(source.source)) {
      return { valid: false, reason: `duplicate source observation for ${source.source}` };
    }
    sourceKinds.add(source.source);
  }
  const missing = missingRequiredSources(observation);
  if (missing.length > 0) {
    return { valid: false, reason: `required source not observed: ${missing.join(", ")}` };
  }
  return { valid: true };
}

/**
 * Whether a verdict says the work item is still active and needs a continuation.
 * Terminal / observation-failure verdicts do not.
 */
export function isContinuationRelevant(verdict: WorkContinuityVerdict): boolean {
  return verdict.diagnosis !== "terminal" && verdict.diagnosis !== "observation_unavailable";
}

/**
 * Whether the verdict requires an automatic recovery delegation.
 * Only `stranded` does; `contradictory` and `blocked` never auto-select an action.
 */
export function requiresAutomaticRecovery(verdict: WorkContinuityVerdict): boolean {
  return verdict.diagnosis === "stranded" && verdict.recovery !== null;
}

// ---------------------------------------------------------------------------
// 15. Stage → expected action derivation
// ---------------------------------------------------------------------------

/** Decision task facts needed to derive the planning / review continuation. */
export interface DecisionTaskStageFacts {
  readonly taskId: string;
  readonly revision: number;
  readonly status: DecisionTaskStatus;
  readonly claimGeneration: number;
}

/**
 * Provider-neutral facts for the stage a work item is currently in.
 *
 * These are the *inputs* of continuation derivation: a reader turns tracker / Decision /
 * Delivery observations into one of these shapes, and {@link deriveStageExpectation}
 * answers "what must happen next and who owns it" without touching any store.
 */
export type WorkStageFacts =
  | {
      readonly kind: "planning";
      /** Latest plan task for this work item; `null` = none exists yet. */
      readonly task: DecisionTaskStageFacts | null;
    }
  | {
      readonly kind: "coding";
      /** Whether the orchestrator currently has a live attempt for this work item. */
      readonly running: boolean;
    }
  | {
      readonly kind: "ci";
      readonly prNumber: number;
      readonly headSha: string;
    }
  | {
      readonly kind: "review";
      readonly task: DecisionTaskStageFacts;
      readonly target: DecisionReviewTarget;
    }
  | {
      readonly kind: "repair";
      readonly target: DecisionReviewTarget;
    }
  | {
      readonly kind: "delivery";
      /** Persisted handoff id when a compensation is still pending; otherwise `null`. */
      readonly handoffId: string | null;
      readonly target: DecisionReviewTarget;
    }
  | {
      readonly kind: "merge";
      readonly target: DecisionReviewTarget;
    };

export interface StageExpectation {
  readonly stage: WorkStage;
  readonly expectedAction: ExpectedNextAction;
}

const DECISION_DISPATCH_EVIDENCE = ["bridge_active", "task_pending"] as const;

/**
 * Derives the expected next action and its owning authority for one stage.
 *
 * This is intentionally conservative: it names the action and the authority, and lists the
 * evidence a recovery would have to re-check. It never claims the action is allowed — the
 * authority still enforces its own gates (planning admission, exact HEAD, delivery state).
 */
export function deriveStageExpectation(facts: WorkStageFacts): StageExpectation {
  switch (facts.kind) {
    case "planning": {
      const task = facts.task;
      if (task === null) {
        return {
          stage: "planning",
          expectedAction: {
            action: "dispatch",
            description: "dispatch the planning task to the Decision executor",
            authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
            requiredEvidence: ["requirements_fresh", ...DECISION_DISPATCH_EVIDENCE],
          },
        };
      }
      const taskRef = { taskId: task.taskId, revision: task.revision };
      if (task.status === "pending") {
        return {
          stage: "planning",
          expectedAction: {
            action: "dispatch",
            description: "claim the pending planning task",
            authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
            taskRef,
            requiredEvidence: [...DECISION_DISPATCH_EVIDENCE],
          },
        };
      }
      return {
        stage: "planning",
        expectedAction: {
          action: "none",
          description: "planning task is being executed under a Decision claim",
          authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
          taskRef,
          requiredEvidence: ["lease_held", "claim_generation_current"],
        },
      };
    }

    case "coding":
      return {
        stage: "coding",
        expectedAction: {
          action: facts.running ? "none" : "dispatch",
          description: facts.running
            ? "coding agent holds the active attempt"
            : "dispatch the coding attempt to the orchestrator",
          authority: { kind: "internal", authority: "orchestrator", executor: "codex-agent" },
          requiredEvidence: ["plan_ready", "workspace_available", "dispatch_admissible"],
        },
      };

    case "ci":
      return {
        stage: "ci",
        expectedAction: {
          action: "await_external",
          description: `wait for CI checks on PR #${facts.prNumber} at ${facts.headSha.slice(0, 10)}`,
          authority: {
            kind: "external",
            system: "github-actions",
            condition: "required_checks_completed",
          },
          requiredEvidence: ["pr_open", "head_sha_matched"],
        },
      };

    case "review": {
      const taskRef = { taskId: facts.task.taskId, revision: facts.task.revision };
      if (facts.task.status === "pending") {
        return {
          stage: "review",
          expectedAction: {
            action: "dispatch",
            description: `claim the review task for PR #${facts.target.prNumber}`,
            authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
            target: facts.target,
            taskRef,
            requiredEvidence: ["ci_green", "exact_head", ...DECISION_DISPATCH_EVIDENCE],
          },
        };
      }
      return {
        stage: "review",
        expectedAction: {
          action: "none",
          description: `review task for PR #${facts.target.prNumber} is under an active claim`,
          authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
          target: facts.target,
          taskRef,
          requiredEvidence: ["lease_held", "exact_head"],
        },
      };
    }

    case "repair":
      return {
        stage: "repair",
        expectedAction: {
          action: "retry",
          description: `re-observe review findings and repair PR #${facts.target.prNumber}`,
          authority: { kind: "internal", authority: "delivery", executor: "codex-agent" },
          target: facts.target,
          requiredEvidence: ["review_verdict_changes_requested", "repair_budget_available"],
        },
      };

    case "delivery":
      return {
        stage: "delivery",
        expectedAction: facts.handoffId === null
          ? {
              action: "resume",
              description: `resume the delivery pipeline for PR #${facts.target.prNumber}`,
              authority: { kind: "internal", authority: "delivery" },
              target: facts.target,
              requiredEvidence: ["exact_head", "delivery_state_readable"],
            }
          : {
              action: "compensate",
              description: `compensate the pending delivery handoff ${facts.handoffId}`,
              authority: { kind: "internal", authority: "delivery" },
              target: facts.target,
              handoffRef: { handoffId: facts.handoffId },
              requiredEvidence: ["handoff_id_matched", "remote_label_removed", "comment_verified"],
            },
      };

    case "merge":
      return {
        stage: "merge",
        expectedAction: {
          action: "none",
          description: `verify merge of PR #${facts.target.prNumber} and remote facts`,
          authority: { kind: "internal", authority: "delivery" },
          target: facts.target,
          requiredEvidence: ["exact_head_approved", "checks_green", "mergeable"],
        },
      };
  }
}
