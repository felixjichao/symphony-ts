/**
 * @symphony/domain — Execution Continuity, Ownership, and Failure Contracts (NEST-130 / GitHub #146).
 *
 * Provider-neutral domain contracts and invariants for cross-stage execution continuity.
 * Establishes the shared vocabulary used by Orchestrator, Decision, ChatGPT Web, Delivery,
 * and future reconciliation code before adding automated recovery behaviors (#147–#151).
 *
 * Invariants:
 * 1. Every supported active WorkKey can identify an expected next action.
 * 2. Every expected action has an owner or is explicitly waiting on an external/human authority.
 * 3. `blocked` is a first-class non-terminal continuity state (not equivalent to failed or retry_queued).
 * 4. Retry semantics are defined as re-observe + re-decide, not blind replay.
 * 5. A stale async continuation may observe but must not mutate current work (fenced).
 * 6. The continuity model is NOT a second authoritative workflow lifecycle.
 * 7. Existing authorities remain authoritative for their own facts (GitHub, Orchestrator, Decision, Delivery).
 * 8. Dashboard and @symphony/operations remain read-only consumers.
 */

import type { UtcTimestampMs } from "./time";
import type { WorkKey } from "./operations-facts";
import type { DecisionReviewTarget } from "./decision";
import type { DecisionAdapterErrorCode, DecisionAdapterSuggestedAction } from "./decision-executor";
import type { DeliveryErrorCode, DeliveryHandoffReason } from "./delivery";

// ---------------------------------------------------------------------------
// 1. Continuity Scope
// ---------------------------------------------------------------------------

/**
 * Execution continuity spans multiple nested scopes. Distinguishing scopes prevents
 * premature or false claims that an entire work item is finished when only a single
 * task, attempt, or session binding completed.
 */
export type ContinuityScope = "work" | "task" | "attempt" | "binding";

export const CONTINUITY_SCOPES = [
  "work",
  "task",
  "attempt",
  "binding",
] as const satisfies readonly ContinuityScope[];

// ---------------------------------------------------------------------------
// 2. Continuity State
// ---------------------------------------------------------------------------

/**
 * Minimal provider-neutral continuity state machine representing execution continuity.
 * Orthogonal to display phases (WorkPhase) and attention flags (AttentionState).
 */
export type ContinuityState =
  | "running"
  | "retry_queued"
  | "recovering"
  | "blocked"
  | "completed"
  | "released";

export const CONTINUITY_STATES = [
  "running",
  "retry_queued",
  "recovering",
  "blocked",
  "completed",
  "released",
] as const satisfies readonly ContinuityState[];

/**
 * Checks whether a continuity state is terminal for its scope.
 * `blocked` is explicitly NON-TERMINAL.
 */
export function isTerminalContinuityState(state: ContinuityState): boolean {
  return state === "completed" || state === "released";
}

/**
 * Checks whether a continuity state represents active ongoing work.
 */
export function isActiveContinuityState(state: ContinuityState): boolean {
  return state === "running" || state === "retry_queued" || state === "recovering";
}

// ---------------------------------------------------------------------------
// 3. Recovery Action
// ---------------------------------------------------------------------------

/**
 * Common vocabulary of recovery actions across Orchestrator, Decision, Web, and Delivery.
 */
export type RecoveryAction =
  | "none"
  | "dispatch"
  | "resume"
  | "retry"
  | "rebind"
  | "reclaim"
  | "compensate"
  | "await_external"
  | "require_human";

export const RECOVERY_ACTIONS = [
  "none",
  "dispatch",
  "resume",
  "retry",
  "rebind",
  "reclaim",
  "compensate",
  "await_external",
  "require_human",
] as const satisfies readonly RecoveryAction[];

// ---------------------------------------------------------------------------
// 4. Action Authority & Owner
// ---------------------------------------------------------------------------

export type ActionAuthorityKind = "internal" | "external" | "human";

/** Internal subsystem authority holding execution responsibility. */
export interface InternalActionAuthority {
  readonly kind: "internal";
  /** Subsystem authority, e.g. "orchestrator", "decision", "delivery". */
  readonly authority: string;
  /** Optional concrete executor provider or runner, e.g. "chatgpt-web", "codex-agent". */
  readonly executor?: string | undefined;
}

/** External system or environment being waited upon. */
export interface ExternalActionAuthority {
  readonly kind: "external";
  /** External system name, e.g. "github", "ci", "tracker", "network". */
  readonly system: string;
  /** Concrete condition or event required before work can continue. */
  readonly condition: string;
}

/** Human intervention or approval requirement. */
export interface HumanActionAuthority {
  readonly kind: "human";
  /** Human role, e.g. "reviewer", "operator", "author". */
  readonly role: string;
  /** Specific action or decision needed from the human. */
  readonly instruction: string;
}

export type ActionAuthority =
  | InternalActionAuthority
  | ExternalActionAuthority
  | HumanActionAuthority;

// ---------------------------------------------------------------------------
// 5. Expected Next Action
// ---------------------------------------------------------------------------

/**
 * Describes the expected next forward action for an active work item.
 * Must carry an owner authority or explicit external/human waiting reference.
 */
export interface ExpectedNextAction {
  readonly action: RecoveryAction;
  readonly description: string;
  readonly authority: ActionAuthority;
  readonly target?: DecisionReviewTarget | undefined;
  readonly taskRef?: { readonly taskId: string; readonly revision: number } | undefined;
  readonly requiredEvidence?: readonly string[] | undefined;
}

// ---------------------------------------------------------------------------
// 6. Liveness and Progress Metadata
// ---------------------------------------------------------------------------

export interface StallPolicy {
  readonly timeoutMs: number;
  readonly policy: "mark_stalled" | "reclaim" | "abort";
}

/**
 * Liveness and forward progress tracking.
 * Heartbeat, polling success, or process existence does NOT count as forward progress;
 * missing progress evidence MUST be represented as "unknown" rather than fabricated timestamps.
 */
export interface LivenessMetadata {
  readonly startedAt: UtcTimestampMs;
  readonly lastProgressAt: UtcTimestampMs | "unknown";
  readonly lastObservedAt: UtcTimestampMs;
  readonly deadlineAt?: UtcTimestampMs | undefined;
  readonly stallPolicy?: StallPolicy | undefined;
  readonly attempt?: number | undefined;
}

// ---------------------------------------------------------------------------
// 7. Multi-dimensional Ownership Fencing
// ---------------------------------------------------------------------------

/**
 * Multi-dimensional async ownership fence. Retains attempt retry token,
 * lifecycle generation, reconciliation epoch, Decision lease, and binding generation.
 * Stale async continuations may observe but MUST NOT mutate current work.
 */
export interface OwnershipFence {
  readonly retryToken?: string | undefined;
  readonly lifecycleGeneration?: number | undefined;
  readonly reconciliationEpoch?: number | undefined;
  /** Capability credential (lease token); must be omitted from public/display view. */
  readonly leaseToken?: string | undefined;
  readonly leaseGeneration?: number | undefined;
  readonly bindingGeneration?: number | undefined;
  readonly expectedHeadSha?: string | undefined;
}

/** Safe projection of OwnershipFence for public/display observation (leaseToken omitted). */
export interface SafeOwnershipFence {
  readonly retryToken?: string | undefined;
  readonly lifecycleGeneration?: number | undefined;
  readonly reconciliationEpoch?: number | undefined;
  readonly leaseGeneration?: number | undefined;
  readonly bindingGeneration?: number | undefined;
  readonly expectedHeadSha?: string | undefined;
  readonly hasLeaseToken: boolean;
}

