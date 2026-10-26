import { describe, it, expect } from "vitest";
import type { RecoveryBudget, RecoveryContext, RecoveryLedger } from "@symphony/domain";
import { reserveRecovery, refundRecovery, beginRecoveryEpoch } from "./recovery-policy";

const context: RecoveryContext = { workKey: { provider: "github", key: "owner/repo#1" }, expectedAction: "review:recover",
  target: "task/revision/head", owner: "decision", fence: { hasLeaseToken: false }, lastProgressAt: 100,
  failure: { classification: "recoverable", reason: "navigation_lost" }, unblock: "Inspect receipt and authorize" };
function fixture() {
  const records = new Map<string, RecoveryBudget>();
  const ledger: RecoveryLedger = { list: () => [...records.values()], transact: (scope, update) => {
    const result = update(records.get(scope) ?? null); records.set(scope, result); return result;
  } };
  let count = 0;
  const reserve = (overrides: Partial<Parameters<typeof reserveRecovery>[0]> = {}) => reserveRecovery({
    ledger, policy: { maxAttempts: 6, maxStrategyAttempts: 2 }, context, invocation: `invocation-${++count}`,
    strategies: ["retry", "resume", "rebind"], now: 1000, ...overrides,
  });
  return { ledger, reserve };
}
describe("bounded native recovery policy", () => {
  it("escalates supported strategies and stops after six reservations", () => {
    const { reserve } = fixture();
    const actions = Array.from({ length: 6 }, () => reserve().strategy);
    expect(actions).toEqual(["retry", "retry", "resume", "resume", "rebind", "rebind"]);
    const blocked = reserve();
    expect(blocked.incident).toMatchObject({ attempts: 6, blockedReason: "recovery_exhausted", lastProgressAt: 100, owner: "decision" });
    expect(reserve().incident?.id).toBe(blocked.incident?.id);
  });
  it("uses only supported primitives and keeps single-strategy retries bounded", () => {
    const { reserve } = fixture();
    for (let i = 0; i < 6; i++) expect(reserve({ strategies: ["reclaim"] }).strategy).toBe("reclaim");
    expect(reserve({ strategies: ["reclaim"] }).incident?.blockedReason).toBe("recovery_exhausted");
  });
  it("does not reset the epoch limit when fingerprints alternate", () => {
    const { reserve } = fixture();
    for (let i = 0; i < 6; i++) reserve({ context: { ...context, failure: { classification: "transient", reason: `known-${i % 2}` } } });
    expect(reserve().incident?.attempts).toBe(6);
  });
  it("preserves the fingerprint across liveness/fencing observations, and resets for a new authoritative target", () => {
    const { reserve } = fixture();
    const first = reserve();
    const second = reserve({ context: { ...context, owner: "new-owner", fence: { hasLeaseToken: true, bindingGeneration: 99 }, lastProgressAt: 900 } });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.repeated).toBe(2);
    expect(second.epoch).toBe(first.epoch);
    const changed = reserve({ context: { ...context, target: "new-task/revision/head" } });
    expect(changed.epoch).toBe(first.epoch + 1);
    expect(changed.attempts).toBe(1);
  });
  it.each(["auth_required", "human_required", "invariant_violation", "irrecoverable_binding", "outcome_unknown"] as const)("blocks %s without authorizing a mutation", classification => {
    const { reserve } = fixture();
    const result = reserve({ context: { ...context, failure: { classification, reason: classification } } });
    expect(result.attempts).toBe(0);
    expect(result.incident?.blockedReason).toBe(classification);
  });
  it("charges an invocation once, but can block its uncertain outcome", () => {
    const { reserve } = fixture();
    reserve({ invocation: "same" });
    expect(reserve({ invocation: "same" }).attempts).toBe(1);
    expect(reserve({ invocation: "same", context: { ...context, failure: { classification: "outcome_unknown", reason: "receipt_unknown" } } }).incident?.attempts).toBe(1);
  });
  it("refunds certified pre-mutation refusal and inherits legacy counts conservatively", () => {
    const { ledger, reserve } = fixture();
    const reserved = reserve({ invocation: "stale", priorAttempts: 4 });
    expect(reserved.attempts).toBe(5);
    refundRecovery(ledger, reserved.scope, "stale", reserved.epoch);
    expect(ledger.list()[0]?.attempts).toBe(4);
    expect(ledger.list()[0]?.actions).toEqual([]);
  });
  it("does not let a stale refusal refund the same invocation in a newly authorized epoch", () => {
    const { ledger, reserve } = fixture();
    const old = reserve({ invocation: "same" });
    ledger.transact(old.scope, current => beginRecoveryEpoch(current!));
    const current = reserve({ invocation: "same" });
    refundRecovery(ledger, old.scope, "same", old.epoch);
    expect(ledger.list()[0]?.attempts).toBe(current.attempts);
    expect(ledger.list()[0]?.invocations).toContain("same");
  });
  it.each([0, -1, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid limits %s", maxAttempts => {
    expect(() => fixture().reserve({ policy: { maxAttempts, maxStrategyAttempts: 2 } })).toThrow();
  });
});
