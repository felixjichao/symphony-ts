import type { OrchestratorRuntimeState, RunningEntry, LiveSession } from "@symphony/domain";
import { describe, expect, it, vi } from "vitest";
import { projectObservabilitySnapshot, tryProjectObservabilitySnapshot } from "./index";

function state(): OrchestratorRuntimeState {
  return { pollIntervalMs: 30000, maxConcurrentAgents: 2, running: new Map(), retryAttempts: new Map(),
    claimed: new Set(), completed: new Set(), codexRateLimits: null,
    codexTotals: { inputTokens: 100, outputTokens: 20, totalTokens: 120, secondsRunning: 7 } };
}
function entry(id: string, session: LiveSession | null = null): RunningEntry {
  return {
    issue: { id, identifier: `ABC-${id}`, url: "https://example.com/issue", state: "Todo", nativeRef: null,
      title: "private title", description: "private", priority: 1, branchName: null, assigneeId: null,
      labels: [], blockedBy: [], dispatchable: true, createdAt: null, updatedAt: null },
    attempt: { issueId: id, issueIdentifier: `ABC-${id}`, attempt: null, status: "preparing_workspace",
      startedAt: 1700000000000, workspacePath: "/workspace" },
    workspacePath: "/workspace", startedAtMs: 1000, session, workerHandle: () => { throw new Error("private"); },
  };
}
const session: LiveSession = {
  sessionId: "thread-turn", threadId: "thread", turnId: "turn", codexAppServerPid: "42", turnCount: 2,
  lastCodexEvent: "notification", lastCodexMessage: "hello", lastCodexTimestamp: 1700000000010,
  codexInputTokens: 50, codexOutputTokens: 10, codexTotalTokens: 60,
  lastReportedInputTokens: 100, lastReportedOutputTokens: 20, lastReportedTotalTokens: 120,
};
const clock = { wallNow: () => 1700000001000, monotonicNow: () => 3000 };
// Output is readonly for consumers, but runtime copy isolation must also withstand mutation.
function mutable<T>(value: T): { -readonly [K in keyof T]: T[K] } { return value; }

