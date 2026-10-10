import { describe, it, expect, vi } from "vitest";
import { DecisionTabDriver } from "../src/driver";
import { MemoryCheckpointStore } from "../src/checkpoint";
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
});
