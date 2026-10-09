import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  githubDecisionRoot,
  decisionSessionId,
  decisionTaskId,
  type DecisionTask,
  type DecisionReviewTask,
  type DecisionSession,
  type DecisionPlanResult,
  type DecisionReviewResult,
  type DecisionConnectorContext,
  type DecisionMaterializedContext,
  DecisionAdapterError,
} from "@symphony/domain";
import {
  extractSymphonyResultPayload,
  normalizeDecisionResult,
  extractDecisionResultFromOutput,
  formatSymphonyResultPayload,
  FakeDecisionExecutorAdapter,
  executeTaskWithAdapter,
  DurableDecisionStore,
  DecisionService,
  DecisionConflictError,
  type DecisionTaskFailure,
} from "./index";

const root = githubDecisionRoot("owner", "repo", 42);
const sessionId = decisionSessionId(root);

function createPlanTask(revision = 1, createdAtMs = 1000): DecisionTask {
  return {
    schemaVersion: 1,
    id: decisionTaskId({ sessionId, kind: "plan", revision }),
    sessionId,
    kind: "plan",
    revision,
    status: "pending",
    lease: null,
    claimGeneration: 0,
    lastClaimToken: null,
    createdAtMs,
    updatedAtMs: createdAtMs,
  };
}

function createReviewTask(revision = 1, headSha = "0123456789abcdef0123456789abcdef01234567", createdAtMs = 1000): DecisionReviewTask {
  return {
    schemaVersion: 1,
    id: decisionTaskId({
      sessionId,
      kind: "review",
      revision,
      target: {
        repository: "owner/repo",
        prNumber: 42,
        headSha,
      },
    }),
    sessionId,
    kind: "review",
    revision,
    status: "pending",
    lease: null,
    claimGeneration: 0,
    lastClaimToken: null,
    target: {
      repository: "owner/repo",
      prNumber: 42,
      headSha,
    },
    createdAtMs,
    updatedAtMs: createdAtMs,
  };
}

const connectorContext: DecisionConnectorContext = {
  strategy: "connector",
  workItem: root,
  repository: "owner/repo",
  prNumber: 42,
  headSha: "0123456789abcdef0123456789abcdef01234567",
};

const materializedContext: DecisionMaterializedContext = {
  strategy: "materialized",
  workItem: root,
  repository: "owner/repo",
  issue: {
    repository: "owner/repo",
    number: 42,
    title: "Implement adapter",
    body: "Define executor contract",
  },
  plan: {
    taskId: createPlanTask(1).id,
    revision: 1,
    plan: "Implement adapter contracts",
    acceptanceCriteria: ["Tests pass"],
    risks: [],
    clarifications: [],
  },
  pullRequest: {
    repository: "owner/repo",
    prNumber: 42,
    headSha: "0123456789abcdef0123456789abcdef01234567",
    baseRef: "main",
    headRef: "feat/adapter",
    title: "PR 42",
    body: "Closes #42",
  },
  diff: {
    patch: "diff --git a/file b/file",
    files: ["file.ts"],
    truncated: false,
  },
  ci: {
    state: "success",
    summary: "All checks passed",
    checks: [],
  },
  repositoryInstructions: "Follow repo rules",
  previousReviews: [],
  unresolvedFindings: [],
};

