import { describe, it, expect, vi } from "vitest";
import { DecisionTabDriver } from "../src/driver";
import { MemoryCheckpointStore } from "../src/checkpoint";
import { initSymphonyUserscript } from "../src/userscript-entry";
import { MockDocument } from "./mock-dom";
import type { BridgeTransport } from "../src/transport";
import type { DecisionExecutorAdapter } from "@symphony/decision/adapter";
import type {
  DecisionTask,
  DecisionSession,
  DecisionLease,
  DecisionContextBundle,
  DecisionResult,
} from "@symphony/domain/decision";

describe("DecisionTabDriver", () => {
  const sampleTask: DecisionTask = {
    schemaVersion: 1,
    id: "github%3Aowner%2Frepo%231:plan:1",
    sessionId: "github:owner/repo#1",
    kind: "plan",
    revision: 1,
    status: "claimed",
    lease: {
      owner: "driver-1",
      token: "tok-1",
      generation: 1,
      expiresAtMs: Date.now() + 60_000,
    },
    claimGeneration: 1,
    lastClaimToken: "tok-1",
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };

  const sampleSession: DecisionSession = {
    schemaVersion: 1,
    id: "github:owner/repo#1",
    root: { provider: "github", key: "owner/repo#1" },
    status: "active",
    binding: null,
    bindingGeneration: 0,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };

  const sampleLease: DecisionLease = {
    owner: "driver-1",
    token: "tok-1",
    generation: 1,
    expiresAtMs: Date.now() + 60_000,
  };

  const sampleContext: DecisionContextBundle = {
    strategy: "connector",
    workItem: { provider: "github", key: "owner/repo#1" },
    repository: "owner/repo",
    prNumber: null,
    headSha: null,
  };

  it("claims next task and fetches context via transport", async () => {
    const mockTransport: BridgeTransport = {
      baseUrl: "http://127.0.0.1:4545",
      authToken: "test",
      request: vi.fn(async <T>(method: string, path: string): Promise<T> => {
        if (method === "GET" && path === "/v1/tasks/next") {
          return { task: sampleTask, session: sampleSession } as unknown as T;
        }
        if (method === "POST" && path.includes("/claim")) {
          return { task: sampleTask, session: sampleSession, lease: sampleLease } as unknown as T;
        }
        if (method === "GET" && path.includes("/context")) {
          return { context: sampleContext } as unknown as T;
        }
        return {} as unknown as T;
      }),
    };

    const driver = new DecisionTabDriver({
      transport: mockTransport,
      checkpointStore: new MemoryCheckpointStore(),
      ownerId: "driver-1",
    });

    const claimed = await driver.claimNextTask();
    expect(claimed).not.toBeNull();
    expect(claimed?.task.id).toBe(sampleTask.id);

    const ctx = await driver.fetchContext(sampleTask.id);
    expect(ctx).toEqual(sampleContext);
  });

  it("handles checkpoint persistence and cleanup during execution", async () => {
    const cpStore = new MemoryCheckpointStore();
    const expectedResult: DecisionResult = {
      schemaVersion: 1,
      taskId: sampleTask.id,
      sessionId: sampleTask.sessionId,
      kind: "plan",
      revision: 1,
      verdict: "ready",
      content: {
        plan: "Plan",
        acceptanceCriteria: [],
        risks: [],
        clarifications: [],
      },
      createdAtMs: Date.now(),
    };

    const mockTransport: BridgeTransport = {
      baseUrl: "http://127.0.0.1:4545",
      authToken: "test",
      request: vi.fn(async <T>(method: string, path: string): Promise<T> => {
        if (method === "POST" && path.includes("/result")) {
          return {
            receipt: {
              schemaVersion: 1,
              taskId: sampleTask.id,
              operationKey: "op",
              status: "completed",
              submittedAtMs: Date.now(),
            },
            result: expectedResult,
            superseded: false,
          } as unknown as T;
        }
        return {} as unknown as T;
      }),
    };

    const mockAdapter: DecisionExecutorAdapter = {
      name: "chatgpt-web",
      supportedTaskKinds: ["plan", "review"],
      supportedContextStrategies: ["connector", "materialized"],
      inspectBinding: vi.fn().mockResolvedValue({ status: "none" }),
      createSession: vi.fn().mockResolvedValue({
        binding: {
          schemaVersion: 1,
          adapter: "chatgpt-web",
          externalSessionRef: "conv-1",
          resumeUri: "https://chatgpt.com/c/conv-1",
          generation: 1,
        },
      }),
      resumeSession: vi.fn().mockResolvedValue({
        binding: {
          schemaVersion: 1,
          adapter: "chatgpt-web",
          externalSessionRef: "conv-1",
          resumeUri: "https://chatgpt.com/c/conv-1",
          generation: 1,
        },
      }),
      executeTask: vi.fn().mockResolvedValue({
        result: expectedResult,
      }),
    };

    const driver = new DecisionTabDriver({
      transport: mockTransport,
      checkpointStore: cpStore,
      adapter: mockAdapter,
      ownerId: "driver-1",
    });

    const outcome = await driver.executeClaimedTask(
      sampleTask,
      sampleSession,
      sampleLease,
      sampleContext
    );

    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.result.verdict).toBe("ready");
    }
    // Checkpoint should be deleted upon completion
    expect(cpStore.get()).toBeNull();
  });

  it("stops background heartbeat when stop() is called", () => {
    const mockTransport: BridgeTransport = {
      baseUrl: "http://127.0.0.1:4545",
      authToken: "test",
      request: vi.fn().mockResolvedValue({} as never),
    };

    const driver = new DecisionTabDriver({
      transport: mockTransport,
      ownerId: "driver-1",
    });

    driver.startHeartbeat(sampleTask, sampleLease);
    expect((driver as unknown as { heartbeatTimer: unknown }).heartbeatTimer).not.toBeNull();

    driver.stop();
    expect((driver as unknown as { heartbeatTimer: unknown }).heartbeatTimer).toBeNull();
  });

  it("recovers candidateResult from checkpoint without calling startTask again", async () => {
    const cpStore = new MemoryCheckpointStore({ tabId: "driver-tab" });
    const expectedResult: DecisionResult = {
      schemaVersion: 1,
      taskId: sampleTask.id,
      sessionId: sampleTask.sessionId,
      kind: "plan",
      revision: 1,
      verdict: "ready",
      content: {
        plan: "Plan",
        acceptanceCriteria: [],
        risks: [],
        clarifications: [],
      },
      createdAtMs: Date.now(),
    };

    // Pre-populate checkpoint at result_extracted step
    cpStore.set({
      schemaVersion: 1,
      tabId: "driver-tab",
      taskId: sampleTask.id,
      sessionId: sampleTask.sessionId,
      leaseOwner: "driver-1",
      leaseToken: "tok-1",
      leaseGeneration: 1,
      leaseExpiresAtMs: Date.now() + 60_000,
      bindingGeneration: 0,
      step: "result_extracted",
      attemptId: "att-1",
      savedAtMs: Date.now(),
      candidateResult: expectedResult,
    });

    const calls: string[] = [];
    const mockTransport: BridgeTransport = {
      baseUrl: "http://127.0.0.1:4545",
      authToken: "test",
      request: vi.fn(async <T>(method: string, path: string): Promise<T> => {
        calls.push(`${method} ${path}`);
        if (method === "POST" && path.includes("/heartbeat")) {
          return { expiresAtMs: Date.now() + 60_000 } as unknown as T;
        }
        if (method === "GET" && path === `/v1/tasks/${encodeURIComponent(sampleTask.id)}`) {
          return { task: { ...sampleTask, status: "running" } } as unknown as T;
        }
        if (method === "GET" && path.includes("/sessions/")) {
          return { session: sampleSession } as unknown as T;
        }
        if (method === "POST" && path.includes("/result")) {
          return {
            receipt: {
              schemaVersion: 1,
              taskId: sampleTask.id,
              type: "result",
              claimGeneration: 1,
              claimOwner: "driver-1",
              claimToken: "tok-1",
              acceptedAtMs: Date.now(),
              payload: expectedResult,
            },
            result: expectedResult,
            superseded: false,
          } as unknown as T;
        }
        return {} as unknown as T;
      }),
    };

    const driver = new DecisionTabDriver({
      transport: mockTransport,
      checkpointStore: cpStore,
      ownerId: "driver-1",
    });

    const resumed = await driver.resumeCheckpointIfAvailable();
    expect(resumed?.status).toBe("completed");
    if (resumed?.status === "completed") {
      expect(resumed.result.verdict).toBe("ready");
    }

    // Verify /start was NEVER called because we recovered from result_extracted
    expect(calls.some((c) => c.includes("/start"))).toBe(false);
    expect(calls.some((c) => c.includes("/result"))).toBe(true);
    expect(cpStore.get()).toBeNull();
  });

  it("surfaces polling errors via onError callback", async () => {
    let capturedError: Error | null = null;
    const mockTransport: BridgeTransport = {
      baseUrl: "http://127.0.0.1:4545",
      authToken: "bad-token",
      request: vi.fn().mockRejectedValue(new Error("HTTP 401: Unauthorized")),
    };

    const driver = new DecisionTabDriver({
      transport: mockTransport,
      ownerId: "driver-1",
      pollIntervalMs: 50,
      onError: (err) => {
        capturedError = err;
      },
    });

    const startPromise = driver.start();
    await new Promise((r) => setTimeout(r, 80));
    driver.stop();
    await startPromise;

    expect(capturedError).not.toBeNull();
    expect(capturedError?.message).toContain("401");
  });

  it("recovers already completed task and receipt without requiring active lease (R4)", async () => {
    const cpStore = new MemoryCheckpointStore({ tabId: "driver-tab" });
    const expectedResult: DecisionResult = {
      schemaVersion: 1,
      taskId: sampleTask.id,
      sessionId: sampleTask.sessionId,
      kind: "plan",
      revision: 1,
      verdict: "ready",
      content: {
        plan: "Plan",
        acceptanceCriteria: [],
        risks: [],
        clarifications: [],
      },
      createdAtMs: Date.now(),
    };

    cpStore.set({
      schemaVersion: 1,
      tabId: "driver-tab",
      taskId: sampleTask.id,
      sessionId: sampleTask.sessionId,
      leaseOwner: "driver-1",
      leaseToken: "tok-1",
      leaseGeneration: 1,
      leaseExpiresAtMs: Date.now() + 60_000,
      bindingGeneration: 0,
      step: "result_extracted",
      attemptId: "att-1",
      savedAtMs: Date.now(),
      candidateResult: expectedResult,
    });

    const mockTransport: BridgeTransport = {
      baseUrl: "http://127.0.0.1:4545",
      authToken: "test",
      request: vi.fn(async <T>(method: string, path: string): Promise<T> => {
        // Heartbeat would fail with 409 because task is completed!
        if (method === "POST" && path.includes("/heartbeat")) {
          throw new Error("HTTP 409: Task is not claimed/running");
        }
        if (method === "GET" && path === `/v1/tasks/${encodeURIComponent(sampleTask.id)}`) {
          return { task: { ...sampleTask, status: "completed" } } as unknown as T;
        }
        if (method === "GET" && path.includes("/sessions/")) {
          return { session: sampleSession } as unknown as T;
        }
        if (method === "GET" && path.includes("/receipt")) {
          return {
            receipt: {
              schemaVersion: 1,
              taskId: sampleTask.id,
              type: "result",
              claimGeneration: 1,
              claimOwner: "driver-1",
              claimToken: "tok-1",
              acceptedAtMs: Date.now(),
              payload: expectedResult,
            },
          } as unknown as T;
        }
        return {} as unknown as T;
      }),
    };

    const driver = new DecisionTabDriver({
      transport: mockTransport,
      checkpointStore: cpStore,
      ownerId: "driver-1",
    });

    const outcome = await driver.resumeCheckpointIfAvailable();
    expect(outcome?.status).toBe("completed");
    if (outcome?.status === "completed") {
      expect(outcome.result.verdict).toBe("ready");
      expect(outcome.receipt.taskId).toBe(sampleTask.id);
    }
    // Checkpoint must be cleanly removed upon verified receipt
    expect(cpStore.get()).toBeNull();
  });

  it("recovers waiting_response checkpoint by waiting for existing response without resending prompt (R3)", async () => {
    const cpStore = new MemoryCheckpointStore({ tabId: "driver-tab" });
    const expectedResult: DecisionResult = {
      schemaVersion: 1,
      taskId: sampleTask.id,
      sessionId: sampleTask.sessionId,
      kind: "plan",
      revision: 1,
      verdict: "ready",
      content: {
        plan: "Plan",
        acceptanceCriteria: [],
        risks: [],
        clarifications: [],
      },
      createdAtMs: Date.now(),
    };

    cpStore.set({
      schemaVersion: 1,
      tabId: "driver-tab",
      taskId: sampleTask.id,
      sessionId: sampleTask.sessionId,
      leaseOwner: "driver-1",
      leaseToken: "tok-1",
      leaseGeneration: 1,
      leaseExpiresAtMs: Date.now() + 60_000,
      bindingGeneration: 0,
      step: "waiting_response",
      attemptId: "att-1",
      savedAtMs: Date.now(),
      baselineCount: 1,
    });

    const mockAdapter = {
      name: "chatgpt-web",
      supportedTaskKinds: ["plan", "review"] as const,
      supportedContextStrategies: ["connector", "materialized"] as const,
      inspectBinding: vi.fn(),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      executeTask: vi.fn(), // MUST NOT be called!
      waitForExistingResponse: vi.fn().mockResolvedValue({ result: expectedResult }),
      setStepListener: vi.fn(),
    };

    const mockTransport: BridgeTransport = {
      baseUrl: "http://127.0.0.1:4545",
      authToken: "test",
      request: vi.fn(async <T>(method: string, path: string): Promise<T> => {
        if (method === "POST" && path.includes("/heartbeat")) {
          return { expiresAtMs: Date.now() + 100_000, ttlMs: 120_000 } as unknown as T;
        }
        if (method === "GET" && path === `/v1/tasks/${encodeURIComponent(sampleTask.id)}`) {
          return { task: { ...sampleTask, status: "running" } } as unknown as T;
        }
        if (method === "GET" && path.includes("/sessions/")) {
          return { session: sampleSession } as unknown as T;
        }
        if (method === "POST" && path.includes("/result")) {
          return {
            receipt: {
              schemaVersion: 1,
              taskId: sampleTask.id,
              type: "result",
              claimGeneration: 1,
              claimOwner: "driver-1",
              claimToken: "tok-1",
              acceptedAtMs: Date.now(),
              payload: expectedResult,
            },
            result: expectedResult,
            superseded: false,
          } as unknown as T;
        }
        return {} as unknown as T;
      }),
    };

    const driver = new DecisionTabDriver({
      transport: mockTransport,
      checkpointStore: cpStore,
      adapter: mockAdapter as unknown as DecisionExecutorAdapter,
      ownerId: "driver-1",
    });

    const outcome = await driver.resumeCheckpointIfAvailable();
    expect(outcome?.status).toBe("completed");
    expect(mockAdapter.executeTask).not.toHaveBeenCalled();
    expect(mockAdapter.waitForExistingResponse).toHaveBeenCalled();
  });

  it("handles prompt_submitting checkpoint: resumes waiting if confirmed sent (S2)", async () => {
    const cpStore = new MemoryCheckpointStore();
    const expectedResult: DecisionResult = {
      schemaVersion: 1,
      taskId: sampleTask.id,
      sessionId: sampleTask.sessionId,
      kind: "plan",
      revision: 1,
      verdict: "ready",
      content: { plan: "Plan", acceptanceCriteria: [], risks: [], clarifications: [] },
      createdAtMs: Date.now(),
    };

    cpStore.set({
      schemaVersion: 1,
      tabId: "driver-tab",
      taskId: sampleTask.id,
      sessionId: sampleTask.sessionId,
      leaseOwner: "driver-1",
      leaseToken: "tok-1",
      leaseGeneration: 1,
      leaseExpiresAtMs: Date.now() + 60_000,
      bindingGeneration: 0,
      step: "prompt_submitting",
      attemptId: "att-1",
      savedAtMs: Date.now(),
      baselineCount: 1,
    });

    const mockAdapter = {
      name: "chatgpt-web",
      supportedTaskKinds: ["plan", "review"] as const,
      supportedContextStrategies: ["connector", "materialized"] as const,
      inspectBinding: vi.fn(),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      executeTask: vi.fn(), // MUST NOT be called!
      confirmPromptSubmitted: vi.fn().mockResolvedValue(true),
      waitForExistingResponse: vi.fn().mockResolvedValue({ result: expectedResult }),
      setStepListener: vi.fn(),
    };

    const mockTransport: BridgeTransport = {
      baseUrl: "http://127.0.0.1:4545",
      authToken: "test",
      request: vi.fn(async <T>(method: string, path: string): Promise<T> => {
        if (method === "POST" && path.includes("/heartbeat")) {
          return { expiresAtMs: Date.now() + 100_000, ttlMs: 120_000 } as unknown as T;
        }
        if (method === "GET" && path === `/v1/tasks/${encodeURIComponent(sampleTask.id)}`) {
          return { task: { ...sampleTask, status: "running" } } as unknown as T;
        }
        if (method === "GET" && path.includes("/sessions/")) {
          return { session: sampleSession } as unknown as T;
        }
        if (method === "POST" && path.includes("/result")) {
          return {
            receipt: {
              schemaVersion: 1,
              taskId: sampleTask.id,
              type: "result",
              claimGeneration: 1,
              claimOwner: "driver-1",
              claimToken: "tok-1",
              acceptedAtMs: Date.now(),
              payload: expectedResult,
            },
            result: expectedResult,
            superseded: false,
          } as unknown as T;
        }
        return {} as unknown as T;
      }),
    };

    const driver = new DecisionTabDriver({
      transport: mockTransport,
      checkpointStore: cpStore,
      adapter: mockAdapter as unknown as DecisionExecutorAdapter,
      ownerId: "driver-1",
    });

    const outcome = await driver.resumeCheckpointIfAvailable();
    expect(outcome?.status).toBe("completed");
    expect(mockAdapter.executeTask).not.toHaveBeenCalled();
    expect(mockAdapter.confirmPromptSubmitted).toHaveBeenCalled();
    expect(mockAdapter.waitForExistingResponse).toHaveBeenCalled();
  });

  it("handles prompt_submitting checkpoint: fails safely when submission cannot be confirmed (S2)", async () => {
    const cpStore = new MemoryCheckpointStore();
    cpStore.set({
      schemaVersion: 1,
      tabId: "driver-tab",
      taskId: sampleTask.id,
      sessionId: sampleTask.sessionId,
      leaseOwner: "driver-1",
      leaseToken: "tok-1",
      leaseGeneration: 1,
      leaseExpiresAtMs: Date.now() + 60_000,
      bindingGeneration: 0,
      step: "prompt_submitting",
      attemptId: "att-1",
      savedAtMs: Date.now(),
      baselineCount: 1,
    });

    const mockAdapter = {
      name: "chatgpt-web",
      supportedTaskKinds: ["plan", "review"] as const,
      supportedContextStrategies: ["connector", "materialized"] as const,
      inspectBinding: vi.fn(),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      executeTask: vi.fn(), // MUST NOT be called!
      confirmPromptSubmitted: vi.fn().mockResolvedValue(false),
      waitForExistingResponse: vi.fn(),
      setStepListener: vi.fn(),
    };

    let submittedFailure: unknown = null;
    const mockTransport: BridgeTransport = {
      baseUrl: "http://127.0.0.1:4545",
      authToken: "test",
      request: vi.fn(async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        if (method === "POST" && path.includes("/heartbeat")) {
          return { expiresAtMs: Date.now() + 100_000, ttlMs: 120_000 } as unknown as T;
        }
        if (method === "GET" && path === `/v1/tasks/${encodeURIComponent(sampleTask.id)}`) {
          return { task: { ...sampleTask, status: "running" } } as unknown as T;
        }
        if (method === "GET" && path.includes("/sessions/")) {
          return { session: sampleSession } as unknown as T;
        }
        if (method === "POST" && path.includes("/fail")) {
          submittedFailure = body;
          return {
            receipt: {
              schemaVersion: 1,
              taskId: sampleTask.id,
              type: "failure",
              claimGeneration: 1,
              claimOwner: "driver-1",
              claimToken: "tok-1",
              acceptedAtMs: Date.now(),
              payload: {
                schemaVersion: 1,
                taskId: sampleTask.id,
                sessionId: sampleTask.sessionId,
                revision: 1,
                error: "human_required",
                details: null,
                retryable: false,
                createdAtMs: Date.now(),
              },
            },
            failure: {
              schemaVersion: 1,
              taskId: sampleTask.id,
              sessionId: sampleTask.sessionId,
              revision: 1,
              error: "human_required",
              details: null,
              retryable: false,
              createdAtMs: Date.now(),
            },
            superseded: false,
          } as unknown as T;
        }
        return {} as unknown as T;
      }),
    };

    const driver = new DecisionTabDriver({
      transport: mockTransport,
      checkpointStore: cpStore,
      adapter: mockAdapter as unknown as DecisionExecutorAdapter,
      ownerId: "driver-1",
    });

    const outcome = await driver.resumeCheckpointIfAvailable();
    expect(outcome?.status).toBe("failed");
    expect(mockAdapter.executeTask).not.toHaveBeenCalled();
    expect((submittedFailure as { error?: string } | null)?.error).toBe("human_required");
    expect(cpStore.get()).toBeNull();
  });

  it("preserves candidateResult in checkpoint and does not call /fail on network transport error (S3)", async () => {
    const cpStore = new MemoryCheckpointStore();
    const expectedResult: DecisionResult = {
      schemaVersion: 1,
      taskId: sampleTask.id,
      sessionId: sampleTask.sessionId,
      kind: "plan",
      revision: 1,
      verdict: "ready",
      content: { plan: "Plan", acceptanceCriteria: [], risks: [], clarifications: [] },
      createdAtMs: Date.now(),
    };

    cpStore.set({
      schemaVersion: 1,
      tabId: "driver-tab",
      taskId: sampleTask.id,
      sessionId: sampleTask.sessionId,
      leaseOwner: "driver-1",
      leaseToken: "tok-1",
      leaseGeneration: 1,
      leaseExpiresAtMs: Date.now() + 60_000,
      bindingGeneration: 0,
      step: "waiting_response",
      attemptId: "att-1",
      savedAtMs: Date.now(),
      baselineCount: 1,
    });

    const mockAdapter = {
      name: "chatgpt-web",
      supportedTaskKinds: ["plan", "review"] as const,
      supportedContextStrategies: ["connector", "materialized"] as const,
      inspectBinding: vi.fn(),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      executeTask: vi.fn(),
      waitForExistingResponse: vi.fn().mockResolvedValue({ result: expectedResult }),
      setStepListener: vi.fn(),
    };

    const failCallSpy = vi.fn();
    const mockTransport: BridgeTransport = {
      baseUrl: "http://127.0.0.1:4545",
      authToken: "test",
      request: vi.fn(async <T>(method: string, path: string): Promise<T> => {
        if (method === "POST" && path.includes("/heartbeat")) {
          return { expiresAtMs: Date.now() + 100_000, ttlMs: 120_000 } as unknown as T;
        }
        if (method === "GET" && path === `/v1/tasks/${encodeURIComponent(sampleTask.id)}`) {
          return { task: { ...sampleTask, status: "running" } } as unknown as T;
        }
        if (method === "GET" && path.includes("/sessions/")) {
          return { session: sampleSession } as unknown as T;
        }
        if (method === "POST" && path.includes("/result")) {
          throw new Error("Network offline during submitResult");
        }
        if (method === "GET" && path.includes("/receipt")) {
          throw new Error("Network offline during receipt check");
        }
        if (method === "POST" && path.includes("/fail")) {
          failCallSpy();
          return {} as unknown as T;
        }
        return {} as unknown as T;
      }),
    };

    const driver = new DecisionTabDriver({
      transport: mockTransport,
      checkpointStore: cpStore,
      adapter: mockAdapter as unknown as DecisionExecutorAdapter,
      ownerId: "driver-1",
    });

    await expect(driver.resumeCheckpointIfAvailable()).rejects.toThrow("Network offline");
    // Critical: must NOT fail task on bridge, must keep candidateResult in checkpoint!
    expect(failCallSpy).not.toHaveBeenCalled();
    const currentCp = cpStore.get();
    expect(currentCp).not.toBeNull();
    expect(currentCp?.candidateResult).toEqual(expectedResult);
    expect(currentCp?.step).toBe("result_extracted");
  });

  it("verifies receipt type and claim identity, never mistaking failure receipt for completed (S4)", async () => {
    const cpStore = new MemoryCheckpointStore();
    const candidateResult: DecisionResult = {
      schemaVersion: 1,
      taskId: sampleTask.id,
      sessionId: sampleTask.sessionId,
      kind: "plan",
      revision: 1,
      verdict: "ready",
      content: { plan: "Plan", acceptanceCriteria: [], risks: [], clarifications: [] },
      createdAtMs: Date.now(),
    };

    cpStore.set({
      schemaVersion: 1,
      tabId: "driver-tab",
      taskId: sampleTask.id,
      sessionId: sampleTask.sessionId,
      leaseOwner: "driver-1",
      leaseToken: "tok-1",
      leaseGeneration: 1,
      leaseExpiresAtMs: Date.now() + 60_000,
      bindingGeneration: 0,
      step: "result_extracted",
      attemptId: "att-1",
      savedAtMs: Date.now(),
      candidateResult,
    });

    const mockFailurePayload = {
      schemaVersion: 1 as const,
      taskId: sampleTask.id,
      sessionId: sampleTask.sessionId,
      revision: 1,
      error: "execution_failed",
      details: null,
      retryable: false,
      createdAtMs: Date.now(),
    };

    const mockTransport: BridgeTransport = {
      baseUrl: "http://127.0.0.1:4545",
      authToken: "test",
      request: vi.fn(async <T>(method: string, path: string): Promise<T> => {
        if (method === "GET" && path === `/v1/tasks/${encodeURIComponent(sampleTask.id)}`) {
          return { task: { ...sampleTask, status: "failed" } } as unknown as T;
        }
        if (method === "GET" && path.includes("/sessions/")) {
          return { session: sampleSession } as unknown as T;
        }
        if (method === "GET" && path.includes("/receipt")) {
          return {
            receipt: {
              schemaVersion: 1,
              taskId: sampleTask.id,
              type: "failure", // Failure receipt!
              claimGeneration: 1,
              claimOwner: "driver-1",
              claimToken: "tok-1",
              acceptedAtMs: Date.now(),
              payload: mockFailurePayload,
            },
          } as unknown as T;
        }
        return {} as unknown as T;
      }),
    };

    const driver = new DecisionTabDriver({
      transport: mockTransport,
      checkpointStore: cpStore,
      ownerId: "driver-1",
    });

    const outcome = await driver.resumeCheckpointIfAvailable();
    // Must report failed, NEVER completed!
    expect(outcome?.status).toBe("failed");
    expect(outcome && "failure" in outcome ? (outcome.failure as { error?: string })?.error : undefined).toBe("execution_failed");
    expect(cpStore.get()).toBeNull();
  });

  it("never exposes bearer token in page DOM inputs or attributes (R5)", () => {
    const doc = new MockDocument();
    const prevDoc = globalThis.document;
    try {
      globalThis.document = doc as unknown as Document;
      initSymphonyUserscript({
        authToken: "super-secret-token",
        bridgeBaseUrl: "http://127.0.0.1:4040",
      });

      // Assert that no input element contains the token
      expect(doc.querySelector("#symphony-token-input")).toBeNull();
      const allElements = doc.querySelectorAll("*");
      for (const el of allElements) {
        expect(el.value).not.toBe("super-secret-token");
        expect(el.textContent).not.toContain("super-secret-token");
        expect(el.getAttribute("value")).not.toBe("super-secret-token");
      }
    } finally {
      globalThis.document = prevDoc;
    }
  });
});
