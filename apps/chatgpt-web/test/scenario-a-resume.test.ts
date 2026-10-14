import { describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DurableDecisionStore, DecisionService, DecisionBridge } from "@symphony/decision";
import {
  type DecisionSession,
  type DecisionTask,
  type DecisionContextBundle,
  type BridgeTransport,
  githubDecisionRoot,
} from "@symphony/domain/decision";
import { ChatGptWebAdapter } from "../src/adapter";
import { detectConversationNotFound } from "../src/probes";
import { DecisionTabDriver } from "../src/driver";
import { MemoryCheckpointStore } from "../src/checkpoint";
import { FetchBridgeTransport } from "../src/transport";
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

    const navStartedAt = Date.now() - 5000;
    const navDeadline = Date.now() + 55000;
    const renewedLeaseExpiry = Date.now() + 120_000;

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
      navigationStartedAtMs: navStartedAt,
      navigationDeadlineMs: navDeadline,
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
    let observedCheckpointDuringExecution: unknown = null;

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
          return { expiresAtMs: renewedLeaseExpiry, ttlMs: 120_000 } as unknown as T;
        }
        if (method === "GET" && path.includes("/context")) {
          // Execution boundary reached: snapshot checkpoint state before rebind/supersession
          observedCheckpointDuringExecution = cpStore.get();
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

    // 1. Verify checkpoint state preserved at execution boundary (not wiped/reverted)
    expect(observedCheckpointDuringExecution).toMatchObject({
      step: "navigating",
      navigationAttempts: 2,
      navigationStartedAtMs: navStartedAt,
      navigationDeadlineMs: navDeadline,
      leaseExpiresAtMs: renewedLeaseExpiry,
      targetUri,
      targetConvId,
    });

    // 2. Must NOT submit execution_failed / retryable: true at generation 1!
    // Must trigger session rebind rollover (superseded outcome)!
    expect(rebindCalled).toBe(true);
    expect(outcome?.status).toBe("superseded");

    // 3. Checkpoint store cleaned up upon successful rollover
    expect(cpStore.get()).toBeNull();
  });

  it("updateCheckpointStep preserves navigation attempts, deadline, and target across step transitions", () => {
    const cpStore = new MemoryCheckpointStore();
    const navStartedAt = Date.now() - 3000;
    const navDeadline = Date.now() + 57000;

    cpStore.set({
      schemaVersion: 1,
      tabId: "tab-test",
      taskId: sampleTask.id,
      sessionId: sampleSession.id,
      leaseOwner: "driver-1",
      leaseToken: "tok-1",
      leaseGeneration: 1,
      leaseExpiresAtMs: Date.now() + 60_000,
      bindingGeneration: 1,
      step: "navigating",
      attemptId: "att-1",
      savedAtMs: Date.now(),
      targetUri: "https://chatgpt.com/c/dead-conv-id",
      targetConvId: "dead-conv-id",
      navigationAttempts: 2,
      navigationStartedAtMs: navStartedAt,
      navigationDeadlineMs: navDeadline,
    });

    const driver = new DecisionTabDriver({
      adapter: new ChatGptWebAdapter({ doc: new MockDocument() as unknown as Document, win: new MockWindow() as unknown as Window }),
      checkpointStore: cpStore,
      transport: { baseUrl: "", authToken: "", request: vi.fn() },
    });

    // Update with same target preserves attempts and deadline
    driver.updateCheckpointStep("navigating", {
      targetUri: "https://chatgpt.com/c/dead-conv-id",
      targetConvId: "dead-conv-id",
    });

    const cp = cpStore.get();
    expect(cp?.navigationAttempts).toBe(2);
    expect(cp?.navigationStartedAtMs).toBe(navStartedAt);
    expect(cp?.navigationDeadlineMs).toBe(navDeadline);
  });

  it("preserves the authoritative heartbeat expiry when a navigating checkpoint reaches its target", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pr126-checkpoint-"));
    const store = new DurableDecisionStore({ storeDir: dir });
    await store.open();
    const service = new DecisionService(store);
    const bridge = new DecisionBridge(service, { port: 0 });
    await bridge.start();
    try {
      const root = githubDecisionRoot("owner", "repo", 126);
      let session = await service.createSession(root);
      session = await service.putBinding(session.id, {
        adapter: "chatgpt-web",
        externalSessionRef: "target",
        resumeUri: "https://chatgpt.com/c/target",
      });
      const task = await service.createPlanTask(session.id);
      await service.putTaskContext(task.id, {
        strategy: "connector",
        workItem: root,
        repository: "owner/repo",
        prNumber: null,
        headSha: null,
      });
      const claim = await service.claimTask(task.id, { owner: "tab", ttlMs: 60_000 });
      const cp = new MemoryCheckpointStore();
      cp.set({
        schemaVersion: 1,
        tabId: cp.tabId,
        taskId: task.id,
        sessionId: session.id,
        leaseOwner: claim.lease.owner,
        leaseToken: claim.lease.token,
        leaseGeneration: claim.lease.generation,
        leaseExpiresAtMs: claim.lease.expiresAtMs,
        bindingGeneration: 1,
        step: "navigating",
        attemptId: "attempt",
        savedAtMs: Date.now(),
        targetUri: "https://chatgpt.com/c/target",
        targetConvId: "target",
        navigationAttempts: 2,
        navigationStartedAtMs: Date.now() - 1000,
        navigationDeadlineMs: Date.now() + 60_000,
      });
      const win = new MockWindow();
      win.location.href = "https://chatgpt.com/c/target";
      const adapter = new ChatGptWebAdapter({
        win: win as unknown as Window,
        doc: new MockDocument() as unknown as Document,
      });
      const driver = new DecisionTabDriver({
        adapter,
        checkpointStore: cp,
        transport: new FetchBridgeTransport({ baseUrl: `http://127.0.0.1:${bridge.getPort()}` }),
      });
      // Inspect the persisted checkpoint at the execution boundary; emulate interruption
      // without adding adapter/coordinator writes that could hide the regression.
      vi.spyOn(driver, "executeClaimedTask").mockRejectedValue(new Error("page interrupted"));
      await expect(driver.resumeCheckpointIfAvailable()).rejects.toThrow("page interrupted");
      const authoritativeExpiry = service.getTask(task.id)?.lease?.expiresAtMs;
      expect(authoritativeExpiry).toBeGreaterThan(claim.lease.expiresAtMs);
      expect(cp.get()?.leaseExpiresAtMs).toBe(authoritativeExpiry);
    } finally {
      await bridge.stop();
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("detectConversationNotFound recognizes authentic access-denied UI (e.g. '你无权访问此对话' / 'Access denied') even when shell composer is present", () => {
    const doc = new MockDocument();
    // Simulate lingering/background shell composer
    const composer = new MockElement("textarea", { id: "prompt-textarea" });
    doc.body.appendChild(composer);

    // 1. Chinese access denied modal/dialog/alert
    const dialog = new MockElement("div", { role: "dialog" });
    const heading = new MockElement("h2");
    heading.textContent = "你无权访问此对话";
    dialog.appendChild(heading);
    doc.body.appendChild(dialog);

    expect(detectConversationNotFound(doc as unknown as Document)).toBe(true);

    // 2. English access denied toast/alert
    doc.body.removeChild(dialog);
    const toast = new MockElement("div", { class: "toast-container text-token-text-error" });
    toast.textContent = "You do not have access to this conversation";
    doc.body.appendChild(toast);

    expect(detectConversationNotFound(doc as unknown as Document)).toBe(true);

    // 3. Clean page with composer only returns false
    doc.body.removeChild(toast);
    expect(detectConversationNotFound(doc as unknown as Document)).toBe(false);
  });

  it("resumeSession rejects with binding_broken rebind when ChatGPT shows '你无权访问此对话' alongside shell composer", async () => {
    const doc = new MockDocument();
    const win = new MockWindow();
    win.location.href = "https://chatgpt.com/c/dead-conv-id";

    const composer = new MockElement("textarea", { id: "prompt-textarea" });
    doc.body.appendChild(composer);

    const alert = new MockElement("div", { role: "alert" });
    alert.textContent = "你无权访问此对话";
    doc.body.appendChild(alert);

    const adapter = new ChatGptWebAdapter({
      doc: doc as unknown as Document,
      win: win as unknown as Window,
      checkIntervalMs: 5,
      stabilizationMs: 20,
      timeoutMs: 100,
    });

    const binding = sampleSession.binding!;
    await expect(adapter.resumeSession(sampleSession, binding)).rejects.toMatchObject({
      code: "binding_broken",
      suggestedAction: "rebind",
      observedGeneration: 1,
    });
  });

  it("resumeSession rejects with binding_broken rebind when route redirects to root during stabilization window after composer is found", async () => {
    const doc = new MockDocument();
    const win = new MockWindow();
    win.location.href = "https://chatgpt.com/c/dead-conv-id";

    const composer = new MockElement("textarea", { id: "prompt-textarea" });
    doc.body.appendChild(composer);

    const adapter = new ChatGptWebAdapter({
      doc: doc as unknown as Document,
      win: win as unknown as Window,
      checkIntervalMs: 5,
      stabilizationMs: 50,
      timeoutMs: 200,
    });

    // Simulate SPA redirecting to root 10ms after resumeSession starts checking stabilization
    setTimeout(() => {
      win.location.href = "https://chatgpt.com/";
    }, 10);

    const binding = sampleSession.binding!;
    await expect(adapter.resumeSession(sampleSession, binding)).rejects.toMatchObject({
      code: "binding_broken",
      suggestedAction: "rebind",
      observedGeneration: 1,
    });
  });

  it("executeTask rejects with binding_broken rebind before execution if window location has departed from target conversation to root", async () => {
    const doc = new MockDocument();
    const win = new MockWindow();
    win.location.href = "https://chatgpt.com/"; // Already redirected away to root

    const composer = new MockElement("textarea", { id: "prompt-textarea" });
    doc.body.appendChild(composer);

    const adapter = new ChatGptWebAdapter({
      doc: doc as unknown as Document,
      win: win as unknown as Window,
      checkIntervalMs: 5,
      timeoutMs: 100,
    });

    await expect(
      adapter.executeTask({
        task: sampleTask,
        session: sampleSession,
        context: sampleContext,
      })
    ).rejects.toMatchObject({
      code: "binding_broken",
      suggestedAction: "rebind",
      observedGeneration: 1,
    });
  });

  it("executeTask rejects with binding_broken rebind before execution if detectConversationNotFound is true", async () => {
    const doc = new MockDocument();
    const win = new MockWindow();
    win.location.href = "https://chatgpt.com/c/dead-conv-id";

    const composer = new MockElement("textarea", { id: "prompt-textarea" });
    doc.body.appendChild(composer);

    const modal = new MockElement("div", { role: "dialog" });
    modal.textContent = "你无权访问此对话";
    doc.body.appendChild(modal);

    const adapter = new ChatGptWebAdapter({
      doc: doc as unknown as Document,
      win: win as unknown as Window,
      checkIntervalMs: 5,
      timeoutMs: 100,
    });

    await expect(
      adapter.executeTask({
        task: sampleTask,
        session: sampleSession,
        context: sampleContext,
      })
    ).rejects.toMatchObject({
      code: "binding_broken",
      suggestedAction: "rebind",
      observedGeneration: 1,
    });
  });

  it("waitForSendButton immediately rejects with binding_broken rebind if route departs or access denied appears during wait, rather than timing out at 180s", async () => {
    const doc = new MockDocument();
    const win = new MockWindow();
    win.location.href = "https://chatgpt.com/c/dead-conv-id";

    const composer = new MockElement("textarea", { id: "prompt-textarea" });
    doc.body.appendChild(composer);

    const sendBtn = new MockElement("button", { "data-testid": "send-button" });
    sendBtn.disabled = true; // Disabled button
    doc.body.appendChild(sendBtn);

    const adapter = new ChatGptWebAdapter({
      doc: doc as unknown as Document,
      win: win as unknown as Window,
      checkIntervalMs: 5,
      timeoutMs: 10_000, // 10 seconds timeout
    });

    // 15ms into execution, tab navigates away to root
    setTimeout(() => {
      win.location.href = "https://chatgpt.com/";
    }, 15);

    const start = Date.now();
    await expect(
      adapter.executeTask({
        task: sampleTask,
        session: sampleSession,
        context: sampleContext,
      })
    ).rejects.toMatchObject({
      code: "binding_broken",
      suggestedAction: "rebind",
      observedGeneration: 1,
    });

    // Must fail fast within ~100ms, not after the 10s timeout
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("detectConversationNotFound does not falsely trigger on chat article text inside open wrappers or modal containers", () => {
    const doc = new MockDocument();
    const openWrapper = new MockElement("div", { "data-state": "open" });
    const article = new MockElement("article");
    article.textContent = "The user asked about: You do not have access to this conversation";
    openWrapper.appendChild(article);

    const composer = new MockElement("textarea", { id: "prompt-textarea" });
    openWrapper.appendChild(composer);
    doc.body.appendChild(openWrapper);

    // Healthy conversation where message quotes not-found text inside an open wrapper
    expect(detectConversationNotFound(doc as unknown as Document)).toBe(false);

    // Also with role='dialog' or modal wrapping an article
    const modalWrapper = new MockElement("div", { role: "dialog" });
    const article2 = new MockElement("article");
    article2.textContent = "无法访问此对话：详情请看设置";
    modalWrapper.appendChild(article2);
    modalWrapper.appendChild(composer);
    doc.body.appendChild(modalWrapper);
    expect(detectConversationNotFound(doc as unknown as Document)).toBe(false);
  });

  it("executeTask prioritizes authentication error over route departure when redirected to root with login button", async () => {
    const doc = new MockDocument();
    const win = new MockWindow();
    win.location.href = "https://chatgpt.com/"; // Redirected to root

    // Login button present
    const loginBtn = new MockElement("button", { "data-testid": "login-button" });
    loginBtn.textContent = "Log in";
    doc.body.appendChild(loginBtn);

    const adapter = new ChatGptWebAdapter({
      doc: doc as unknown as Document,
      win: win as unknown as Window,
      checkIntervalMs: 5,
      timeoutMs: 100,
    });

    await expect(
      adapter.executeTask({
        task: sampleTask,
        session: sampleSession,
        context: sampleContext,
      })
    ).rejects.toMatchObject({
      code: "human_required",
      suggestedAction: "human_intervention",
    });
  });

  it("triggers automated rebind rollover and fences lease when route departs to root during executeTask before prompt submit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pr127-pre-submit-rebind-"));
    const store = new DurableDecisionStore({ storeDir: dir });
    await store.open();
    const service = new DecisionService(store);
    const bridge = new DecisionBridge(service, { port: 0 });
    await bridge.start();

    try {
      const root = githubDecisionRoot("owner", "repo", 127);
      let session = await service.createSession(root);
      session = await service.putBinding(session.id, {
        adapter: "chatgpt-web",
        externalSessionRef: "target-conv-1",
        resumeUri: "https://chatgpt.com/c/target-conv-1",
      });
      const task = await service.createPlanTask(session.id);
      await service.putTaskContext(task.id, {
        strategy: "connector",
        workItem: root,
        repository: "owner/repo",
        prNumber: null,
        headSha: null,
      });

      const doc = new MockDocument();
      const win = new MockWindow();
      win.location.href = "https://chatgpt.com/c/target-conv-1";

      const composer = new MockElement("textarea", { id: "prompt-textarea" });
      doc.body.appendChild(composer);

      const sendBtn = new MockElement("button", { "data-testid": "send-button" });
      sendBtn.disabled = true;
      doc.body.appendChild(sendBtn);

      const adapter = new ChatGptWebAdapter({
        doc: doc as unknown as Document,
        win: win as unknown as Window,
        checkIntervalMs: 5,
        timeoutMs: 5000,
      });

      // Mock createSession to simulate creating generation 2 conversation during rollover
      vi.spyOn(adapter, "createSession").mockResolvedValue({
        binding: {
          schemaVersion: 1,
          adapter: "chatgpt-web",
          externalSessionRef: "new-target-conv-2",
          resumeUri: "https://chatgpt.com/c/new-target-conv-2",
          generation: 2,
        },
        handle: { conversationId: "new-target-conv-2", bootstrapped: true, isRollover: true },
      });

      const cpStore = new MemoryCheckpointStore();
      const driver = new DecisionTabDriver({
        adapter,
        checkpointStore: cpStore,
        transport: new FetchBridgeTransport({ baseUrl: `http://127.0.0.1:${bridge.getPort()}` }),
        ownerId: "driver-test-1",
      });

      // Claim task and start execution
      const claim = await service.claimTask(task.id, { owner: "driver-test-1", ttlMs: 60_000 });

      const context: DecisionContextBundle = {
        strategy: "connector",
        workItem: root,
        repository: "owner/repo",
        prNumber: null,
        headSha: null,
      };

      // While executeTask is waiting for send button, page navigates away to root
      setTimeout(() => {
        win.location.href = "https://chatgpt.com/";
      }, 20);

      const outcome = await driver.executeClaimedTask(task, session, claim.lease, context);

      // Outcome MUST be superseded with generation 2 (not failed!)
      expect(outcome.status).toBe("superseded");
      expect(outcome.session.bindingGeneration).toBe(2);
      expect(outcome.session.binding?.externalSessionRef).toBe("new-target-conv-2");

      // Verify authoritative state on Bridge/Service
      const authoritativeSession = service.getSession(session.id);
      expect(authoritativeSession?.bindingGeneration).toBe(2);
      expect(authoritativeSession?.binding?.externalSessionRef).toBe("new-target-conv-2");

      // Verify task status is reset to pending upon rebind, and old lease is invalidated
      const authoritativeTask = service.getTask(task.id);
      expect(authoritativeTask?.status).toBe("pending");

      // Checkpoint store is cleaned up
      expect(cpStore.get()).toBeNull();
    } finally {
      await bridge.stop();
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
