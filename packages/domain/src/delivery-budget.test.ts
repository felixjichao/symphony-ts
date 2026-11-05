import { describe, expect, it } from "vitest";
import { authorizeDeliveryBudget, completeDeliveryBudgetPhase, enterDeliveryBudgetPhase, evaluateDeliveryBudget, isDeliveryBudgetExhaustion, isDeliveryBudgetState, migrateLegacyDeliveryBudget } from "./delivery-budget";
import type { DeliveryBudgetState, PersistedDeliveryState } from "./delivery";

const budget = (): DeliveryBudgetState => ({
  schemaVersion: 1, deliveryRoundId: "round-1", totalStartedAtMs: 1_000, totalDeadlineAtMs: 11_000,
  phaseLimitsMs: { ci: 4_000, review: 3_000, repair: 2_000, validation: 1_000 },
  activePhase: null, phaseHistory: [], spentRepairs: 0, repairLimit: 4, authorizationGeneration: 0, authorizations: [],
});

describe("delivery budget contracts", () => {
  it("persists completion without refreshing authority, and retains it when the exhausted phase is renewed", () => {
    const entered = enterDeliveryBudgetPhase(budget(), "validation", "initial", 2_000);
    const completed = completeDeliveryBudgetPhase(entered, "validation", "initial", 2_500);
    expect(completed.activePhase).toMatchObject({ completedAtMs: 2_500, deadlineAtMs: 3_000 });
    expect(isDeliveryBudgetState(completed)).toBe(true);
    expect(completeDeliveryBudgetPhase(completed, "validation", "initial", 2_700)).toBe(completed);
    expect(() => completeDeliveryBudgetPhase(completed, "validation", "initial", 3_000)).toThrow(/exhausted/);
    expect(isDeliveryBudgetState({ ...completed, activePhase: { ...completed.activePhase!, completedAtMs: 3_000 } })).toBe(false);
    const renewed = authorizeDeliveryBudget(completed, { id: "renew", expectedGeneration: 0, deadlineAtMs: 11_000,
      repairLimit: 4, reason: "revalidate", renewPhase: { phase: "validation", identity: "initial" } }, 3_000);
    expect(renewed.phaseHistory[0]?.completedAtMs).toBe(2_500);
    expect(renewed.activePhase?.completedAtMs).toBeUndefined();
    expect(isDeliveryBudgetState(renewed)).toBe(true);
  });
  it("retains a phase deadline on reentry and grants a new HEAD its own bounded phase", () => {
    const first = enterDeliveryBudgetPhase(budget(), "ci", "head-a", 2_000);
    expect(first.activePhase?.deadlineAtMs).toBe(6_000);
    expect(enterDeliveryBudgetPhase(first, "ci", "head-a", 5_000)).toBe(first);
    const review = enterDeliveryBudgetPhase(first, "review", "head-a/revision-1", 6_000);
    const second = enterDeliveryBudgetPhase(review, "ci", "head-b", 9_000);
    expect(second.activePhase?.deadlineAtMs).toBe(11_000);
    expect(second.phaseHistory).toHaveLength(2);
    expect(second.totalDeadlineAtMs).toBe(11_000);
    expect(enterDeliveryBudgetPhase(second, "ci", "head-a", 10_000).activePhase?.deadlineAtMs).toBe(6_000);
    expect(() => enterDeliveryBudgetPhase(second, "review", "head-b/revision-1", 11_000)).toThrow(/total budget/);
  });

  it("identifies phase exhaustion and gives the total deadline priority on a tie", () => {
    const ci = enterDeliveryBudgetPhase(budget(), "ci", "head-a", 2_000);
    expect(evaluateDeliveryBudget(ci, 5_999, "head-a")).toBeNull();
    expect(evaluateDeliveryBudget(ci, 6_000, "head-a")).toMatchObject({ budgetKind: "phase", phase: "ci",
      phaseIdentity: "head-a", startedAtMs: 2_000, deadlineAtMs: 6_000, elapsedMs: 4_000,
      limitMs: 4_000, remainingMs: 0, headSha: "head-a" });
    const exhaustion = evaluateDeliveryBudget(ci, 6_000, "head-a")!;
    expect(isDeliveryBudgetExhaustion(exhaustion)).toBe(true);
    expect(isDeliveryBudgetExhaustion({ ...exhaustion, observedAtMs: Number.MAX_SAFE_INTEGER })).toBe(false);
    const second = enterDeliveryBudgetPhase(ci, "ci", "head-b", 9_000);
    expect(evaluateDeliveryBudget(second, 11_000, "head-b")).toMatchObject({ budgetKind: "total", phase: "ci",
      phaseIdentity: "head-b", startedAtMs: 1_000, deadlineAtMs: 11_000, elapsedMs: 10_000, limitMs: 10_000 });
  });

  it("rejects malformed budgets, overflow, and broken authorization history", () => {
    const initial = budget();
    expect(isDeliveryBudgetState(initial)).toBe(true);
    expect(isDeliveryBudgetState({ ...initial, phaseLimitsMs: { ...initial.phaseLimitsMs, ci: Infinity } })).toBe(false);
    expect(isDeliveryBudgetState({ ...initial, authorizationGeneration: 1 })).toBe(false);
    expect(isDeliveryBudgetState({ ...initial, spentRepairs: 5 })).toBe(false);
    expect(() => enterDeliveryBudgetPhase({ ...initial, phaseLimitsMs: { ...initial.phaseLimitsMs, ci: Number.MAX_SAFE_INTEGER } }, "ci", "head", 2_000)).toThrow(/overflow/);
    expect(() => enterDeliveryBudgetPhase(initial, "ci", "head", 999)).toThrow(/clock precedes/);
    expect(() => authorizeDeliveryBudget(initial, { id: "clock", expectedGeneration: 0, deadlineAtMs: 20_000,
      repairLimit: 4, reason: "extend" }, 999)).toThrow(/clock precedes/);
    const receipt = { id: "auth-1", generation: 1, previousDeadlineAtMs: 11_000, newDeadlineAtMs: 21_000,
      previousRepairLimit: 4, newRepairLimit: 8, spentRepairs: 4, authorizedAtMs: 10_000, reason: "more time" };
    const extended = { ...initial, totalDeadlineAtMs: 21_000, repairLimit: 8, spentRepairs: 4,
      authorizationGeneration: 1, authorizations: [receipt] };
    expect(isDeliveryBudgetState(extended)).toBe(true);
    expect(isDeliveryBudgetState({ ...extended, totalDeadlineAtMs: 22_000 })).toBe(false);
    expect(isDeliveryBudgetState({ ...extended, authorizations: [receipt, receipt], authorizationGeneration: 2 })).toBe(false);
  });

  it("authorizes an exhausted phase once, retaining spent repairs and fencing stale writers", () => {
    const initial = enterDeliveryBudgetPhase({ ...budget(), spentRepairs: 4 }, "ci", "head-b", 8_000);
    const request = { id: "auth-1", expectedGeneration: 0, deadlineAtMs: 20_000, repairLimit: 8, reason: "continue review", renewPhase: { phase: "ci" as const, identity: "head-b" } };
    const extended = authorizeDeliveryBudget(initial, request, 11_000);
    expect(extended.spentRepairs).toBe(4);
    expect(extended.activePhase?.deadlineAtMs).toBe(15_000);
    expect(extended.phaseHistory[0]?.deadlineAtMs).toBe(11_000);
    expect(isDeliveryBudgetState(extended)).toBe(true);
    expect(authorizeDeliveryBudget(extended, request, 12_000)).toBe(extended);
    expect(() => authorizeDeliveryBudget(extended, { ...request, id: "auth-2" }, 12_000)).toThrow(/Stale/);
    expect(() => authorizeDeliveryBudget(extended, { ...request, repairLimit: 9 }, 12_000)).toThrow(/identifier/);
    expect(() => authorizeDeliveryBudget(initial, request, 9_000)).toThrow(/not exhausted/);
    expect(() => authorizeDeliveryBudget(initial, { ...request, renewPhase: { phase: "ci", identity: "head-c" } }, 11_000)).toThrow(/identity changed/);
    const totalOnly = authorizeDeliveryBudget(initial, { ...request, id: "total-only", renewPhase: undefined }, 11_000);
    expect(totalOnly.activePhase?.deadlineAtMs).toBe(11_000);
    expect(totalOnly.spentRepairs).toBe(4);
  });

  it("migrates proven legacy authority without starting a fresh wait", () => {
    const legacy: PersistedDeliveryState = { repo: "owner/repo", issueNumber: 203, workspaceKey: "GH-203",
      spentRepairs: 4, spentWaitSeconds: 70, deadlineTimestampMs: 100_000, isPaused: true, lastUpdated: "now",
      continuation: { intentId: "intent", headBranch: "work", baseBranch: "main", headSha: "head-b", prNumber: 42,
        optInLand: true, readyLabel: "ready", maxRepairAttempts: 8, maxWaitSeconds: 90, phase: "ci" } };
    const migrated = migrateLegacyDeliveryBudget(legacy);
    expect(migrated.totalStartedAtMs).toBe(10_000);
    expect(migrated.totalStartEstimated).toBe(true);
    expect(migrated.totalDeadlineAtMs).toBe(100_000);
    expect(migrated.activePhase).toMatchObject({ identity: "head-b", startedAtMs: 10_000, deadlineAtMs: 100_000 });
    expect(migrated.spentRepairs).toBe(4);
    expect(() => migrateLegacyDeliveryBudget({ ...legacy, continuation: undefined })).toThrow(/Ambiguous/);
    expect(() => migrateLegacyDeliveryBudget({ ...legacy, deadlineTimestampMs: undefined })).toThrow(/Ambiguous/);
    expect(() => migrateLegacyDeliveryBudget({ ...legacy, deadlineTimestampMs: 20 })).toThrow(/deadline/);
    const handoff = { reason: "budget_exhausted" as const, details: "expired", repo: legacy.repo,
      issueNumber: legacy.issueNumber, headBranch: "work", prNumber: 42, prUrl: null, headSha: "head-b",
      spentRepairs: 4, maxRepairs: 9, spentWaitSeconds: 70, maxWaitSeconds: 90, readyLabel: "ready" };
    expect(() => migrateLegacyDeliveryBudget({ ...legacy, handoff })).toThrow(/conflicting authority/);
    expect(() => migrateLegacyDeliveryBudget({ ...legacy, handoff: { ...handoff, maxRepairs: 8, maxWaitSeconds: 100 } })).toThrow(/conflicting authority/);
    expect(migrateLegacyDeliveryBudget({ ...legacy, handoff: { ...handoff, maxRepairs: 8 } }).repairLimit).toBe(8);
  });
});
