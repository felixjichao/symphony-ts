/** Real authority + public AgentEvent reduction + projector, with controlled boundary ports. */
import { AgentError, type AgentAttemptOptions, type AgentAttemptResult, type AgentEvent } from "@symphony/agent";
import type { Issue } from "@symphony/domain";
import { projectObservabilitySnapshot, tryProjectObservabilitySnapshot } from "@symphony/observability";
import { expect, it } from "vitest";
import { OrchestratorAuthority, createOrchestratorRuntimeState, type AttemptContext, type RetryScheduler } from "./index";

function issue(id = "1", url: string | null = "https://example.com/1"): Issue {
  return { id, identifier: `ABC-${id}`, url, state: "Todo", nativeRef: null, title: "Work", description: null,
    priority: 1, branchName: null, assigneeId: null, labels: [], blockedBy: [], dispatchable: true, createdAt: null, updatedAt: null };
}
const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
function harness() {
  let mono = 100; let wall = 1700000000000; let refreshFails = false; let dispatchFails = false;
  let refreshed: readonly Issue[] = [issue()];
  const state = createOrchestratorRuntimeState({ pollIntervalMs: 30000, maxConcurrentAgents: 2 });
  const timers: { callback: () => void; canceled: boolean }[] = [];
  const scheduler: RetryScheduler = {
    schedule: (_delay, callback) => { const timer = { callback, canceled: false }; timers.push(timer); return timer; },
    cancel: (handle) => { const timer = timers.find((t) => t === handle); if (timer) timer.canceled = true; },
  };
  const attempts: { context: AttemptContext; resolve: (result: AgentAttemptResult) => void; reject: (error: unknown) => void }[] = [];
  let current!: AttemptContext;
  const clock = { wallNow: () => wall, monotonicNow: () => mono };
  const authority = new OrchestratorAuthority({
    state, policy: { activeStates: ["Todo"], terminalStates: ["Done"], requiredLabels: [], maxConcurrentAgentsByState: {} },
    now: clock.wallNow, monotonicNow: clock.monotonicNow, tracker: { fetchIssuesByIds: async () => {
      if (refreshFails) throw new Error("offline"); return refreshed;
    } },
    resolveWorkspacePath: (value) => { if (dispatchFails) throw new Error("path unavailable"); return `/workspace/${value.id}`; },
    createAttemptOptions: (context) => {
      current = context;
      // Controlled runner consumes only this context, not agent/workspace configuration.
      return { issue: context.issue, attempt: context.attempt } as unknown as AgentAttemptOptions;
    },
    runner: () => new Promise<AgentAttemptResult>((resolve, reject) => {
      attempts.push({ context: current, resolve, reject });
      current.signal.addEventListener("abort", () => reject(new AgentError("port_exit", "stopped")), { once: true });
    }),
    retry: { scheduler, maxRetryBackoffMs: () => 300000,
      cleanupWorkspace: { removeWorkspace: async () => ({ status: "missing" }) } },
  });
  return { state, authority, attempts, clock,
    advance: (ms: number) => { mono += ms; wall += ms; },
    refresh: (values: readonly Issue[]) => { refreshed = values; refreshFails = false; },
    failRefresh: () => { refreshFails = true; }, failDispatch: () => { dispatchFails = true; },
    fire: async () => { const timer = [...timers].reverse().find((t) => !t.canceled); if (!timer) throw new Error("no timer");
      timer.canceled = true; timer.callback(); await flush(); },
    snapshot: () => projectObservabilitySnapshot(state, clock),
  };
}
function event(partial: Partial<AgentEvent>): AgentEvent {
  return { event: "notification", timestamp: 1700000000010, codexAppServerPid: "42", threadId: "t", turnId: "u1", ...partial };
}
function success(value: Issue): AgentAttemptResult {
  return { issue: value, workspace: { path: `/workspace/${value.id}`, workspaceKey: value.id, createdNow: false },
    threadId: "t", turnCount: 2, lastTurn: { turnId: "u2", sessionId: "t-u2" }, stopReason: "decider_stop" };
}

