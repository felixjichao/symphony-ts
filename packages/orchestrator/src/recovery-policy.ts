/** Bounded strategy selection; the native authority still owns every recovery effect (§14). */
import { createHash } from "node:crypto";
import { recoveryFingerprintInput, recoveryScope, type RecoveryBudget, type RecoveryContext,
  type RecoveryLedger, type RecoveryPolicy, type RecoveryStrategy } from "@symphony/domain";

export function reserveRecovery(options: {
  ledger: RecoveryLedger; policy: RecoveryPolicy; context: RecoveryContext;
  priorAttempts?: number;
  priorActions?: readonly RecoveryStrategy[];
  invocation: string; strategies: readonly RecoveryStrategy[]; now: number;
}): RecoveryBudget {
  const { ledger, context, policy, invocation, strategies, now } = options;
  if (![policy.maxAttempts, policy.maxStrategyAttempts].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error("Recovery limits must be finite positive integers");
  }
  const scope = recoveryScope(context);
  const fingerprint = createHash("sha256").update(recoveryFingerprintInput(context)).digest("hex");
  return ledger.transact(scope, previous => {
    const current: RecoveryBudget = previous?.target === context.target ? previous : {
      schemaVersion: 1, scope, target: context.target, epoch: (previous?.epoch ?? 0) + 1,
      attempts: options.priorAttempts ?? 0, fingerprint, repeated: 0, strategy: null, strategyAttempts: 0,
      actions: options.priorActions ?? [], invocations: [], incident: null,
    };
    if (current.incident || current.invocations.includes(invocation) && (context.failure.classification === "transient" || context.failure.classification === "recoverable") && strategies.length > 0) return current;
    const same = current.fingerprint === fingerprint;
    // Strategy progression is epoch-wide. Alternating fingerprints cannot restore a spent strategy.
    const index = current.strategy === null ? 0 : strategies.indexOf(current.strategy);
    const nextIndex = current.strategy !== null && current.strategyAttempts >= policy.maxStrategyAttempts && index + 1 < strategies.length ? index + 1 : Math.max(0, index);
    const strategy = strategies[nextIndex] ?? null;
    const nonRetryable = context.failure.classification !== "transient" && context.failure.classification !== "recoverable";
    const blockedReason = nonRetryable ? context.failure.classification
      : current.attempts >= policy.maxAttempts || !strategy ? "recovery_exhausted" : null;
    if (blockedReason) {
      const id = createHash("sha256").update(JSON.stringify([scope, fingerprint, current.epoch])).digest("hex");
      return { ...current, fingerprint, incident: { ...context, id, fingerprint, epoch: current.epoch,
        attempts: current.attempts, actions: current.actions, blockedReason, createdAt: now } };
    }
    return { ...current, attempts: current.attempts + 1, fingerprint, repeated: same ? current.repeated + 1 : 1,
      strategy, strategyAttempts: strategy === current.strategy ? current.strategyAttempts + 1 : 1,
      actions: [...current.actions, strategy!], invocations: [...current.invocations, invocation] };
  });
}

/** Certified pre-mutation refusal refunds its reservation, never a completed/uncertain action. */
export function refundRecovery(ledger: RecoveryLedger, scope: string, invocation: string, expectedEpoch: number): void {
  ledger.transact(scope, current => {
    if (!current) throw new Error("Missing recovery reservation");
    if (current.epoch !== expectedEpoch) return current;
    const index = current.invocations.indexOf(invocation);
    if (current.incident || index < 0) return current;
    const invocations = current.invocations.filter(id => id !== invocation);
    const actions = [...current.actions];
    actions.splice(actions.length - current.invocations.length + index, 1);
    const strategy = actions.at(-1) ?? null;
    let strategyAttempts = 0;
    for (let i = actions.length - 1; i >= 0 && actions[i] === strategy; i--) strategyAttempts++;
    return { ...current, attempts: current.attempts - 1, repeated: Math.max(0, current.repeated - 1),
      invocations, actions, strategy, strategyAttempts };
  });
}

/** Only explicit authorization or a proven modeled unblock condition may call this. */
export function beginRecoveryEpoch(current: RecoveryBudget): RecoveryBudget {
  return { ...current, epoch: current.epoch + 1, attempts: 0, repeated: 0, strategy: null,
    strategyAttempts: 0, actions: [], invocations: [], incident: null };
}
