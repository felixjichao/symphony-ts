import { describe, expect, it } from "vitest";

import { githubWorkKey, type WorkContinuityObservation, type WorkKey } from "@symphony/domain";

import {
  WorkContinuityCoordinator,
  type WorkRecoveryOutcome,
  type WorkRecoveryRequest,
} from "./index";

const NOW = 1_770_000_000_000;

const workA = githubWorkKey("felixjichao", "symphony-ts", 147);
const workB = githubWorkKey("felixjichao", "symphony-ts", 148);

function observationFor(
  workKey: WorkKey,
  overrides: Partial<WorkContinuityObservation> = {},
): WorkContinuityObservation {
  return {
    workKey,
    observedAt: NOW,
    active: true,
    stage: "coding",
    expectedAction: {
      action: "dispatch",
      description: "dispatch coding attempt",
      authority: { kind: "internal", authority: "orchestrator", executor: "codex-agent" },
    },
    owner: {
      authority: "orchestrator",
      presence: "present",
      fence: { retryToken: "retry::a::1", hasLeaseToken: false },
    },
    liveness: { startedAt: NOW - 60_000, lastProgressAt: NOW - 1_000 },
    scheduledRecovery: null,
    externalWait: null,
    blocked: null,
    sources: [{ source: "tracker", status: "ok", observedAt: NOW }],
    requiredSources: ["tracker"],
    ...overrides,
  };
}

function ownerlessObservation(workKey: WorkKey): WorkContinuityObservation {
  return observationFor(workKey, {
    owner: null,
    fence: { retryToken: "retry::a::1", hasLeaseToken: false },
  });
}

interface Harness {
  readonly coordinator: WorkContinuityCoordinator;
  readonly requests: readonly WorkRecoveryRequest[];
  readonly observeCount: () => number;
}

function harness(options: {
  readonly workKeys?: readonly WorkKey[];
  readonly observe: (workKey: WorkKey, call: number) => WorkContinuityObservation;
  readonly outcome?: (request: WorkRecoveryRequest) => WorkRecoveryOutcome | Promise<WorkRecoveryOutcome>;
  readonly authorityName?: string;
  readonly now?: () => number;
  readonly policy?: { repeatSuppressionMs: number };
}): Harness {
  const requests: WorkRecoveryRequest[] = [];
  let observeCalls = 0;
  const authorityName = options.authorityName ?? "orchestrator";

  const coordinator = new WorkContinuityCoordinator({
    scan: {
      listWorkKeys: async () => options.workKeys ?? [workA],
    },
    observer: {
      observe: async (workKey) => {
        observeCalls += 1;
        return options.observe(workKey, observeCalls);
      },
    },
    authorities: [
      {
        authority: authorityName,
        recover: async (request) => {
          requests.push(request);
          if (options.outcome !== undefined) {
            return await options.outcome(request);
          }
          return { kind: "applied" };
        },
      },
    ],
    now: options.now ?? (() => NOW),
    ...(options.policy !== undefined ? { policy: { ...options.policy, scheduledRecoveryGraceMs: 0, progressTimeoutMs: 0 } } : {}),
  });

  return { coordinator, requests, observeCount: () => observeCalls };
}

