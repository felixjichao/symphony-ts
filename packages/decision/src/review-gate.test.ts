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
    expect(checkB.reason).toContain("No completed review task found for target PR");
  });
});
