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
