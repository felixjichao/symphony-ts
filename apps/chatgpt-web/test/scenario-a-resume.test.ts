import { describe, it, expect, vi } from "vitest";
import { ChatGptWebAdapter } from "../src/adapter";
import { DecisionTabDriver } from "../src/driver";
import { MemoryCheckpointStore } from "../src/checkpoint";
import {
  type DecisionSession,
  type DecisionTask,
  type DecisionContextBundle,
  type BridgeTransport,
} from "@symphony/domain/decision";
import { MockDocument, MockElement, MockWindow } from "./mock-dom";

const sampleTask: DecisionTask = {
  schemaVersion: 1,
  id: "github%3Aowner%2Frepo%23120:plan:1",
  sessionId: "github:owner/repo#120",
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
  id: "github:owner/repo#120",
  root: { provider: "github", key: "owner/repo#120" },
  status: "active",
  binding: {
    schemaVersion: 1,
    adapter: "chatgpt-web",
    externalSessionRef: "dead-conv-id",
    resumeUri: "https://chatgpt.com/c/dead-conv-id",
    generation: 1,
  },
  bindingGeneration: 1,
  createdAtMs: Date.now(),
  updatedAtMs: Date.now(),
};

const sampleContext: DecisionContextBundle = {
  strategy: "connector",
  workItem: { provider: "github", key: "owner/repo#120" },
  repository: "owner/repo",
  prNumber: null,
  headSha: null,
};

describe("Dogfood Scenario A: resume recovery with redirect to root", () => {
  it("resumeSession rejects with binding_broken rebind when ChatGPT redirects away from target to root", async () => {
    const doc = new MockDocument();
    const win = new MockWindow();
    win.location.href = "https://chatgpt.com/c/dead-conv-id";

    // Simulate composer only present on root page after redirect
    const composer = new MockElement("textarea", { id: "prompt-textarea" });

    const adapter = new ChatGptWebAdapter({
      doc: doc as unknown as Document,
      win: win as unknown as Window,
      checkIntervalMs: 5,
      timeoutMs: 100,
    });

    // Simulate SPA redirecting to root "/" after brief moment
    setTimeout(() => {
      win.location.href = "https://chatgpt.com/";
      doc.body.appendChild(composer);
    }, 10);

    const binding = sampleSession.binding!;
    await expect(adapter.resumeSession(sampleSession, binding)).rejects.toMatchObject({
      code: "binding_broken",
      suggestedAction: "rebind",
      observedGeneration: 1,
    });
  });

  it("resumeSession rejects with binding_broken rebind when route wait times out", async () => {
    const doc = new MockDocument();
    const win = new MockWindow();
    // Mock assign to simulate browser failing to navigate to target conversation route
    win.location.assign = vi.fn();

    const adapter = new ChatGptWebAdapter({
      doc: doc as unknown as Document,
      win: win as unknown as Window,
      checkIntervalMs: 5,
      timeoutMs: 50,
    });

    const binding = sampleSession.binding!;
    await expect(adapter.resumeSession(sampleSession, binding)).rejects.toMatchObject({
      code: "binding_broken",
      suggestedAction: "rebind",
      observedGeneration: 1,
    });
  });

  it("Driver preserves navigating checkpoint budget and triggers rebind rollover upon redirect to root", async () => {
    const targetConvId = "dead-conv-id";
    const targetUri = `https://chatgpt.com/c/${targetConvId}`;
    const cpStore = new MemoryCheckpointStore();

    cpStore.set({
      schemaVersion: 1,
      tabId: "tab-scenario-a",
      taskId: sampleTask.id,
      sessionId: sampleTask.sessionId,
      leaseOwner: "driver-1",
      leaseToken: "tok-1",
      leaseGeneration: 1,
      leaseExpiresAtMs: Date.now() + 60_000,
      bindingGeneration: 1,
      step: "navigating",
      attemptId: "att-1",
      savedAtMs: Date.now(),
      targetUri,
      targetConvId,
      navigationAttempts: 2,
      navigationStartedAtMs: Date.now() - 5000,
      navigationDeadlineMs: Date.now() + 55000,
    });

    const mockWin = new MockWindow();
    mockWin.location.href = targetUri; // Hit target initially

    const mockDoc = new MockDocument();
    const composer = mockDoc.createElement("div");
    composer.setAttribute("id", "prompt-textarea");

    // Simulate SPA redirect to root "/" and root page composer mounting
    setTimeout(() => {
      mockWin.location.href = "https://chatgpt.com/";
      mockDoc.body.appendChild(composer);
    }, 10);

    let rebindCalled = false;
    let reboundGeneration = 0;

    const mockTransport: BridgeTransport = {
      baseUrl: "http://127.0.0.1:4545",
      authToken: "test",
      request: vi.fn(async <T>(method: string, path: string, _body?: unknown): Promise<T> => {
        if (method === "GET" && path === `/v1/tasks/${encodeURIComponent(sampleTask.id)}`) {
          return {
            task: {
              ...sampleTask,
              status: "running",
              lease: {
                owner: "driver-1",
                token: "tok-1",
                generation: 1,
                expiresAtMs: Date.now() + 60_000,
              },
            },
          } as unknown as T;
        }
        if (method === "GET" && path.includes("/sessions/")) {
          return {
            session: {
              ...sampleSession,
              bindingGeneration: reboundGeneration || 1,
            },
          } as unknown as T;
        }
        if (method === "POST" && path.includes("/heartbeat")) {
          return { expiresAtMs: Date.now() + 60_000, ttlMs: 120_000 } as unknown as T;
        }
        if (method === "GET" && path.includes("/context")) {
          return { context: sampleContext } as unknown as T;
        }
        if (method === "POST" && path.includes("/break-binding")) {
          return {} as unknown as T;
        }
        if (method === "POST" && path.includes("/rebind")) {
          rebindCalled = true;
          reboundGeneration = 2;
          return {
            session: {
              ...sampleSession,
              binding: {
                schemaVersion: 1,
                adapter: "chatgpt-web",
                externalSessionRef: "new-conv-id",
                resumeUri: "https://chatgpt.com/c/new-conv-id",
                generation: 2,
              },
              bindingGeneration: 2,
            },
          } as unknown as T;
        }
        if (method === "POST" && path.includes("/fail")) {
          return {
            failure: { code: "execution_failed", retryable: true },
            receipt: {},
            superseded: false,
          } as unknown as T;
        }
        return {} as unknown as T;
      }),
    };

    const adapter = new ChatGptWebAdapter({
      win: mockWin as unknown as Window,
      doc: mockDoc as unknown as Document,
      timeoutMs: 200,
      checkIntervalMs: 5,
    });

    // Mock createSession on adapter for rebind rollover
    vi.spyOn(adapter, "createSession").mockResolvedValue({
      binding: {
        schemaVersion: 1,
        adapter: "chatgpt-web",
        externalSessionRef: "new-conv-id",
        resumeUri: "https://chatgpt.com/c/new-conv-id",
        generation: 2,
      },
      handle: { conversationId: "new-conv-id", bootstrapped: true },
    });

    const driver = new DecisionTabDriver({
      transport: mockTransport,
      checkpointStore: cpStore,
      adapter,
      ownerId: "driver-1",
      maxNavigationAttempts: 3,
    });

    const outcome = await driver.resumeCheckpointIfAvailable();

    // Must NOT submit execution_failed / retryable: true at generation 1!
    // Must trigger session rebind rollover (superseded outcome)!
    expect(rebindCalled).toBe(true);
    expect(outcome?.status).toBe("superseded");
  });
});