/** Strips capability credentials from an ownership fence for safe public observation. */
export function sanitizeOwnershipFence(fence: OwnershipFence): SafeOwnershipFence {
  const { leaseToken, ...safe } = fence;
  return {
    ...safe,
    hasLeaseToken: Boolean(leaseToken && leaseToken.length > 0),
  };
}

export type OwnershipFenceDimension =
  | "lifecycleGeneration"
  | "reconciliationEpoch"
  | "leaseGeneration"
  | "bindingGeneration"
  | "expectedHeadSha"
  | "retryToken"
  | "leaseToken";

export const OWNERSHIP_FENCE_DIMENSIONS: readonly OwnershipFenceDimension[] = [
  "lifecycleGeneration",
  "reconciliationEpoch",
  "leaseGeneration",
  "bindingGeneration",
  "expectedHeadSha",
  "retryToken",
  "leaseToken",
] as const;

export type OwnershipFenceViolationReason =
  | "missing_lifecycle_generation"
  | "missing_reconciliation_epoch"
  | "missing_lease_generation"
  | "missing_binding_generation"
  | "missing_expected_head_sha"
  | "missing_retry_token"
  | "missing_lease_token"
  | "missing_authoritative_lifecycle_generation"
  | "missing_authoritative_reconciliation_epoch"
  | "missing_authoritative_lease_generation"
  | "missing_authoritative_binding_generation"
  | "missing_authoritative_expected_head_sha"
  | "missing_authoritative_retry_token"
  | "missing_authoritative_lease_token"
  | "superseded_lifecycle_generation"
  | "conflicting_lifecycle_generation"
  | "superseded_reconciliation_epoch"
  | "conflicting_reconciliation_epoch"
  | "superseded_lease_generation"
  | "conflicting_lease_generation"
  | "superseded_binding_generation"
  | "conflicting_binding_generation"
  | "stale_head_sha"
  | "conflicting_retry_token"
  | "conflicting_lease_token";

export type OwnershipFenceValidationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason: OwnershipFenceViolationReason;
      readonly details: string;
    };

function isValidNonNegativeSafeInteger(val: unknown): val is number {
  return typeof val === "number" && Number.isSafeInteger(val) && val >= 0;
}

/**
 * Validates whether candidate async continuation credentials match the current authoritative fence
 * across all applicable dimensions.
 *
 * Applicable dimensions are either explicitly supplied or inferred from defined fields on `current` or `candidate`.
 * Fencing is fail-closed on both sides: applicable dimensions require both authoritative and candidate credentials
 * to be present and to exact-match. Any missing credential (dual-sided, authoritative-missing, or candidate-missing),
 * invalid numeric format (NaN, negative, float, non-finite), superseded generation (smaller than current),
 * or ahead/conflicting generation (greater than or differing from current) invalidates ownership.
 *
 * NOTE: This pure helper provides domain-level contract validation and classification. It DOES NOT
 * replace source-authority atomic commit-time verification (such as CAS, atomic DB updates, or
 * Git push lease checks at commit/push time).
 */