it("real telemetry preserves absolute totals, session identity and live/ended duration without observation writes", async () => {
  const h = harness(); const original = issue();
  h.authority.dispatchIssue(original); await flush();
  expect(h.snapshot().running[0]?.tokens).toBeNull();
  const onEvent = h.attempts[0]!.context.onEvent;
  onEvent(event({ turnId: undefined, usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } }));
  expect(h.snapshot()).toMatchObject({ running: [{ tokens: null }], codexTotals: { totalTokens: 100 } });
  onEvent(event({ event: "session_started", summary: "started" }));
  const rateLimits = { primary: { windows: [{ remaining: 5 }] } };
  for (const total of [100, 100, 90, 150]) onEvent(event({ usage: { inputTokens: total - 20, outputTokens: 20, totalTokens: total }, rateLimits }));
  onEvent(event({ threadId: "foreign", turnId: "foreign", usage: { inputTokens: 999, outputTokens: 0, totalTokens: 999 } }));
  onEvent(event({ event: "session_started", turnId: "u2" }));
  h.advance(2000);
  const old = h.snapshot();
  expect(old).toMatchObject({ running: [{ sessionId: "t-u2", turnCount: 2, tokens: { totalTokens: 150 } }],
    codexTotals: { totalTokens: 150, secondsRunning: 2 }, rateLimits });
  expect(h.snapshot()).toEqual(old); expect(h.state.codexTotals.secondsRunning).toBe(0);
  (old.rateLimits as unknown as typeof rateLimits).primary.windows[0]!.remaining = 0;
  expect(rateLimits.primary.windows[0]?.remaining).toBe(5);
  h.state.codexRateLimits = { unsupported: () => 0 };
  expect(tryProjectObservabilitySnapshot(h.state, h.clock).status).toBe("unavailable");
  expect(h.authority.dispatchIssue(original).kind).toBe("skipped"); // original claim still guards duplicate launch
  onEvent(event({ rateLimits }));
  h.attempts[0]!.resolve(success(original)); await flush();
  expect(h.snapshot()).toMatchObject({ running: [], retrying: [{ issueUrl: original.url, retryInMs: 1000 }], codexTotals: { secondsRunning: 2, totalTokens: 150 } });
  expect(old.running[0]?.elapsedMs).toBe(2000);
  await h.fire(); expect(h.state.running.size).toBe(1);
  h.advance(1000); await h.authority.shutdown();
  expect(h.snapshot()).toMatchObject({ running: [], retrying: [], codexTotals: { secondsRunning: 3 } });
});

it("outcome URL survives refresh failure; slot and dispatch requeues update URL including explicit null", async () => {
  const h = harness(); const original = issue();
  h.authority.dispatchIssue(original); await flush();
  const before = h.snapshot();
  const updated = issue("1", "https://example.com/running");
  h.refresh([updated]); await h.authority.reconcileRunningIssues();
  expect(h.snapshot().running[0]?.issueUrl).toBe(updated.url);
  expect(before.running[0]?.issueUrl).toBe(original.url);
  h.attempts[0]!.reject(new AgentError("port_exit", "failed")); await flush();
  expect(h.snapshot().retrying[0]?.issueUrl).toBe(updated.url);
  h.failRefresh(); await h.fire();
  expect(h.snapshot().retrying[0]).toMatchObject({ issueUrl: updated.url, error: "retry refresh failed", attempt: 2 });
  h.state.maxConcurrentAgents = 0; h.refresh([issue("1", "https://example.com/new")]); await h.fire();
  expect(h.snapshot().retrying[0]).toMatchObject({ issueUrl: "https://example.com/new", error: "no available orchestrator slots" });
  h.refresh([issue("1", null)]); await h.fire(); expect(h.snapshot().retrying[0]?.issueUrl).toBeNull();
  h.state.maxConcurrentAgents = 1; h.failDispatch(); h.refresh([issue("1", "https://example.com/latest")]); await h.fire();
  expect(h.snapshot().retrying[0]).toMatchObject({ issueUrl: "https://example.com/latest", error: "failed to dispatch retry: path unavailable" });
  h.refresh([issue("1", null)]); await h.fire(); expect(h.snapshot().retrying[0]?.issueUrl).toBeNull();
  await h.authority.shutdown();
});

it("manual retry metadata remains optional and explicit null clears a replaced URL", async () => {
  const h = harness();
  const request = { issueId: "1", identifier: null, attempt: 1, kind: "failure" as const, error: null };
  h.authority.scheduleRetry(request); expect(h.snapshot().retrying[0]?.issueUrl).toBeNull();
  h.authority.scheduleRetry({ ...request, issueUrl: "old" });
  h.authority.scheduleRetry({ ...request, issueUrl: null }); expect(h.snapshot().retrying[0]?.issueUrl).toBeNull();
  await h.authority.shutdown();
});