describe("Result Extractor and Protocol Verification", () => {
  it("extracts and normalizes a valid plan result", () => {
    const task = createPlanTask(1, 1000);
    const result: DecisionPlanResult = {
      schemaVersion: 1,
      taskId: task.id,
      sessionId: task.sessionId,
      kind: "plan",
      revision: 1,
      verdict: "ready",
      content: {
        plan: "Step 1: do A\nStep 2: do B",
        acceptanceCriteria: ["AC 1", "AC 2"],
        risks: ["Risk 1"],
        clarifications: ["None"],
      },
      createdAtMs: 1500,
    };

    const formatted = `Here is my assessment of the task:\n\n${formatSymphonyResultPayload(result)}\n\nPlease proceed.`;
    const extracted = extractDecisionResultFromOutput(formatted, task);
    expect(extracted).toEqual(result);
  });

  it("extracts and normalizes all 6 legal verdicts", () => {
    const planTask = createPlanTask(1, 1000);
    const planVerdicts = ["ready", "needs_clarification", "needs_human"] as const;

    for (const verdict of planVerdicts) {
      const planRes: DecisionPlanResult = {
        schemaVersion: 1,
        taskId: planTask.id,
        sessionId: planTask.sessionId,
        kind: "plan",
        revision: 1,
        verdict,
        content: {
          plan: "Test plan",
          acceptanceCriteria: ["Criteria"],
          risks: [],
          clarifications: [],
        },
        createdAtMs: 1200,
      };
      const text = formatSymphonyResultPayload(planRes);
      const parsed = extractDecisionResultFromOutput(text, planTask);
      expect(parsed.verdict).toBe(verdict);
    }

    const reviewTask = createReviewTask(1, "0123456789abcdef0123456789abcdef01234567", 1000);
    const reviewVerdicts = ["approve", "changes_requested", "needs_human"] as const;

    for (const verdict of reviewVerdicts) {
      const reviewRes: DecisionReviewResult = {
        schemaVersion: 1,
        taskId: reviewTask.id,
        sessionId: reviewTask.sessionId,
        kind: "review",
        revision: 1,
        verdict,
        target: reviewTask.target,
        findings:
          verdict === "changes_requested"
            ? [
                {
                  severity: "blocker",
                  message: "Must fix bug",
                  location: "src/file.ts:10",
                },
              ]
            : [],
        createdAtMs: 1200,
      };
      const text = formatSymphonyResultPayload(reviewRes);
      const parsed = extractDecisionResultFromOutput(text, reviewTask);
      expect(parsed.verdict).toBe(verdict);
    }
  });

  it("takes the LAST symphony-result block when multiple blocks exist", () => {
    const task = createPlanTask(1, 1000);
    const firstResult: DecisionPlanResult = {
      schemaVersion: 1,
      taskId: task.id,
      sessionId: task.sessionId,
      kind: "plan",
      revision: 1,
      verdict: "needs_clarification",
      content: { plan: "Draft 1", acceptanceCriteria: [], risks: [], clarifications: [] },
      createdAtMs: 1100,
    };

    const finalResult: DecisionPlanResult = {
      schemaVersion: 1,
      taskId: task.id,
      sessionId: task.sessionId,
      kind: "plan",
      revision: 1,
      verdict: "ready",
      content: { plan: "Final Plan", acceptanceCriteria: ["Done"], risks: [], clarifications: [] },
      createdAtMs: 1200,
    };

    const mixedOutput = [
      "Here is initial thought:",
      formatSymphonyResultPayload(firstResult),
      "Wait, after reconsideration, here is the final outcome:",
      formatSymphonyResultPayload(finalResult),
      "Done.",
    ].join("\n\n");

    const rawPayload = extractSymphonyResultPayload(mixedOutput) as Record<string, unknown>;
    expect(rawPayload["verdict"]).toBe("ready");

    const extracted = extractDecisionResultFromOutput(mixedOutput, task);
    expect(extracted.verdict).toBe("ready");
    expect((extracted as DecisionPlanResult).content.plan).toBe("Final Plan");
  });

  it("fails closed when the last block is invalid, never falling back to earlier valid blocks", () => {
    const task = createPlanTask(1, 1000);
    const validResult: DecisionPlanResult = {
      schemaVersion: 1,
      taskId: task.id,
      sessionId: task.sessionId,
      kind: "plan",
      revision: 1,
      verdict: "ready",
      content: { plan: "Valid Plan", acceptanceCriteria: [], risks: [], clarifications: [] },
      createdAtMs: 1100,
    };

    // Case 1: Last block is malformed JSON
    const textWithCorruptLastBlock = [
      formatSymphonyResultPayload(validResult),
      "Now I provide another broken block:",
      "```symphony-result\n{ invalid-json: true \n```",
    ].join("\n\n");

    expect(() => extractDecisionResultFromOutput(textWithCorruptLastBlock, task)).toThrow(
      DecisionAdapterError
    );
    try {
      extractDecisionResultFromOutput(textWithCorruptLastBlock, task);
    } catch (e) {
      expect((e as DecisionAdapterError).code).toBe("malformed_output");
    }

    // Case 2: Last block is unclosed
    const textWithUnclosedLastBlock = [
      formatSymphonyResultPayload(validResult),
      "Now unclosed:",
      "```symphony-result\n{ \"schemaVersion\": 1 }",
    ].join("\n\n");

    expect(() => extractDecisionResultFromOutput(textWithUnclosedLastBlock, task)).toThrow(
      /Unclosed symphony-result code block/
    );

    // Case 3: Last block has mismatched task id/revision from another valid task
    const otherTask = createPlanTask(2, 1000);
    const mismatchedResult: DecisionPlanResult = {
      schemaVersion: 1,
      taskId: otherTask.id,
      sessionId: otherTask.sessionId,
      kind: "plan",
      revision: 2,
      verdict: "ready",
      content: { plan: "Other Plan", acceptanceCriteria: [], risks: [], clarifications: [] },
      createdAtMs: 1200,
    };
    const textWithMismatchedLastBlock = [
      formatSymphonyResultPayload(validResult),
      formatSymphonyResultPayload(mismatchedResult),
    ].join("\n\n");

    expect(() => extractDecisionResultFromOutput(textWithMismatchedLastBlock, task)).toThrow(
      DecisionAdapterError
    );
    try {
      extractDecisionResultFromOutput(textWithMismatchedLastBlock, task);
    } catch (e) {
      expect(["task_mismatch", "revision_mismatch"]).toContain((e as DecisionAdapterError).code);
    }
  });

  it("fails closed when no symphony-result block exists", () => {
    const task = createPlanTask(1, 1000);
    const prose = "I looked at the code and everything looks good! Approved.";
    expect(() => extractDecisionResultFromOutput(prose, task)).toThrow(
      /No symphony-result code block found/
    );
  });

  it("fails closed on task identity, revision, and review target mismatches", () => {
    const reviewTask = createReviewTask(1, "0123456789abcdef0123456789abcdef01234567", 1000);

    const baseResult: DecisionReviewResult = {
      schemaVersion: 1,
      taskId: reviewTask.id,
      sessionId: reviewTask.sessionId,
      kind: "review",
      revision: 1,
      verdict: "approve",
      target: reviewTask.target,
      findings: [],
      createdAtMs: 1200,
    };

    // 1. Revision mismatch
    const wrongRevisionResult: DecisionReviewResult = {
      ...baseResult,
      taskId: decisionTaskId({
        sessionId: reviewTask.sessionId,
        kind: "review",
        revision: 2,
        target: reviewTask.target,
      }),
      revision: 2,
    };
    expect(() => normalizeDecisionResult(wrongRevisionResult, reviewTask)).toThrow(DecisionAdapterError);
    try {
      normalizeDecisionResult(wrongRevisionResult, reviewTask);
    } catch (e) {
      expect((e as DecisionAdapterError).code).toBe("revision_mismatch");
    }

    // 2. HEAD SHA mismatch
    const wrongShaTarget = {
      ...baseResult.target,
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const wrongShaResult: DecisionReviewResult = {
      ...baseResult,
      taskId: decisionTaskId({
        sessionId: reviewTask.sessionId,
        kind: "review",
        revision: 1,
        target: wrongShaTarget,
      }),
      target: wrongShaTarget,
    };
    expect(() => normalizeDecisionResult(wrongShaResult, reviewTask)).toThrow(DecisionAdapterError);
    try {
      normalizeDecisionResult(wrongShaResult, reviewTask);
    } catch (e) {
      expect((e as DecisionAdapterError).code).toBe("target_mismatch");
    }

    // 3. PR Number mismatch
    const wrongPrTarget = {
      ...baseResult.target,
      prNumber: 999,
    };
    const wrongPrResult: DecisionReviewResult = {
      ...baseResult,
      taskId: decisionTaskId({
        sessionId: reviewTask.sessionId,
        kind: "review",
        revision: 1,
        target: wrongPrTarget,
      }),
      target: wrongPrTarget,
    };
    expect(() => normalizeDecisionResult(wrongPrResult, reviewTask)).toThrow(DecisionAdapterError);
    try {
      normalizeDecisionResult(wrongPrResult, reviewTask);
    } catch (e) {
      expect((e as DecisionAdapterError).code).toBe("target_mismatch");
    }

    // 4. Result created before task
    const oldResult: DecisionReviewResult = {
      ...baseResult,
      createdAtMs: 500, // task was 1000
    };
    expect(() => normalizeDecisionResult(oldResult, reviewTask)).toThrow(DecisionAdapterError);
    try {
      normalizeDecisionResult(oldResult, reviewTask);
    } catch (e) {
      expect((e as DecisionAdapterError).code).toBe("malformed_output");
    }
  });
});

describe("FakeDecisionExecutorAdapter and Context Strategies", () => {
  it("executes with connector and materialized context strategies", async () => {
    const adapter = new FakeDecisionExecutorAdapter();
    const task = createReviewTask(1, "0123456789abcdef0123456789abcdef01234567", 1000);
    const session: DecisionSession = {
      schemaVersion: 1,
      id: sessionId,
      root,
      status: "active",
      binding: null,
      bindingGeneration: 0,
      createdAtMs: 1000,
      updatedAtMs: 1000,
    };

    // 1. Connector strategy
    const outcomeConnector = await adapter.executeTask({
      task,
      session,
      context: connectorContext,
    });
    expect(outcomeConnector.result.verdict).toBe("approve");
    expect(outcomeConnector.result.kind).toBe("review");

    // 2. Materialized strategy
    const outcomeMaterialized = await adapter.executeTask({
      task,
      session,
      context: materializedContext,
    });
    expect(outcomeMaterialized.result.verdict).toBe("approve");
  });

  it("fails closed on unsupported context strategy and unsupported task kind", async () => {
    const connectorOnlyAdapter = new FakeDecisionExecutorAdapter({
      supportedContextStrategies: ["connector"],
    });
    const task = createReviewTask(1, "0123456789abcdef0123456789abcdef01234567", 1000);
    const session: DecisionSession = {
      schemaVersion: 1,
      id: sessionId,
      root,
      status: "active",
      binding: null,
      bindingGeneration: 0,
      createdAtMs: 1000,
      updatedAtMs: 1000,
    };

    await expect(
      connectorOnlyAdapter.executeTask({
        task,
        session,
        context: materializedContext,
      })
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "unsupported_strategy",
      })
    );

    const planOnlyAdapter = new FakeDecisionExecutorAdapter({
      supportedTaskKinds: ["plan"],
    });
    await expect(
      planOnlyAdapter.executeTask({
        task,
        session,
        context: connectorContext,
      })
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "unsupported_task_kind",
      })
    );
  });
});

