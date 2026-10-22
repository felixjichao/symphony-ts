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

describe("bootstrap typed error recovery", () => {
  it("persists nonterminal human-required blocking for bootstrap authentication failure", async () => {
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
        targetConvId: "unrelated-history",
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
      doc.body.appendChild(new MockElement("button", { "data-testid": "login-button" }));
      const oldUserMsg = new MockElement("div", { "data-message-author-role": "user" });
      oldUserMsg.textContent = BOOTSTRAP_PROMPT;
      doc.body.appendChild(oldUserMsg);
      const msg = new MockElement("div", { "data-message-author-role": "assistant" });
      msg.textContent = "Ready for Symphony tasks";
      doc.body.appendChild(msg);

      const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window, stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 50 });
      const driver = new DecisionTabDriver({ transport, checkpointStore: cp, adapter });
      const outcome = await driver.runOnce();

      expect.soft(sends).toBe(0);
      expect.soft(outcome?.status).toBe("blocked");
      expect.soft(service.getExecution(task.id)?.blocked?.reason).toBe("human_required");
      expect.soft(service.getSession(session.id)?.binding).toBeNull();
      expect.soft(service.getSession(session.id)?.bindingGeneration).toBe(1);
      expect.soft(service.getReceipt(task.id)).toBeNull();
      expect.soft(service.getExecution(task.id)?.blocked?.unblock).toContain("explicitly authorize");
      expect.soft(cp.get()).toBeNull();
    } finally { await bridge.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });

});
