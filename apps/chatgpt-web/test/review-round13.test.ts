import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DurableDecisionStore, DecisionService, DecisionBridge } from "@symphony/decision";
import { githubDecisionRoot } from "@symphony/domain/decision";
import { DecisionTabDriver } from "../src/driver";
import { MemoryCheckpointStore } from "../src/checkpoint";
import { FetchBridgeTransport } from "../src/transport";
import { ChatGptWebAdapter } from "../src/adapter";
import { MockDocument, MockElement, MockWindow } from "./mock-dom";

describe("review round 13: navigating checkpoint convergence and temporary route isolation", () => {
  it("isolates temporary client routes during bootstrap and records formal conversation reference", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-round13-temp-route-"));
    const store = new DurableDecisionStore({ storeDir: dir });
    await store.open();
    const service = new DecisionService(store);
    const bridge = new DecisionBridge(service, { port: 0 });
    await bridge.start();

    try {
      const root = githubDecisionRoot("owner", "repo", 13);
      const session = await service.createSession(root);
      const task = await service.createPlanTask(session.id);
      await service.putTaskContext(task.id, {
        strategy: "connector",
        workItem: root,
        repository: "owner/repo",
        prNumber: null,
        headSha: null,
      });
      const claim = await service.claimTask(task.id, { owner: "browser-tab" });

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
        step: "claimed",
        attemptId: "a",
        savedAtMs: Date.now(),
      });

      const transport = new FetchBridgeTransport({
        baseUrl: `http://127.0.0.1:${bridge.getPort()}`,
      });

      const doc = new MockDocument();
      const win = new MockWindow();
      win.location.href = "https://chatgpt.com/";
      const composer = new MockElement("textarea", { id: "prompt-textarea" });
      const send = new MockElement("button", { "data-testid": "send-button" });
      doc.body.appendChild(composer);
      doc.body.appendChild(send);

      let recordedDuringLocalRoute: string | null | undefined;
      let recordedAfterFormalRoute: string | null | undefined;

      send.addEventListener("click", () => {
        // Step 1: ChatGPT client route transitions immediately to temporary /c/local-chatgpt
        win.location.href = "https://chatgpt.com/c/local-chatgpt";
        setTimeout(() => {
          recordedDuringLocalRoute = cp.get()?.targetConvId;

          // Step 2: Backend assigns formal UUID route and streams response
          win.location.href = "https://chatgpt.com/c/formal-conversation-uuid-99";
          setTimeout(() => {
            recordedAfterFormalRoute = cp.get()?.targetConvId;
            const msg = new MockElement("div", { "data-message-author-role": "assistant" });
            msg.textContent = "Ready for Symphony tasks";
            doc.body.appendChild(msg);
          }, 20);
        }, 10);
      });

      const adapter = new ChatGptWebAdapter({
        doc: doc as unknown as Document,
        win: win as unknown as Window,
        stabilizationMs: 5,
        checkIntervalMs: 5,
        timeoutMs: 1000,
      });

      // Install listener on checkpoint store
      new DecisionTabDriver({ transport, checkpointStore: cp, adapter });

      const created = await adapter.createSession(session);

      // Verify that local-chatgpt was ignored, and formal UUID was captured
      expect(recordedDuringLocalRoute).toBeNull();
      expect(recordedAfterFormalRoute).toBe("formal-conversation-uuid-99");
      expect(created.binding.externalSessionRef).toBe("formal-conversation-uuid-99");
      expect(created.binding.resumeUri).toBe("https://chatgpt.com/c/formal-conversation-uuid-99");
    } finally {
      await bridge.stop();
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("converges navigating checkpoint failure across reloads and executes unrecoverable session rebind", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-round13-nav-convergence-"));
    const store = new DurableDecisionStore({ storeDir: dir });
    await store.open();
    const service = new DecisionService(store);
    const bridge = new DecisionBridge(service, { port: 0 });
    await bridge.start();

    try {
      const root = githubDecisionRoot("owner", "repo", 14);
      let session = await service.createSession(root);
      session = await service.putBinding(session.id, {
        adapter: "chatgpt-web",
        externalSessionRef: "target-conv-dead",
        resumeUri: "https://chatgpt.com/c/target-conv-dead",
      });
      const task = await service.createPlanTask(session.id);
      await service.putTaskContext(task.id, {
        strategy: "connector",
        workItem: root,
        repository: "owner/repo",
        prNumber: null,
        headSha: null,
      });
      const claim = await service.claimTask(task.id, { owner: "browser-tab" });

      const cp = new MemoryCheckpointStore();
      const transport = new FetchBridgeTransport({
        baseUrl: `http://127.0.0.1:${bridge.getPort()}`,
      });

      // Initialize checkpoint at navigating step, but browser was redirected/landed at root https://chatgpt.com/
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
        targetUri: "https://chatgpt.com/c/target-conv-dead",
        targetConvId: "target-conv-dead",
        navigationStartedAtMs: Date.now() - 1000,
        navigationDeadlineMs: Date.now() + 60000,
        navigationAttempts: 1,
        attemptId: "a",
        savedAtMs: Date.now(),
      });

      // Simulation: Reload 1 lands back on root / (e.g. redirect back from SPA)
      const doc1 = new MockDocument();
      const win1 = new MockWindow();
      win1.location.href = "https://chatgpt.com/";
      let assignedUrl1 = "";
      win1.location.assign = (url: string) => {
        assignedUrl1 = url;
        // ChatGPT redirects back to homepage / when conversation is dead
        win1.location.href = "https://chatgpt.com/";
      };
      const adapter1 = new ChatGptWebAdapter({
        doc: doc1 as unknown as Document,
        win: win1 as unknown as Window,
        stabilizationMs: 5,
        checkIntervalMs: 5,
        timeoutMs: 1000,
      });
      const driver1 = new DecisionTabDriver({
        transport,
        checkpointStore: cp,
        adapter: adapter1,
        maxNavigationAttempts: 3,
      });

      const res1 = await driver1.runOnce();
      expect(res1).toBeNull();
      // Navigation attempts must have incremented to 2, and location.assign must be called
      expect(cp.get()?.navigationAttempts).toBe(2);
      expect(assignedUrl1).toBe("https://chatgpt.com/c/target-conv-dead");

      // Simulation: Reload 2 lands back on root /
      const doc2 = new MockDocument();
      const win2 = new MockWindow();
      win2.location.href = "https://chatgpt.com/";
      let assignedUrl2 = "";
      win2.location.assign = (url: string) => {
        assignedUrl2 = url;
        win2.location.href = "https://chatgpt.com/";
      };
      const adapter2 = new ChatGptWebAdapter({
        doc: doc2 as unknown as Document,
        win: win2 as unknown as Window,
        stabilizationMs: 5,
        checkIntervalMs: 5,
        timeoutMs: 1000,
      });
      const driver2 = new DecisionTabDriver({
        transport,
        checkpointStore: cp,
        adapter: adapter2,
        maxNavigationAttempts: 3,
      });

      const res2 = await driver2.runOnce();
      expect(res2).toBeNull();
      expect(cp.get()?.navigationAttempts).toBe(3);
      expect(assignedUrl2).toBe("https://chatgpt.com/c/target-conv-dead");

      // Simulation: Reload 3 lands back on root /
      // Attempts is now 3 (>= maxNavigationAttempts 3), budget is exhausted!
      // Driver executes rebindUnrecoverableSession:
      // it creates a new session, rebinds on bridge, clears checkpoint, and returns { status: "superseded" }
      const doc3 = new MockDocument();
      const win3 = new MockWindow();
      win3.location.href = "https://chatgpt.com/";
      const composer3 = new MockElement("textarea", { id: "prompt-textarea" });
      const send3 = new MockElement("button", { "data-testid": "send-button" });
      doc3.body.appendChild(composer3);
      doc3.body.appendChild(send3);
      send3.addEventListener("click", () => {
        win3.location.href = "https://chatgpt.com/c/rebound-new-conv";
        setTimeout(() => {
          const msg = new MockElement("div", { "data-message-author-role": "assistant" });
          msg.textContent = "Ready for Symphony tasks";
          doc3.body.appendChild(msg);
        }, 10);
      });

      const adapter3 = new ChatGptWebAdapter({
        doc: doc3 as unknown as Document,
        win: win3 as unknown as Window,
        stabilizationMs: 5,
        checkIntervalMs: 5,
        timeoutMs: 1000,
      });
      const driver3 = new DecisionTabDriver({
        transport,
        checkpointStore: cp,
        adapter: adapter3,
        maxNavigationAttempts: 3,
      });

      const res3 = await driver3.runOnce();
      expect(res3).not.toBeNull();
      expect(res3?.status).toBe("superseded");
      expect(cp.get()).toBeNull();

      // Check session on bridge: bindingGeneration must have bumped from 1 to 2
      const updatedSession = service.getSession(session.id);
      expect(updatedSession?.bindingGeneration).toBe(2);
      expect(updatedSession?.binding?.externalSessionRef).toBe("rebound-new-conv");
      expect(updatedSession?.binding?.resumeUri).toBe("https://chatgpt.com/c/rebound-new-conv");
    } finally {
      await bridge.stop();
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("immediately converges on 404 conversation not found without waiting for attempt limit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-round13-notfound-"));
    const store = new DurableDecisionStore({ storeDir: dir });
    await store.open();
    const service = new DecisionService(store);
    const bridge = new DecisionBridge(service, { port: 0 });
    await bridge.start();

    try {
      const root = githubDecisionRoot("owner", "repo", 15);
      let session = await service.createSession(root);
      session = await service.putBinding(session.id, {
        adapter: "chatgpt-web",
        externalSessionRef: "target-conv-404",
        resumeUri: "https://chatgpt.com/c/target-conv-404",
      });
      const task = await service.createPlanTask(session.id);
      await service.putTaskContext(task.id, {
        strategy: "connector",
        workItem: root,
        repository: "owner/repo",
        prNumber: null,
        headSha: null,
      });
      const claim = await service.claimTask(task.id, { owner: "browser-tab" });

      const cp = new MemoryCheckpointStore();
      const transport = new FetchBridgeTransport({
        baseUrl: `http://127.0.0.1:${bridge.getPort()}`,
      });

      // Browser reached target URI, but page renders "Conversation not found"
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
        targetUri: "https://chatgpt.com/c/target-conv-404",
        targetConvId: "target-conv-404",
        navigationStartedAtMs: Date.now(),
        navigationDeadlineMs: Date.now() + 60000,
        navigationAttempts: 1,
        attemptId: "a",
        savedAtMs: Date.now(),
      });

      const doc = new MockDocument();
      const win = new MockWindow();
      win.location.href = "https://chatgpt.com/c/target-conv-404";
      const notFoundEl = new MockElement("div", { "data-testid": "conversation-not-found" });
      doc.body.appendChild(notFoundEl);

      // Rebind requires fresh session creation, so add composer & send button for fresh session
      const composer = new MockElement("textarea", { id: "prompt-textarea" });
      const send = new MockElement("button", { "data-testid": "send-button" });
      doc.body.appendChild(composer);
      doc.body.appendChild(send);
      send.addEventListener("click", () => {
        // Remove 404 element on new conversation
        doc.body.removeChild(notFoundEl);
        win.location.href = "https://chatgpt.com/c/rebound-after-404";
        setTimeout(() => {
          const msg = new MockElement("div", { "data-message-author-role": "assistant" });
          msg.textContent = "Ready for Symphony tasks";
          doc.body.appendChild(msg);
        }, 10);
      });

      const adapter = new ChatGptWebAdapter({
        doc: doc as unknown as Document,
        win: win as unknown as Window,
        stabilizationMs: 5,
        checkIntervalMs: 5,
        timeoutMs: 1000,
      });

      const driver = new DecisionTabDriver({
        transport,
        checkpointStore: cp,
        adapter,
        maxNavigationAttempts: 3,
      });

      const res = await driver.runOnce();
      expect(res).not.toBeNull();
      expect(res?.status).toBe("superseded");
      expect(cp.get()).toBeNull();

      const updatedSession = service.getSession(session.id);
      expect(updatedSession?.bindingGeneration).toBe(2);
      expect(updatedSession?.binding?.externalSessionRef).toBe("rebound-after-404");
    } finally {
      await bridge.stop();
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