describe("WorkContinuityCoordinator", () => {
  it("does not delegate when a valid owner is making progress", async () => {
    const h = harness({ observe: (key) => observationFor(key) });

    const result = await h.coordinator.reconcileOnce();

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.diagnosis).toBe("healthy");
    expect(result.entries[0]?.action).toBe("none");
    expect(h.requests).toHaveLength(0);
    expect(result.recoveryAttempts).toBe(0);
  });

  it("detects stranded work with no owner and delegates exactly once", async () => {
    const requests: WorkRecoveryRequest[] = [];
    // Observes 1-2 see the stranded facts; observe 3 (post-action) sees the owner again.
    let call = 0;
    const coordinator = new WorkContinuityCoordinator({
      scan: { listWorkKeys: async () => [workA] },
      observer: {
        observe: async (key) => {
          call += 1;
          return call >= 3 ? observationFor(key) : ownerlessObservation(key);
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
    });

    const result = await coordinator.reconcileOnce();

    expect(result.entries[0]?.diagnosis).toBe("stranded");
    expect(result.entries[0]?.action).toBe("delegated");
    expect(result.entries[0]?.detail).toContain("now healthy");
    expect(result.strandedWorkKeys).toEqual([workA]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.recovery.class).toBe("dispatch");
    expect(requests[0]?.recovery.authority).toBe("orchestrator");
    expect(requests[0]?.recovery.expectedFence.retryToken).toBe("retry::a::1");
  });

  it("never auto-retries blocked work", async () => {
    const h = harness({
      observe: (key) =>
        observationFor(key, {
          owner: null,
          blocked: {
            reason: "human_required",
            waitingOn: { kind: "human", role: "owner", instruction: "approve" },
            unblockCondition: "operator approves",
            blockedAt: NOW - 1_000,
          },
        }),
    });

    const result = await h.coordinator.reconcileOnce();

    expect(result.entries[0]?.diagnosis).toBe("blocked");
    expect(result.entries[0]?.action).toBe("none");
    expect(h.requests).toHaveLength(0);
    expect(result.recoveryAttempts).toBe(0);
  });

  it("does not treat a legitimate external wait as stranded", async () => {
    const h = harness({
      observe: (key) =>
        observationFor(key, {
          stage: "ci",
          owner: null,
          externalWait: {
            authority: { kind: "external", system: "github-actions", condition: "checks_green" },
            since: NOW - 60_000,
          },
        }),
    });

    const result = await h.coordinator.reconcileOnce();

    expect(result.entries[0]?.diagnosis).toBe("awaiting_external");
    expect(h.requests).toHaveLength(0);
  });

  it("does not duplicate an already scheduled retry", async () => {
    const h = harness({
      observe: (key) =>
        observationFor(key, {
          owner: null,
          scheduledRecovery: {
            kind: "retry",
            authority: "orchestrator",
            scheduledAt: NOW - 1_000,
            dueAt: NOW + 5_000,
            credential: "retry::a::9",
          },
        }),
    });

    const result = await h.coordinator.reconcileOnce();

    expect(result.entries[0]?.diagnosis).toBe("retry_scheduled");
    expect(result.entries[0]?.action).toBe("none");
    expect(h.requests).toHaveLength(0);
  });

  it("fails safe when a source read throws", async () => {
    const requests: WorkRecoveryRequest[] = [];
    const coordinator = new WorkContinuityCoordinator({
      scan: { listWorkKeys: async () => [workA] },
      observer: {
        observe: async () => {
          throw new Error("tracker read timeout");
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
    });

    const result = await coordinator.reconcileOnce();

    expect(result.entries[0]?.action).toBe("observation_failed");
    expect(result.entries[0]?.diagnosis).toBe("observation_unavailable");
    expect(result.failures).toBe(1);
    expect(requests).toHaveLength(0);
  });

  it("fails safe when a required source is unavailable", async () => {
    const h = harness({
      observe: (key) =>
        observationFor(key, {
          owner: null,
          sources: [
            { source: "tracker", status: "unavailable", observedAt: NOW, reason: "rate_limited" },
          ],
        }),
    });

    const result = await h.coordinator.reconcileOnce();

    expect(result.entries[0]?.diagnosis).toBe("observation_unavailable");
    expect(h.requests).toHaveLength(0);
  });

  it("reports an unwired authority instead of mutating a source directly", async () => {
    const coordinator = new WorkContinuityCoordinator({
      scan: { listWorkKeys: async () => [workA] },
      observer: { observe: async (key) => ownerlessObservation(key) },
      authorities: [],
      now: () => NOW,
    });

    const result = await coordinator.reconcileOnce();

    expect(result.entries[0]?.action).toBe("authority_unavailable");
    expect(result.entries[0]?.recoveryClass).toBe("dispatch");
    expect(result.entries[0]?.authority).toBe("orchestrator");
  });

  it("abandons a stale plan when facts change between decision and action", async () => {
    const requests: WorkRecoveryRequest[] = [];
    let call = 0;
    const coordinator = new WorkContinuityCoordinator({
      scan: { listWorkKeys: async () => [workA] },
      observer: {
        observe: async (key) => {
          call += 1;
          // Between the first and the pre-action read, a real retry appeared.
          return call === 1
            ? ownerlessObservation(key)
            : observationFor(key, {
                owner: null,
                scheduledRecovery: {
                  kind: "retry",
                  authority: "orchestrator",
                  scheduledAt: NOW,
                  dueAt: NOW + 9_000,
                  credential: "retry::a::10",
                },
              });
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
    });

    const result = await coordinator.reconcileOnce();

    expect(result.entries[0]?.action).toBe("skipped_facts_changed");
    expect(requests).toHaveLength(0);
  });

  it("does not act when the pre-action re-observation fails", async () => {
    const requests: WorkRecoveryRequest[] = [];
    let call = 0;
    const coordinator = new WorkContinuityCoordinator({
      scan: { listWorkKeys: async () => [workA] },
      observer: {
        observe: async (key) => {
          call += 1;
          if (call === 2) {
            throw new Error("re-read failed");
          }
          return ownerlessObservation(key);
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
    });

    const result = await coordinator.reconcileOnce();

    expect(result.entries[0]?.action).toBe("unverified");
    expect(requests).toHaveLength(0);
  });

  it("reports a refused recovery as a normal race outcome without retrying", async () => {
    const h = harness({
      observe: (key) => ownerlessObservation(key),
      outcome: () => ({ kind: "refused" as const, reason: "stale generation" }),
    });

    const result = await h.coordinator.reconcileOnce();

    expect(result.entries[0]?.action).toBe("refused");
    expect(h.requests).toHaveLength(1);
  });

  it("marks the result unverified when post-action re-observation fails", async () => {
    let call = 0;
    const requests: WorkRecoveryRequest[] = [];
    const coordinator = new WorkContinuityCoordinator({
      scan: { listWorkKeys: async () => [workA] },
      observer: {
        observe: async (key) => {
          call += 1;
          if (call === 3) {
            throw new Error("post read failed");
          }
          return ownerlessObservation(key);
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
    });

    const result = await coordinator.reconcileOnce();

    expect(result.entries[0]?.action).toBe("unverified");
    expect(requests).toHaveLength(1);
  });

  it("is idempotent across repeated passes over unchanged facts", async () => {
    const requests: WorkRecoveryRequest[] = [];
    const coordinator = new WorkContinuityCoordinator({
      scan: { listWorkKeys: async () => [workA] },
      observer: {
        observe: async (key) => ownerlessObservation(key),
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
      policy: { scheduledRecoveryGraceMs: 0, progressTimeoutMs: 0, repeatSuppressionMs: 30_000 },
    });

    const first = await coordinator.reconcileOnce();
    const second = await coordinator.reconcileOnce();

    expect(first.entries[0]?.action).toBe("delegated");
    expect(second.entries[0]?.action).toBe("skipped_duplicate");
    expect(requests).toHaveLength(1);
    expect(first.strandedWorkKeys).toEqual(second.strandedWorkKeys);
  });

  it("allows a repeat delegation once the suppression window elapses", async () => {
    let now = NOW;
    const requests: WorkRecoveryRequest[] = [];
    const coordinator = new WorkContinuityCoordinator({
      scan: { listWorkKeys: async () => [workA] },
      observer: { observe: async (key) => ownerlessObservation(key) },
      authorities: [
        {
          authority: "orchestrator",
          recover: async (request) => {
            requests.push(request);
            return { kind: "applied" };
          },
        },
      ],
      now: () => now,
      policy: { scheduledRecoveryGraceMs: 0, progressTimeoutMs: 0, repeatSuppressionMs: 1_000 },
    });

    await coordinator.reconcileOnce();
    now = NOW + 5_000;
    const second = await coordinator.reconcileOnce();

    expect(second.entries[0]?.action).toBe("delegated");
    expect(requests).toHaveLength(2);
  });

  it("fences concurrent reconciliations of the same work item to a single delegation", async () => {
    let releaseObserve!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseObserve = resolve;
    });
    let observeCall = 0;
    const requests: WorkRecoveryRequest[] = [];
    const coordinator = new WorkContinuityCoordinator({
      scan: { listWorkKeys: async () => [workA] },
      observer: {
        observe: async (key) => {
          observeCall += 1;
          if (observeCall === 1) {
            await gate;
          }
          return ownerlessObservation(key);
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

    const first = coordinator.reconcileOnce();
    const second = coordinator.reconcileOnce();
    releaseObserve();

    const [a, b] = await Promise.all([first, second]);

    const actions = [...a.entries, ...b.entries].map((entry) => entry.action);
    expect(actions.filter((action) => action === "delegated")).toHaveLength(1);
    expect(actions.filter((action) => action === "skipped_concurrent")).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("isolates one failing work item from the rest of the pass", async () => {
    const coordinator = new WorkContinuityCoordinator({
      scan: { listWorkKeys: async () => [workA, workB] },
      observer: {
        observe: async (key) => {
          if (key.key === workA.key) {
            throw new Error("boom");
          }
          return observationFor(key);
        },
      },
      authorities: [],
      now: () => NOW,
    });

    const result = await coordinator.reconcileOnce();

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.action).toBe("observation_failed");
    expect(result.entries[1]?.action).toBe("none");
    expect(result.failures).toBe(1);
  });

  it("closes recovery admission synchronously on stop and never starts a recovery afterwards", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observeCall = 0;
    let startedObserving!: () => void;
    const observing = new Promise<void>((resolve) => {
      startedObserving = resolve;
    });
    const requests: WorkRecoveryRequest[] = [];
    const coordinator = new WorkContinuityCoordinator({
      scan: { listWorkKeys: async () => [workA] },
      observer: {
        observe: async (key) => {
          observeCall += 1;
          if (observeCall === 1) {
            startedObserving();
            await gate;
          }
          return ownerlessObservation(key);
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

    const pass = coordinator.reconcileOnce();
    await observing;
    const stopping = coordinator.stop();
    release();

    const [result] = await Promise.all([pass, stopping]);

    expect(result.entries[0]?.action).toBe("skipped_stopped");
    expect(requests).toHaveLength(0);
    expect(coordinator.stopped).toBe(true);

    // A later pass is a no-op as well.
    const after = await coordinator.reconcileOnce();
    expect(after.entries).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it("stops scanning remaining work items once stop is requested", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observeCall = 0;
    let startedObserving!: () => void;
    const observing = new Promise<void>((resolve) => {
      startedObserving = resolve;
    });
    const observedKeys: string[] = [];
    const coordinator = new WorkContinuityCoordinator({
      scan: { listWorkKeys: async () => [workA, workB] },
      observer: {
        observe: async (key) => {
          observeCall += 1;
          observedKeys.push(key.key);
          if (observeCall === 1) {
            startedObserving();
            await gate;
          }
          return observationFor(key);
        },
      },
      authorities: [],
      now: () => NOW,
    });

    const pass = coordinator.reconcileOnce();
    await observing;
    const stopping = coordinator.stop();
    release();
    await Promise.all([pass, stopping]);

    expect(observedKeys).toEqual([workA.key]);
  });

  it("does not replay an uncertain recovery whose response was lost", async () => {
    let recoverCalls = 0;
    const coordinator = new WorkContinuityCoordinator({
      scan: { listWorkKeys: async () => [workA] },
      observer: { observe: async (key) => ownerlessObservation(key) },
      authorities: [
        {
          authority: "orchestrator",
          recover: async () => {
            recoverCalls += 1;
            // The side effect committed but the response was lost.
            throw new Error("socket hang up after commit");
          },
        },
      ],
      now: () => NOW,
      policy: { scheduledRecoveryGraceMs: 0, progressTimeoutMs: 0, repeatSuppressionMs: 30_000 },
    });

    const first = await coordinator.reconcileOnce();
    const second = await coordinator.reconcileOnce();

    expect(first.entries[0]?.action).toBe("unverified");
    expect(first.entries[0]?.detail).toContain("post-failure observation");
    expect(second.entries[0]?.action).toBe("skipped_duplicate");
    expect(recoverCalls).toBe(1);
  });

  it("reports convergence when the post-failure observation shows the side effect landed", async () => {
    let observeCall = 0;
    const coordinator = new WorkContinuityCoordinator({
      scan: { listWorkKeys: async () => [workA] },
      observer: {
        observe: async (key) => {
          observeCall += 1;
          return observeCall >= 3 ? observationFor(key) : ownerlessObservation(key);
        },
      },
      authorities: [
        {
          authority: "orchestrator",
          recover: async () => {
            throw new Error("response lost");
          },
        },
      ],
      now: () => NOW,
      policy: { scheduledRecoveryGraceMs: 0, progressTimeoutMs: 0, repeatSuppressionMs: 30_000 },
    });

    const result = await coordinator.reconcileOnce();

    expect(result.entries[0]?.action).toBe("unverified");
    expect(result.entries[0]?.detail).toContain("post-failure observation: healthy");
  });

  it("refuses to delegate when a required source was never observed", async () => {
    const requests: WorkRecoveryRequest[] = [];
    const coordinator = new WorkContinuityCoordinator({
      scan: { listWorkKeys: async () => [workA] },
      observer: {
        observe: async (key) =>
          ownerlessObservation(key),
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
    });

    // Sanity: the delegated observation is valid on its own.
    const valid = await coordinator.reconcileOnce();
    expect(valid.entries[0]?.action).toBe("delegated");

    const missing = new WorkContinuityCoordinator({
      scan: { listWorkKeys: async () => [workA] },
      observer: {
        observe: async (key) =>
          observationFor(key, {
            owner: null,
            requiredSources: ["tracker", "decision"],
          }),
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
    });

    const blocked = await missing.reconcileOnce();
    expect(blocked.entries[0]?.action).toBe("observation_failed");
    expect(requests).toHaveLength(1);
  });

  it("reports a scan failure without touching any work item", async () => {
    const requests: WorkRecoveryRequest[] = [];
    const coordinator = new WorkContinuityCoordinator({
      scan: {
        listWorkKeys: async () => {
          throw new Error("tracker down");
        },
      },
      observer: { observe: async (key) => ownerlessObservation(key) },
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
    });

    const result = await coordinator.reconcileOnce();

    expect(result.scannedWorkKeys).toEqual([]);
    expect(result.failures).toBe(1);
    expect(requests).toHaveLength(0);
  });
});
