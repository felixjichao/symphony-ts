/** Work-level reconciliation facts (SPEC §4 adjacent; §7/§8/§14). Not a lifecycle store. */
import type { ActionAuthority, ExpectedNextAction, LivenessMetadata, OwnershipFence, RecoveryAction, SafeOwnershipFence } from "./execution-continuity";
import type { DecisionReviewTarget } from "./decision";
import type { WorkKey } from "./operations-facts";

export type WorkContinuityStage = "plan" | "coding" | "ci" | "review" | "delivery" | "repair" | "handoff" | "merge";
export interface ContinuityOwner {
  readonly id: string;
  readonly fence: OwnershipFence;
  readonly liveness: LivenessMetadata;
  /** An unexpired lease establishes authority even when business progress is unknown. */
  readonly leaseExpiresAt?: number | undefined;
}
export interface WorkContinuityObservation {
  readonly workKey: WorkKey;
  readonly observedAt: number;
  /** Must change when admission, task revision, HEAD, binding, or ownership changes. */
  readonly version: string;
  readonly active: boolean;
  readonly stage: WorkContinuityStage;
  readonly available: boolean;
  readonly unavailableSources: readonly string[];
  readonly expectedFence: OwnershipFence;
  readonly owner: ContinuityOwner | null;
  readonly blocked: string | null;
  /** Host-owned policy block; unlike a native handoff pause it forbids compensation too. */
  readonly recoveryIncidentId?: string;
  readonly nativeRecovery?: { readonly lastProgressAt: number | "unknown"; readonly attempts: number; readonly epoch: number; readonly actions: readonly import("./recovery-policy").RecoveryStrategy[] };
  readonly externalWait: { readonly system: string; readonly condition: string } | null;
  readonly scheduled: { readonly id: string; readonly kind: "retry" | "recovery" | "admission"; readonly due: boolean } | null;
  readonly contradictions: readonly string[];
  readonly target?: DecisionReviewTarget | undefined;
  readonly taskRef?: { readonly taskId: string; readonly revision: number } | undefined;
  /** Native handoff identity, independent of observation/version timestamps. */
  readonly handoffRef?: { readonly handoffId: string; readonly headSha: string | null } | undefined;
}
export interface WorkContinuityDiagnosis {
  readonly workKey: WorkKey;
  readonly observedAt: number;
  readonly status: "inactive" | "healthy" | "unknown" | "blocked" | "external_wait" | "scheduled" | "stranded" | "stalled" | "contradictory" | "observation_unavailable" | "unverified";
  readonly next: ExpectedNextAction;
  readonly owner: { readonly id: string; readonly fence: SafeOwnershipFence; readonly liveness: LivenessMetadata } | null;
  readonly reasons: readonly string[];
  readonly recovery: RecoveryAction;
}
export interface WorkRecoveryRequest {
  /** Unique invocation identity: a stale acknowledgement cannot clear its successor. */
  readonly invocationId?: string;
  readonly workKey: WorkKey;
  readonly version: string;
  readonly stage: WorkContinuityStage;
  readonly action: RecoveryAction;
  readonly authority: ActionAuthority;
  readonly fence: OwnershipFence;
  readonly taskRef?: { readonly taskId: string; readonly revision: number } | undefined;
  readonly handoffRef?: { readonly handoffId: string; readonly headSha: string | null } | undefined;
  readonly leaseExpiresAt?: number | undefined;
}
/** stale/unsupported/stopped certify that this invocation did not commit a mutation. */
/** failed: attempted native operation with authoritative proof that no mutation committed. */
export type WorkRecoveryResult = "failed" | "applied" | "stale" | "unsupported" | "stopped" | "unverified";
