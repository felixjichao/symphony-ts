import { describe, expect, it } from "vitest";

import { githubWorkKey, type WorkContinuityObservation } from "@symphony/domain";

import { WorkContinuityCoordinator, type WorkRecoveryRequest } from "./index";
import { createLoopHarness, flushMicrotasks, makeIssue } from "./loop.test-helpers";

const NOW = 1_770_000_000_000;
const workKey = githubWorkKey("felixjichao", "symphony-ts", 147);

function ownerlessObservation(): WorkContinuityObservation {
  return {
    workKey,
    observedAt: NOW,
    active: true,
    stage: "coding",
    expectedAction: {
      action: "dispatch",
      description: "dispatch coding",
      authority: { kind: "internal", authority: "orchestrator", executor: "codex-agent" },
    },
    owner: null,
    liveness: { startedAt: NOW - 60_000, lastProgressAt: "unknown" },
    scheduledRecovery: null,
    externalWait: null,
    blocked: null,
    sources: [{ source: "tracker", status: "ok", observedAt: NOW }],
    requiredSources: ["tracker"],
  };
}

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

  it("closes work-level recovery admission synchronously when the loop stops", async () => {
    let releaseObserve!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseObserve = resolve;
    });
    let startedObserving!: () => void;
    const observing = new Promise<void>((resolve) => {
      startedObserving = resolve;
    });
    let observeCall = 0;
    const requests: WorkRecoveryRequest[] = [];
    const coordinator = new WorkContinuityCoordinator({
      scan: { listWorkKeys: async () => [workKey] },
      observer: {
        observe: async () => {
          observeCall += 1;
          if (observeCall === 1) {
            startedObserving();
            await gate;
          }
          return ownerlessObservation();
        },
      },
      authorities: [
        {
          authority: "orchestrator",
          recover: async (request) => {
            requests.push(request);
            return { kind: "applied" };
          },
        },
      ],
      now: () => NOW,
      policy: { scheduledRecoveryGraceMs: 0, progressTimeoutMs: 0, repeatSuppressionMs: 0 },
    });

    const h = createLoopHarness({ workContinuity: coordinator });
    h.tracker.activeIssues = [];

    await h.loop.start();
    h.pollScheduler.fire();
    await observing;

    const stopping = h.loop.stop();
    releaseObserve();
    await stopping;

    expect(coordinator.stopped).toBe(true);
    expect(requests).toHaveLength(0);
  });
});
