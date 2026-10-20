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
