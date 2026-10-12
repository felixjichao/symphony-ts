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
import { BOOTSTRAP_PROMPT } from "../src/prompts";
import { MockDocument, MockElement, MockWindow } from "./mock-dom";

describe("approved bootstrap navigation recovery", () => {
  it("does not blindly create another conversation after bootstrap was sent before rebind", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-bootstrap-"));
    const store = new DurableDecisionStore({ storeDir: dir });
    await store.open();
    const service = new DecisionService(store);
    const bridge = new DecisionBridge(service, { port: 0 });
    await bridge.start();
    try {
      const root = githubDecisionRoot("owner", "repo", 1);
      let session = await service.createSession(root);
      session = await service.putBinding(session.id, { adapter: "chatgpt-web", externalSessionRef: "old", resumeUri: "https://chatgpt.com/c/old" });
      session = await service.breakBinding(session.id);
      const task = await service.createPlanTask(session.id);
      await service.putTaskContext(task.id, { strategy: "connector", workItem: root, repository: "owner/repo", prNumber: null, headSha: null });
      const claim = await service.claimTask(task.id, { owner: "browser-tab" });
      const cp = new MemoryCheckpointStore();
      cp.set({ schemaVersion: 1, tabId: cp.tabId, taskId: task.id, sessionId: session.id, leaseOwner: claim.lease.owner, leaseToken: claim.lease.token, leaseGeneration: claim.lease.generation, leaseExpiresAtMs: claim.lease.expiresAtMs, bindingGeneration: 1, step: "claimed", attemptId: "a", savedAtMs: Date.now() });
      const transport = new FetchBridgeTransport({ baseUrl: `http://127.0.0.1:${bridge.getPort()}` });
      let sends = 0;
      function page(url: string) {
        const doc = new MockDocument();
        const win = new MockWindow();
        win.location.href = url;
        const composer = new MockElement("textarea", { id: "prompt-textarea" });
        const send = new MockElement("button", { "data-testid": "send-button" });
        doc.body.appendChild(composer);
        doc.body.appendChild(send);
        function addReady() {
          const userMsg = new MockElement("div", { "data-message-author-role": "user" });
          userMsg.textContent = BOOTSTRAP_PROMPT;
          doc.body.appendChild(userMsg);
          const msg = new MockElement("div", { "data-message-author-role": "assistant" });
          msg.textContent = "Ready for Symphony tasks";
          doc.body.appendChild(msg);
        }
        send.addEventListener("click", () => {
          if (composer.value.includes("Acknowledge these instructions")) {
            sends++;
            win.location.href = `https://chatgpt.com/c/recovery-${sends}`;
            addReady();
          } else {
            const msg = new MockElement("div", { "data-message-author-role": "assistant" });
            msg.textContent = "```symphony-result\n" + JSON.stringify({
              schemaVersion: 1,
              taskId: task.id,
              sessionId: session.id,
              kind: "plan",
              revision: 1,
              verdict: "ready",
              content: { plan: "done", acceptanceCriteria: [], risks: [], clarifications: [] },
              createdAtMs: Date.now(),
            }) + "\n```";
            doc.body.appendChild(msg);
          }
        });
        const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window, stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 500 });
        return { doc, win, adapter, addReady };
      }
      const first = page("https://chatgpt.com/c/old");
      // Install the real driver's checkpoint listener for the coordinator's creation phase.
      new DecisionTabDriver({ transport, checkpointStore: cp, adapter: first.adapter });
      const created = await first.adapter.createSession(session);
      expect(sends).toBe(1);
      expect(created.binding.externalSessionRef).toBe("recovery-1");
      expect(cp.get()?.step).toBe("rebind_submitting");
      expect(cp.get()?.rebindState?.newExternalSessionRef).toBe("recovery-1");
      expect(service.getSession(session.id)?.bindingGeneration).toBe(1);

      // Reconstruct the page at the already-created conversation, before bridge rebind was sent.
      const reloaded = page("https://chatgpt.com/c/recovery-1");
      reloaded.addReady();
      const driver = new DecisionTabDriver({ transport, checkpointStore: cp, adapter: reloaded.adapter });
      await driver.runOnce();
      expect(service.getSession(session.id)?.binding?.externalSessionRef).toBe("recovery-1");
      expect(sends).toBe(1);
    } finally { await bridge.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("recovers conversation when interrupted during bootstrap_waiting", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-bootstrap-wait-"));
    const store = new DurableDecisionStore({ storeDir: dir });
    await store.open();
    const service = new DecisionService(store);
    const bridge = new DecisionBridge(service, { port: 0 });
    await bridge.start();
    try {
      const root = githubDecisionRoot("owner", "repo", 2);
      let session = await service.createSession(root);
      session = await service.putBinding(session.id, { adapter: "chatgpt-web", externalSessionRef: "old", resumeUri: "https://chatgpt.com/c/old" });
      session = await service.breakBinding(session.id);
      const task = await service.createPlanTask(session.id);
      await service.putTaskContext(task.id, { strategy: "connector", workItem: root, repository: "owner/repo", prNumber: null, headSha: null });
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
        step: "bootstrap_waiting",
        attemptId: "a",
        savedAtMs: Date.now(),
        baselineCount: 0,
        // The creation attempt recorded the conversation its send produced before the page
        // was lost; recovery may only ever continue from exactly this conversation.
        targetConvId: "recovered-bootstrap",
      });
      const transport = new FetchBridgeTransport({ baseUrl: `http://127.0.0.1:${bridge.getPort()}` });

      let sends = 0;
      const doc = new MockDocument();
      const win = new MockWindow();
      win.location.href = "https://chatgpt.com/c/recovered-bootstrap";
      const composer = new MockElement("textarea", { id: "prompt-textarea" });
      const send = new MockElement("button", { "data-testid": "send-button" });
      send.addEventListener("click", () => { sends++; });
      doc.body.appendChild(composer);
      doc.body.appendChild(send);
      const userMsg = new MockElement("div", { "data-message-author-role": "user" });
      userMsg.textContent = BOOTSTRAP_PROMPT;
      doc.body.appendChild(userMsg);
      const msg = new MockElement("div", { "data-message-author-role": "assistant" });
      msg.textContent = "Ready for Symphony tasks";
      doc.body.appendChild(msg);

      const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window, stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 500 });
      const driver = new DecisionTabDriver({ transport, checkpointStore: cp, adapter });
      await driver.runOnce();

      expect(sends).toBe(0);
      expect(service.getSession(session.id)?.binding?.externalSessionRef).toBe("recovered-bootstrap");
      expect(service.getSession(session.id)?.bindingGeneration).toBe(2);
      expect(cp.get()).toBeNull();
    } finally { await bridge.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("fails closed during bootstrap_waiting recovery when the tab shows an earlier Symphony bootstrap conversation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-bootstrap-unrelated-"));
    const store = new DurableDecisionStore({ storeDir: dir });
    await store.open();
    const service = new DecisionService(store);
    const bridge = new DecisionBridge(service, { port: 0 });
    await bridge.start();
    try {
      const root = githubDecisionRoot("owner", "repo", 6);
      let session = await service.createSession(root);
      session = await service.putBinding(session.id, { adapter: "chatgpt-web", externalSessionRef: "old", resumeUri: "https://chatgpt.com/c/old" });
      session = await service.breakBinding(session.id);
      const task = await service.createPlanTask(session.id);
      await service.putTaskContext(task.id, { strategy: "connector", workItem: root, repository: "owner/repo", prNumber: null, headSha: null });
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
        step: "bootstrap_waiting",
        attemptId: "a",
        savedAtMs: Date.now(),
        baselineCount: 0,
        targetUri: "https://chatgpt.com/",
        targetConvId: "created-by-this-attempt",
      });
      const transport = new FetchBridgeTransport({ baseUrl: `http://127.0.0.1:${bridge.getPort()}` });

      // Healthy page showing an EARLIER Symphony-created conversation: it renders the very
      // same bootstrap prompt and ready reply, so prompt text alone cannot prove that this
      // conversation belongs to the current attempt; only the recorded reference can.
      let sends = 0;
      const doc = new MockDocument();
      const win = new MockWindow();
      win.location.href = "https://chatgpt.com/c/unrelated-history";
      const composer = new MockElement("textarea", { id: "prompt-textarea" });
      const send = new MockElement("button", { "data-testid": "send-button" });
      send.addEventListener("click", () => { sends++; });
      doc.body.appendChild(composer);
      doc.body.appendChild(send);
      const oldUserMsg = new MockElement("div", { "data-message-author-role": "user" });
      oldUserMsg.textContent = BOOTSTRAP_PROMPT;
      doc.body.appendChild(oldUserMsg);
      const msg = new MockElement("div", { "data-message-author-role": "assistant" });
      msg.textContent = "Ready for Symphony tasks";
      doc.body.appendChild(msg);

      const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window, stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 50 });
      const driver = new DecisionTabDriver({ transport, checkpointStore: cp, adapter });
      const outcome = await driver.runOnce();

      expect(sends).toBe(0);
      expect(outcome?.status).toBe("failed");
      expect((outcome as { failure?: { error?: string } })?.failure?.error).toBe("human_required");
      expect(service.getSession(session.id)?.binding).toBeNull();
      expect(service.getSession(session.id)?.bindingGeneration).toBe(1);
      expect(service.getReceipt(task.id)?.payload as { error?: string } | undefined).toMatchObject({ error: "human_required" });
      expect(cp.get()).toBeNull();
    } finally { await bridge.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("fails closed when interrupted during bootstrap_submitting if send status is uncertain", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-bootstrap-failclosed-"));
    const store = new DurableDecisionStore({ storeDir: dir });
    await store.open();
    const service = new DecisionService(store);
    const bridge = new DecisionBridge(service, { port: 0 });
    await bridge.start();
    try {
      const root = githubDecisionRoot("owner", "repo", 3);
      let session = await service.createSession(root);
      session = await service.putBinding(session.id, { adapter: "chatgpt-web", externalSessionRef: "old", resumeUri: "https://chatgpt.com/c/old" });
      session = await service.breakBinding(session.id);
      const task = await service.createPlanTask(session.id);
      await service.putTaskContext(task.id, { strategy: "connector", workItem: root, repository: "owner/repo", prNumber: null, headSha: null });
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
        step: "bootstrap_submitting",
        attemptId: "a",
        savedAtMs: Date.now(),
        baselineCount: 0,
      });
      const transport = new FetchBridgeTransport({ baseUrl: `http://127.0.0.1:${bridge.getPort()}` });

      let sends = 0;
      const doc = new MockDocument();
      const win = new MockWindow();
      win.location.href = "https://chatgpt.com/";
      const composer = new MockElement("textarea", { id: "prompt-textarea" });
      const send = new MockElement("button", { "data-testid": "send-button" });
      send.addEventListener("click", () => { sends++; });
      doc.body.appendChild(composer);
      doc.body.appendChild(send);

      const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window, stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 500 });
      const driver = new DecisionTabDriver({ transport, checkpointStore: cp, adapter });
      const outcome = await driver.runOnce();

      expect(sends).toBe(0);
      expect(outcome?.status).toBe("failed");
      const currentTask = service.getTask(task.id);
      expect(currentTask?.status).toBe("failed");
      expect((outcome as { failure?: { error?: string } })?.failure?.error).toBe("human_required");
      expect((service.getReceipt(task.id)?.payload as { error?: string })?.error).toBe("human_required");
      expect(cp.get()).toBeNull();
    } finally { await bridge.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("recovers the conversation created by this attempt after an interrupted bootstrap", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-bootstrap-created-"));
    const store = new DurableDecisionStore({ storeDir: dir });
    await store.open();
    const service = new DecisionService(store);
    const bridge = new DecisionBridge(service, { port: 0 });
    await bridge.start();
    try {
      const root = githubDecisionRoot("owner", "repo", 7);
      let session = await service.createSession(root);
      session = await service.putBinding(session.id, { adapter: "chatgpt-web", externalSessionRef: "old", resumeUri: "https://chatgpt.com/c/old" });
      session = await service.breakBinding(session.id);
      const task = await service.createPlanTask(session.id);
      await service.putTaskContext(task.id, { strategy: "connector", workItem: root, repository: "owner/repo", prNumber: null, headSha: null });
      const claim = await service.claimTask(task.id, { owner: "browser-tab" });
      const cp = new MemoryCheckpointStore();
      cp.set({ schemaVersion: 1, tabId: cp.tabId, taskId: task.id, sessionId: session.id, leaseOwner: claim.lease.owner, leaseToken: claim.lease.token, leaseGeneration: claim.lease.generation, leaseExpiresAtMs: claim.lease.expiresAtMs, bindingGeneration: 1, step: "claimed", attemptId: "a", savedAtMs: Date.now() });
      const transport = new FetchBridgeTransport({ baseUrl: `http://127.0.0.1:${bridge.getPort()}` });

      // Creation page: the send produces the conversation, then the page is lost while the
      // reply is still streaming (aborted mid-wait).
      let sends = 0;
      const doc = new MockDocument();
      const win = new MockWindow();
      win.location.href = "https://chatgpt.com/";
      const composer = new MockElement("textarea", { id: "prompt-textarea" });
      const send = new MockElement("button", { "data-testid": "send-button" });
      doc.body.appendChild(composer);
      doc.body.appendChild(send);
      const controller = new AbortController();
      send.addEventListener("click", () => {
        sends++;
        win.location.href = "https://chatgpt.com/c/created-by-this-attempt";
        controller.abort();
      });
      const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window, stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 500 });
      // Install the real driver's checkpoint listener for the creation phase.
      new DecisionTabDriver({ transport, checkpointStore: cp, adapter });
      await adapter.createSession(session, { signal: controller.signal }).catch(() => null);

      expect(sends).toBe(1);
      expect(cp.get()?.step).toBe("bootstrap_waiting");
      expect(cp.get()?.targetConvId).toBe("created-by-this-attempt");

      // The tab is rebuilt on the conversation this attempt created: recovery binds exactly
      // that conversation and never re-sends the bootstrap.
      const reloadedDoc = new MockDocument();
      const reloadedWin = new MockWindow();
      reloadedWin.location.href = "https://chatgpt.com/c/created-by-this-attempt";
      reloadedDoc.body.appendChild(new MockElement("textarea", { id: "prompt-textarea" }));
      reloadedDoc.body.appendChild(new MockElement("button", { "data-testid": "send-button" }));
      const msg = new MockElement("div", { "data-message-author-role": "assistant" });
      msg.textContent = "Ready for Symphony tasks";
      reloadedDoc.body.appendChild(msg);
      const reloadedAdapter = new ChatGptWebAdapter({ doc: reloadedDoc as unknown as Document, win: reloadedWin as unknown as Window, stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 500 });
      const recoveryDriver = new DecisionTabDriver({ transport, checkpointStore: cp, adapter: reloadedAdapter });
      await recoveryDriver.runOnce();

      expect(sends).toBe(1);
      expect(service.getSession(session.id)?.binding?.externalSessionRef).toBe("created-by-this-attempt");
      expect(service.getSession(session.id)?.bindingGeneration).toBe(2);
      expect(cp.get()).toBeNull();
    } finally { await bridge.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("fails closed when the tab leaves the created conversation while the bootstrap reply is pending", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-bootstrap-drift-"));
    const store = new DurableDecisionStore({ storeDir: dir });
    await store.open();
    const service = new DecisionService(store);
    const bridge = new DecisionBridge(service, { port: 0 });
    await bridge.start();
    try {
      const root = githubDecisionRoot("owner", "repo", 8);
      let session = await service.createSession(root);
      session = await service.putBinding(session.id, { adapter: "chatgpt-web", externalSessionRef: "old", resumeUri: "https://chatgpt.com/c/old" });
      session = await service.breakBinding(session.id);
      const task = await service.createPlanTask(session.id);
      await service.putTaskContext(task.id, { strategy: "connector", workItem: root, repository: "owner/repo", prNumber: null, headSha: null });
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
        step: "bootstrap_waiting",
        attemptId: "a",
        savedAtMs: Date.now(),
        baselineCount: 0,
        targetConvId: "created-by-this-attempt",
      });
      const transport = new FetchBridgeTransport({ baseUrl: `http://127.0.0.1:${bridge.getPort()}` });

      let sends = 0;
      const doc = new MockDocument();
      const win = new MockWindow();
      win.location.href = "https://chatgpt.com/c/created-by-this-attempt";
      const composer = new MockElement("textarea", { id: "prompt-textarea" });
      const send = new MockElement("button", { "data-testid": "send-button" });
      send.addEventListener("click", () => { sends++; });
      doc.body.appendChild(composer);
      doc.body.appendChild(send);
      // While the reply is still pending the tab leaves for another conversation, which then
      // renders a completion: recovery must not read that reply or bind that conversation.
      setTimeout(() => {
        win.location.href = "https://chatgpt.com/c/unrelated-history";
        const msg = new MockElement("div", { "data-message-author-role": "assistant" });
        msg.textContent = "Ready for Symphony tasks";
        doc.body.appendChild(msg);
      }, 5);

      const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window, stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 500 });
      const driver = new DecisionTabDriver({ transport, checkpointStore: cp, adapter });
      const outcome = await driver.runOnce();

      expect(sends).toBe(0);
      expect(outcome?.status).toBe("failed");
      expect((outcome as { failure?: { error?: string } })?.failure?.error).toBe("human_required");
      expect(service.getSession(session.id)?.binding).toBeNull();
      expect(service.getSession(session.id)?.bindingGeneration).toBe(1);
      expect(cp.get()).toBeNull();
    } finally { await bridge.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  for (const [faultSelector, expectedError] of [
    ["login-button", "human_required"],
    ["conversation-not-found", "binding_broken"],
  ] as const) {
    it(`preserves the typed ${expectedError} failure when the fault appears during the bootstrap wait`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-bootstrap-typed-"));
      const store = new DurableDecisionStore({ storeDir: dir });
      await store.open();
      const service = new DecisionService(store);
      const bridge = new DecisionBridge(service, { port: 0 });
      await bridge.start();
      try {
        const root = githubDecisionRoot("owner", "repo", 9);
        let session = await service.createSession(root);
        session = await service.putBinding(session.id, { adapter: "chatgpt-web", externalSessionRef: "old", resumeUri: "https://chatgpt.com/c/old" });
        session = await service.breakBinding(session.id);
        const task = await service.createPlanTask(session.id);
        await service.putTaskContext(task.id, { strategy: "connector", workItem: root, repository: "owner/repo", prNumber: null, headSha: null });
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
          step: "bootstrap_waiting",
          attemptId: "a",
          savedAtMs: Date.now(),
          baselineCount: 0,
          targetConvId: "created-by-this-attempt",
        });
        const transport = new FetchBridgeTransport({ baseUrl: `http://127.0.0.1:${bridge.getPort()}` });

        let sends = 0;
        const doc = new MockDocument();
        const win = new MockWindow();
        win.location.href = "https://chatgpt.com/c/created-by-this-attempt";
        const composer = new MockElement("textarea", { id: "prompt-textarea" });
        const send = new MockElement("button", { "data-testid": "send-button" });
        send.addEventListener("click", () => { sends++; });
        doc.body.appendChild(composer);
        doc.body.appendChild(send);
        // The fault (auth barrier or deleted conversation) appears while the reply is pending.
        setTimeout(() => {
          doc.body.appendChild(new MockElement("div", { "data-testid": faultSelector }));
        }, 5);

        const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window, stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 500 });
        const driver = new DecisionTabDriver({ transport, checkpointStore: cp, adapter });
        const outcome = await driver.runOnce();

        expect(sends).toBe(0);
        expect(outcome?.status).toBe("failed");
        expect((outcome as { failure?: { error?: string } })?.failure?.error).toBe(expectedError);
        expect(service.getReceipt(task.id)?.payload).toMatchObject({ error: expectedError });
        expect((service.getReceipt(task.id)?.payload as { retryable?: boolean })?.retryable).toBe(false);
        expect((service.getReceipt(task.id)?.payload as { details?: { suggestedAction?: string } })?.details?.suggestedAction).toBe(
          expectedError === "human_required" ? "human_intervention" : "rebind"
        );
        expect(service.getSession(session.id)?.binding).toBeNull();
        expect(service.getSession(session.id)?.bindingGeneration).toBe(1);
        expect(cp.get()).toBeNull();
      } finally { await bridge.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
    });
  }

  it("fails closed during bootstrap_submitting recovery without a recorded created conversation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-bootstrap-confirmed-"));
    const store = new DurableDecisionStore({ storeDir: dir });
    await store.open();
    const service = new DecisionService(store);
    const bridge = new DecisionBridge(service, { port: 0 });
    await bridge.start();
    try {
      const root = githubDecisionRoot("owner", "repo", 4);
      let session = await service.createSession(root);
      session = await service.putBinding(session.id, { adapter: "chatgpt-web", externalSessionRef: "old", resumeUri: "https://chatgpt.com/c/old" });
      session = await service.breakBinding(session.id);
      const task = await service.createPlanTask(session.id);
      await service.putTaskContext(task.id, { strategy: "connector", workItem: root, repository: "owner/repo", prNumber: null, headSha: null });
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
        step: "bootstrap_submitting",
        attemptId: "a",
        savedAtMs: Date.now(),
        baselineCount: 0,
      });
      const transport = new FetchBridgeTransport({ baseUrl: `http://127.0.0.1:${bridge.getPort()}` });

      // A healthy page at some conversation with a reply cannot be tied to this attempt:
      // its send may have created a conversation elsewhere, so binding it would be a guess.
      let sends = 0;
      const doc = new MockDocument();
      const win = new MockWindow();
      win.location.href = "https://chatgpt.com/c/confirmed-conv";
      const composer = new MockElement("textarea", { id: "prompt-textarea" });
      const send = new MockElement("button", { "data-testid": "send-button" });
      send.addEventListener("click", () => { sends++; });
      doc.body.appendChild(composer);
      doc.body.appendChild(send);
      const userMsg = new MockElement("div", { "data-message-author-role": "user" });
      userMsg.textContent = BOOTSTRAP_PROMPT;
      doc.body.appendChild(userMsg);
      const msg = new MockElement("div", { "data-message-author-role": "assistant" });
      msg.textContent = "Ready for Symphony tasks";
      doc.body.appendChild(msg);

      const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window, stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 500 });
      const driver = new DecisionTabDriver({ transport, checkpointStore: cp, adapter });
      const outcome = await driver.runOnce();

      expect(sends).toBe(0);
      expect(outcome?.status).toBe("failed");
      expect((outcome as { failure?: { error?: string } })?.failure?.error).toBe("human_required");
      expect(service.getSession(session.id)?.binding).toBeNull();
      expect(service.getSession(session.id)?.bindingGeneration).toBe(1);
      expect(cp.get()).toBeNull();
    } finally { await bridge.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("recovers when interrupted during rebind_submitting before bridge rebind", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-bootstrap-rebind-"));
    const store = new DurableDecisionStore({ storeDir: dir });
    await store.open();
    const service = new DecisionService(store);
    const bridge = new DecisionBridge(service, { port: 0 });
    await bridge.start();
    try {
      const root = githubDecisionRoot("owner", "repo", 5);
      let session = await service.createSession(root);
      session = await service.putBinding(session.id, { adapter: "chatgpt-web", externalSessionRef: "old", resumeUri: "https://chatgpt.com/c/old" });
      session = await service.breakBinding(session.id);
      const task = await service.createPlanTask(session.id);
      await service.putTaskContext(task.id, { strategy: "connector", workItem: root, repository: "owner/repo", prNumber: null, headSha: null });
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
        step: "rebind_submitting",
        attemptId: "a",
        savedAtMs: Date.now(),
        rebindState: {
          newExternalSessionRef: "pending-rebind-conv",
          newResumeUri: "https://chatgpt.com/c/pending-rebind-conv",
          expectedGeneration: 1,
        },
      });
      const transport = new FetchBridgeTransport({ baseUrl: `http://127.0.0.1:${bridge.getPort()}` });

      const doc = new MockDocument();
      const win = new MockWindow();
      win.location.href = "https://chatgpt.com/c/pending-rebind-conv";
      const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window, stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 500 });
      const driver = new DecisionTabDriver({ transport, checkpointStore: cp, adapter });
      await driver.runOnce();

      expect(service.getSession(session.id)?.binding?.externalSessionRef).toBe("pending-rebind-conv");
      expect(service.getSession(session.id)?.bindingGeneration).toBe(2);
      expect(cp.get()).toBeNull();
    } finally { await bridge.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });
});
