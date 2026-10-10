import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  githubDecisionRoot,
  decisionSessionId,
  isDecisionReviewApproved,
  type DecisionReviewResult,
  type DecisionReviewTarget,
} from "@symphony/domain";
import { DecisionConflictError } from "./errors";
import { DecisionService } from "./service";
import { DurableDecisionStore } from "./store";

describe("DecisionService", () => {
  async function createFixture(): Promise<{
    service: DecisionService;
    store: DurableDecisionStore;
    clock: { now: number; advance: (ms: number) => void };
    cleanup: () => Promise<void>;
  }> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "service-test-"));
    let currentTime = 1000;
    const clock = {
      now: currentTime,
      advance: (ms: number) => {
        currentTime += ms;
        clock.now = currentTime;
      },
    };

    const store = new DurableDecisionStore({
      storeDir: tmpDir,
      clock: () => clock.now,
      defaultClaimTtlMs: 120_000,
    });
    await store.open();

    const service = new DecisionService(store, {
      clock: () => clock.now,
      defaultClaimTtlMs: 120_000,
    });

    const cleanup = async () => {
      await store.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    };

    return { service, store, clock, cleanup };
  }

  it("handles session binding, rebind CAS, broken binding, and completion lifecycle", async () => {
    const { service, cleanup } = await createFixture();
    try {
      const root = githubDecisionRoot("felixjichao", "symphony-ts", 95);
      const session = await service.createSession(root);
      expect(session.id).toBe(decisionSessionId(root));
      expect(session.bindingGeneration).toBe(0);
      expect(session.status).toBe("active");

      // Initial binding (generation 1)
      const bound = await service.putBinding(session.id, {
        adapter: "chatgpt-web",
        externalSessionRef: "ext-1",
        resumeUri: null,
      });
      expect(bound.binding?.generation).toBe(1);
      expect(bound.bindingGeneration).toBe(1);

      // Idempotent identical PUT retry returns same binding without increment
      const retryPut = await service.putBinding(session.id, {
        adapter: "chatgpt-web",
        externalSessionRef: "ext-1",
        resumeUri: null,
      });
      expect(retryPut.bindingGeneration).toBe(1);

      // Conflicting PUT without rebind fails
      await expect(
        service.putBinding(session.id, {
          adapter: "chatgpt-web",
          externalSessionRef: "ext-2",
          resumeUri: null,
        })
      ).rejects.toThrow(DecisionConflictError);

      // Rebind CAS failure on wrong expectedGeneration
      await expect(
        service.rebindSession(session.id, {
          adapter: "chatgpt-web",
          externalSessionRef: "ext-2",
          resumeUri: "https://chatgpt.com/c/123",
          expectedGeneration: 0,
        })
      ).rejects.toThrow(DecisionConflictError);

      // Rebind CAS success increments to generation 2
      const rebound = await service.rebindSession(session.id, {
        adapter: "chatgpt-web",
        externalSessionRef: "ext-2",
        resumeUri: "https://chatgpt.com/c/123",
        expectedGeneration: 1,
        operationKey: "op-rebind-1",
      });
      expect(rebound.bindingGeneration).toBe(2);
      expect(rebound.binding?.generation).toBe(2);

      // Rebind replay with same operationKey returns previous result without increment
      const replayRebind = await service.rebindSession(session.id, {
        adapter: "chatgpt-web",
        externalSessionRef: "ext-2",
        resumeUri: "https://chatgpt.com/c/123",
        expectedGeneration: 2,
        operationKey: "op-rebind-1",
      });
      expect(replayRebind.bindingGeneration).toBe(2);

      // Break binding
      const broken = await service.breakBinding(session.id);
      expect(broken.status).toBe("broken-binding");
      expect(broken.binding).toBeNull();
      expect(broken.bindingGeneration).toBe(2);

      // Rebind restores active status
      const restored = await service.rebindSession(session.id, {
        adapter: "chatgpt-web",
        externalSessionRef: "ext-3",
        resumeUri: null,
        expectedGeneration: 2,
      });
      expect(restored.status).toBe("active");
      expect(restored.bindingGeneration).toBe(3);

      // Complete and reopen
      const completed = await service.completeSession(session.id);
      expect(completed.status).toBe("completed");

      // Cannot rebind completed session without reopening
      await expect(
        service.rebindSession(session.id, {
          adapter: "chatgpt-web",
          externalSessionRef: "ext-4",
          resumeUri: null,
          expectedGeneration: 3,
        })
      ).rejects.toThrow();

      const reopened = await service.reopenSession(session.id);
      expect(reopened.status).toBe("active");
    } finally {
      await cleanup();
    }
  });

  it("allocates task revisions and automatically supersedes older tasks", async () => {
    const { service, cleanup } = await createFixture();
    try {
      const root = githubDecisionRoot("felixjichao", "symphony-ts", 95);
      const session = await service.createSession(root);

      // Create plan task
      const plan1 = await service.createPlanTask(session.id, { operationKey: "plan-key-1" });
      expect(plan1.revision).toBe(1);
      expect(plan1.status).toBe("pending");

      // Replay creation with same operationKey returns identical task
      const plan1Replay = await service.createPlanTask(session.id, { operationKey: "plan-key-1" });
      expect(plan1Replay.id).toBe(plan1.id);

      // Create plan task revision 2 supersedes revision 1
      const plan2 = await service.createPlanTask(session.id, { operationKey: "plan-key-2" });
      expect(plan2.revision).toBe(2);

      const plan1Updated = service.getTask(plan1.id);
      expect(plan1Updated?.status).toBe("superseded");

      // Create review tasks
      const target: DecisionReviewTarget = {
        repository: "felixjichao/symphony-ts",
        prNumber: 99,
        headSha: "a".repeat(40),
      };
      const review1 = await service.createReviewTask(session.id, {
        target,
        operationKey: "rev-key-1",
      });
      expect(review1.revision).toBe(1);

      // Different PR in same session gets its own independent revision sequence
      const targetOtherPR: DecisionReviewTarget = {
        repository: "felixjichao/symphony-ts",
        prNumber: 100,
        headSha: "b".repeat(40),
      };
      const reviewOther = await service.createReviewTask(session.id, {
        target: targetOtherPR,
        operationKey: "rev-key-other",
      });
      expect(reviewOther.revision).toBe(1);

      // New revision for PR 99 supersedes review1
      const review2 = await service.createReviewTask(session.id, {
        target: { ...target, headSha: "c".repeat(40) },
        operationKey: "rev-key-2",
      });
      expect(review2.revision).toBe(2);

      expect(service.getTask(review1.id)?.status).toBe("superseded");
      expect(service.getTask(reviewOther.id)?.status).toBe("pending");
    } finally {
      await cleanup();
    }
  });

  it("handles claim, start, heartbeat, lease expiry, and lazy release", async () => {
    const { service, clock, cleanup } = await createFixture();
    try {
      const root = githubDecisionRoot("felixjichao", "symphony-ts", 95);
      const session = await service.createSession(root);
      const task = await service.createPlanTask(session.id, { operationKey: "plan-op" });

      // getNextTask returns the task
      const next = await service.getNextTask();
      expect(next?.task.id).toBe(task.id);

      // Claim task
      const claimResult = await service.claimTask(task.id, { owner: "worker-1", ttlMs: 120_000 });
      expect(claimResult.task.status).toBe("claimed");
      expect(claimResult.lease.owner).toBe("worker-1");
      expect(claimResult.lease.generation).toBe(1);
      expect(claimResult.lease.expiresAtMs).toBe(clock.now + 120_000);

      // Concurrent claim on same task fails with conflict
      await expect(service.claimTask(task.id, { owner: "worker-2" })).rejects.toThrow(DecisionConflictError);

      // Start task
      const started = await service.startTask(task.id, {
        owner: "worker-1",
        token: claimResult.lease.token,
        generation: 1,
      });
      expect(started.status).toBe("running");

      // Heartbeat extends expiry
      const hb = await service.heartbeatTask(task.id, {
        owner: "worker-1",
        token: claimResult.lease.token,
        generation: 1,
        ttlMs: 60_000,
      });
      expect(hb.expiresAtMs).toBe(clock.now + 60_000);

      // Advance clock past expiry
      clock.advance(70_000);

      // Start, heartbeat, submitResult all fail due to expired lease
      await expect(
        service.heartbeatTask(task.id, {
          owner: "worker-1",
          token: claimResult.lease.token,
          generation: 1,
        })
      ).rejects.toThrow(DecisionConflictError);

      // getNextTask lazily reclaims expired task to pending
      const nextAfterExpiry = await service.getNextTask();
      expect(nextAfterExpiry?.task.id).toBe(task.id);
      expect(nextAfterExpiry?.task.status).toBe("pending");

      // Claiming again increments claim generation to 2
      const claim2 = await service.claimTask(task.id, { owner: "worker-2", ttlMs: 120_000 });
      expect(claim2.lease.generation).toBe(2);
      expect(claim2.lease.token).not.toBe(claimResult.lease.token);
    } finally {
      await cleanup();
    }
  });

  it("handles idempotent result submission with key-order independence and conflict detection", async () => {
    const { service, cleanup } = await createFixture();
    try {
      const root = githubDecisionRoot("felixjichao", "symphony-ts", 95);
      const session = await service.createSession(root);
      const target: DecisionReviewTarget = {
        repository: "felixjichao/symphony-ts",
        prNumber: 95,
        headSha: "a".repeat(40),
      };
      const task = await service.createReviewTask(session.id, { target, operationKey: "rev-op" });

      const claim = await service.claimTask(task.id, { owner: "browser-agent" });
      await service.startTask(task.id, {
        owner: "browser-agent",
        token: claim.lease.token,
        generation: claim.lease.generation,
      });

      const reviewResult: DecisionReviewResult = {
        schemaVersion: 1,
        kind: "review",
        taskId: task.id,
        sessionId: session.id,
        revision: 1,
        target,
        verdict: "approve",
        findings: [{ severity: "suggestion", message: "Looks great", location: null }],
        createdAtMs: 1000,
      };

      const outcome = await service.submitResult(task.id, {
        owner: "browser-agent",
        token: claim.lease.token,
        generation: claim.lease.generation,
        result: reviewResult,
      });
      expect(outcome.receipt.type).toBe("result");
      expect(outcome.result.verdict).toBe("approve");
      expect(outcome.superseded).toBe(false);

      const completedTask = service.getTask(task.id)!;
      expect(completedTask.status).toBe("completed");
      expect(completedTask.lease).toBeNull();

      // Verified approval predicate
      expect(
        isDecisionReviewApproved(completedTask, reviewResult, {
          ...target,
          sessionId: session.id,
        })
      ).toBe(true);

      // Idempotent retry with shuffled JSON object keys succeeds and returns original receipt
      const shuffledResult: DecisionReviewResult = {
        createdAtMs: 1000,
        verdict: "approve",
        target,
        schemaVersion: 1,
        kind: "review",
        revision: 1,
        sessionId: session.id,
        taskId: task.id,
        findings: [{ location: null, severity: "suggestion", message: "Looks great" }],
      };

      const retryOutcome = await service.submitResult(task.id, {
        owner: "browser-agent",
        token: claim.lease.token,
        generation: claim.lease.generation,
        result: shuffledResult,
      });
      expect(retryOutcome.receipt).toEqual(outcome.receipt);

      // Conflicting payload submission fails with 409
      const conflictingResult: DecisionReviewResult = {
        ...reviewResult,
        verdict: "changes_requested",
      };
      await expect(
        service.submitResult(task.id, {
          owner: "browser-agent",
          token: claim.lease.token,
          generation: claim.lease.generation,
          result: conflictingResult,
        })
      ).rejects.toThrow(DecisionConflictError);

      // Conflicting failure submission on completed task fails with 409
      await expect(
        service.submitFailure(task.id, {
          owner: "browser-agent",
          token: claim.lease.token,
          generation: claim.lease.generation,
          error: "Runner crashed",
        })
      ).rejects.toThrow(DecisionConflictError);

      // Superseding completed task and retrying duplicate submission
      await service.supersedeTask(task.id);
      expect(service.getTask(task.id)?.status).toBe("superseded");

      const supersededRetry = await service.submitResult(task.id, {
        owner: "browser-agent",
        token: claim.lease.token,
        generation: claim.lease.generation,
        result: reviewResult,
      });
      expect(supersededRetry.superseded).toBe(true);
      expect(service.getTask(task.id)?.status).toBe("superseded");
    } finally {
      await cleanup();
    }
  });

  it("handles failure submission and idempotency", async () => {
    const { service, cleanup } = await createFixture();
    try {
      const root = githubDecisionRoot("felixjichao", "symphony-ts", 95);
      const session = await service.createSession(root);
      const task = await service.createPlanTask(session.id, { operationKey: "fail-test" });

      const claim = await service.claimTask(task.id, { owner: "worker-fail" });

      const failOutcome = await service.submitFailure(task.id, {
        owner: "worker-fail",
        token: claim.lease.token,
        generation: claim.lease.generation,
        error: "Script evaluation timed out",
        retryable: true,
      });

      expect(failOutcome.receipt.type).toBe("failure");
      expect(failOutcome.failure.error).toBe("Script evaluation timed out");
      expect(service.getTask(task.id)?.status).toBe("failed");

      // Idempotent retry returns original failure receipt
      const retryFail = await service.submitFailure(task.id, {
        owner: "worker-fail",
        token: claim.lease.token,
        generation: claim.lease.generation,
        error: "Script evaluation timed out",
        retryable: true,
      });
      expect(retryFail.receipt).toEqual(failOutcome.receipt);

      // Conflicting error message fails with 409
      await expect(
        service.submitFailure(task.id, {
          owner: "worker-fail",
          token: claim.lease.token,
          generation: claim.lease.generation,
          error: "Different error message",
        })
      ).rejects.toThrow(DecisionConflictError);
    } finally {
      await cleanup();
    }
  });

  it("handles task context publishing, retrieval, and consistency validation", async () => {
    const { service, cleanup } = await createFixture();
    try {
      const root = githubDecisionRoot("felixjichao", "symphony-ts", 95);
      const session = await service.createSession(root);
      const task = await service.createPlanTask(session.id, { operationKey: "context-test" });

      const context = {
        strategy: "connector" as const,
        workItem: root,
        repository: "felixjichao/symphony-ts",
        prNumber: null,
        headSha: null,
      };

      const putRes = await service.putTaskContext(task.id, context);
      expect(putRes).toEqual(context);

      const retrieved = service.getTaskContext(task.id);
      expect(retrieved).toEqual(context);

      // Inconsistent context fails validation
      const badContext = {
        strategy: "connector" as const,
        workItem: githubDecisionRoot("other", "repo", 1),
        repository: "other/repo",
        prNumber: null,
        headSha: null,
      };
      await expect(service.putTaskContext(task.id, badContext)).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("enforces session execution mutual exclusion and lease-fenced binding updates", async () => {
    const { service, clock, cleanup } = await createFixture();
    try {
      const root = githubDecisionRoot("felixjichao", "symphony-ts", 95);
      const session = await service.createSession(root);
      const task1 = await service.createPlanTask(session.id, { operationKey: "mutex-1" });
      const target: DecisionReviewTarget = {
        repository: "felixjichao/symphony-ts",
        prNumber: 95,
        headSha: "a".repeat(40),
      };
      const task2 = await service.createReviewTask(session.id, { target, operationKey: "mutex-2" });

      // Claim task1
      const claim1 = await service.claimTask(task1.id, { owner: "worker-1", ttlMs: 60_000 });

      // Attempting to claim task2 in same session while task1 is actively leased fails with 409
      await expect(
        service.claimTask(task2.id, { owner: "worker-2", ttlMs: 60_000 })
      ).rejects.toThrow(DecisionConflictError);

      // Stale owner credentials fail binding update
      await expect(
        service.putBinding(session.id, {
          adapter: "chatgpt-web",
          externalSessionRef: "c-1",
          resumeUri: null,
          owner: "worker-wrong",
          token: "wrong-token",
          generation: 1,
        })
      ).rejects.toThrow(DecisionConflictError);

      // Current lease holder succeeds
      const bound = await service.putBinding(session.id, {
        adapter: "chatgpt-web",
        externalSessionRef: "c-1",
        resumeUri: null,
        owner: "worker-1",
        token: claim1.lease.token,
        generation: claim1.lease.generation,
      });
      expect(bound.bindingGeneration).toBe(1);

      // After task1 lease expires, task2 can be claimed
      clock.advance(70_000);
      const claim2 = await service.claimTask(task2.id, { owner: "worker-2", ttlMs: 60_000 });
      expect(claim2.task.id).toBe(task2.id);

      // Worker 1 can no longer rebind with expired credentials
      await expect(
        service.rebindSession(session.id, {
          adapter: "chatgpt-web",
          externalSessionRef: "c-2",
          resumeUri: null,
          expectedGeneration: 1,
          owner: "worker-1",
          token: claim1.lease.token,
          generation: claim1.lease.generation,
        })
      ).rejects.toThrow(DecisionConflictError);

      // Worker 2 rebind succeeds
      const rebound = await service.rebindSession(session.id, {
        adapter: "chatgpt-web",
        externalSessionRef: "c-2",
        resumeUri: null,
        expectedGeneration: 1,
        owner: "worker-2",
        token: claim2.lease.token,
        generation: claim2.lease.generation,
      });
      expect(rebound.bindingGeneration).toBe(2);
    } finally {
      await cleanup();
    }
  });
});
