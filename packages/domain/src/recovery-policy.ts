/** Recovery evidence contracts (§4 adjacent, §7/§8/§14). No scheduler or I/O. */
import type { WorkKey } from "./operations-facts";
import type { SafeOwnershipFence } from "./execution-continuity";

export interface RecoveryPolicy {
  readonly maxAttempts: number;
  readonly maxStrategyAttempts: number;
}
export type RecoveryStrategy = "retry" | "resume" | "reconstruct" | "rebind" | "reclaim" | "compensate";
export type RecoveryFailureClass = "transient" | "recoverable" | "auth_required" | "human_required" | "invariant_violation" | "irrecoverable_binding" | "outcome_unknown";
export interface RecoveryFailure {
  readonly classification: RecoveryFailureClass;
  /** A controlled code, never an error message, URL, credential or timestamp. */
  readonly reason: string;
}
export interface RecoveryContext {
  readonly workKey: WorkKey;
  readonly expectedAction: string;
  /** Authoritative task/revision/HEAD or explicit authorization; never a lease generation. */
  readonly target: string;
  readonly owner: string | null;
  readonly fence: SafeOwnershipFence;
  readonly lastProgressAt: number | "unknown";
  readonly failure: RecoveryFailure;
  readonly unblock: string;
  readonly unblockCondition?: { readonly kind: "ownership_conflict_absent"; readonly reason: RecoveryOwnershipConflict };
}
export interface RecoveryIncident extends RecoveryContext {
  readonly id: string;
  readonly fingerprint: string;
  readonly epoch: number;
  readonly attempts: number;
  readonly actions: readonly RecoveryStrategy[];
  readonly blockedReason: string;
  readonly createdAt: number;
}
export interface RecoveryBudget {
  readonly schemaVersion: 1;
  readonly scope: string;
  readonly target: string;
  readonly epoch: number;
  readonly attempts: number;
  readonly fingerprint: string;
  readonly repeated: number;
  readonly strategy: RecoveryStrategy | null;
  readonly strategyAttempts: number;
  readonly actions: readonly RecoveryStrategy[];
  /** Invocation reservations survive restart; a retry of an invocation never charges again. */
  readonly invocations: readonly string[];
  readonly incident: RecoveryIncident | null;
}
export interface RecoveryLedger {
  /** Atomic read/modify/write under the host's cross-process lock. Exceptions fail closed. */
  transact(scope: string, update: (current: RecoveryBudget | null) => RecoveryBudget): RecoveryBudget;
  list(): readonly RecoveryBudget[];
}

/** Canonical components rather than raw error-string normalization. Hashing belongs to host. */
export function recoveryScope(context: Pick<RecoveryContext, "workKey" | "expectedAction">): string {
  return JSON.stringify([context.workKey.provider.toLowerCase(), context.workKey.provider.toLowerCase() === "github" ? context.workKey.key.toLowerCase() : context.workKey.key, context.expectedAction]);
}
export function recoveryFingerprintInput(context: RecoveryContext): string {
  return JSON.stringify([recoveryScope(context), context.target, context.failure.classification, context.failure.reason]);
}

export const RECOVERY_OWNERSHIP_CONFLICTS = [
  "multiple_active_decision_tasks", "runtime_and_decision_ownership_overlap",
  "merged_pull_request_has_conflicting_executor", "runtime_retry_conflicts_with_next_stage",
  "delivery_and_execution_ownership_overlap", "stale_or_conflicting_owner_fence",
  "decision_review_targets_stale_head",
] as const;
export type RecoveryOwnershipConflict = typeof RECOVERY_OWNERSHIP_CONFLICTS[number];
export function isRecoveryOwnershipConflict(reason: unknown): reason is RecoveryOwnershipConflict {
  return typeof reason === "string" && (RECOVERY_OWNERSHIP_CONFLICTS as readonly string[]).includes(reason);
}
export interface NativeRecoveryBlock {
  readonly authority: "decision" | "delivery" | "orchestrator";
  readonly failure: RecoveryFailure;
}
/** Exact native reason codes. Free-form messages never determine report identity. */
export function mapNativeRecoveryBlock(reason: string): NativeRecoveryBlock | null {
  const block = (authority: NativeRecoveryBlock["authority"], classification: RecoveryFailureClass): NativeRecoveryBlock => ({ authority, failure: { classification, reason } });
  switch (reason) {
    case "auth_required": return block("decision", "auth_required");
    case "human_required": case "approval_required": case "review_requires_human":
    case "verdict_needs_human": case "verdict_needs_clarification": case "unresolved_clarifications":
      return block("decision", "human_required");
    case "invariant_violation": return block("decision", "invariant_violation");
    case "irrecoverable_binding": return block("decision", "irrecoverable_binding");
    case "recovery_exhausted": return block("decision", "recoverable");
    case "manual_intervention_required": case "review_needs_human": case "budget_exhausted":
    case "landing_target_superseded": case "pull_request_closed_unmerged": case "delivery_paused":
    case "ci_failed_max_repairs": case "review_changes_requested_max_repairs": case "ci_wait_timeout": case "unmergeable":
      return block("delivery", "human_required");
    case "foreign_pr_conflict": return block("delivery", "invariant_violation");
    case "delivery_reclaim_interrupted": case "legacy_delivery_authority_requires_verification": case "delivery_subprocess_outcome_unverified":
      return block("delivery", "outcome_unknown");
    case "worker_launch_unverified": case "retry_recovery_unverified": case "recovery_outcome_unverified":
      return block("orchestrator", "outcome_unknown");
    default: return null;
  }
}
