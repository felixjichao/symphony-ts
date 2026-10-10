import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decisionSessionId,
  type DecisionReviewTarget,
  type DecisionMaterializedContext,
  type DecisionReviewTask,
} from "@symphony/domain";
import { DurableDecisionStore } from "./store.js";
import { DecisionService } from "./service.js";
import { DecisionBridge } from "./bridge.js";
import { DecisionBridgeClient } from "./client.js";
import { DecisionReviewGate } from "./review-gate.js";

describe("DecisionReviewGate", () => {
  let tmpDir: string;
  let store: DurableDecisionStore;
  let service: DecisionService;
  let gate: DecisionReviewGate;
  let clockTime = 1_000_000;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-gate-test-"));
    store = new DurableDecisionStore({
      storeDir: tmpDir,
      clock: () => clockTime,
    });
    service = new DecisionService(store, {
      clock: () => clockTime,
    });
    await store.open();
    gate = new DecisionReviewGate(service);
  });

  afterEach(async () => {
    await store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const targetA: DecisionReviewTarget = {
    repository: "felixjichao/symphony-ts",
    prNumber: 98,
    headSha: "a".repeat(40),
  };

  const sessionId = decisionSessionId({
    provider: "github",
    key: "felixjichao/symphony-ts#98",
  });

  it("ensures session and emits review task with atomic context", async () => {
    const context: DecisionMaterializedContext = {
      strategy: "materialized",
      workItem: { provider: "github", key: "felixjichao/symphony-ts#98" },
      repository: "felixjichao/symphony-ts",
      issue: {
        repository: "felixjichao/symphony-ts",
        number: 98,
        title: "Test Issue",
        body: "Test Body",
      },
      plan: null,
      pullRequest: {
        repository: "felixjichao/symphony-ts",
        prNumber: 98,
        headSha: "a".repeat(40),
        baseRef: "main",
        headRef: "feat",
        title: "PR Title",
        body: "PR Body",
      },
      diff: {
        patch: "+line\n",
        files: ["test.ts"],
        truncated: false,
      },
      ci: {
        state: "success",
        summary: "all green",
        checks: [],
      },
      repositoryInstructions: "Follow AGENTS.md",
      previousReviews: [],
      unresolvedFindings: [],
    };

    const task = await gate.ensureReviewTask(sessionId, targetA, context);
    expect(task.kind).toBe("review");
    expect(task.status).toBe("pending");
    expect((task as DecisionReviewTask).target.headSha).toBe("a".repeat(40));

    // Verify context was attached atomically
    const storedContext = service.getTaskContext(task.id);
    expect(storedContext?.strategy).toBe("materialized");

    // Re-ensuring with same target reuses existing active task
    const reused = await gate.ensureReviewTask(sessionId, targetA);
    expect(reused.id).toBe(task.id);
  });

  it("verifies review approval correctly and fails closed on unapproved or mismatched SHA", async () => {
    const task = await gate.ensureReviewTask(sessionId, targetA);

    // Initial check: not approved
    const preCheck = await gate.verifyReviewApproval({
      ...targetA,
      sessionId,
    });
    expect(preCheck.approved).toBe(false);

    // Claim and start task
    clockTime += 1000;
    const { lease } = await service.claimTask(task.id, { owner: "browser-agent" });
    await service.startTask(task.id, lease);

    // Submit changes_requested
    clockTime += 1000;
    await service.submitResult(task.id, {
      owner: lease.owner,
      token: lease.token,
      generation: lease.generation,
      result: {
        schemaVersion: 1,
        taskId: task.id,
        sessionId,
        kind: "review",
        revision: task.revision,
        createdAtMs: clockTime,
        target: targetA,
        verdict: "changes_requested",
        findings: [
          {
            severity: "blocker",
            message: "Missing test case",
            location: "src/index.ts:10",
          },
        ],
      },
    });

    const statusAfterChanges = await gate.getReviewStatus(task.id);
    expect(statusAfterChanges.status).toBe("completed");
    expect(statusAfterChanges.result?.kind).toBe("review");

    const checkAfterChanges = await gate.verifyReviewApproval({
      ...targetA,
      sessionId,
    });
    expect(checkAfterChanges.approved).toBe(false);
    expect(checkAfterChanges.verdict).toBe("changes_requested");

    // Now create new revision with approval for SHA-A
    clockTime += 1000;
    const task2 = await service.createReviewTask(sessionId, {
      target: targetA,
      operationKey: "review-round-2",
    });
    const { lease: lease2 } = await service.claimTask(task2.id, { owner: "browser-agent" });
    await service.startTask(task2.id, lease2);

    clockTime += 1000;
    await service.submitResult(task2.id, {
      owner: lease2.owner,
      token: lease2.token,
      generation: lease2.generation,
      result: {
        schemaVersion: 1,
        taskId: task2.id,
        sessionId,
        kind: "review",
        revision: task2.revision,
        createdAtMs: clockTime,
        target: targetA,
        verdict: "approve",
        findings: [],
      },
    });

    const checkApprove = await gate.verifyReviewApproval({
      ...targetA,
      sessionId,
    });
    expect(checkApprove.approved).toBe(true);
    expect(checkApprove.verdict).toBe("approve");

    // Moving PR to SHA-B must fail closed: SHA-B is NOT approved
    const targetB: DecisionReviewTarget = {
      ...targetA,
      headSha: "b".repeat(40),
    };
    const checkB = await gate.verifyReviewApproval({
      ...targetB,
      sessionId,
    });
    expect(checkB.approved).toBe(false);
    expect(checkB.reason).toContain("No review task found for target PR");
  });

  it("fails closed when sessionId is missing in verifyReviewApproval", async () => {
    await expect(gate.verifyReviewApproval(targetA as unknown as Parameters<typeof gate.verifyReviewApproval>[0])).rejects.toThrow(
      "verifyReviewApproval requires target.sessionId",
    );
  });

  it("supersedes previous PR reviews when replacement PR is created under same session", async () => {
    const taskPr104 = await gate.ensureReviewTask(sessionId, {
      ...targetA,
      prNumber: 104,
    });
    expect(taskPr104.status).toBe("pending");

    // Replacement PR #105 under same session
    clockTime += 1000;
    const taskPr105 = await gate.ensureReviewTask(sessionId, {
      ...targetA,
      prNumber: 105,
    });
    expect(taskPr105.status).toBe("pending");

    // Old task for PR #104 must be superseded
    const oldTask = service.getTask(taskPr104.id);
    expect(oldTask?.status).toBe("superseded");
  });

  it("prevents TOCTOU approval race when task is superseded in HTTP bridge mode", async () => {
    const bridgeTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-test-gate-1-"));
    const bridgeStore = new DurableDecisionStore({
      storeDir: bridgeTmpDir,
      clock: () => clockTime,
    });
    const bridgeService = new DecisionService(bridgeStore, { clock: () => clockTime });
    const bridge = new DecisionBridge(bridgeService, {
      port: 0,
      host: "127.0.0.1",
    });
    const { port } = await bridge.start();
    try {
      const client = new DecisionBridgeClient(`http://127.0.0.1:${port}`);
      const httpGate = new DecisionReviewGate(client);

      const task = await httpGate.ensureReviewTask(sessionId, targetA);
      clockTime += 1000;
      const { lease } = await bridgeService.claimTask(task.id, { owner: "test-agent" });
      await bridgeService.startTask(task.id, lease);
      await bridgeService.submitResult(task.id, {
        owner: lease.owner,
        token: lease.token,
        generation: lease.generation,
        result: {
          schemaVersion: 1,
          taskId: task.id,
          sessionId,
          kind: "review",
          revision: task.revision,
          createdAtMs: clockTime,
          target: targetA,
          verdict: "approve",
          findings: [],
        },
      });

      // Verify approved
      const approvedResult = await httpGate.verifyReviewApproval({
        ...targetA,
        sessionId,
      });
      expect(approvedResult.approved).toBe(true);

      // Supersede task in store
      await bridgeService.supersedeTask(task.id);

      // Verify fail-closed: even though completed result is in store, the task is now superseded
      const supersededResult = await httpGate.verifyReviewApproval({
        ...targetA,
        sessionId,
      });
      expect(supersededResult.approved).toBe(false);
      expect(supersededResult.reason).toContain("not completed (status: superseded)");
    } finally {
      await bridge.stop();
      await fs.rm(bridgeTmpDir, { recursive: true, force: true });
    }
  });

  it("handles A -> B -> A revision cycle without operationKey collisions or resurrected stale tasks in HTTP mode", async () => {
    const bridgeTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-test-gate-2-"));
    const bridgeStore = new DurableDecisionStore({
      storeDir: bridgeTmpDir,
      clock: () => clockTime,
    });
    const bridgeService = new DecisionService(bridgeStore, { clock: () => clockTime });
    const bridge = new DecisionBridge(bridgeService, {
      port: 0,
      host: "127.0.0.1",
    });
    const { port } = await bridge.start();
    try {
      const client = new DecisionBridgeClient(`http://127.0.0.1:${port}`);
      const httpGate = new DecisionReviewGate(client);

      // Round 1: SHA-A
      const taskA1 = await httpGate.ensureReviewTask(sessionId, targetA);
      expect(taskA1.revision).toBe(1);

      // Round 2: PR moves to SHA-B
      const targetB: DecisionReviewTarget = { ...targetA, headSha: "b".repeat(40) };
      clockTime += 1000;
      const taskB = await httpGate.ensureReviewTask(sessionId, targetB);
      expect(taskB.kind).toBe("review");
      if (taskB.kind === "review") {
        expect(taskB.target.headSha).toBe("b".repeat(40));
      }

      const oldA1 = bridgeService.getTask(taskA1.id);
      expect(oldA1?.status).toBe("superseded");

      // Round 3: PR reverts or moves back to SHA-A
      clockTime += 1000;
      const taskA2 = await httpGate.ensureReviewTask(sessionId, targetA);
      expect(taskA2.id).not.toBe(taskA1.id);
      expect(taskA2.revision).toBe(3);
      expect(taskA2.status).toBe("pending");
      expect(taskA2.kind).toBe("review");
      if (taskA2.kind === "review") {
        expect(taskA2.target.headSha).toBe("a".repeat(40));
      }
    } finally {
      await bridge.stop();
      await fs.rm(bridgeTmpDir, { recursive: true, force: true });
    }
  });

  it("concurrent ensureReviewTask for the same target reuses task atomically without bumping revision or superseding", async () => {
    const bridgeTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-test-concurrent-"));
    const bridgeStore = new DurableDecisionStore({
      storeDir: bridgeTmpDir,
      clock: () => clockTime,
    });
    const bridgeService = new DecisionService(bridgeStore, { clock: () => clockTime });
    const bridge = new DecisionBridge(bridgeService, {
      port: 0,
      host: "127.0.0.1",
    });
    const { port } = await bridge.start();
    try {
      const client = new DecisionBridgeClient(`http://127.0.0.1:${port}`);
      const httpGate = new DecisionReviewGate(client);

      // Concurrent ensureReviewTask calls with empty initial state
      const [task1, task2] = await Promise.all([
        httpGate.ensureReviewTask(sessionId, targetA),
        httpGate.ensureReviewTask(sessionId, targetA),
      ]);

      expect(task1.id).toBe(task2.id);
      expect(task1.revision).toBe(1);
      expect(task2.revision).toBe(1);
      expect(task1.status).toBe("pending");
      expect(task2.status).toBe("pending");

      // Verify that stored task is active and not superseded
      const stored = bridgeService.getTask(task1.id);
      expect(stored?.status).toBe("pending");
      expect(stored?.revision).toBe(1);

      // Repeated ensure (retry) returns the same task
      const retryTask = await httpGate.ensureReviewTask(sessionId, targetA);
      expect(retryTask.id).toBe(task1.id);
      expect(retryTask.revision).toBe(1);
      expect(retryTask.status).toBe("pending");
    } finally {
      await bridge.stop();
      await fs.rm(bridgeTmpDir, { recursive: true, force: true });
    }
  });
});

