import { describe, expect, it, vi } from "vitest";
import type {
  RecoveryProposal,
  WorkItemFacts,
  WorkKey,
} from "@symphony/domain";
import {
  deriveWorkContinuity,
  isSameRecoveryProposal,
  WorkContinuityCoordinator,
  type RecoveryAuthorities,
} from "./work-continuity";

function makeWorkKey(repo: string, num: number): WorkKey {
  return {
    provider: "github",
    key: `${repo}#${num}`,
  };
}

describe("deriveWorkContinuity", () => {
  const now = 100_000;
  const repo = "acme/repo";

  it("evaluates active coding worker with recent progress as making_progress", () => {
    const key = makeWorkKey(repo, 1);
    const facts: WorkItemFacts = {
      workKey: key,
      github: {
        issue: { state: "open" },
        pullRequest: null,
        ci: null,
      },
      decision: {
        latestPlanTask: {
          taskId: "plan-1",
          revision: 1,
          status: "completed",
          verdict: "ready",
        },
      },
      orchestrator: {
        isRunning: true,
        isStalled: false,
        attempt: 1,
        attemptToken: "tok-1",
        lifecycleGeneration: 1,
        reconciliationEpoch: 1,
        lastProgressAt: now - 1000,
      },
    };

    const analysis = deriveWorkContinuity(facts, now);
    expect(analysis.stage).toBe("coding");
    expect(analysis.condition).toBe("making_progress");
    expect(analysis.currentOwner).toEqual({
      kind: "internal",
      authority: "orchestrator",
      executor: "codex-agent",
    });
    expect(analysis.recoveryProposal).toBeUndefined();
  });

  it("evaluates active coding worker exceeding stall timeout as stranded with stop_stalled proposal", () => {
    const key = makeWorkKey(repo, 1);
    const facts: WorkItemFacts = {
      workKey: key,
      github: {
        issue: { state: "open" },
        pullRequest: null,
        ci: null,
      },
      decision: {
        latestPlanTask: {
          taskId: "plan-1",
          revision: 1,
          status: "completed",
          verdict: "ready",
        },
      },
      orchestrator: {
        isRunning: true,
        isStalled: true,
        attempt: 1,
        attemptToken: "tok-1",
        lifecycleGeneration: 1,
        reconciliationEpoch: 1,
        lastProgressAt: now - 35_000,
      },
    };

    const analysis = deriveWorkContinuity(facts, now);
    expect(analysis.stage).toBe("coding");
    expect(analysis.condition).toBe("stranded");
    expect(analysis.recoveryProposal).toEqual({
      kind: "orchestrator_stop_stalled",
      authority: "orchestrator",
      issueId: "1",
      fence: {
        expectedAttemptToken: "tok-1",
        expectedGeneration: 1,
        expectedEpoch: 1,
      },
    });
  });

  it("evaluates ready issue without worker or retry as stranded with dispatch proposal", () => {
    const key = makeWorkKey(repo, 1);
    const facts: WorkItemFacts = {
      workKey: key,
      github: {
        issue: { state: "open" },
        pullRequest: null,
        ci: null,
      },
      decision: {
        latestPlanTask: {
          taskId: "plan-1",
          revision: 1,
          status: "completed",
          verdict: "ready",
        },
      },
      orchestrator: {
        isRunning: false,
        isStalled: false,
      },
    };

    const analysis = deriveWorkContinuity(facts, now);
    expect(analysis.stage).toBe("coding");
    expect(analysis.condition).toBe("stranded");
    expect(analysis.expectedAction?.action).toBe("dispatch");
    expect(analysis.recoveryProposal).toEqual({
      kind: "orchestrator_dispatch",
      authority: "orchestrator",
      issueId: "1",
    });
  });

  it("evaluates scheduled retry as retry_scheduled without proposal", () => {
    const key = makeWorkKey(repo, 1);
    const facts: WorkItemFacts = {
      workKey: key,
      github: {
        issue: { state: "open" },
        pullRequest: null,
        ci: null,
      },
      decision: {
        latestPlanTask: {
          taskId: "plan-1",
          revision: 1,
          status: "completed",
          verdict: "ready",
        },
      },
      orchestrator: {
        isRunning: false,
        isStalled: false,
        retryScheduled: {
          attempt: 2,
          retryInMs: 5000,
          error: "Transient network failure",
        },
      },
    };

    const analysis = deriveWorkContinuity(facts, now);
    expect(analysis.stage).toBe("coding");
    expect(analysis.condition).toBe("retry_scheduled");
    expect(analysis.recoveryProposal).toBeUndefined();
  });

  it("evaluates planning stage when planning is enabled and task missing", () => {
    const key = makeWorkKey(repo, 1);
    const facts: WorkItemFacts = {
      workKey: key,
      github: {
        issue: { state: "open" },
        pullRequest: null,
        ci: null,
      },
      decision: {
        latestPlanTask: null,
      },
    };

    const analysis = deriveWorkContinuity(facts, now, { planningEnabled: true });
    expect(analysis.stage).toBe("planning");
    expect(analysis.condition).toBe("stranded");
    expect(analysis.expectedAction?.action).toBe("dispatch");
    expect(analysis.recoveryProposal).toEqual({
      kind: "decision_dispatch_plan",
      authority: "decision",
      sessionId: "github:acme/repo#1",
    });
  });

  it("evaluates expired claim in planning task as stranded with release_expired_claim proposal", () => {
    const key = makeWorkKey(repo, 1);
    const facts: WorkItemFacts = {
      workKey: key,
      github: {
        issue: { state: "open" },
        pullRequest: null,
        ci: null,
      },
      decision: {
        bindingGeneration: 1,
        latestPlanTask: {
          taskId: "task-plan-99",
          revision: 5,
          status: "claimed",
          claimGeneration: 2,
          lease: {
            owner: "agent-x",
            generation: 2,
            expiresAtMs: now - 500, // expired!
          },
        },
      },
    };

    const analysis = deriveWorkContinuity(facts, now, { planningEnabled: true });
    expect(analysis.stage).toBe("planning");
    expect(analysis.condition).toBe("stranded");
    expect(analysis.recoveryProposal).toEqual({
      kind: "decision_release_expired_claim",
      authority: "decision",
      taskId: "task-plan-99",
      revision: 5,
      claimGeneration: 2,
      bindingGeneration: 1,
    });
  });

  it("evaluates planning task with valid unexpired lease as making_progress", () => {
    const key = makeWorkKey(repo, 1);
    const facts: WorkItemFacts = {
      workKey: key,
      github: {
        issue: { state: "open" },
        pullRequest: null,
        ci: null,
      },
      decision: {
        bindingGeneration: 1,
        latestPlanTask: {
          taskId: "task-plan-99",
          revision: 5,
          status: "running",
          claimGeneration: 2,
          lease: {
            owner: "agent-x",
            generation: 2,
            expiresAtMs: now + 60_000,
          },
        },
      },
    };

    const analysis = deriveWorkContinuity(facts, now, { planningEnabled: true });
    expect(analysis.stage).toBe("planning");
    expect(analysis.condition).toBe("making_progress");
    expect(analysis.recoveryProposal).toBeUndefined();
  });

  it("evaluates planning task needing clarification as blocked", () => {
    const key = makeWorkKey(repo, 1);
    const facts: WorkItemFacts = {
      workKey: key,
      github: {
        issue: { state: "open" },
        pullRequest: null,
        ci: null,
      },
      decision: {
        latestPlanTask: {
          taskId: "task-plan-99",
          revision: 5,
          status: "completed",
          verdict: "needs_clarification",
        },
      },
    };

    const analysis = deriveWorkContinuity(facts, now, { planningEnabled: true });
    expect(analysis.stage).toBe("planning");
    expect(analysis.condition).toBe("blocked");
    expect(analysis.blockedDetails?.reason).toBe("human_required");
    expect(analysis.recoveryProposal).toBeUndefined();
  });

  it("evaluates CI wait stage as external_wait when checks are in progress", () => {
    const key = makeWorkKey(repo, 1);
    const facts: WorkItemFacts = {
      workKey: key,
      github: {
        issue: { state: "open" },
        pullRequest: {
          number: 42,
          state: "open",
          headSha: "abc1234",
          isDraft: false,
        },
        ci: {
          status: "pending",
          headSha: "abc1234",
        },
      },
    };

    const analysis = deriveWorkContinuity(facts, now);
    expect(analysis.stage).toBe("ci_wait");
    expect(analysis.condition).toBe("external_wait");
    expect(analysis.recoveryProposal).toBeUndefined();
  });

  it("evaluates review stage with no review session as stranded with review proposal", () => {
    const key = makeWorkKey(repo, 1);
    const facts: WorkItemFacts = {
      workKey: key,
      github: {
        issue: { state: "open" },
        pullRequest: {
          number: 42,
          state: "open",
          headSha: "abc1234",
          isDraft: false,
        },
        ci: {
          status: "success",
          headSha: "abc1234",
        },
      },
      decision: {
        latestReviewTask: null,
      },
    };

    const analysis = deriveWorkContinuity(facts, now);
    expect(analysis.stage).toBe("review");
    expect(analysis.condition).toBe("stranded");
    expect(analysis.expectedAction?.action).toBe("dispatch");
    expect(analysis.recoveryProposal).toEqual({
      kind: "decision_dispatch_review",
      authority: "decision",
      sessionId: "github:acme/repo#1",
      target: {
        repository: "acme/repo",
        prNumber: 42,
        headSha: "abc1234",
      },
    });
  });

  it("evaluates review stage when review is approved as merge making_progress", () => {
    const key = makeWorkKey(repo, 1);
    const facts: WorkItemFacts = {
      workKey: key,
      github: {
        issue: { state: "open" },
        pullRequest: {
          number: 42,
          state: "open",
          headSha: "abc1234",
          isDraft: false,
        },
        ci: {
          status: "success",
          headSha: "abc1234",
        },
      },
      decision: {
        latestReviewTask: {
          taskId: "rev-1",
          revision: 1,
          status: "completed",
          verdict: "approve",
          target: {
            repository: "acme/repo",
            prNumber: 42,
            headSha: "abc1234",
          },
        },
      },
    };

    const analysis = deriveWorkContinuity(facts, now);
    expect(analysis.stage).toBe("merge");
    expect(analysis.condition).toBe("stranded");
    expect(analysis.recoveryProposal).toBeUndefined();
  });

  it("evaluates repair stage when review requests changes and no worker running", () => {
    const key = makeWorkKey(repo, 1);
    const facts: WorkItemFacts = {
      workKey: key,
      github: {
        issue: { state: "open" },
        pullRequest: {
          number: 42,
          state: "open",
          headSha: "abc1234",
          isDraft: false,
        },
        ci: {
          status: "success",
          headSha: "abc1234",
        },
      },
      decision: {
        latestReviewTask: {
          taskId: "rev-1",
          revision: 1,
          status: "completed",
          verdict: "changes_requested",
          target: {
            repository: "acme/repo",
            prNumber: 42,
            headSha: "abc1234",
          },
        },
      },
      orchestrator: {
        isRunning: false,
        isStalled: false,
      },
    };

    const analysis = deriveWorkContinuity(facts, now);
    expect(analysis.stage).toBe("repair");
    expect(analysis.condition).toBe("stranded");
    expect(analysis.recoveryProposal).toEqual({
      kind: "delivery_resume_repair",
      authority: "delivery",
      target: {
        repository: "acme/repo",
        prNumber: 42,
        headSha: "abc1234",
      },
    });
  });

  it("evaluates repair stage when review requests changes and repair worker is stalled as stranded worker_stalled", () => {
    const key = makeWorkKey(repo, 1);
    const facts: WorkItemFacts = {
      workKey: key,
      github: {
        issue: { state: "open" },
        pullRequest: {
          number: 42,
          state: "open",
          headSha: "abc1234",
          isDraft: false,
        },
        ci: {
          status: "success",
          headSha: "abc1234",
        },
      },
      decision: {
        latestReviewTask: {
          taskId: "rev-1",
          revision: 1,
          status: "completed",
          verdict: "changes_requested",
          target: {
            repository: "acme/repo",
            prNumber: 42,
            headSha: "abc1234",
          },
        },
      },
      orchestrator: {
        isRunning: true,
        isStalled: true,
        attempt: 1,
        attemptToken: "tok-repair-stalled",
        lifecycleGeneration: 2,
        reconciliationEpoch: 3,
        lastProgressAt: "unknown",
      },
    };

    const analysis = deriveWorkContinuity(facts, now);
    expect(analysis.stage).toBe("repair");
    expect(analysis.condition).toBe("stranded");
    expect(analysis.strandedReason).toBe("worker_stalled");
    expect(analysis.liveness.lastProgressAt).toBe("unknown");
    expect(analysis.recoveryProposal).toEqual({
      kind: "orchestrator_stop_stalled",
      authority: "orchestrator",
      issueId: "1",
      fence: {
        expectedAttemptToken: "tok-repair-stalled",
        expectedGeneration: 2,
        expectedEpoch: 3,
      },
    });
  });

  it("evaluates repair stage when review requests changes and repair worker is actively progressing as making_progress", () => {
    const key = makeWorkKey(repo, 1);
    const progressTime = now - 5000;
    const facts: WorkItemFacts = {
      workKey: key,
      github: {
        issue: { state: "open" },
        pullRequest: {
          number: 42,
          state: "open",
          headSha: "abc1234",
          isDraft: false,
        },
        ci: {
          status: "success",
          headSha: "abc1234",
        },
      },
      decision: {
        latestReviewTask: {
          taskId: "rev-1",
          revision: 1,
          status: "completed",
          verdict: "changes_requested",
          target: {
            repository: "acme/repo",
            prNumber: 42,
            headSha: "abc1234",
          },
        },
      },
      orchestrator: {
        isRunning: true,
        isStalled: false,
        attempt: 1,
        attemptToken: "tok-repair-active",
        lifecycleGeneration: 2,
        reconciliationEpoch: 3,
        lastProgressAt: progressTime,
      },
    };

    const analysis = deriveWorkContinuity(facts, now);
    expect(analysis.stage).toBe("repair");
    expect(analysis.condition).toBe("making_progress");
    expect(analysis.liveness.lastProgressAt).toBe(progressTime);
    expect(analysis.recoveryProposal).toBeUndefined();
  });

  it("evaluates delivery handoff pending compensation as delivery_compensate stranded", () => {
    const key = makeWorkKey(repo, 1);
    const facts: WorkItemFacts = {
      workKey: key,
      delivery: {
        isPaused: true,
        pendingCompensation: true,
        handoff: {
          handoffId: "handoff-99",
          reason: "Failed commit",
          details: "Conflict on remote",
        },
        spentRepairs: 1,
        maxRepairs: 3,
        spentWaitSeconds: 0,
        maxWaitSeconds: 300,
      },
    };

    const analysis = deriveWorkContinuity(facts, now);
    expect(analysis.stage).toBe("delivery_compensate");
    expect(analysis.condition).toBe("stranded");
    expect(analysis.recoveryProposal).toEqual({
      kind: "delivery_compensate",
      authority: "delivery",
      handoffId: "handoff-99",
    });
  });

  it("evaluates completed PR / closed issue as completed", () => {
    const key = makeWorkKey(repo, 1);
    const facts: WorkItemFacts = {
      workKey: key,
      github: {
        issue: { state: "closed" },
        pullRequest: {
          number: 42,
          state: "merged",
          headSha: "abc1234",
          isDraft: false,
        },
        ci: null,
      },
    };

    const analysis = deriveWorkContinuity(facts, now);
    expect(analysis.stage).toBe("completed");
    expect(analysis.condition).toBe("completed");
    expect(analysis.expectedAction).toBeNull();
    expect(analysis.recoveryProposal).toBeUndefined();
  });

  it("fails safe when observation errors are present", () => {
    const key = makeWorkKey(repo, 1);
    const facts: WorkItemFacts = {
      workKey: key,
      sourceFreshness: {
        github: "unavailable",
      },
    };

    const analysis = deriveWorkContinuity(facts, now);
    expect(analysis.condition).toBe("observation_unavailable");
    expect(analysis.recoveryProposal).toBeUndefined();
  });
});

