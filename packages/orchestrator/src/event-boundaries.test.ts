/** SPEC §13 / §17.6: facts at commit points, never scheduler input. */
import { describe, expect, it } from "vitest";
import type { AgentAttemptOptions, AgentAttemptResult } from "@symphony/agent";
import { OrchestratorAuthority, createOrchestratorRuntimeState, type OrchestratorEvent, type WorkerTerminalOutcome, type RetryWorkspaceCleanup } from "./index";
import { makeIssue, defaultPolicy, ManualScheduler } from "./loop.test-helpers";
const issue = makeIssue("GH-1", "Todo");
function harness(throws = false, synchronousFailure = false, cleanup?: RetryWorkspaceCleanup) {
  const state = createOrchestratorRuntimeState({ pollIntervalMs: 10, maxConcurrentAgents: 1 });
  const timer = new ManualScheduler();
  const events: OrchestratorEvent[] = [];
  const outcomes: WorkerTerminalOutcome[] = [];
  let finish!: () => void;
  let utc = 1000;
  let refreshed = [issue];
  let refreshFailure = false;
  let badPath = false;
  let pendingRefresh: Promise<readonly typeof issue[]> | undefined;
  const authority = new OrchestratorAuthority({ state, policy: defaultPolicy(),
    runner(options) {
      if (synchronousFailure) throw new Error("sync");
      return new Promise<AgentAttemptResult>((_resolve, reject) => {
        finish = () => reject(new Error("exit"));
        options.signal?.addEventListener("abort", finish, { once: true });
      });
    },
    createAttemptOptions: (context) => ({ issue: context.issue, attempt: context.attempt, signal: context.signal } as AgentAttemptOptions),
    tracker: { fetchIssuesByIds: async () => { if (refreshFailure) throw new Error("network"); return pendingRefresh ?? refreshed; } },
    resolveWorkspacePath: () => { if (badPath) throw new Error("path failure"); return "/workspace/GH-1"; }, now: () => utc, monotonicNow: () => 5000,
    stallTimeoutMs: () => 1000,
    cleanupWorkspace: cleanup ?? { removeWorkspace: async () => ({ status: "removed" }) },
    retry: { scheduler: timer, maxRetryBackoffMs: () => 300000, cleanupWorkspace: { removeWorkspace: async () => ({ status: "removed" }) } },
    onOutcome(outcome) { outcomes.push(outcome); if (throws) throw new Error("observer"); },
    onEvent(event) {
      if (event.event === "dispatch_committed" || event.event === "worker_started") {
        expect(state.running.has(event.issueId)).toBe(true); expect(state.claimed.has(event.issueId)).toBe(true);
      }
      if (event.event === "retry_scheduled") {
        expect(state.retryAttempts.has(event.issueId)).toBe(true); expect(state.claimed.has(event.issueId)).toBe(true); expect(timer.pendingCount).toBe(1);
      }
      expect(Object.isFrozen(event)).toBe(true);
      events.push(event); if (throws) throw new Error("observer");
    },
  });
  return { state, timer, events, outcomes, authority, finish: () => finish(),
    refresh: (rows: typeof refreshed) => { refreshed = rows; pendingRefresh = undefined; },
    deferRefresh: (promise: Promise<readonly typeof issue[]>) => { pendingRefresh = promise; },
    badPath: () => { badPath = true; }, failRefresh: () => { refreshFailure = true; }, stall: () => { utc = 2001; } };
}
describe("event boundaries", () => {
  it.each([false, true])("committed dispatch → accepted worker → outcome → queued retry, throwing=%s", async (throws) => {
    const h = harness(throws);
    h.authority.dispatchIssue(issue); h.finish(); await h.authority.waitForIdle();
    expect(h.events.map((e) => e.event)).toEqual(["dispatch_committed", "worker_started", "retry_scheduled"]);
    expect(h.outcomes).toHaveLength(1); expect(h.state.running.size).toBe(0);
    expect(h.state.retryAttempts.get(issue.id)?.attempt).toBe(1);
    expect(h.events.at(-1)).toMatchObject({ retryInMs: 10000, attempt: 1 });
    await h.authority.shutdown(); expect(h.timer.pendingCount).toBe(0);
  });
  it("synchronous runner failure never reports accepted worker", async () => {
    const h = harness(true, true); h.authority.dispatchIssue(issue);
    await h.authority.waitForIdle();
    expect(h.events.map((e) => e.event)).toEqual(["dispatch_committed", "retry_scheduled"]);
    expect(h.outcomes[0]?.status).toBe("failed"); await h.authority.shutdown();
  });
  it.each(["missing", "inactive", "unroutable", "terminal"] as const)("reports applied %s stop exactly once", async (reason) => {
    const h = harness(true); h.authority.dispatchIssue(issue);
    h.refresh(reason === "missing" ? [] : [{ ...issue, state: reason === "terminal" ? "Done" : reason === "inactive" ? "Review" : "Todo", dispatchable: reason !== "unroutable" }]);
    await h.authority.reconcileRunningIssues(); await h.authority.reconcileRunningIssues();
    expect(h.events.filter((e) => e.event === "reconciliation_applied")).toEqual([expect.objectContaining({ reason, action: "stop" })]);
    expect(h.state.running.size + h.state.claimed.size + h.state.retryAttempts.size).toBe(0);
    await h.authority.shutdown();
  });
  it("context-aware cleanup receives authority identity once and preserves the legacy port", async () => {
    let legacyCalls = 0;
    const contexts: { issueId: string | null; identifier: string }[] = [];
    const h = harness(false, false, {
      async removeWorkspace() { legacyCalls++; return { status: "removed" }; },
      async removeWorkspaceForIssue(context) { contexts.push(context); return { status: "removed" }; },
    });
    h.authority.dispatchIssue(issue); h.refresh([{ ...issue, state: "Done" }]);
    await h.authority.reconcileRunningIssues();
    expect(contexts).toEqual([{ issueId: issue.id, identifier: issue.identifier }]);
    expect(legacyCalls).toBe(0);
    expect(h.state.running.size + h.state.claimed.size).toBe(0);
    await h.authority.shutdown();
  });
  it("stall outcome and retry remain correct under observer exceptions", async () => {
    const h = harness(true); h.authority.dispatchIssue(issue); h.stall(); await h.authority.reconcileRunningIssues();
    expect(h.outcomes[0]?.status).toBe("stalled"); expect(h.events.filter((e) => e.event === "retry_scheduled")).toHaveLength(1);
    await h.authority.shutdown();
  });
  it("dispatch precondition failure emits failure without committed/start facts", async () => {
    const h = harness(true); h.badPath();
    expect(h.authority.dispatchIssue(issue).kind).toBe("failed");
    expect(h.events.map((e) => e.event)).toEqual(["dispatch_failed"]);
    expect(h.state.running.size + h.state.claimed.size).toBe(0); await h.authority.shutdown();
  });
  it.each(["slots", "dispatch"] as const)("retry %s requeue is observed only after entry and timer commit", async (kind) => {
    const h = harness(true);
    const target = { ...issue, id: "other", identifier: "GH-2" };
    if (kind === "slots") h.authority.dispatchIssue(issue); else h.badPath();
    h.refresh([target]);
    h.authority.scheduleRetry({ issueId: target.id, identifier: target.identifier, attempt: 1, kind: "failure", error: null });
    h.timer.fire(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.events.at(-1)).toMatchObject({ event: "retry_scheduled", reason: kind === "slots" ? "no_available_slots" : "dispatch_failed", attempt: 2 });
    await h.authority.shutdown();
  });
  it("retired exited lifecycle has a distinct fact and does not report stopping a worker", async () => {
    const h = harness(true); h.authority.dispatchIssue(issue);
    let resolve!: (rows: readonly typeof issue[]) => void;
    h.deferRefresh(new Promise((r) => { resolve = r; }));
    const operation = h.authority.reconcileRunningIssues();
    h.finish(); await h.authority.waitForIdle(); resolve([]); await operation;
    expect(h.events.at(-1)).toMatchObject({ event: "reconciliation_applied", action: "retire_exited_lifecycle", reason: "missing", issueIdentifier: issue.identifier });
    expect(h.state.claimed.size + h.state.retryAttempts.size + h.timer.pendingCount).toBe(0); await h.authority.shutdown();
  });
  it("late reconciliation epoch cannot emit applied facts or stop a newer accepted view", async () => {
    const h = harness(true); h.authority.dispatchIssue(issue);
    let resolve!: (rows: readonly typeof issue[]) => void;
    h.deferRefresh(new Promise((r) => { resolve = r; }));
    const old = h.authority.reconcileRunningIssues();
    h.refresh([issue]); await h.authority.reconcileRunningIssues();
    resolve([]); await old;
    expect(h.events.filter((e) => e.event === "reconciliation_applied")).toEqual([]);
    expect(h.state.running.size).toBe(1); await h.authority.shutdown();
  });
  it("retry refresh failure reschedules at the unique commit point, unknown identifier stays null", async () => {
    const h = harness(true); h.authority.scheduleRetry({ issueId: issue.id, identifier: null, attempt: 1, kind: "failure", error: "failed" });
    h.failRefresh(); h.timer.fire();
    // Foreground microtasks, no real network or timer wait.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.events.filter((e) => e.event === "retry_scheduled")).toEqual([
      expect.objectContaining({ issueIdentifier: null, retryInMs: 10000 }), expect.objectContaining({ issueIdentifier: null, retryInMs: 20000 }),
    ]);
    await h.authority.shutdown();
  });
});