describe("Adapter Lifecycle, CAS Rebind, and Store Coordination", () => {
  it("coordinates full lifecycle: initial binding creation, task execution, and result submission", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-adapter-test-"));
    try {
      const store = new DurableDecisionStore({ storeDir: tempDir });
      await store.open();
      const service = new DecisionService(store);

      // Create session in service
      const session = await service.createSession(root);
      expect(session.binding).toBeNull();
      expect(session.bindingGeneration).toBe(0);

      // Create task in service
      const task = await service.createPlanTask(session.id, {
        operationKey: "op:plan:1",
      });

      // Claim task
      const claim = await service.claimTask(task.id, { owner: "worker-1" });
      expect(claim.task.status).toBe("claimed");

      // Execute with adapter coordinator
      const adapter = new FakeDecisionExecutorAdapter();
      const outcome = await executeTaskWithAdapter({
        controller: service,
        adapter,
        task: claim.task,
        session: claim.session,
        lease: claim.lease,
        context: {
          strategy: "connector",
          workItem: root,
          repository: "owner/repo",
          prNumber: null,
          headSha: null,
        },
      });

      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.result.verdict).toBe("ready");
        expect(outcome.receipt.type).toBe("result");
        expect(outcome.session.binding).not.toBeNull();
        expect(outcome.session.binding?.generation).toBe(1);
      }

      // Verify store has completed task and bound session
      const storedTask = service.getTask(task.id);
      expect(storedTask?.status).toBe("completed");
      const storedSession = service.getSession(session.id);
      expect(storedSession?.binding?.generation).toBe(1);
      expect(storedSession?.bindingGeneration).toBe(1);

      // Idempotent resubmission of identical result returns identical receipt
      const storedReceipt = service.getReceipt(task.id);
      expect(storedReceipt).not.toBeNull();
      expect(storedReceipt?.payload.taskId).toBe(task.id);

      // Subsequent review task resumes the same binding
      const reviewTask = await service.createReviewTask(session.id, {
        target: {
          repository: "owner/repo",
          prNumber: 42,
          headSha: "0123456789abcdef0123456789abcdef01234567",
        },
        operationKey: "op:review:1",
      });
      const reviewClaim = await service.claimTask(reviewTask.id, { owner: "worker-1" });

      const reviewOutcome = await executeTaskWithAdapter({
        controller: service,
        adapter,
        task: reviewClaim.task,
        session: reviewClaim.session,
        lease: reviewClaim.lease,
        context: connectorContext,
      });

      expect(reviewOutcome.status).toBe("completed");
      if (reviewOutcome.status === "completed") {
        expect(reviewOutcome.result.verdict).toBe("approve");
        // Resume reused binding without changing generation
        expect(reviewOutcome.session.binding?.generation).toBe(1);
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("handles binding invalidation, durable handoff, and CAS rebind", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-adapter-rebind-"));
    try {
      const store = new DurableDecisionStore({ storeDir: tempDir });
      await store.open();
      const service = new DecisionService(store);

      let session = await service.createSession(root);
      session = await service.putBinding(session.id, {
        adapter: "fake-executor",
        externalSessionRef: "chat-generation-1",
        resumeUri: "https://fake.local/chat/1",
      });
      expect(session.bindingGeneration).toBe(1);

      // Simulate external chat deletion / broken binding
      const brokenAdapter = new FakeDecisionExecutorAdapter({
        inspectBindingStatus: "unusable",
        inspectBindingReason: "External thread 404 deleted",
      });

      const task = await service.createPlanTask(session.id, {
        operationKey: "op:plan:rebind:1",
      });
      const claim = await service.claimTask(task.id, { owner: "worker-1" });

      const outcome = await executeTaskWithAdapter({
        controller: service,
        adapter: brokenAdapter,
        task: claim.task,
        session: claim.session,
        lease: claim.lease,
        context: {
          strategy: "connector",
          workItem: root,
          repository: "owner/repo",
          prNumber: null,
          headSha: null,
        },
        operationKeyPrefix: "op:worker-1",
      });

      expect(outcome.status).toBe("completed");
      // Session rebind was automatically performed by coordinator to generation 2
      expect(outcome.session.bindingGeneration).toBe(2);
      expect(outcome.session.binding?.generation).toBe(2);

      // CAS conflict: late callback with stale expectedGeneration=1 is rejected
      await expect(
        service.rebindSession(session.id, {
          adapter: "fake-executor",
          externalSessionRef: "stale-chat-callback",
          resumeUri: null,
          expectedGeneration: 1, // Store is now at 2
        })
      ).rejects.toThrow(/Compare-and-swap failed/);

      // Reading back session confirms binding generation remains 2
      const freshSession = await service.getSession(session.id);
      expect(freshSession?.bindingGeneration).toBe(2);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("persists structured failure across store restarts and verifies fail-closed properties", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-adapter-fail-"));
    try {
      const store1 = new DurableDecisionStore({ storeDir: tempDir });
      await store1.open();
      const service1 = new DecisionService(store1);

      const session = await service1.createSession(root);

      const failReviewTarget = {
        repository: "owner/repo",
        prNumber: 42,
        headSha: "0123456789abcdef0123456789abcdef01234567",
      };
      const task = await service1.createReviewTask(session.id, {
        target: failReviewTarget,
        operationKey: "op:review:fail",
      });

      const claim = await service1.claimTask(task.id, { owner: "worker-1" });

      // Adapter fails with human_required error (e.g. login / captcha)
      const failingAdapter = new FakeDecisionExecutorAdapter({
        executeError: new DecisionAdapterError({
          code: "human_required",
          message: "Captcha verification required to continue",
          rawDetails: { challengeType: "turnstile" },
        }),
      });

      const outcome = await executeTaskWithAdapter({
        controller: service1,
        adapter: failingAdapter,
        task: claim.task,
        session: claim.session,
        lease: claim.lease,
        context: connectorContext,
      });

      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") {
        expect(outcome.failure.error).toBe("human_required");
        expect(outcome.failure.retryable).toBe(false);
        const details = outcome.failure.details as Record<string, unknown> | undefined;
        expect(details?.["code"]).toBe("human_required");
      }

      // Close store and restart a new store instance to test durability across restarts
      await store1.close();

      const store2 = new DurableDecisionStore({ storeDir: tempDir });
      await store2.open();
      const service2 = new DecisionService(store2);

      const reloadedTask = service2.getTask(task.id);
      expect(reloadedTask?.status).toBe("failed");

      const reloadedReceipt = service2.getReceipt(task.id);
      expect(reloadedReceipt).not.toBeNull();
      expect(reloadedReceipt?.type).toBe("failure");
      const payload = reloadedReceipt?.payload as Record<string, unknown> | undefined;
      expect(payload?.["error"]).toBe("human_required");
      expect(payload?.["retryable"]).toBe(false);

      // Rejected submissions on completed/failed tasks
      const reviewResult: DecisionReviewResult = {
        schemaVersion: 1,
        taskId: task.id,
        sessionId: task.sessionId,
        kind: "review",
        revision: 1,
        verdict: "approve",
        target: failReviewTarget,
        findings: [],
        createdAtMs: 2000,
      };

      await expect(
        service2.submitResult(task.id, {
          owner: claim.lease.owner,
          token: claim.lease.token,
          generation: claim.lease.generation,
          result: reviewResult,
        })
      ).rejects.toThrow();

      await store2.close();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("coordinates execution end-to-end via DecisionBridgeClient over real HTTP", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-adapter-http-"));
    const { DecisionBridge } = await import("./bridge");
    const { DecisionBridgeClient } = await import("./client");
    const token = "test-adapter-token";

    const bridge = new DecisionBridge({
      storeDir: tmpDir,
      port: 0,
      host: "127.0.0.1",
      authToken: token,
      allowedOrigins: ["http://localhost:3000"],
    });

    try {
      const { port } = await bridge.start();
      const client = new DecisionBridgeClient(`http://127.0.0.1:${port}`, {
        authToken: token,
      });

      const { session } = await client.createSession(root);
      const { task } = await client.createTask({
        sessionId: session.id,
        kind: "plan",
        operationKey: "op:http:plan:1",
      });

      const claim = await client.claimTask(task.id, { owner: "http-adapter-worker" });

      const adapter = new FakeDecisionExecutorAdapter();
      const outcome = await executeTaskWithAdapter({
        controller: client,
        adapter,
        task: claim.task,
        session: claim.session,
        lease: claim.lease,
        context: {
          strategy: "connector",
          workItem: root,
          repository: "owner/repo",
          prNumber: null,
          headSha: null,
        },
      });

      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.result.verdict).toBe("ready");
        expect(outcome.session.binding?.adapter).toBe("fake-executor");
      }

      const { result: fetchedResult } = await client.getTaskResult(task.id);
      expect(fetchedResult.verdict).toBe("ready");
      expect(fetchedResult.taskId).toBe(task.id);

      await bridge.stop();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("persists lifecycle failures during inspectBinding, createSession, and resumeSession across store restart", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-lifecycle-fail-"));
    try {
      const store1 = new DurableDecisionStore({ storeDir: tempDir });
      await store1.open();
      const service1 = new DecisionService(store1);

      // --- Scenario A: inspectBinding fails with human_required (e.g. login/CAPTCHA) ---
      const sessionA = await service1.createSession(root);
      const taskA = await service1.createPlanTask(sessionA.id, { operationKey: "op:plan:a" });
      const claimA = await service1.claimTask(taskA.id, { owner: "worker-1" });

      const inspectFailAdapter = new FakeDecisionExecutorAdapter({
        inspectError: new DecisionAdapterError({
          code: "human_required",
          message: "Login / CAPTCHA required during inspectBinding",
        }),
      });

      const outcomeA = await executeTaskWithAdapter({
        controller: service1,
        adapter: inspectFailAdapter,
        task: claimA.task,
        session: claimA.session,
        lease: claimA.lease,
        context: connectorContext,
      });

      expect(outcomeA.status).toBe("failed");
      if (outcomeA.status === "failed") {
        expect(outcomeA.failure.error).toBe("human_required");
        expect(outcomeA.receipt.type).toBe("failure");
      }

      // --- Scenario B: createSession fails with execution_failed (retryable network drop) ---
      const sessionB = await service1.createSession(githubDecisionRoot("owner", "repo", 43));
      const taskB = await service1.createPlanTask(sessionB.id, { operationKey: "op:plan:b" });
      const claimB = await service1.claimTask(taskB.id, { owner: "worker-1" });

      const createFailAdapter = new FakeDecisionExecutorAdapter({
        createSessionError: new DecisionAdapterError({
          code: "execution_failed",
          message: "Network drop during createSession",
          retryable: true,
          suggestedAction: "retry",
        }),
      });

      const outcomeB = await executeTaskWithAdapter({
        controller: service1,
        adapter: createFailAdapter,
        task: claimB.task,
        session: claimB.session,
        lease: claimB.lease,
        context: {
          strategy: "connector",
          workItem: sessionB.root,
          repository: "owner/repo",
          prNumber: null,
          headSha: null,
        },
      });

      expect(outcomeB.status).toBe("failed");
      if (outcomeB.status === "failed") {
        expect(outcomeB.failure.error).toBe("execution_failed");
        expect(outcomeB.failure.retryable).toBe(true);
      }

      // --- Scenario C: resumeSession fails with binding_broken ---
      let sessionC = await service1.createSession(githubDecisionRoot("owner", "repo", 44));
      sessionC = await service1.putBinding(sessionC.id, {
        adapter: "fake-executor",
        externalSessionRef: "ext-c-1",
        resumeUri: null,
      });
      const taskC = await service1.createPlanTask(sessionC.id, { operationKey: "op:plan:c" });
      const claimC = await service1.claimTask(taskC.id, { owner: "worker-1" });

      const resumeFailAdapter = new FakeDecisionExecutorAdapter({
        resumeSessionError: new DecisionAdapterError({
          code: "binding_broken",
          message: "Session expired on remote provider during resumeSession",
        }),
      });

      const outcomeC = await executeTaskWithAdapter({
        controller: service1,
        adapter: resumeFailAdapter,
        task: claimC.task,
        session: claimC.session,
        lease: claimC.lease,
        context: {
          strategy: "connector",
          workItem: sessionC.root,
          repository: "owner/repo",
          prNumber: null,
          headSha: null,
        },
      });

      expect(outcomeC.status).toBe("failed");
      if (outcomeC.status === "failed") {
        expect(outcomeC.failure.error).toBe("binding_broken");
      }

      // --- Scenario D: unusable binding that cannot be rebound (needsRebind: false) ---
      let sessionD = await service1.createSession(githubDecisionRoot("owner", "repo", 45));
      sessionD = await service1.putBinding(sessionD.id, {
        adapter: "fake-executor",
        externalSessionRef: "ext-d-1",
        resumeUri: null,
      });
      const taskD = await service1.createPlanTask(sessionD.id, { operationKey: "op:plan:d" });
      const claimD = await service1.claimTask(taskD.id, { owner: "worker-1" });

      const unrecoverableAdapter = new FakeDecisionExecutorAdapter({
        inspectBindingStatus: "unusable",
        inspectBindingNeedsRebind: false,
        inspectBindingReason: "Account terminated permanently",
      });

      const outcomeD = await executeTaskWithAdapter({
        controller: service1,
        adapter: unrecoverableAdapter,
        task: claimD.task,
        session: claimD.session,
        lease: claimD.lease,
        context: {
          strategy: "connector",
          workItem: sessionD.root,
          repository: "owner/repo",
          prNumber: null,
          headSha: null,
        },
      });

      expect(outcomeD.status).toBe("failed");
      if (outcomeD.status === "failed") {
        expect(outcomeD.failure.error).toBe("binding_broken");
      }

      // Close store and reopen fresh instance to prove durability
      await store1.close();

      const store2 = new DurableDecisionStore({ storeDir: tempDir });
      await store2.open();
      const service2 = new DecisionService(store2);

      const reloadedA = service2.getTask(taskA.id);
      expect(reloadedA?.status).toBe("failed");
      expect((service2.getReceipt(taskA.id)?.payload as DecisionTaskFailure)?.error).toBe("human_required");

      const reloadedB = service2.getTask(taskB.id);
      expect(reloadedB?.status).toBe("failed");
      expect((service2.getReceipt(taskB.id)?.payload as DecisionTaskFailure)?.error).toBe("execution_failed");

      const reloadedC = service2.getTask(taskC.id);
      expect(reloadedC?.status).toBe("failed");
      expect((service2.getReceipt(taskC.id)?.payload as DecisionTaskFailure)?.error).toBe("binding_broken");

      const reloadedD = service2.getTask(taskD.id);
      expect(reloadedD?.status).toBe("failed");
      expect((service2.getReceipt(taskD.id)?.payload as DecisionTaskFailure)?.error).toBe("binding_broken");

      await store2.close();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rethrows controller authority errors on stale lease or CAS rebind conflict without recording adapter failure", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-authority-test-"));
    try {
      const store = new DurableDecisionStore({ storeDir: tempDir });
      await store.open();
      const service = new DecisionService(store);

      // 1. Stale lease during startTask
      const session1 = await service.createSession(root);
      const task1 = await service.createPlanTask(session1.id, { operationKey: "op:plan:auth:1" });
      const claim1 = await service.claimTask(task1.id, { owner: "worker-1" });

      const staleLease = {
        ...claim1.lease,
        token: "completely-invalid-stale-token",
      };

      const adapter1 = new FakeDecisionExecutorAdapter();
      await expect(
        executeTaskWithAdapter({
          controller: service,
          adapter: adapter1,
          task: claim1.task,
          session: claim1.session,
          lease: staleLease,
          context: connectorContext,
        })
      ).rejects.toThrow(DecisionConflictError);

      // Task must remain in claimed state — NOT failed!
      const storedTask1 = service.getTask(task1.id);
      expect(storedTask1?.status).toBe("claimed");
      expect(service.getReceipt(task1.id)).toBeNull();

      // 2. CAS conflict during rebindSession
      let session2 = await service.createSession(githubDecisionRoot("owner", "repo", 43));
      session2 = await service.putBinding(session2.id, {
        adapter: "fake-executor",
        externalSessionRef: "chat-gen-1",
        resumeUri: null,
      });
      expect(session2.bindingGeneration).toBe(1);

      const task2 = await service.createPlanTask(session2.id, { operationKey: "op:plan:auth:2" });
      const claim2 = await service.claimTask(task2.id, { owner: "worker-1" });

      // Simulate a concurrent worker advancing binding generation to 2 behind our back
      await service.rebindSession(session2.id, {
        adapter: "concurrent-worker-adapter",
        externalSessionRef: "chat-gen-2",
        resumeUri: null,
        expectedGeneration: 1,
      });

      // Now coordinator encounters an unusable binding and attempts to rebind with expectedGeneration: 1 (stale)
      const rebindAdapter = new FakeDecisionExecutorAdapter({
        inspectBindingStatus: "unusable",
        inspectBindingNeedsRebind: true,
        inspectBindingReason: "Old session dropped",
      });

      await expect(
        executeTaskWithAdapter({
          controller: service,
          adapter: rebindAdapter,
          task: claim2.task,
          session: claim2.session, // Session at generation 1
          lease: claim2.lease,
          context: {
            strategy: "connector",
            workItem: session2.root,
            repository: "owner/repo",
            prNumber: null,
            headSha: null,
          },
        })
      ).rejects.toThrow(DecisionConflictError);

      // Task must remain in claimed state — NOT failed!
      const storedTask2 = service.getTask(task2.id);
      expect(storedTask2?.status).toBe("claimed");
      expect(service.getReceipt(task2.id)).toBeNull();

      await store.close();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("enforces safe bounded diagnostics and prevents secrets or raw content from leaking into store.json", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-secret-test-"));
    try {
      const store = new DurableDecisionStore({ storeDir: tempDir });
      await store.open();
      const service = new DecisionService(store);

      const session = await service.createSession(root);
      const task = await service.createPlanTask(session.id, { operationKey: "op:plan:secret:1" });
      const claim = await service.claimTask(task.id, { owner: "worker-1" });

      const SECRET = "TOP_SECRET_SESSION_TOKEN_ABC_XYZ_987";
      const PRIVATE_PROMPT = "Confidential customer prompt data";

      // Adapter returns malformed JSON with private prompt and secret in the output
      const rawTextOutput = [
        "Thought: Let me evaluate this secretly.",
        `Private data: ${PRIVATE_PROMPT}`,
        "```symphony-result",
        `{ "secret": "${SECRET}", "malformed_json": missing_quotes_here }`,
        "```",
      ].join("\n");

      const leakyAdapter = new FakeDecisionExecutorAdapter({
        rawTextOutput,
      });

      const outcome = await executeTaskWithAdapter({
        controller: service,
        adapter: leakyAdapter,
        task: claim.task,
        session: claim.session,
        lease: claim.lease,
        context: connectorContext,
      });

      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") {
        expect(outcome.failure.error).toBe("malformed_output");
      }

      await store.close();

      // Read raw store.json from disk
      const storeContent = await fs.readFile(path.join(tempDir, "store.json"), "utf8");

      // Verify that SECRET and PRIVATE_PROMPT are nowhere in store.json!
      expect(storeContent.includes(SECRET)).toBe(false);
      expect(storeContent.includes(PRIVATE_PROMPT)).toBe(false);

      // Verify that only bounded whitelist diagnostics are present
      expect(storeContent).toContain('"errorName": "SyntaxError"');
      expect(storeContent).toContain('"contentLength":');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("sanitizes generic Error and DecisionAdapterError messages preventing token or prompt leakage into store.json and receipts across restart", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-msg-sanitize-"));
    try {
      const store1 = new DurableDecisionStore({ storeDir: tempDir });
      await store1.open();
      const service1 = new DecisionService(store1);

      // Scenario A: Generic Error containing Bearer token
      const sessionA = await service1.createSession(root);
      const taskA = await service1.createPlanTask(sessionA.id, { operationKey: "op:plan:bearer:1" });
      const claimA = await service1.claimTask(taskA.id, { owner: "worker-1" });

      const BEARER_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitive_payload.signature";
      const genericErrorAdapter = new FakeDecisionExecutorAdapter({
        executeError: new Error(`Failed with authorization header: ${BEARER_TOKEN}`),
      });

      const outcomeA = await executeTaskWithAdapter({
        controller: service1,
        adapter: genericErrorAdapter,
        task: claimA.task,
        session: claimA.session,
        lease: claimA.lease,
        context: connectorContext,
      });

      expect(outcomeA.status).toBe("failed");
      if (outcomeA.status === "failed") {
        expect(outcomeA.failure.error).toBe("execution_failed");
        expect((outcomeA.failure.details as Record<string, unknown>)?.["message"]).toBe(
          "Executor task execution failed"
        );
      }

      // Scenario B: DecisionAdapterError message containing private prompt data
      const sessionB = await service1.createSession(githubDecisionRoot("owner", "repo", 43));
      const taskB = await service1.createPlanTask(sessionB.id, { operationKey: "op:plan:prompt:1" });
      const claimB = await service1.claimTask(taskB.id, { owner: "worker-1" });

      const PRIVATE_USER_PROMPT = "Confidential customer prompt: please process payroll records secret_12345";
      const adapterErrorWithPrompt = new FakeDecisionExecutorAdapter({
        executeError: new DecisionAdapterError({
          code: "human_required",
          message: `Executor halted on prompt: ${PRIVATE_USER_PROMPT}`,
          suggestedAction: "human_intervention",
        }),
      });

      const outcomeB = await executeTaskWithAdapter({
        controller: service1,
        adapter: adapterErrorWithPrompt,
        task: claimB.task,
        session: claimB.session,
        lease: claimB.lease,
        context: {
          strategy: "connector",
          workItem: sessionB.root,
          repository: "owner/repo",
          prNumber: null,
          headSha: null,
        },
      });

      expect(outcomeB.status).toBe("failed");
      if (outcomeB.status === "failed") {
        expect(outcomeB.failure.error).toBe("human_required");
        expect((outcomeB.failure.details as Record<string, unknown>)?.["message"]).toBe(
          "Executor requires human interaction or verification"
        );
      }

      await store1.close();

      // Read raw store.json from disk and verify zero leakage
      const storeContent = await fs.readFile(path.join(tempDir, "store.json"), "utf8");
      expect(storeContent.includes(BEARER_TOKEN)).toBe(false);
      expect(storeContent.includes("sensitive_payload")).toBe(false);
      expect(storeContent.includes(PRIVATE_USER_PROMPT)).toBe(false);
      expect(storeContent.includes("secret_12345")).toBe(false);

      // Verify canonical safe messages are persisted
      expect(storeContent).toContain('"message": "Executor task execution failed"');
      expect(storeContent).toContain('"message": "Executor requires human interaction or verification"');

      // Reopen in fresh DurableDecisionStore and verify receipts
      const store2 = new DurableDecisionStore({ storeDir: tempDir });
      await store2.open();
      const service2 = new DecisionService(store2);

      const reloadedTaskA = service2.getTask(taskA.id);
      expect(reloadedTaskA?.status).toBe("failed");
      const receiptA = service2.getReceipt(taskA.id);
      expect(receiptA?.type).toBe("failure");
      const failurePayloadA = receiptA?.payload as DecisionTaskFailure;
      expect(failurePayloadA.error).toBe("execution_failed");
      expect((failurePayloadA.details as Record<string, unknown>)?.["message"]).toBe(
        "Executor task execution failed"
      );

      const reloadedTaskB = service2.getTask(taskB.id);
      expect(reloadedTaskB?.status).toBe("failed");
      const receiptB = service2.getReceipt(taskB.id);
      expect(receiptB?.type).toBe("failure");
      const failurePayloadB = receiptB?.payload as DecisionTaskFailure;
      expect(failurePayloadB.error).toBe("human_required");
      expect((failurePayloadB.details as Record<string, unknown>)?.["message"]).toBe(
        "Executor requires human interaction or verification"
      );

      await store2.close();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects nested objects under whitelist keys and clamps oversized strings preventing diagnostic bloating across restart", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-nested-sanitize-"));
    try {
      const store1 = new DurableDecisionStore({ storeDir: tempDir });
      await store1.open();
      const service1 = new DecisionService(store1);

      // Scenario A: nested object under reason and actualTarget with sensitive auth token
      const sessionA = await service1.createSession(root);
      const taskA = await service1.createPlanTask(sessionA.id, { operationKey: "op:plan:nested:1" });
      const claimA = await service1.claimTask(taskA.id, { owner: "worker-1" });

      const NESTED_32K_TRANSCRIPT = "CONFIDENTIAL_TRANSCRIPT_BLOCK_".repeat(1000); // > 30KB
      const NESTED_TOKEN = "ghp_super_secret_personal_access_token_999999999";

      const nestedErrorAdapter = new FakeDecisionExecutorAdapter({
        executeError: new DecisionAdapterError({
          code: "target_mismatch",
          message: "Target mismatch error",
          rawDetails: {
            reason: { transcript: NESTED_32K_TRANSCRIPT },
            actualTarget: { authorization: NESTED_TOKEN, invalidExtra: true },
          },
        }),
      });

      const outcomeA = await executeTaskWithAdapter({
        controller: service1,
        adapter: nestedErrorAdapter,
        task: claimA.task,
        session: claimA.session,
        lease: claimA.lease,
        context: connectorContext,
      });

      expect(outcomeA.status).toBe("failed");

      // Scenario B: oversized string under reason (> 32KB)
      const sessionB = await service1.createSession(githubDecisionRoot("owner", "repo", 43));
      const taskB = await service1.createPlanTask(sessionB.id, { operationKey: "op:plan:oversized:1" });
      const claimB = await service1.claimTask(taskB.id, { owner: "worker-1" });

      const OVERSIZED_REASON_TEXT = "OVERSIZED_STRING_REASON_SEGMENT_".repeat(1024); // > 32KB
      const oversizedErrorAdapter = new FakeDecisionExecutorAdapter({
        executeError: new DecisionAdapterError({
          code: "binding_broken",
          message: "Broken binding",
          rawDetails: {
            reason: OVERSIZED_REASON_TEXT,
          },
        }),
      });

      const outcomeB = await executeTaskWithAdapter({
        controller: service1,
        adapter: oversizedErrorAdapter,
        task: claimB.task,
        session: claimB.session,
        lease: claimB.lease,
        context: {
          strategy: "connector",
          workItem: sessionB.root,
          repository: "owner/repo",
          prNumber: null,
          headSha: null,
        },
      });

      expect(outcomeB.status).toBe("failed");

      await store1.close();

      // Read raw store.json from disk and verify zero leakage and bounded file size
      const storeContent = await fs.readFile(path.join(tempDir, "store.json"), "utf8");

      // Verify that neither the 30KB transcript nor the nested token is persisted
      expect(storeContent.includes(NESTED_32K_TRANSCRIPT)).toBe(false);
      expect(storeContent.includes(NESTED_TOKEN)).toBe(false);
      expect(storeContent.includes("CONFIDENTIAL_TRANSCRIPT_BLOCK_")).toBe(false);

      // Verify oversized string was clamped (full 32KB string not present)
      expect(storeContent.includes(OVERSIZED_REASON_TEXT)).toBe(false);
      // Entire store.json file size must be small (< 15KB), definitely not 64KB+!
      expect(storeContent.length).toBeLessThan(15000);

      // Reopen store and verify valid structured recovery
      const store2 = new DurableDecisionStore({ storeDir: tempDir });
      await store2.open();
      const service2 = new DecisionService(store2);

      const receiptA = service2.getReceipt(taskA.id);
      expect(receiptA?.type).toBe("failure");
      const detailsA = (receiptA?.payload as DecisionTaskFailure)?.details as Record<string, unknown>;
      // Nested objects under reason and actualTarget were rejected, so rawDetails is not set or empty
      expect(detailsA?.["rawDetails"]).toBeUndefined();

      const receiptB = service2.getReceipt(taskB.id);
      expect(receiptB?.type).toBe("failure");
      const detailsB = (receiptB?.payload as DecisionTaskFailure)?.details as Record<string, unknown>;
      const rawDetailsB = detailsB?.["rawDetails"] as Record<string, unknown> | undefined;
      expect(rawDetailsB).toBeDefined();
      expect(typeof rawDetailsB?.["reason"]).toBe("string");
      expect((rawDetailsB?.["reason"] as string).length).toBeLessThanOrEqual(128);

      await store2.close();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects cross-issue context at coordinator entrypoint before touching adapter or mutating task", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-cross-issue-test-"));
    try {
      const store = new DurableDecisionStore({ storeDir: tempDir });
      await store.open();
      const service = new DecisionService(store);

      const session = await service.createSession(root); // github:owner/repo#42
      const task = await service.createPlanTask(session.id, { operationKey: "op:plan:cross:1" });
      const claim = await service.claimTask(task.id, { owner: "worker-1" });

      const adapter = new FakeDecisionExecutorAdapter();

      // 1. Cross-repo connector context
      const crossRepoConnectorContext: DecisionConnectorContext = {
        strategy: "connector",
        workItem: githubDecisionRoot("other", "different-repo", 99),
        repository: "other/different-repo",
        prNumber: null,
        headSha: null,
      };

      await expect(
        executeTaskWithAdapter({
          controller: service,
          adapter,
          task: claim.task,
          session: claim.session,
          lease: claim.lease,
          context: crossRepoConnectorContext,
        })
      ).rejects.toThrow(/context workItem mismatch with session root/);

      // 2. Cross-issue materialized context
      const crossIssueMaterializedContext: DecisionMaterializedContext = {
        ...materializedContext,
        issue: {
          ...materializedContext.issue,
          number: 99, // Mismatched issue number
        },
      };

      await expect(
        executeTaskWithAdapter({
          controller: service,
          adapter,
          task: claim.task,
          session: claim.session,
          lease: claim.lease,
          context: crossIssueMaterializedContext,
        })
      ).rejects.toThrow(/materialized issue number mismatch with session root issue number/);

      // Verify adapter was NEVER touched
      expect(adapter.inspectCalls).toHaveLength(0);
      expect(adapter.createSessionCalls).toHaveLength(0);
      expect(adapter.resumeSessionCalls).toHaveLength(0);
      expect(adapter.executeTaskCalls).toHaveLength(0);

      // Verify task in store remains in claimed state, no receipt created
      const storedTask = service.getTask(task.id);
      expect(storedTask?.status).toBe("claimed");
      expect(service.getReceipt(task.id)).toBeNull();

      await store.close();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("verifies browser safety of @symphony/decision/adapter entrypoint", async () => {
    // Verify that the adapter module file contains no imports of node built-ins
    const adapterIndexFile = path.resolve(__dirname, "adapter/index.ts");
    const resultExtractorFile = path.resolve(__dirname, "adapter/result-extractor.ts");
    const fakeAdapterFile = path.resolve(__dirname, "adapter/fake-adapter.ts");
    const coordinatorFile = path.resolve(__dirname, "adapter/coordinator.ts");

    for (const file of [adapterIndexFile, resultExtractorFile, fakeAdapterFile, coordinatorFile]) {
      const content = await fs.readFile(file, "utf8");
      expect(content).not.toMatch(/from\s+["']node:/);
      expect(content).not.toMatch(/require\(["']node:/);
    }
  });
});
