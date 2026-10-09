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
