import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import type { WorkContinuityObservation, WorkRecoveryRequest } from "@symphony/domain";
import { WorkContinuityCoordinator } from "@symphony/orchestrator";
import { FileRecoveryLedger } from "./recovery-ledger";
import { FileWorkRecoveryStorage } from "./recovery-storage";
import { createHostRecovery } from "./host-recovery";
import { runRecoveryCli } from "./recovery-cli";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const workKey = { provider: "github", key: "owner/repo#1" };
const facts: WorkContinuityObservation = { workKey, observedAt: 100, version: "current", active: true,
  stage: "delivery", available: true, unavailableSources: [], expectedFence: { expectedHeadSha: "head" }, owner: null,
  target: { repository: "owner/repo", prNumber: 1, headSha: "head" }, blocked: null, externalWait: null, scheduled: null, contradictions: [] };
const request: WorkRecoveryRequest = { invocationId: "first", workKey, version: "current", stage: "delivery", action: "dispatch",
  authority: { kind: "internal", authority: "delivery" }, fence: facts.expectedFence };
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-budget-")); dirs.push(dir);
  const ledger = new FileRecoveryLedger(path.join(dir, "ledger.json"));
  const recovery = createHostRecovery(ledger, () => ({ maxAttempts: 2, maxStrategyAttempts: 1 }), () => 1000);
  return { dir, ledger, recovery };
}
describe("host native recovery composition", () => {
  it("persists worker budgets across success continuations, classifies human blocks, and permits exact authorization", () => {
    const { ledger, recovery } = fixture();
    const retry = { issueId: "1", identifier: "GH-1", attempt: 1, kind: "failure" as const, reason: "worker_failure" as const, error: "port_exit" };
    expect(recovery.authorizeRetry(retry, "one", workKey)).toBe(true);
    expect(recovery.authorizeRetry(retry, "two", workKey)).toBe(true);
    expect(recovery.authorizeRetry(retry, "three", workKey)).toBe(false);
    expect(recovery.observe({ ...facts, stage: "coding", expectedFence: {} }).blocked).toContain("recovery_exhausted");
    const incident = ledger.incidents()[0]!;
    expect(runRecoveryCli(["authorize", ledger.file, incident.id], { stdout: { write() {} }, stderr: { write() {} } })).toBe(0);
    expect(recovery.blocked(workKey)).toBe(false);
    expect(recovery.authorizeRetry({ ...retry, error: "approval_required" }, "four", workKey)).toBe(false);
    expect(ledger.incidents()[1]?.blockedReason).toBe("human_required");
    expect(ledger.list()[0]?.attempts).toBe(0);
  });
  it("fences a reserved mutation when an operator changes its epoch, and refunds refused mutation", () => {
    const { ledger, recovery } = fixture();
    expect(recovery.authorize(request, facts)).toBe(true);
    expect(recovery.canCommit(request)).toBe(true);
    recovery.refused(request);
    expect(ledger.list()[0]?.attempts).toBe(0);
    expect(recovery.canCommit(request)).toBe(false);
    recovery.authorize(request, facts);
    recovery.unverified(request, facts);
    expect(recovery.canCommit(request)).toBe(false);
    const incident = ledger.incidents()[0]!;
    runRecoveryCli(["authorize", ledger.file, incident.id], { stdout: { write() {} }, stderr: { write() {} } });
    recovery.unverified(request, facts); // Late old-epoch callback cannot re-block authorized work.
    expect(ledger.list()[0]?.incident).toBeNull();
    recovery.authorize({ ...request, invocationId: "second" }, facts);
    recovery.unverified({ ...request, invocationId: "second" }, facts);
    const blocked = recovery.observe(facts);
    expect(blocked.recoveryIncidentId).toBe(ledger.incidents().at(-1)?.id);
  });
  it("does not turn stale task, HEAD, binding or handoff callbacks into a current incident", () => {
    const { ledger, recovery } = fixture();
    recovery.authorize(request, facts);
    recovery.unverified(request, { ...facts, expectedFence: { expectedHeadSha: "new-head" } });
    recovery.unverified(request, { ...facts, taskRef: { taskId: "new", revision: 2 } });
    recovery.unverified(request, { ...facts, handoffRef: { handoffId: "new", headSha: "head" } });
    expect(ledger.incidents()).toEqual([]);
  });
  it("preserves native Decision exhaustion evidence and resets only after fenced native authorization", () => {
    const { ledger, recovery } = fixture();
    const blocked = { ...facts, stage: "review" as const, taskRef: { taskId: "task", revision: 1 }, blocked: "recovery_exhausted: Inspect receipt",
      nativeRecovery: { attempts: 3, epoch: 0, lastProgressAt: 50, actions: ["rebind", "reclaim", "rebind"] as const } };
    recovery.observe(blocked);
    expect(ledger.incidents()[0]).toMatchObject({ attempts: 3, lastProgressAt: 50, blockedReason: "recovery_exhausted", actions: ["rebind", "reclaim", "rebind"] });
    expect(recovery.observe({ ...blocked, blocked: null }).recoveryIncidentId).toBeDefined();
    expect(recovery.observe({ ...blocked, blocked: null, nativeRecovery: { ...blocked.nativeRecovery, epoch: 1 } }).recoveryIncidentId).toBeUndefined();
  });
  it("does not let a new HEAD reset infrastructure authentication blocks", () => {
    const { recovery } = fixture();
    recovery.observe({ ...facts, blocked: "auth_required: Login" });
    expect(recovery.observe({ ...facts, target: { ...facts.target!, headSha: "new-head" } }).blocked).toContain("auth_required");
  });
  it("durably blocks conflicting ownership and reopens an epoch only when the modeled conflict clears", () => {
    const { ledger, recovery } = fixture();
    const blocked = recovery.observe({ ...facts, contradictions: ["multiple_active_decision_tasks"] });
    expect(blocked.recoveryIncidentId).toBeDefined();
    expect(ledger.incidents()[0]?.unblockCondition).toEqual({ kind: "ownership_conflict_absent", reason: "multiple_active_decision_tasks" });
    expect(recovery.observe({ ...facts, contradictions: ["multiple_active_decision_tasks"] }).recoveryIncidentId).toBe(blocked.recoveryIncidentId);
    expect(recovery.observe(facts).recoveryIncidentId).toBeUndefined();
    expect(ledger.list()[0]?.epoch).toBe(2);
    expect(ledger.incidents()).toHaveLength(1);
  });
  it("keeps legitimate waits out of mutation budgets and bounds uncertain native replays", async () => {
    const { dir, ledger, recovery } = fixture(); let mutations = 0;
    let current = { ...facts, externalWait: { system: "ci", condition: "checks" } } as WorkContinuityObservation;
    const coordinator = new WorkContinuityCoordinator({ recoveryStorage: new FileWorkRecoveryStorage(path.join(dir, "invocations.json")),
      listWork: async () => [workKey], observe: async () => recovery.observe(current),
      authorizeRecovery: (r, f) => recovery.authorize(r, f), canCommitRecovery: r => recovery.canCommit(r),
      onUnverified: (r, f) => recovery.unverified(r, f), canResumeRecovery: (_r, f) => !f.recoveryIncidentId,
      recover: async (_r, canCommit) => { if (canCommit()) mutations++; return "unverified"; } });
    await coordinator.reconcile(); expect(ledger.list()).toEqual([]); expect(mutations).toBe(0);
    current = facts;
    await coordinator.reconcile(); await coordinator.reconcile(); await coordinator.reconcile();
    expect(mutations).toBe(1); expect(ledger.incidents()).toHaveLength(1);
    expect(coordinator.observations[0]?.diagnosis?.status).toBe("blocked");
  });
});