describe("snapshot §13.3 / §13.5", () => {
  it("empty runtime succeeds and samples each clock once", () => {
    const clocks = { wallNow: vi.fn(clock.wallNow), monotonicNow: vi.fn(clock.monotonicNow) };
    const result = projectObservabilitySnapshot(state(), clocks);
    expect(result).toEqual({ generatedAt: clock.wallNow(), pollIntervalMs: 30000, maxConcurrentAgents: 2,
      running: [], retrying: [], codexTotals: state().codexTotals, rateLimits: null });
    expect(clocks.wallNow).toHaveBeenCalledTimes(1);
    expect(clocks.monotonicNow).toHaveBeenCalledTimes(1);
    expect(tryProjectObservabilitySnapshot(state(), clock).status).toBe("available");
  });
  it("projects unknown session fields as null; sorts rows and sums all worker elapsed", () => {
    const runtime = state();
    runtime.running.set("z", entry("z"));
    runtime.running.set("a", entry("a", { ...session }));
    const before = structuredClone({ ...runtime, running: undefined });
    const result = projectObservabilitySnapshot(runtime, clock);
    expect(result.running.map((r) => r.issueId)).toEqual(["a", "z"]);
    expect(result.running[0]).toEqual({ issueId: "a", issueIdentifier: "ABC-a", issueUrl: "https://example.com/issue",
      issueState: "Todo", attempt: null, status: "preparing_workspace", workspacePath: "/workspace",
      startedAt: 1700000000000, elapsedMs: 2000, sessionId: "thread-turn", threadId: "thread", turnId: "turn",
      codexAppServerPid: "42", turnCount: 2, lastCodexEvent: "notification", lastCodexMessage: "hello",
      lastCodexTimestamp: 1700000000010, tokens: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } });
    expect(result.running[1]).toMatchObject({ tokens: null, turnCount: null, sessionId: null });
    expect(result.codexTotals).toEqual({ ...runtime.codexTotals, secondsRunning: 11 });
    expect(projectObservabilitySnapshot(runtime, clock)).toEqual(result);
    expect({ ...runtime, running: undefined }).toEqual(before);
    runtime.running.delete("a"); runtime.codexTotals.secondsRunning += 2;
    expect(projectObservabilitySnapshot(runtime, clock).codexTotals.secondsRunning).toBe(11);
    runtime.running.clear(); runtime.codexTotals.secondsRunning += 2;
    expect(projectObservabilitySnapshot(runtime, clock).codexTotals.secondsRunning).toBe(11);
  });
  it("retry delays use monotonic time, normalize absent URLs, and never expose handles or raw due", () => {
    const runtime = state();
    for (const [id, due] of [["z", 4000], ["a", 3000], ["b", 1000]] as const) {
      runtime.retryAttempts.set(id, { issueId: id, identifier: null, attempt: 1, dueAtMs: due,
        timerHandle: new Map(), error: "failed" });
    }
    const result = projectObservabilitySnapshot(runtime, clock);
    expect(result.retrying.map((r) => [r.issueId, r.retryInMs, r.issueUrl])).toEqual([["a", 0, null], ["b", 0, null], ["z", 1000, null]]);
    expect(projectObservabilitySnapshot(runtime, { ...clock, wallNow: () => 0 }).retrying).toEqual(result.retrying);
    expect(JSON.stringify(result)).not.toMatch(/timerHandle|workerHandle|dueAtMs/);
    runtime.running.set("future", { ...entry("future"), startedAtMs: 4000 });
    expect(projectObservabilitySnapshot(runtime, clock).running[0]?.elapsedMs).toBe(0);
  });
  it("arrays, rows, tokens, totals and nested payloads are independently copied both ways", () => {
    const runtime = state(); const running = entry("a", { ...session }); runtime.running.set("a", running);
    runtime.retryAttempts.set("r", { issueId: "r", identifier: "R", issueUrl: "old", attempt: 1, dueAtMs: 5000, timerHandle: {}, error: null });
    const payload = { windows: [{ remaining: 8, nested: [1, 2] }] }; runtime.codexRateLimits = payload;
    const old = projectObservabilitySnapshot(runtime, clock); const changed = projectObservabilitySnapshot(runtime, clock);
    mutable(changed.running[0]!).issueState = "edited";
    mutable(changed.running[0]!.tokens!).totalTokens = 999;
    mutable(changed.retrying[0]!).issueUrl = "edited";
    mutable(changed.codexTotals).totalTokens = 999;
    const copied = changed.rateLimits as unknown as typeof payload;
    copied.windows[0]!.remaining = 0; copied.windows[0]!.nested.push(99);
    (changed.running as unknown as RunningEntry[]).pop();
    expect(running.issue.state).toBe("Todo"); expect(running.session?.codexTotalTokens).toBe(60);
    expect(runtime.retryAttempts.get("r")?.issueUrl).toBe("old"); expect(runtime.codexTotals.totalTokens).toBe(120);
    expect(payload.windows[0]).toEqual({ remaining: 8, nested: [1, 2] });
    mutable(running.issue).state = "new"; running.session!.codexTotalTokens = 500; payload.windows[0]!.remaining = 2;
    runtime.pollIntervalMs = 10; runtime.maxConcurrentAgents = 3; runtime.codexTotals.totalTokens = 600;
    expect(old.running[0]?.issueState).toBe("Todo"); expect(old.running[0]?.tokens?.totalTokens).toBe(60);
    expect((old.rateLimits as unknown as typeof payload).windows[0]?.remaining).toBe(8);
    expect(projectObservabilitySnapshot(runtime, clock)).toMatchObject({ pollIntervalMs: 10, maxConcurrentAgents: 3, codexTotals: { totalTokens: 600 } });
    expect(JSON.stringify(old)).not.toMatch(/workerHandle|timerHandle|lastReported|private/);
  });
  it("unavailable has stable reasons and failures leave runtime unchanged", () => {
    expect(tryProjectObservabilitySnapshot(null, clock)).toEqual({ status: "unavailable", reason: "runtime_unavailable" });
    const runtime = state();
    expect(tryProjectObservabilitySnapshot(runtime, { ...clock, wallNow: () => { throw new Error("secret"); } }))
      .toEqual({ status: "unavailable", reason: "projection_failed" });
    for (const unsupported of [() => 1, new Map(), new Set(), new Date()]) {
      runtime.codexRateLimits = { unsupported };
      expect(tryProjectObservabilitySnapshot(runtime, clock)).toEqual({ status: "unavailable", reason: "projection_failed" });
      expect(runtime.codexRateLimits.unsupported).toBe(unsupported);
    }
    expect(runtime.codexTotals.secondsRunning).toBe(7);
  });
});