export function validateOwnershipFence(
  current: OwnershipFence,
  candidate: OwnershipFence,
  applicableDimensions?: readonly OwnershipFenceDimension[],
): OwnershipFenceValidationResult {
  const dimensionsToCheck: readonly OwnershipFenceDimension[] =
    applicableDimensions ??
    OWNERSHIP_FENCE_DIMENSIONS.filter(
      (dim) => current[dim] !== undefined || candidate[dim] !== undefined,
    );

  for (const dim of dimensionsToCheck) {
    switch (dim) {
      case "lifecycleGeneration":
        if (current.lifecycleGeneration === undefined && candidate.lifecycleGeneration === undefined) {
          return {
            valid: false,
            reason: "missing_lifecycle_generation",
            details: "Both authoritative fence and candidate are missing required lifecycleGeneration",
          };
        }
        if (current.lifecycleGeneration === undefined) {
          return {
            valid: false,
            reason: "missing_authoritative_lifecycle_generation",
            details: `Candidate provided lifecycleGeneration ${candidate.lifecycleGeneration} but authoritative fence has none`,
          };
        }
        if (candidate.lifecycleGeneration === undefined) {
          return {
            valid: false,
            reason: "missing_lifecycle_generation",
            details: "Candidate is missing required lifecycleGeneration",
          };
        }
        if (!isValidNonNegativeSafeInteger(current.lifecycleGeneration)) {
          return {
            valid: false,
            reason: "conflicting_lifecycle_generation",
            details: `Authoritative fence has invalid non-integer or negative lifecycleGeneration: ${current.lifecycleGeneration}`,
          };
        }
        if (!isValidNonNegativeSafeInteger(candidate.lifecycleGeneration)) {
          return {
            valid: false,
            reason: "conflicting_lifecycle_generation",
            details: `Candidate has invalid non-integer or negative lifecycleGeneration: ${candidate.lifecycleGeneration}`,
          };
        }
        if (candidate.lifecycleGeneration < current.lifecycleGeneration) {
          return {
            valid: false,
            reason: "superseded_lifecycle_generation",
            details: `Candidate lifecycle generation ${candidate.lifecycleGeneration} is superseded by current ${current.lifecycleGeneration}`,
          };
        }
        if (candidate.lifecycleGeneration > current.lifecycleGeneration) {
          return {
            valid: false,
            reason: "conflicting_lifecycle_generation",
            details: `Candidate lifecycle generation ${candidate.lifecycleGeneration} does not match current ${current.lifecycleGeneration} (ahead/unrecognized)`,
          };
        }
        break;

      case "reconciliationEpoch":
        if (current.reconciliationEpoch === undefined && candidate.reconciliationEpoch === undefined) {
          return {
            valid: false,
            reason: "missing_reconciliation_epoch",
            details: "Both authoritative fence and candidate are missing required reconciliationEpoch",
          };
        }
        if (current.reconciliationEpoch === undefined) {
          return {
            valid: false,
            reason: "missing_authoritative_reconciliation_epoch",
            details: `Candidate provided reconciliationEpoch ${candidate.reconciliationEpoch} but authoritative fence has none`,
          };
        }
        if (candidate.reconciliationEpoch === undefined) {
          return {
            valid: false,
            reason: "missing_reconciliation_epoch",
            details: "Candidate is missing required reconciliationEpoch",
          };
        }
        if (!isValidNonNegativeSafeInteger(current.reconciliationEpoch)) {
          return {
            valid: false,
            reason: "conflicting_reconciliation_epoch",
            details: `Authoritative fence has invalid non-integer or negative reconciliationEpoch: ${current.reconciliationEpoch}`,
          };
        }
        if (!isValidNonNegativeSafeInteger(candidate.reconciliationEpoch)) {
          return {
            valid: false,
            reason: "conflicting_reconciliation_epoch",
            details: `Candidate has invalid non-integer or negative reconciliationEpoch: ${candidate.reconciliationEpoch}`,
          };
        }
        if (candidate.reconciliationEpoch < current.reconciliationEpoch) {
          return {
            valid: false,
            reason: "superseded_reconciliation_epoch",
            details: `Candidate reconciliation epoch ${candidate.reconciliationEpoch} is superseded by current ${current.reconciliationEpoch}`,
          };
        }
        if (candidate.reconciliationEpoch > current.reconciliationEpoch) {
          return {
            valid: false,
            reason: "conflicting_reconciliation_epoch",
            details: `Candidate reconciliation epoch ${candidate.reconciliationEpoch} does not match current ${current.reconciliationEpoch} (ahead/unrecognized)`,
          };
        }
        break;

      case "leaseGeneration":
        if (current.leaseGeneration === undefined && candidate.leaseGeneration === undefined) {
          return {
            valid: false,
            reason: "missing_lease_generation",
            details: "Both authoritative fence and candidate are missing required leaseGeneration",
          };
        }
        if (current.leaseGeneration === undefined) {
          return {
            valid: false,
            reason: "missing_authoritative_lease_generation",
            details: `Candidate provided leaseGeneration ${candidate.leaseGeneration} but authoritative fence has none`,
          };
        }
        if (candidate.leaseGeneration === undefined) {
          return {
            valid: false,
            reason: "missing_lease_generation",
            details: "Candidate is missing required leaseGeneration",
          };
        }
        if (!isValidNonNegativeSafeInteger(current.leaseGeneration)) {
          return {
            valid: false,
            reason: "conflicting_lease_generation",
            details: `Authoritative fence has invalid non-integer or negative leaseGeneration: ${current.leaseGeneration}`,
          };
        }
        if (!isValidNonNegativeSafeInteger(candidate.leaseGeneration)) {
          return {
            valid: false,
            reason: "conflicting_lease_generation",
            details: `Candidate has invalid non-integer or negative leaseGeneration: ${candidate.leaseGeneration}`,
          };
        }
        if (candidate.leaseGeneration < current.leaseGeneration) {
          return {
            valid: false,
            reason: "superseded_lease_generation",
            details: `Candidate lease generation ${candidate.leaseGeneration} is superseded by current ${current.leaseGeneration}`,
          };
        }
        if (candidate.leaseGeneration > current.leaseGeneration) {
          return {
            valid: false,
            reason: "conflicting_lease_generation",
            details: `Candidate lease generation ${candidate.leaseGeneration} does not match current ${current.leaseGeneration} (ahead/unrecognized)`,
          };
        }
        break;

      case "bindingGeneration":
        if (current.bindingGeneration === undefined && candidate.bindingGeneration === undefined) {
          return {
            valid: false,
            reason: "missing_binding_generation",
            details: "Both authoritative fence and candidate are missing required bindingGeneration",
          };
        }
        if (current.bindingGeneration === undefined) {
          return {
            valid: false,
            reason: "missing_authoritative_binding_generation",
            details: `Candidate provided bindingGeneration ${candidate.bindingGeneration} but authoritative fence has none`,
          };
        }
        if (candidate.bindingGeneration === undefined) {
          return {
            valid: false,
            reason: "missing_binding_generation",
            details: "Candidate is missing required bindingGeneration",
          };
        }
        if (!isValidNonNegativeSafeInteger(current.bindingGeneration)) {
          return {
            valid: false,
            reason: "conflicting_binding_generation",
            details: `Authoritative fence has invalid non-integer or negative bindingGeneration: ${current.bindingGeneration}`,
          };
        }
        if (!isValidNonNegativeSafeInteger(candidate.bindingGeneration)) {
          return {
            valid: false,
            reason: "conflicting_binding_generation",
            details: `Candidate has invalid non-integer or negative bindingGeneration: ${candidate.bindingGeneration}`,
          };
        }
        if (candidate.bindingGeneration < current.bindingGeneration) {
          return {
            valid: false,
            reason: "superseded_binding_generation",
            details: `Candidate binding generation ${candidate.bindingGeneration} is superseded by current ${current.bindingGeneration}`,
          };
        }
        if (candidate.bindingGeneration > current.bindingGeneration) {
          return {
            valid: false,
            reason: "conflicting_binding_generation",
            details: `Candidate binding generation ${candidate.bindingGeneration} does not match current ${current.bindingGeneration} (ahead/unrecognized)`,
          };
        }
        break;

      case "expectedHeadSha":
        if (current.expectedHeadSha === undefined && candidate.expectedHeadSha === undefined) {
          return {
            valid: false,
            reason: "missing_expected_head_sha",
            details: "Both authoritative fence and candidate are missing required expectedHeadSha",
          };
        }
        if (current.expectedHeadSha === undefined) {
          return {
            valid: false,
            reason: "missing_authoritative_expected_head_sha",
            details: `Candidate provided expectedHeadSha ${candidate.expectedHeadSha} but authoritative fence has none`,
          };
        }
        if (candidate.expectedHeadSha === undefined) {
          return {
            valid: false,
            reason: "missing_expected_head_sha",
            details: "Candidate is missing required expectedHeadSha",
          };
        }
        if (current.expectedHeadSha !== candidate.expectedHeadSha) {
          return {
            valid: false,
            reason: "stale_head_sha",
            details: `Candidate HEAD SHA ${candidate.expectedHeadSha} does not match authoritative HEAD SHA ${current.expectedHeadSha}`,
          };
        }
        break;

      case "retryToken":
        if (current.retryToken === undefined && candidate.retryToken === undefined) {
          return {
            valid: false,
            reason: "missing_retry_token",
            details: "Both authoritative fence and candidate are missing required retryToken",
          };
        }
        if (current.retryToken === undefined) {
          return {
            valid: false,
            reason: "missing_authoritative_retry_token",
            details: "Candidate provided retry token but authoritative fence has none",
          };
        }
        if (candidate.retryToken === undefined) {
          return {
            valid: false,
            reason: "missing_retry_token",
            details: "Candidate is missing required retryToken",
          };
        }
        if (current.retryToken !== candidate.retryToken) {
          return {
            valid: false,
            reason: "conflicting_retry_token",
            details: "Candidate retry token does not match authoritative retry token",
          };
        }
        break;

      case "leaseToken":
        if (current.leaseToken === undefined && candidate.leaseToken === undefined) {
          return {
            valid: false,
            reason: "missing_lease_token",
            details: "Both authoritative fence and candidate are missing required leaseToken",
          };
        }
        if (current.leaseToken === undefined) {
          return {
            valid: false,
            reason: "missing_authoritative_lease_token",
            details: "Candidate provided lease token but authoritative fence has none",
          };
        }
        if (candidate.leaseToken === undefined) {
          return {
            valid: false,
            reason: "missing_lease_token",
            details: "Candidate is missing required leaseToken",
          };
        }
        if (current.leaseToken !== candidate.leaseToken) {
          return {
            valid: false,
            reason: "conflicting_lease_token",
            details: "Candidate lease token does not match authoritative lease token",
          };
        }
        break;
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// 8. Blocked Reason Details
// ---------------------------------------------------------------------------

export interface BlockedReasonDetails {
  readonly reason: FailureReason | string;
  readonly waitingOn: ActionAuthority;
  readonly unblockCondition: string;
  readonly blockedAt: UtcTimestampMs;
}

// ---------------------------------------------------------------------------
// 9. Failure Taxonomy & Subsystem Mapping
// ---------------------------------------------------------------------------

export type FailureCategory =
  | "transient"
  | "recoverable"
  | "blocked_external"
  | "superseded"
  | "invariant_violation";

export const FAILURE_CATEGORIES = [
  "transient",
  "recoverable",
  "blocked_external",
  "superseded",
  "invariant_violation",
] as const satisfies readonly FailureCategory[];

export type FailureReason =
  | "network_timeout"
  | "bridge_unavailable"
  | "stale_binding"
  | "stale_claim"
  | "navigation_lost"
  | "process_stalled"
  | "incomplete_handoff"
  | "auth_required"
  | "human_required"
  | "ci_checks_pending"
  | "stale_head"
  | "stale_task"
  | "stale_generation"
  | "conflicting_owner"
  | "impossible_transition"
  | "unmapped";

export const FAILURE_REASONS = [
  "network_timeout",
  "bridge_unavailable",
  "stale_binding",
  "stale_claim",
  "navigation_lost",
  "process_stalled",
  "incomplete_handoff",
  "auth_required",
  "human_required",
  "ci_checks_pending",
  "stale_head",
  "stale_task",
  "stale_generation",
  "conflicting_owner",
  "impossible_transition",
  "unmapped",
] as const satisfies readonly FailureReason[];

export interface ContinuityFailureDiagnostic {
  readonly category: FailureCategory;
  readonly reason: FailureReason;
  readonly source: string;
  readonly sourceCode?: string | undefined;
  readonly message: string;
  readonly suggestedAction: RecoveryAction;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

export type ContinuityFailureMappingResult =
  | {
      readonly mapped: true;
      readonly diagnostic: ContinuityFailureDiagnostic;
    }
  | {
      readonly mapped: false;
      readonly rawCode: string;
      readonly message: string;
      readonly gapReason: string;
      readonly diagnostic: ContinuityFailureDiagnostic;
    };

/**
 * Maps DecisionAdapterError structures into provider-neutral continuity failure taxonomy.
 * Lacks of contextual evidence (e.g. bare execution_failed or cancelled) produce explicit unmapped results.
 */
export function mapDecisionAdapterFailure(input: {
  readonly code: DecisionAdapterErrorCode;
  readonly message: string;
  readonly suggestedAction?: DecisionAdapterSuggestedAction | undefined;
  readonly retryable?: boolean | undefined;
  readonly observedGeneration?: number | undefined;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}): ContinuityFailureMappingResult {
  const { code, message, suggestedAction, details } = input;

  switch (code) {
    case "binding_broken":
      return {
        mapped: true,
        diagnostic: {
          category: "recoverable",
          reason: "stale_binding",
          source: "decision",
          sourceCode: code,
          message,
          suggestedAction: "rebind",
          details,
        },
      };

    case "human_required":
      return {
        mapped: true,
        diagnostic: {
          category: "blocked_external",
          reason: "human_required",
          source: "decision",
          sourceCode: code,
          message,
          suggestedAction: "require_human",
          details,
        },
      };

    case "revision_mismatch": {
      const isAuthoritativelySuperseded =
        details?.["taskSuperseded"] === true ||
        (typeof details?.["authoritativeTaskStatus"] === "string" &&
          (details["authoritativeTaskStatus"] === "superseded" ||
            details["authoritativeTaskStatus"] === "cancelled"));

      if (isAuthoritativelySuperseded) {
        return {
          mapped: true,
          diagnostic: {
            category: "superseded",
            reason: "stale_generation",
            source: "decision",
            sourceCode: code,
            message,
            suggestedAction: "none",
            details,
          },
        };
      }

      return {
        mapped: false,
        rawCode: code,
        message,
        gapReason:
          "revision_mismatch from adapter output extraction does not prove task is superseded without authoritative store status; returned unmapped to prevent dropping active task",
        diagnostic: {
          category: "invariant_violation",
          reason: "unmapped",
          source: "decision",
          sourceCode: code,
          message,
          suggestedAction: "require_human",
          details,
        },
      };
    }

    case "task_mismatch": {
      // Check if context details reveal superseded vs invariant violation
      const isSuperseded =
        details?.["superseded"] === true ||
        (typeof details?.["currentStatus"] === "string" &&
          (details["currentStatus"] === "superseded" || details["currentStatus"] === "cancelled"));
      if (isSuperseded) {
        return {
          mapped: true,
          diagnostic: {
            category: "superseded",
            reason: "stale_task",
            source: "decision",
            sourceCode: code,
            message,
            suggestedAction: "none",
            details,
          },
        };
      }
      return {
        mapped: false,
        rawCode: code,
        message,
        gapReason:
          "task_mismatch requires contextual comparison of task status/revision to distinguish superseded from invariant violation",
        diagnostic: {
          category: "invariant_violation",
          reason: "unmapped",
          source: "decision",
          sourceCode: code,
          message,
          suggestedAction: "require_human",
          details,
        },
      };
    }

    case "target_mismatch": {
      const isAuthoritativelySupersededHead =
        details?.["headSuperseded"] === true ||
        (typeof details?.["authoritativeHeadSha"] === "string" &&
          typeof details?.["expectedHeadSha"] === "string" &&
          details["authoritativeHeadSha"] !== details["expectedHeadSha"]);

      if (isAuthoritativelySupersededHead) {
        return {
          mapped: true,
          diagnostic: {
            category: "superseded",
            reason: "stale_head",
            source: "decision",
            sourceCode: code,
            message,
            suggestedAction: "none",
            details,
          },
        };
      }

      const isRepoOrPrMismatch =
        details?.["expectedPrNumber"] !== undefined || details?.["expectedRepo"] !== undefined;
      if (isRepoOrPrMismatch) {
        return {
          mapped: true,
          diagnostic: {
            category: "invariant_violation",
            reason: "impossible_transition",
            source: "decision",
            sourceCode: code,
            message,
            suggestedAction: "require_human",
            details,
          },
        };
      }

      return {
        mapped: false,
        rawCode: code,
        message,
        gapReason:
          "target_mismatch from adapter output extraction does not prove GitHub HEAD changed without authoritative tracker verification; returned unmapped to prevent dropping active task",
        diagnostic: {
          category: "invariant_violation",
          reason: "unmapped",
          source: "decision",
          sourceCode: code,
          message,
          suggestedAction: "require_human",
          details,
        },
      };
    }

    case "unsupported_strategy":
    case "unsupported_task_kind":
      return {
        mapped: true,
        diagnostic: {
          category: "invariant_violation",
          reason: "impossible_transition",
          source: "decision",
          sourceCode: code,
          message,
          suggestedAction: "require_human",
          details,
        },
      };

    case "malformed_output":
      return {
        mapped: false,
        rawCode: code,
        message,
        gapReason:
          "malformed_output is an execution symptom; cannot determine transient vs permanent without parser context",
        diagnostic: {
          category: "recoverable",
          reason: "unmapped",
          source: "decision",
          sourceCode: code,
          message,
          suggestedAction: suggestedAction === "retry" ? "retry" : "require_human",
          details,
        },
      };

    case "execution_failed":
      return {
        mapped: false,
        rawCode: code,
        message,
        gapReason:
          "generic execution_failed lacks diagnostic context; must not be blindly defaulted to transient or retryable",
        diagnostic: {
          category: "recoverable",
          reason: "unmapped",
          source: "decision",
          sourceCode: code,
          message,
          suggestedAction: suggestedAction === "retry" ? "retry" : "require_human",
          details,
        },
      };

    case "cancelled":
      return {
        mapped: false,
        rawCode: code,
        message,
        gapReason:
          "cancelled without recorded authority (operator vs supervisor vs timeout) cannot be categorized",
        diagnostic: {
          category: "superseded",
          reason: "unmapped",
          source: "decision",
          sourceCode: code,
          message,
          suggestedAction: "none",
          details,
        },
      };
  }
}

/**
 * Maps DeliveryError codes into provider-neutral continuity failure taxonomy.
 */
export function mapDeliveryFailure(input: {
  readonly code: DeliveryErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}): ContinuityFailureMappingResult {
  const { code, message, details } = input;

  switch (code) {
    case "network_failure":
    case "timeout":
      return {
        mapped: true,
        diagnostic: {
          category: "transient",
          reason: "network_timeout",
          source: "delivery",
          sourceCode: code,
          message,
          suggestedAction: "retry",
          details,
        },
      };

    case "rate_limited":
      return {
        mapped: true,
        diagnostic: {
          category: "transient",
          reason: "network_timeout",
          source: "delivery",
          sourceCode: code,
          message,
          suggestedAction: "await_external",
          details,
        },
      };

    case "auth_failure":
      return {
        mapped: true,
        diagnostic: {
          category: "blocked_external",
          reason: "auth_required",
          source: "delivery",
          sourceCode: code,
          message,
          suggestedAction: "require_human",
          details,
        },
      };

    case "head_changed":
      return {
        mapped: true,
        diagnostic: {
          category: "superseded",
          reason: "stale_head",
          source: "delivery",
          sourceCode: code,
          message,
          suggestedAction: "none",
          details,
        },
      };

    case "checks_waiting":
      return {
        mapped: true,
        diagnostic: {
          category: "blocked_external",
          reason: "ci_checks_pending",
          source: "delivery",
          sourceCode: code,
          message,
          suggestedAction: "await_external",
          details,
        },
      };

    case "checks_failing":
      return {
        mapped: true,
        diagnostic: {
          category: "recoverable",
          reason: "incomplete_handoff",
          source: "delivery",
          sourceCode: code,
          message,
          suggestedAction: "retry",
          details,
        },
      };

    case "opt_in_required":
    case "review_gate_required":
    case "review_not_approved":
      return {
        mapped: true,
        diagnostic: {
          category: "blocked_external",
          reason: "human_required",
          source: "delivery",
          sourceCode: code,
          message,
          suggestedAction: code === "review_gate_required" ? "await_external" : "require_human",
          details,
        },
      };

    case "ownership_refusal": {
      const conflicting =
        typeof details?.["reason"] === "string" &&
        details["reason"].includes("conflicting_multiple_markers_found");
      return {
        mapped: true,
        diagnostic: {
          category: conflicting ? "invariant_violation" : "superseded",
          reason: conflicting ? "conflicting_owner" : "stale_claim",
          source: "delivery",
          sourceCode: code,
          message,
          suggestedAction: conflicting ? "require_human" : "none",
          details,
        },
      };
    }

    case "cli_missing":
    case "cli_malformed_response":
    case "invalid_context":
    case "session_mismatch":
      return {
        mapped: true,
        diagnostic: {
          category: "invariant_violation",
          reason: "impossible_transition",
          source: "delivery",
          sourceCode: code,
          message,
          suggestedAction: "require_human",
          details,
        },
      };

    case "merge_rejected":
    case "pr_closed_unmerged":
      return {
        mapped: true,
        diagnostic: {
          category: "blocked_external",
          reason: "human_required",
          source: "delivery",
          sourceCode: code,
          message,
          suggestedAction: "require_human",
          details,
        },
      };

    case "checks_unknown":
    case "verification_unknown":
    case "requirements_unavailable":
      return {
        mapped: false,
        rawCode: code,
        message,
        gapReason:
          "observation source status is unknown; fresh read required before failure can be categorized",
        diagnostic: {
          category: "transient",
          reason: "unmapped",
          source: "delivery",
          sourceCode: code,
          message,
          suggestedAction: "retry",
          details,
        },
      };
  }
}

/**
 * Maps DeliveryHandoffReason values into provider-neutral continuity failure taxonomy.
 */
export function mapDeliveryHandoffReason(input: {
  readonly reason: DeliveryHandoffReason;
  readonly details: string;
}): ContinuityFailureMappingResult {
  const { reason, details } = input;

  switch (reason) {
    case "budget_exhausted":
    case "manual_intervention_required":
    case "review_needs_human":
    case "ci_failed_max_repairs":
    case "review_changes_requested_max_repairs":
    case "ci_wait_timeout":
    case "unmergeable":
      return {
        mapped: true,
        diagnostic: {
          category: "blocked_external",
          reason: "human_required",
          source: "delivery",
          sourceCode: reason,
          message: details,
          suggestedAction: "require_human",
        },
      };

    case "foreign_pr_conflict":
      return {
        mapped: true,
        diagnostic: {
          category: "invariant_violation",
          reason: "conflicting_owner",
          source: "delivery",
          sourceCode: reason,
          message: details,
          suggestedAction: "require_human",
        },
      };

    case "reconciliation_needed":
      return {
        mapped: true,
        diagnostic: {
          category: "recoverable",
          reason: "incomplete_handoff",
          source: "delivery",
          sourceCode: reason,
          message: details,
          suggestedAction: "compensate",
        },
      };
  }
}

/**
 * Maps browser Web Driver failure symptoms into provider-neutral continuity failure taxonomy.
 */
export function mapWebDriverFailure(input: {
  readonly errorKind: "navigation_lost" | "bridge_unavailable" | "checkpoint_mismatch" | "stale_binding" | string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}): ContinuityFailureMappingResult {
  const { errorKind, message, details } = input;

  switch (errorKind) {
    case "navigation_lost":
      return {
        mapped: true,
        diagnostic: {
          category: "recoverable",
          reason: "navigation_lost",
          source: "chatgpt-web",
          sourceCode: errorKind,
          message,
          suggestedAction: "rebind",
          details,
        },
      };

    case "bridge_unavailable":
      return {
        mapped: true,
        diagnostic: {
          category: "transient",
          reason: "bridge_unavailable",
          source: "chatgpt-web",
          sourceCode: errorKind,
          message,
          suggestedAction: "retry",
          details,
        },
      };

    case "stale_binding":
      return {
        mapped: true,
        diagnostic: {
          category: "recoverable",
          reason: "stale_binding",
          source: "chatgpt-web",
          sourceCode: errorKind,
          message,
          suggestedAction: "rebind",
          details,
        },
      };

    case "checkpoint_mismatch":
      return {
        mapped: true,
        diagnostic: {
          category: "superseded",
          reason: "stale_generation",
          source: "chatgpt-web",
          sourceCode: errorKind,
          message,
          suggestedAction: "none",
          details,
        },
      };

    default:
      return {
        mapped: false,
        rawCode: errorKind,
        message,
        gapReason: `unknown web driver error kind '${errorKind}'`,
        diagnostic: {
          category: "recoverable",
          reason: "unmapped",
          source: "chatgpt-web",
          sourceCode: errorKind,
          message,
          suggestedAction: "rebind",
          details,
        },
      };
  }
}

/**
 * Maps orchestrator failure symptoms into provider-neutral continuity failure taxonomy.
 */
export function mapOrchestratorFailure(input: {
  readonly failureKind:
    | "process_stalled"
    | "stale_generation"
    | "stale_owner_token"
    | "epoch_mismatch"
    | "cancelled_by_reconciliation"
    | "retry_limit"
    | string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}): ContinuityFailureMappingResult {
  const { failureKind, message, details } = input;

  switch (failureKind) {
    case "process_stalled":
      return {
        mapped: true,
        diagnostic: {
          category: "recoverable",
          reason: "process_stalled",
          source: "orchestrator",
          sourceCode: failureKind,
          message,
          suggestedAction: "retry",
          details,
        },
      };

    case "stale_generation":
    case "stale_owner_token":
    case "epoch_mismatch":
    case "cancelled_by_reconciliation":
      return {
        mapped: true,
        diagnostic: {
          category: "superseded",
          reason: "stale_generation",
          source: "orchestrator",
          sourceCode: failureKind,
          message,
          suggestedAction: "none",
          details,
        },
      };

    case "retry_limit":
      return {
        mapped: true,
        diagnostic: {
          category: "blocked_external",
          reason: "human_required",
          source: "orchestrator",
          sourceCode: failureKind,
          message,
          suggestedAction: "require_human",
          details,
        },
      };

    default:
      return {
        mapped: false,
        rawCode: failureKind,
        message,
        gapReason: `unrecognized orchestrator failure kind '${failureKind}'`,
        diagnostic: {
          category: "transient",
          reason: "unmapped",
          source: "orchestrator",
          sourceCode: failureKind,
          message,
          suggestedAction: "retry",
          details,
        },
      };
  }
}

// ---------------------------------------------------------------------------
// 10. Execution Continuity Descriptor
// ---------------------------------------------------------------------------

/**
 * The canonical observation descriptor for execution continuity of a work item or scope.
 * Purely declarative and read-only: does NOT mutate existing authorities or maintain a
 * second workflow state machine.
 */
export interface ExecutionContinuityDescriptor {
  readonly workKey: WorkKey;
  readonly scope: ContinuityScope;
  readonly state: ContinuityState;
  readonly expectedAction: ExpectedNextAction | null;
  readonly liveness: LivenessMetadata;
  readonly fence: SafeOwnershipFence;
  readonly blockedDetails?: BlockedReasonDetails | undefined;
  readonly failureDiagnostic?: ContinuityFailureDiagnostic | undefined;
}

export type ContinuityValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly invariant: number; readonly reason: string };

/** Validates that an ActionAuthority object is well-formed with non-empty fields. */
export function validateActionAuthority(
  authority: ActionAuthority | undefined | null,
): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
  if (!authority || typeof authority !== "object") {
    return { valid: false, reason: "Action authority must be an object" };
  }
  if (authority.kind === "internal") {
    if (!authority.authority || authority.authority.trim() === "") {
      return {
        valid: false,
        reason: "Internal action authority must specify a non-empty authority name",
      };
    }
    return { valid: true };
  }
  if (authority.kind === "external") {
    if (!authority.system || authority.system.trim() === "") {
      return {
        valid: false,
        reason: "External action authority must specify a non-empty system name",
      };
    }
    if (!authority.condition || authority.condition.trim() === "") {
      return {
        valid: false,
        reason: "External action authority must specify a non-empty condition",
      };
    }
    return { valid: true };
  }
  if (authority.kind === "human") {
    if (!authority.role || authority.role.trim() === "") {
      return {
        valid: false,
        reason: "Human action authority must specify a non-empty role",
      };
    }
    if (!authority.instruction || authority.instruction.trim() === "") {
      return {
        valid: false,
        reason: "Human action authority must specify a non-empty instruction",
      };
    }
    return { valid: true };
  }
  return {
    valid: false,
    reason: `Unknown action authority kind: ${(authority as { readonly kind: string }).kind}`,
  };
}

/**
 * Pure function that validates that an ExecutionContinuityDescriptor adheres to the 8 required invariants.
 */
export function validateContinuityDescriptor(
  descriptor: ExecutionContinuityDescriptor,
): ContinuityValidationResult {
  const { state, expectedAction, liveness, blockedDetails, fence } = descriptor;

  // Invariant 1: Every active work item must have an expected next action.
  if (isActiveContinuityState(state)) {
    if (!expectedAction) {
      return {
        valid: false,
        invariant: 1,
        reason: `Active continuity state '${state}' must specify an expectedNextAction`,
      };
    }
  }

  // Invariant 2: Every expected action must have an owner or explicit external/human waiting authority.
  if (expectedAction) {
    const authVal = validateActionAuthority(expectedAction.authority);
    if (!authVal.valid) {
      return {
        valid: false,
        invariant: 2,
        reason: authVal.reason,
      };
    }
  }

  // Invariant 3: 'blocked' is not equivalent to terminal failure or retry queued.
  if (state === "blocked") {
    if (!blockedDetails) {
      return {
        valid: false,
        invariant: 3,
        reason: `State 'blocked' must provide blockedDetails with reason, waitingOn authority, and unblock condition`,
      };
    }
    if (isTerminalContinuityState(state)) {
      return {
        valid: false,
        invariant: 3,
        reason: `State 'blocked' must never be categorized as terminal`,
      };
    }
    if (
      !blockedDetails.reason ||
      (typeof blockedDetails.reason === "string" && blockedDetails.reason.trim() === "")
    ) {
      return {
        valid: false,
        invariant: 3,
        reason: `State 'blocked' blockedDetails must specify a non-empty reason`,
      };
    }
    if (!blockedDetails.unblockCondition || blockedDetails.unblockCondition.trim() === "") {
      return {
        valid: false,
        invariant: 3,
        reason: `State 'blocked' blockedDetails must specify a non-empty unblockCondition`,
      };
    }
    const waitingAuthVal = validateActionAuthority(blockedDetails.waitingOn);
    if (!waitingAuthVal.valid) {
      return {
        valid: false,
        invariant: 3,
        reason: `State 'blocked' waitingOn authority invalid: ${waitingAuthVal.reason}`,
      };
    }
  }

  // Invariant 4: Retry semantics are re-observe + re-decide, not blind replay.
  if (state === "retry_queued") {
    if (
      expectedAction &&
      expectedAction.action !== "retry" &&
      expectedAction.action !== "reclaim" &&
      expectedAction.action !== "resume" &&
      expectedAction.action !== "rebind"
    ) {
      return {
        valid: false,
        invariant: 4,
        reason: `State 'retry_queued' expected action must be a re-evaluating recovery action (retry, reclaim, resume, or rebind)`,
      };
    }
  }

  // Invariant 5: Stale continuation fencing: generation / epoch / fence values must be non-negative.
  if (fence.lifecycleGeneration !== undefined && fence.lifecycleGeneration < 0) {
    return {
      valid: false,
      invariant: 5,
      reason: `Lifecycle generation cannot be negative`,
    };
  }
  if (fence.reconciliationEpoch !== undefined && fence.reconciliationEpoch < 0) {
    return {
      valid: false,
      invariant: 5,
      reason: `Reconciliation epoch cannot be negative`,
    };
  }
  if (fence.leaseGeneration !== undefined && fence.leaseGeneration < 0) {
    return {
      valid: false,
      invariant: 5,
      reason: `Lease generation cannot be negative`,
    };
  }
  if (fence.bindingGeneration !== undefined && fence.bindingGeneration < 0) {
    return {
      valid: false,
      invariant: 5,
      reason: `Binding generation cannot be negative`,
    };
  }

  // Liveness constraints
  if (liveness.startedAt > liveness.lastObservedAt) {
    return {
      valid: false,
      invariant: 6,
      reason: `startedAt (${liveness.startedAt}) cannot be in the future of lastObservedAt (${liveness.lastObservedAt})`,
    };
  }
  if (typeof liveness.lastProgressAt === "number" && liveness.lastProgressAt > liveness.lastObservedAt) {
    return {
      valid: false,
      invariant: 6,
      reason: `lastProgressAt (${liveness.lastProgressAt}) cannot be in the future of lastObservedAt (${liveness.lastObservedAt})`,
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// 11. Canonical Typed Examples across Workflow Stages
// ---------------------------------------------------------------------------

/**
 * Typed canonical descriptors illustrating expected action, authority, and required facts
 * across representative workflow stages (planning, coding, CI, review, repair, delivery, merge).
 */
export const CanonicalStageDescriptors = {
  createPlanningDescriptor(params: {
    readonly workKey: WorkKey;
    readonly observedAt: UtcTimestampMs;
    readonly startedAt: UtcTimestampMs;
    readonly sessionId: string;
    readonly taskId: string;
    readonly revision: number;
    readonly bindingGeneration: number;
  }): ExecutionContinuityDescriptor {
    return {
      workKey: params.workKey,
      scope: "task",
      state: "running",
      expectedAction: {
        action: "none",
        description: "Executing Decision planning task via Web Agent Bridge",
        authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
        taskRef: { taskId: params.taskId, revision: params.revision },
        requiredEvidence: ["issue_requirements_fresh", "bridge_active", "session_bound"],
      },
      liveness: {
        startedAt: params.startedAt,
        lastProgressAt: "unknown",
        lastObservedAt: params.observedAt,
      },
      fence: {
        bindingGeneration: params.bindingGeneration,
        hasLeaseToken: true,
      },
    };
  },

  createCodingDescriptor(params: {
    readonly workKey: WorkKey;
    readonly observedAt: UtcTimestampMs;
    readonly startedAt: UtcTimestampMs;
    readonly attempt: number;
    readonly retryToken: string;
    readonly lifecycleGeneration: number;
  }): ExecutionContinuityDescriptor {
    return {
      workKey: params.workKey,
      scope: "attempt",
      state: "running",
      expectedAction: {
        action: "none",
        description: "Coding agent active in workspace executing issue prompt",
        authority: { kind: "internal", authority: "orchestrator", executor: "codex-agent" },
        requiredEvidence: ["workspace_provisioned", "prompt_rendered", "session_active"],
      },
      liveness: {
        startedAt: params.startedAt,
        lastProgressAt: params.startedAt,
        lastObservedAt: params.observedAt,
        attempt: params.attempt,
      },
      fence: {
        retryToken: params.retryToken,
        lifecycleGeneration: params.lifecycleGeneration,
        hasLeaseToken: false,
      },
    };
  },

  createCiWaitingDescriptor(params: {
    readonly workKey: WorkKey;
    readonly observedAt: UtcTimestampMs;
    readonly startedAt: UtcTimestampMs;
    readonly prNumber: number;
    readonly headSha: string;
  }): ExecutionContinuityDescriptor {
    return {
      workKey: params.workKey,
      scope: "work",
      state: "blocked",
      expectedAction: {
        action: "await_external",
        description: `Waiting for GitHub CI checks completion on PR #${params.prNumber}`,
        authority: {
          kind: "external",
          system: "github-actions",
          condition: "required_checks_completed_and_green",
        },
        requiredEvidence: ["pr_open", "head_sha_matched", "checks_pending"],
      },
      liveness: {
        startedAt: params.startedAt,
        lastProgressAt: "unknown",
        lastObservedAt: params.observedAt,
      },
      fence: {
        expectedHeadSha: params.headSha,
        hasLeaseToken: false,
      },
      blockedDetails: {
        reason: "ci_checks_pending",
        waitingOn: {
          kind: "external",
          system: "github-actions",
          condition: "required_checks_completed_and_green",
        },
        unblockCondition: "All required check suites conclude with success",
        blockedAt: params.observedAt,
      },
    };
  },

  createReviewClaimDescriptor(params: {
    readonly workKey: WorkKey;
    readonly observedAt: UtcTimestampMs;
    readonly startedAt: UtcTimestampMs;
    readonly target: DecisionReviewTarget;
    readonly taskId: string;
    readonly revision: number;
  }): ExecutionContinuityDescriptor {
    return {
      workKey: params.workKey,
      scope: "task",
      state: "running",
      expectedAction: {
        action: "dispatch",
        description: `Claiming review task for PR #${params.target.prNumber} at HEAD ${params.target.headSha.slice(0, 10)}`,
        authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
        target: params.target,
        taskRef: { taskId: params.taskId, revision: params.revision },
        requiredEvidence: ["ci_green", "review_task_pending", "target_head_matched"],
      },
      liveness: {
        startedAt: params.startedAt,
        lastProgressAt: "unknown",
        lastObservedAt: params.observedAt,
      },
      fence: {
        expectedHeadSha: params.target.headSha,
        hasLeaseToken: true,
      },
    };
  },

  createRepairDescriptor(params: {
    readonly workKey: WorkKey;
    readonly observedAt: UtcTimestampMs;
    readonly startedAt: UtcTimestampMs;
    readonly attempt: number;
    readonly target: DecisionReviewTarget;
    readonly retryToken: string;
  }): ExecutionContinuityDescriptor {
    return {
      workKey: params.workKey,
      scope: "attempt",
      state: "running",
      expectedAction: {
        action: "retry",
        description: "Re-observing review findings and re-executing repair turn",
        authority: { kind: "internal", authority: "delivery", executor: "codex-agent" },
        target: params.target,
        requiredEvidence: ["review_verdict_changes_requested", "repair_budget_available"],
      },
      liveness: {
        startedAt: params.startedAt,
        lastProgressAt: params.startedAt,
        lastObservedAt: params.observedAt,
        attempt: params.attempt,
      },
      fence: {
        expectedHeadSha: params.target.headSha,
        retryToken: params.retryToken,
        hasLeaseToken: false,
      },
    };
  },

  createDeliveryResumeDescriptor(params: {
    readonly workKey: WorkKey;
    readonly observedAt: UtcTimestampMs;
    readonly startedAt: UtcTimestampMs;
    readonly handoffId: string;
    readonly target: DecisionReviewTarget;
  }): ExecutionContinuityDescriptor {
    return {
      workKey: params.workKey,
      scope: "work",
      state: "recovering",
      expectedAction: {
        action: "compensate",
        description: `Compensating delivery handoff state for handoff ${params.handoffId}`,
        authority: { kind: "internal", authority: "delivery" },
        target: params.target,
        requiredEvidence: ["persisted_paused_state", "remote_label_status", "comment_verified"],
      },
      liveness: {
        startedAt: params.startedAt,
        lastProgressAt: params.startedAt,
        lastObservedAt: params.observedAt,
      },
      fence: {
        expectedHeadSha: params.target.headSha,
        hasLeaseToken: false,
      },
    };
  },

  createMergeConfirmationDescriptor(params: {
    readonly workKey: WorkKey;
    readonly observedAt: UtcTimestampMs;
    readonly startedAt: UtcTimestampMs;
    readonly target: DecisionReviewTarget;
    readonly lastProgressAt?: UtcTimestampMs | "unknown" | undefined;
  }): ExecutionContinuityDescriptor {
    return {
      workKey: params.workKey,
      scope: "work",
      state: "running",
      expectedAction: {
        action: "none",
        description: `Executing squash-merge and verifying merged state for PR #${params.target.prNumber}`,
        authority: { kind: "internal", authority: "delivery" },
        target: params.target,
        requiredEvidence: ["exact_head_approved", "ci_all_green", "mergeable"],
      },
      liveness: {
        startedAt: params.startedAt,
        lastProgressAt: params.lastProgressAt ?? "unknown",
        lastObservedAt: params.observedAt,
      },
      fence: {
        expectedHeadSha: params.target.headSha,
        hasLeaseToken: false,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 12. Work Continuity Condition & Derivation (NEST-131 / GitHub #147)
// ---------------------------------------------------------------------------

/**
 * Diagnostic condition characterizing the execution continuity state of a work item.
 * Deliberately distinguishes making progress, legitimate waits, blocked states,
 * and stranded/contradictory anomalies.
 */
export type WorkContinuityCondition =
  | "making_progress"
  | "blocked"
  | "external_wait"
  | "retry_scheduled"
  | "stranded"
  | "contradictory"
  | "observation_unavailable"
  | "completed";

export const WORK_CONTINUITY_CONDITIONS = [
  "making_progress",
  "blocked",
  "external_wait",
  "retry_scheduled",
  "stranded",
  "contradictory",
  "observation_unavailable",
  "completed",
] as const satisfies readonly WorkContinuityCondition[];

/**
 * High-level lifecycle stage derived from authoritative cross-source facts.
 */
export type WorkContinuityStage =
  | "planning"
  | "coding"
  | "ci_wait"
  | "review"
  | "repair"
  | "delivery_compensate"
  | "merge"
  | "completed"
  | "terminal";

export const WORK_CONTINUITY_STAGES = [
  "planning",
  "coding",
  "ci_wait",
  "review",
  "repair",
  "delivery_compensate",
  "merge",
  "completed",
  "terminal",
] as const satisfies readonly WorkContinuityStage[];

/**
 * Concrete recovery delegation proposal produced when work is stranded.
 * Carries the required authority and fence coordinates to prevent race conditions.
 */
export type RecoveryProposal =
  | {
      readonly kind: "decision_release_expired_claim";
      readonly authority: "decision";
      readonly taskId: string;
      readonly revision?: number | undefined;
      readonly claimGeneration?: number | undefined;
      readonly bindingGeneration?: number | undefined;
    }
  | {
      readonly kind: "decision_dispatch_plan";
      readonly authority: "decision";
      readonly sessionId: string;
    }
  | {
      readonly kind: "decision_dispatch_review";
      readonly authority: "decision";
      readonly target: DecisionReviewTarget;
      readonly sessionId: string;
    }
  | {
      readonly kind: "orchestrator_dispatch";
      readonly authority: "orchestrator";
      readonly issueId: string;
    }
  | {
      readonly kind: "orchestrator_retry";
      readonly authority: "orchestrator";
      readonly issueId: string;
    }
  | {
      readonly kind: "orchestrator_stop_stalled";
      readonly authority: "orchestrator";
      readonly issueId: string;
    }
  | {
      readonly kind: "delivery_compensate";
      readonly authority: "delivery";
      readonly handoffId?: string | undefined;
      readonly target?: DecisionReviewTarget | undefined;
    }
  | {
      readonly kind: "delivery_resume_repair";
      readonly authority: "delivery";
      readonly target: DecisionReviewTarget;
    };

/**
 * Normalized fact bundle for one WorkKey across sources.
 */
export interface WorkItemFacts {
  readonly workKey: WorkKey;
  readonly github?: {
    readonly issue: { readonly state: "open" | "closed"; readonly url?: string | undefined };
    readonly pullRequest: {
      readonly number: number;
      readonly state: "open" | "closed" | "merged";
      readonly headSha: string;
      readonly isDraft: boolean;
      readonly url?: string | undefined;
    } | null;
    readonly ci: {
      readonly status: "pending" | "success" | "failure";
      readonly headSha?: string | undefined;
    } | null;
  } | null | undefined;
  readonly orchestrator?: {
    readonly isRunning: boolean;
    readonly isStalled: boolean;
    readonly attempt?: number | null | undefined;
    readonly attemptToken?: string | undefined;
    readonly lifecycleGeneration?: number | undefined;
    readonly reconciliationEpoch?: number | undefined;
    readonly lastProgressAt?: UtcTimestampMs | "unknown" | undefined;
    readonly retryScheduled?: {
      readonly attempt: number;
      readonly retryInMs: number;
      readonly error: string | null;
    } | null | undefined;
  } | null | undefined;
  readonly decision?: {
    readonly sessionStatus?: "active" | "broken-binding" | "closed" | undefined;
    readonly bindingGeneration?: number | undefined;
    readonly latestPlanTask?: {
      readonly taskId: string;
      readonly revision: number;
      readonly status: "pending" | "claimed" | "running" | "completed" | "failed";
      readonly lease?: { readonly owner: string; readonly generation: number; readonly expiresAtMs: UtcTimestampMs } | null | undefined;
      readonly claimGeneration?: number | undefined;
      readonly verdict?: "ready" | "needs_clarification" | "needs_human" | undefined;
    } | null | undefined;
    readonly latestReviewTask?: {
      readonly taskId: string;
      readonly revision: number;
      readonly status: "pending" | "claimed" | "running" | "completed" | "failed";
      readonly lease?: { readonly owner: string; readonly generation: number; readonly expiresAtMs: UtcTimestampMs } | null | undefined;
      readonly claimGeneration?: number | undefined;
      readonly target: DecisionReviewTarget;
      readonly verdict?: "approve" | "changes_requested" | "needs_human" | undefined;
    } | null | undefined;
  } | null | undefined;
  readonly delivery?: {
    readonly isPaused: boolean;
    readonly pauseReason?: string | undefined;
    readonly pendingCompensation: boolean;
    readonly handoff?: {
      readonly handoffId?: string | undefined;
      readonly reason: string;
      readonly details: string;
    } | null | undefined;
    readonly spentRepairs: number;
    readonly maxRepairs: number;
    readonly spentWaitSeconds: number;
    readonly maxWaitSeconds: number;
    readonly lastUpdated?: string | undefined;
  } | null | undefined;
  readonly sourceFreshness?: {
    readonly github?: "fresh" | "stale" | "unavailable" | "unknown" | undefined;
    readonly decision?: "fresh" | "stale" | "unavailable" | "unknown" | undefined;
    readonly unavailableReason?: string | undefined;
  } | undefined;
}

/**
 * Result of deriving work continuity for a work item from its cross-source facts.
 */
export interface WorkContinuityAnalysis {
  readonly workKey: WorkKey;
  readonly stage: WorkContinuityStage;
  readonly condition: WorkContinuityCondition;
  readonly expectedAction: ExpectedNextAction | null;
  readonly currentOwner: ActionAuthority | null;
  readonly liveness: LivenessMetadata;
  readonly fence: SafeOwnershipFence;
  readonly blockedDetails?: BlockedReasonDetails | undefined;
  readonly strandedReason?: string | undefined;
  readonly recoveryProposal?: RecoveryProposal | null | undefined;
  readonly descriptor: ExecutionContinuityDescriptor;
  readonly sourceFreshness?: Readonly<Record<string, string>> | undefined;
}
