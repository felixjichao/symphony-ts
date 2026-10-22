import type { DecisionTaskStatus, DecisionResult, DecisionReviewTarget } from "./decision";
import type { WorkKey } from "./operations-facts";

/** Credential-free committed view; heartbeat timestamps deliberately not called progress. */
export interface DecisionContinuityTask {
  readonly id: string;
  readonly revision: number;
  readonly kind: "plan" | "review";
  readonly status: DecisionTaskStatus;
  readonly claimGeneration: number;
  readonly claimBindingGeneration: number | null;
  readonly createdAtMs: number;
  readonly owner: string | null;
  readonly leaseExpiresAtMs: number | null;
  readonly verdict: DecisionResult["verdict"] | null;
  readonly target: DecisionReviewTarget | null;
  readonly execution?: DecisionExecution | null;
}
export interface DecisionContinuityWork {
  readonly workKey: WorkKey;
  readonly sessionId: string;
  readonly bindingGeneration: number;
  readonly tasks: readonly DecisionContinuityTask[];
}
export interface ReclaimDecisionClaim {
  readonly taskId: string;
  readonly revision: number;
  readonly claimGeneration: number;
  readonly bindingGeneration: number;
  readonly leaseExpiresAtMs: number;
}

/**
 * Fence for an operator-authorized unblock after inspecting the exact block fact.
 * `leaseExpiresAtMs` must equal the incumbent lease expiry for a leased execution, and must be
 * `null` for a pending execution that owns no lease: the absence of a lease is itself the state
 * being fenced, so an authorization captured before a later claim cannot clear that claim's block.
 * `blockedAtMs` pins the block the operator reviewed, so a replay cannot clear a newer one.
 */
export interface UnblockDecisionExecution {
  readonly taskId: string;
  readonly revision: number;
  readonly claimGeneration: number;
  readonly bindingGeneration: number;
  readonly leaseExpiresAtMs: number | null;
  readonly blockedAtMs: number;
}

/** Native Decision facts, scoped to a task revision. No credentials or response text. */
export interface DecisionExecution {
  readonly revision: number;
  readonly startedAtMs: number;
  readonly lastProgressAtMs: number;
  readonly deadlineAtMs: number;
  readonly phase: string;
  readonly responseLength: number;
  readonly recoveryAttempts: number;
  readonly blocked: { readonly reason: string; readonly unblock: string; readonly atMs: number } | null;
}

export const DECISION_PROGRESS_TIMEOUT_MS = 10 * 60_000;
export const DECISION_MAX_RECOVERY_ATTEMPTS = 3;

export const DECISION_MAX_TRANSPORT_RECOVERIES = 6;

export const DECISION_EXECUTION_PHASES: readonly string[] = [
  "unknown", "claimed", "navigating", "bootstrap_submitting", "bootstrap_waiting", "started",
  "prompt_submitting", "waiting_response", "result_extracted", "completed",
];