describe("isSameRecoveryProposal", () => {
  it("correctly compares decision_release_expired_claim proposals", () => {
    const a: RecoveryProposal = {
      kind: "decision_release_expired_claim",
      authority: "decision",
      taskId: "task-1",
      revision: 2,
      claimGeneration: 1,
      bindingGeneration: 1,
    };
    const b: RecoveryProposal = {
      kind: "decision_release_expired_claim",
      authority: "decision",
      taskId: "task-1",
      revision: 2,
      claimGeneration: 1,
      bindingGeneration: 1,
    };
    const c: RecoveryProposal = {
      ...a,
      revision: 3,
    };
    expect(isSameRecoveryProposal(a, b)).toBe(true);
    expect(isSameRecoveryProposal(a, c)).toBe(false);
  });
});

describe("WorkContinuityCoordinator", () => {
  const now = 50_000;
  const repo = "acme/repo";

  it("coordinates full safe 5-step reconciliation protocol for stranded work", async () => {
    const key = makeWorkKey(repo, 10);
    let callCount = 0;

    const factsReader = vi.fn().mockImplementation(async (wk: WorkKey): Promise<WorkItemFacts> => {
      callCount++;
      if (callCount <= 2) {
        return {
          workKey: wk,
          github: {
            issue: { state: "open" },
            pullRequest: null,
            ci: null,
          },
          decision: {
            latestPlanTask: {
              taskId: "p-1",
              revision: 1,
              status: "completed",
              verdict: "ready",
            },
          },
          orchestrator: {
            isRunning: false,
            isStalled: false,
          },
        };
      }
      return {
        workKey: wk,
        github: {
          issue: { state: "open" },
          pullRequest: null,
          ci: null,
        },
        decision: {
          latestPlanTask: {
            taskId: "p-1",
            revision: 1,
            status: "completed",
            verdict: "ready",
          },
        },
        orchestrator: {
          isRunning: true,
          isStalled: false,
          lastProgressAt: now,
        },
      };
    });

    const dispatchMock = vi.fn().mockResolvedValue({ dispatched: true });
    const authorities: RecoveryAuthorities = {
      orchestrator: {
        dispatch: dispatchMock,
        stopStalled: vi.fn(),
      },
    };

    const coordinator = new WorkContinuityCoordinator({
      clock: () => now,
      factsReader,
      activeWorkKeysSource: async () => [key],
      authorities,
    });

    const result = await coordinator.reconcile();

    expect(result.reconciledCount).toBe(1);
    expect(result.recoveredCount).toBe(1);
    expect(dispatchMock).toHaveBeenCalledWith("10");
    // Facts reader called: 1 (initial) + 1 (pre-action) + 1 (post-action) = 3 times
    expect(factsReader).toHaveBeenCalledTimes(3);
    expect(result.items[0]?.recoveryExecuted).toBe(true);
    expect(result.items[0]?.analysis?.condition).toBe("making_progress");
  });

  it("aborts recovery delegation if state converged or changed during pre-action check", async () => {
    const key = makeWorkKey(repo, 11);
    let callCount = 0;

    const factsReader = vi.fn().mockImplementation(async (wk: WorkKey): Promise<WorkItemFacts> => {
      callCount++;
      if (callCount === 1) {
        // First observation: stranded
        return {
          workKey: wk,
          github: {
            issue: { state: "open" },
            pullRequest: null,
            ci: null,
          },
          decision: {
            latestPlanTask: {
              taskId: "p-1",
              revision: 1,
              status: "completed",
              verdict: "ready",
            },
          },
          orchestrator: {
            isRunning: false,
            isStalled: false,
          },
        };
      }
      // Second observation (pre-action): worker already spawned by other thread
      return {
        workKey: wk,
        github: {
          issue: { state: "open" },
          pullRequest: null,
          ci: null,
        },
        decision: {
          latestPlanTask: {
            taskId: "p-1",
            revision: 1,
            status: "completed",
            verdict: "ready",
          },
        },
        orchestrator: {
          isRunning: true,
          isStalled: false,
          lastProgressAt: now,
        },
      };
    });

    const dispatchMock = vi.fn();
    const authorities: RecoveryAuthorities = {
      orchestrator: {
        dispatch: dispatchMock,
        stopStalled: vi.fn(),
      },
    };

    const coordinator = new WorkContinuityCoordinator({
      clock: () => now,
      factsReader,
      activeWorkKeysSource: async () => [key],
      authorities,
    });

    const result = await coordinator.reconcile();

    expect(result.reconciledCount).toBe(1);
    expect(result.recoveredCount).toBe(0);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(result.items[0]?.recoveryExecuted).toBe(false);
  });

  it("handles decision_release_expired_claim delegation through Decision authority adapter", async () => {
    const key = makeWorkKey(repo, 1);
    const facts: WorkItemFacts = {
      workKey: key,
      github: {
        issue: { state: "open" },
        pullRequest: null,
        ci: null,
      },
      decision: {
        bindingGeneration: 1,
        latestPlanTask: {
          taskId: "task-claim-1",
          revision: 4,
          status: "claimed",
          claimGeneration: 2,
          lease: {
            owner: "stale-agent",
            generation: 2,
            expiresAtMs: now - 100,
          },
        },
      },
    };

    const factsReader = vi.fn().mockResolvedValue(facts);
    const releaseClaimMock = vi.fn().mockResolvedValue({ released: true });

    const authorities: RecoveryAuthorities = {
      decision: {
        releaseExpiredClaim: releaseClaimMock,
      },
    };

    const coordinator = new WorkContinuityCoordinator({
      clock: () => now,
      factsReader,
      activeWorkKeysSource: async () => [key],
      authorities,
      deriveOptions: { planningEnabled: true },
    });

    const result = await coordinator.reconcile();

    expect(result.recoveredCount).toBe(1);
    expect(releaseClaimMock).toHaveBeenCalledWith({
      taskId: "task-claim-1",
      expectedRevision: 4,
      expectedClaimGeneration: 2,
      expectedBindingGeneration: 1,
    });
  });

  it("stops immediately when stop() is called", async () => {
    const key1 = makeWorkKey(repo, 1);
    const key2 = makeWorkKey(repo, 2);

    const coordinator = new WorkContinuityCoordinator({
      clock: () => now,
      factsReader: vi.fn().mockImplementation(async () => {
        coordinator.stop();
        return {
          workKey: key1,
          github: {
            issue: { state: "closed" },
            pullRequest: null,
            ci: null,
          },
        };
      }),
      activeWorkKeysSource: async () => [key1, key2],
      authorities: {},
    });

    const result = await coordinator.reconcile();
    // After processing key1, stop() was triggered, key2 should not be processed
    expect(result.reconciledCount).toBe(1);
  });

  describe("Review Blockers Regression (NEST-131)", () => {
    const workKey = { provider: "github", key: "acme/repo#1" } as const;
    const github = { issue: { state: "open" as const }, pullRequest: null, ci: null };
    const ready = { latestPlanTask: { taskId: "p", revision: 1, status: "completed" as const, verdict: "ready" as const } };
    const pr = { number: 2, state: "open" as const, headSha: "new-head", isDraft: false };

    it("Blocker 2: missing planning recovery is unsupported and NOT counted as recovered", async () => {
      const c = new WorkContinuityCoordinator({
        factsReader: async () => ({ workKey, github }),
        activeWorkKeysSource: async () => [workKey],
        authorities: {},
      });
      const result = await c.reconcile();
      expect(result.recoveredCount).toBe(0);
      const item = result.items[0];
      expect(item).toBeDefined();
      expect((item?.recoveryOutcome as { unsupported?: boolean } | undefined)?.unsupported).toBe(true);
      expect(item?.recoveryExecuted).toBe(false);
      expect(item?.analysis?.condition).toBe("stranded");
    });

    it("Blocker 3: unavailable Decision source yields observation_unavailable and emits no mutation", () => {
      const a = deriveWorkContinuity(
        { workKey, github, sourceFreshness: { github: "fresh", decision: "unavailable" } },
        100,
      );
      expect(a.condition).toBe("observation_unavailable");
      expect(a.recoveryProposal).toBeFalsy();
    });

    it("Blocker 7: CI repair respects active worker or scheduled retry without duplicating repair", () => {
      const runningAnalysis = deriveWorkContinuity(
        { workKey, github: { ...github, pullRequest: pr, ci: { status: "failure", headSha: "new-head" } }, orchestrator: { isRunning: true, isStalled: false } },
        100,
      );
      expect(runningAnalysis.condition).toBe("making_progress");
      expect(runningAnalysis.recoveryProposal).toBeFalsy();

      const retryAnalysis = deriveWorkContinuity(
        { workKey, github: { ...github, pullRequest: pr, ci: { status: "failure", headSha: "new-head" } }, orchestrator: { isRunning: false, isStalled: false, retryScheduled: { attempt: 1, retryInMs: 10000, error: null } } },
        100,
      );
      expect(retryAnalysis.condition).toBe("retry_scheduled");
      expect(retryAnalysis.recoveryProposal).toBeFalsy();
    });

    it("Blocker 6: pending task without executor and ownerless merge are reported as stranded with unknown progress", () => {
      const pending = deriveWorkContinuity(
        { workKey, github, decision: { latestPlanTask: { taskId: "p", revision: 1, status: "pending" as const } } },
        100,
      );
      expect(pending.condition).toBe("stranded");
      expect(pending.currentOwner).toBeNull();
      expect(pending.liveness.lastProgressAt).toBe("unknown");

      const merge = deriveWorkContinuity(
        {
          workKey,
          github: { ...github, pullRequest: pr, ci: { status: "success" as const } },
          decision: {
            latestReviewTask: {
              taskId: "r",
              revision: 1,
              status: "completed" as const,
              target: { repository: "acme/repo", prNumber: 2, headSha: "new-head" },
              verdict: "approve" as const,
            },
          },
        },
        100,
      );
      expect(merge.condition).toBe("stranded");
      expect(merge.currentOwner).toBeNull();
      expect(merge.liveness.lastProgressAt).toBe("unknown");
    });

    it("Blocker 8: stop during awaited observation does NOT delegate recovery", async () => {
      const dispatch = vi.fn(async () => true);
      let c: WorkContinuityCoordinator;
      c = new WorkContinuityCoordinator({
        factsReader: async () => {
          c.stop();
          return { workKey, github, decision: ready };
        },
        activeWorkKeysSource: async () => [workKey],
        authorities: { orchestrator: { dispatch, stopStalled: async () => true } },
      });
      await c.reconcile();
      expect(c.isStopping).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("Blocker 4: stop delegation passes fenced attemptToken, generation, and epoch", async () => {
      const stopStalled = vi.fn(async () => true);
      const c = new WorkContinuityCoordinator({
        factsReader: async () => ({
          workKey,
          github,
          decision: ready,
          orchestrator: {
            isRunning: true,
            isStalled: true,
            lifecycleGeneration: 3,
            attemptToken: "token-3",
            reconciliationEpoch: 2,
          },
        }),
        activeWorkKeysSource: async () => [workKey],
        authorities: { orchestrator: { dispatch: async () => true, stopStalled } },
      });
      await c.reconcile();
      expect(stopStalled).toHaveBeenCalledWith("1", {
        expectedAttemptToken: "token-3",
        expectedGeneration: 3,
        expectedEpoch: 2,
      });
    });

    it("Blocker 9: failed planning task does not fall through to coding dispatch", () => {
      const a = deriveWorkContinuity(
        { workKey, github, decision: { latestPlanTask: { taskId: "p", revision: 1, status: "failed" as const } } },
        100,
        { planningEnabled: true },
      );
      expect(a.stage).toBe("planning");
      expect(a.recoveryProposal?.kind).toBe("decision_dispatch_plan");
    });

    it("Blocker 10: canonical identity uses provider-neutral opaque issue ID and canonical session id", () => {
      const a = deriveWorkContinuity(
        { workKey: { provider: "github", key: "acme/repo#42" }, github, decision: undefined },
        100,
        { planningEnabled: true },
      );
      expect(a.recoveryProposal?.kind).toBe("decision_dispatch_plan");
      if (a.recoveryProposal?.kind === "decision_dispatch_plan") {
        expect(a.recoveryProposal.sessionId).toBe("github:acme/repo#42");
      }

      const b = deriveWorkContinuity(
        {
          workKey: { provider: "github", key: "acme/repo#42" },
          github: { issue: { id: "42", state: "open" }, pullRequest: null, ci: null },
          decision: { latestPlanTask: { taskId: "p", revision: 1, status: "completed", verdict: "ready" } },
        },
        100,
        { planningEnabled: true },
      );
      expect(b.recoveryProposal?.kind).toBe("orchestrator_dispatch");
      if (b.recoveryProposal?.kind === "orchestrator_dispatch") {
        expect(b.recoveryProposal.issueId).toBe("42");
      }
    });
  });
});
