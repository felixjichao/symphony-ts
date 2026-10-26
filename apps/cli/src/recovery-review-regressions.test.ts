/** NEST-134 review blockers: native scheduling + durable host evidence. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError, type AgentAttemptOptions } from "@symphony/agent";
import type { DurableRetryReservation, Issue, WorkContinuityObservation } from "@symphony/domain";
import { createOrchestratorRuntimeState, OrchestratorAuthority, WorkContinuityCoordinator } from "@symphony/orchestrator";
import { FileRecoveryLedger } from "./recovery-ledger";
import { FileRetryReservationStorage } from "./recovery-storage";
import { createHostRecovery } from "./host-recovery";
import { runRecoveryCli } from "./recovery-cli";
import { RecoveryIncidentReporter } from "./recovery-reporter";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const workKey = { provider: "github", key: "owner/repo#1" };
const facts: WorkContinuityObservation = { workKey, observedAt: 100, version: "current", active: true,
  stage: "coding", available: true, unavailableSources: [], expectedFence: {}, owner: null,
  blocked: null, externalWait: null, scheduled: null, contradictions: [] };
const issue: Issue = { id: "1", identifier: "GH-1", nativeRef: null, title: "work", description: null,
  state: "open", priority: 1, branchName: null, url: null, assigneeId: null, labels: [], blockedBy: [],
  dispatchable: true, createdAt: 0, updatedAt: null };
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-review-")); dirs.push(dir);
  const ledger = new FileRecoveryLedger(path.join(dir, "ledger.json"));
  const recovery = createHostRecovery(ledger, () => ({ maxAttempts: 6, maxStrategyAttempts: 2 }), () => 1000);
  return { dir, ledger, recovery };
}
function nativeFixture() {
  const f = fixture();
  const storage = new FileRetryReservationStorage(path.join(f.dir, "retries.json"));
  const state = createOrchestratorRuntimeState({ pollIntervalMs: 1000, maxConcurrentAgents: 1 });
  let runs = 0;
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const makeAuthority = () => new OrchestratorAuthority({ state, retryStorage: storage, resolveWorkKey: () => workKey,
    authorizeFailureRetry: (request, invocation) => f.recovery.authorizeRetry(request, invocation, workKey),
    policy: { activeStates: ["open"], terminalStates: ["closed"], requiredLabels: [], maxConcurrentAgentsByState: {} },
    runner: async () => {
      if (++runs > 1) throw new AgentError("port_exit", "fixture failure");
      return { workspace: { path: f.dir, workspaceKey: issue.identifier, createdNow: false }, issue,
        threadId: "thread", turnCount: 1, lastTurn: { turnId: "turn", sessionId: "thread-turn" }, stopReason: "decider_stop" };
    },
    createAttemptOptions: context => ({ issue: context.issue, attempt: context.attempt } as unknown as AgentAttemptOptions),
    tracker: { fetchIssuesByIds: async () => [issue] }, resolveWorkspacePath: () => f.dir,
    retry: { scheduler: { schedule: (_delay, callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
      cancel: handle => { timers.delete(handle as number); } }, maxRetryBackoffMs: () => 300000,
      cleanupWorkspace: { removeWorkspace: async () => ({ status: "missing" as const }) } },
  });
  const fire = async () => {
    const [id, callback] = [...timers.entries()].at(-1)!;
    timers.delete(id); callback();
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  return { ...f, storage, state, makeAuthority, fire, timers, runs: () => runs };
}
describe("recovery review regressions", () => {
  it.each(["invalid_workspace_cwd", "invariant_violation"])("never clears %s merely because coding ownership is consistent", error => {
    const { ledger, recovery } = fixture();
    expect(recovery.authorizeRetry({ issueId: issue.id, identifier: issue.identifier, attempt: 1, kind: "failure", reason: "worker_failure", error }, "failed-worker", workKey)).toBe(false);
    const incident = ledger.incidents()[0]!;
    expect(incident.failure.classification).toBe("invariant_violation");
    expect(incident.unblockCondition).toBeUndefined();
    const reopened = createHostRecovery(new FileRecoveryLedger(ledger.file), () => ({ maxAttempts: 6, maxStrategyAttempts: 2 }), () => 2000);
    for (let i = 0; i < 10; i++) {
      expect(reopened.observe(facts).recoveryIncidentId).toBe(incident.id);
      expect(reopened.blocked(workKey)).toBe(true);
    }
    expect(ledger.list()[0]?.epoch).toBe(1);
    expect(ledger.incidents()).toHaveLength(1);
    expect(runRecoveryCli(["authorize", ledger.file, incident.id], { stdout: { write() {} }, stderr: { write() {} } })).toBe(0);
    expect(reopened.observe(facts).recoveryIncidentId).toBeUndefined();
    expect(ledger.list()[0]?.epoch).toBe(2);
  });
  it("requires explicit authorization for a legacy invariant incident without a modeled unblock condition", () => {
    const { ledger, recovery } = fixture();
    recovery.observe({ ...facts, contradictions: ["multiple_active_decision_tasks"] });
    const snapshot = JSON.parse(fs.readFileSync(ledger.file, "utf8")) as {
      budgets: { incident: { unblockCondition?: unknown } }[]; incidents: { unblockCondition?: unknown }[];
    };
    delete snapshot.budgets[0]!.incident.unblockCondition;
    delete snapshot.incidents[0]!.unblockCondition;
    fs.writeFileSync(ledger.file, JSON.stringify(snapshot));
    expect(recovery.observe(facts).recoveryIncidentId).toBe(ledger.incidents()[0]?.id);
    expect(ledger.list()[0]?.epoch).toBe(1);
  });
  it("rejects unknown retry accounting schemas rather than discarding migration evidence", () => {
    const f = nativeFixture();
    fs.writeFileSync(path.join(f.dir, "retries.json"), JSON.stringify({ schemaVersion: 1, reservations: [{
      workKey, issueId: issue.id, identifier: issue.identifier, issueUrl: null, attempt: 5, kind: "failure", error: "legacy",
      dueAtUtcMs: 1000, token: "old", phase: "scheduled", recoveryAccounting: { schemaVersion: 2, legacyAttempts: 4 },
    }] }));
    expect(() => f.storage.load()).toThrow("Invalid retry recovery accounting");
    expect(f.ledger.list()).toEqual([]);
  });
  it.each([false, true])("does not charge six native slot waits when the first resumed worker fails (restart=%s)", async restart => {
    const f = nativeFixture(); let authority = f.makeAuthority();
    try {
      authority.dispatchIssue(issue); await authority.waitForIdle();
      expect(f.ledger.list()).toEqual([]);
      f.state.maxConcurrentAgents = 0;
      for (let i = 0; i < 6; i++) {
        await f.fire();
        expect(f.state.retryAttempts.get(issue.id)?.attempt).toBe(i + 2);
        expect(f.ledger.list()).toEqual([]);
        expect(f.storage.load()[0]?.recoveryAccounting).toEqual({ schemaVersion: 1, legacyAttempts: 0 });
      }
      if (restart) { await authority.shutdown(); authority = f.makeAuthority(); authority.restoreRetries(); }
      f.state.maxConcurrentAgents = 1;
      await f.fire(); await authority.waitForIdle();
      expect(f.runs()).toBe(2);
      expect(f.ledger.list()[0]?.attempts).toBe(1);
      expect(f.ledger.incidents()).toEqual([]);
      for (let i = 0; i < 5; i++) { await f.fire(); await authority.waitForIdle(); }
      expect(f.ledger.list()[0]?.attempts).toBe(6);
      expect(f.ledger.incidents()).toEqual([]);
      await f.fire(); await authority.waitForIdle();
      expect(f.ledger.incidents()[0]).toMatchObject({ attempts: 6, blockedReason: "recovery_exhausted" });
      expect(f.timers.size).toBe(0);
    } finally { await authority.shutdown(); }
  });
  it("preserves explicit legacy migration evidence across timer reconstruction, not new queue attempts", async () => {
    const f = nativeFixture();
    const record: DurableRetryReservation = { workKey, issueId: issue.id, identifier: issue.identifier, issueUrl: null,
      attempt: 5, kind: "failure", error: "legacy failure", dueAtUtcMs: 1000, token: "old", phase: "scheduled" };
    f.storage.put(record, null);
    let authority = f.makeAuthority();
    authority.restoreRetries();
    expect(f.storage.load()[0]?.recoveryAccounting).toEqual({ schemaVersion: 1, legacyAttempts: 4 });
    await authority.shutdown();
    authority = f.makeAuthority(); authority.restoreRetries();
    try {
      expect(f.ledger.list()).toEqual([]);
      await f.fire(); await authority.waitForIdle(); // successful continuation does not erase legacy evidence
      expect(f.storage.load()[0]?.recoveryAccounting?.legacyAttempts).toBe(4);
      await f.fire(); await authority.waitForIdle();
      expect(f.ledger.list()[0]?.attempts).toBe(5);
      expect(f.ledger.incidents()).toEqual([]);
    } finally { await authority.shutdown(); }
  });
  it.each(["review_requires_human", "manual_intervention_required", "review_needs_human", "budget_exhausted", "ci_failed_max_repairs", "review_changes_requested_max_repairs", "ci_wait_timeout", "unmergeable"])("reports native %s once through the durable reporter", async reason => {
    const f = fixture();
    const blocked = { ...facts, stage: "review" as const, blocked: reason };
    for (let i = 0; i < 3; i++) f.recovery.observe(blocked);
    const incident = f.ledger.incidents()[0]!;
    expect(f.ledger.incidents()).toHaveLength(1);
    expect(incident).toMatchObject({ blockedReason: "human_required", failure: { classification: "human_required", reason } });
    let output = "";
    expect(runRecoveryCli(["list", f.ledger.file], { stdout: { write: s => { output += s; } }, stderr: { write() {} } })).toBe(0);
    expect(output).toContain(incident.id);
    let posts = 0;
    const reporter = new RecoveryIncidentReporter(f.ledger, { gh: async args => {
      if (args.includes("POST")) posts++;
      return { exitCode: 0, stdout: args.includes("POST") ? "{}" : "[[]]", stderr: "" };
    } }, f.dir);
    const isCurrent = async () => f.recovery.observe(blocked).recoveryIncidentId === incident.id || f.recovery.isNativeIncident(blocked, incident.id);
    await reporter.publish(isCurrent, () => true); await reporter.publish(isCurrent, () => true);
    expect(posts).toBe(1);
  });
  it("reports a Delivery human block without taking over its pending compensation", async () => {
    const f = fixture(); let compensations = 0;
    let current: WorkContinuityObservation = { ...facts, stage: "handoff", blocked: "manual_intervention_required",
      handoffRef: { handoffId: "handoff", headSha: "head" } };
    const coordinator = new WorkContinuityCoordinator({ listWork: async () => [workKey], observe: async () => f.recovery.observe(current),
      authorizeRecovery: (r, o) => f.recovery.authorize(r, o), canCommitRecovery: r => f.recovery.canCommit(r),
      recover: async (_r, canCommit) => {
        expect(canCommit()).toBe(true); compensations++;
        current = { ...current, stage: "coding" }; // native pause remains after compensation completes
        return "applied";
      } });
    await coordinator.reconcile(); await coordinator.reconcile();
    expect(compensations).toBe(1);
    expect(f.ledger.incidents()).toHaveLength(1);
    expect(f.recovery.isNativeIncident(current, f.ledger.incidents()[0]!.id)).toBe(true);
  });
});
