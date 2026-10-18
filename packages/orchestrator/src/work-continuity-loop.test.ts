import { describe, expect, it } from "vitest";

import { createLoopHarness, flushMicrotasks, makeIssue } from "./loop.test-helpers";

describe("OrchestratorLoop work-level reconciliation (NEST-137)", () => {
  it("runs work continuity on a tick even when no worker is running", async () => {
    let calls = 0;
    const h = createLoopHarness({
      workContinuity: {
        reconcileOnce: async () => {
          calls += 1;
          return {};
        },
      },
    });
    h.tracker.activeIssues = [];

    await h.loop.start();
    h.pollScheduler.fire();
    await h.loop.settled();
    await flushMicrotasks();

    expect(calls).toBe(1);
    // The tick continues normally after work reconciliation.
    expect(h.tracker.candidateStateCalls.length).toBeGreaterThanOrEqual(2);
    await h.loop.stop();
  });

  it("runs before candidate dispatch so stranded work is resolved before new dispatches", async () => {
    const events: string[] = [];
    let dispatchSeen = 0;
    const issue = makeIssue("NEST-1", "Todo");
    const h = createLoopHarness({
      workContinuity: {
        reconcileOnce: async () => {
          events.push("work_continuity");
          dispatchSeen = h.runner.started.length;
          return {};
        },
      },
    });
    h.tracker.activeIssues = [issue];

    await h.loop.start();
    h.pollScheduler.fire();
    await h.loop.settled();
    await flushMicrotasks();

    expect(events).toEqual(["work_continuity"]);
    // Work reconciliation observed zero running workers before the dispatch step.
    expect(dispatchSeen).toBe(0);
    expect(h.runner.started).toEqual([issue.id]);
    await h.loop.stop();
  });

  it("isolates a work continuity failure and keeps the tick chain alive", async () => {
    const issue = makeIssue("NEST-2", "Todo");
    let calls = 0;
    const h = createLoopHarness({
      workContinuity: {
        reconcileOnce: async () => {
          calls += 1;
          throw new Error("continuity exploded");
        },
      },
    });
    h.tracker.activeIssues = [issue];

    await h.loop.start();
    h.pollScheduler.fire();
    await h.loop.settled();
    await flushMicrotasks();

    expect(calls).toBe(1);
    expect(h.diagnostics.map((diagnostic) => diagnostic.kind)).toContain(
      "work_continuity_failed",
    );
    // The candidate fetch and dispatch continue after the isolated failure.
    expect(h.runner.started).toEqual([issue.id]);
    await h.loop.stop();
  });
});
