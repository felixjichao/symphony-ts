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

async function environment() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-seven-"));
  const store = new DurableDecisionStore({ storeDir: dir });
  await store.open();
  let current = Date.now();
  const service = new DecisionService(store, { clock: () => current });
  const bridge = new DecisionBridge(service, { port: 0 });
  await bridge.start();
  const transport = new FetchBridgeTransport({ baseUrl: `http://127.0.0.1:${bridge.getPort()}` });
  return { service, transport, advance(ms: number) { current += ms; }, async close() { await bridge.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}

describe("bootstrap recovery preflight", () => {
  for (const [step, route, errorUi] of [
    ["bootstrap_submitting", "deleted", true],
    ["bootstrap_waiting", "deleted", true],
    ["bootstrap_submitting", "unrelated-history", false],
  ] as const) {
    it(`does not infer this attempt's bootstrap from ${route} during ${step}`, async () => {
      const e = await environment();
      try {
        const root = githubDecisionRoot("owner", "repo", 1);
        let s = await e.service.createSession(root);
        s = await e.service.putBinding(s.id, { adapter: "chatgpt-web", externalSessionRef: "deleted", resumeUri: "https://chatgpt.com/c/deleted" });
        s = await e.service.breakBinding(s.id);
        const task = await e.service.createPlanTask(s.id);
        const claim = await e.service.claimTask(task.id, { owner: "tab" });
        const cp = new MemoryCheckpointStore();
        cp.set({ schemaVersion: 1, tabId: cp.tabId, taskId: task.id, sessionId: s.id, leaseOwner: claim.lease.owner, leaseToken: claim.lease.token, leaseGeneration: claim.lease.generation, leaseExpiresAtMs: claim.lease.expiresAtMs, bindingGeneration: 1, step, baselineCount: 0, attemptId: "a", savedAtMs: Date.now(), targetUri: "https://chatgpt.com/" });
        const doc = new MockDocument();
        if (errorUi) doc.body.appendChild(new MockElement("div", { "data-testid": "conversation-not-found" }));
        const retained = new MockElement("div", { "data-message-author-role": "assistant" });
        retained.textContent = "Ready for Symphony tasks";
        doc.body.appendChild(retained);
        const win = new MockWindow();
        // The attempt has no confirmed send receipt or stored new conversation; this is a different loaded page.
        win.location.href = `https://chatgpt.com/c/${route}`;
        const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window, stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 100 });
        const driver = new DecisionTabDriver({ transport: e.transport, checkpointStore: cp, adapter });
        await driver.runOnce().catch(() => null);
        expect(e.service.getSession(s.id)?.binding?.externalSessionRef).not.toBe(route);
      } finally { await e.close(); }
    });
  }

  it("does not send bootstrap under a superseded claim from initial binding checkpoint", async () => {
    const e = await environment();
    try {
      const root = githubDecisionRoot("owner", "repo", 2);
      let s = await e.service.createSession(root);
      const task = await e.service.createPlanTask(s.id);
      await e.service.putTaskContext(task.id, { strategy: "connector", workItem: root, repository: "owner/repo", prNumber: null, headSha: null });
      const old = await e.service.claimTask(task.id, { owner: "old-tab", ttlMs: 1000 });
      s = await e.service.putBinding(s.id, { adapter: "chatgpt-web", externalSessionRef: "first", resumeUri: "https://chatgpt.com/c/first" });
      e.advance(1001);
      const newer = await e.service.claimTask(task.id, { owner: "new-tab" });
      expect(newer.lease.generation).toBe(old.lease.generation + 1);
      s = await e.service.breakBinding(s.id);
      const cp = new MemoryCheckpointStore();
      cp.set({ schemaVersion: 1, tabId: cp.tabId, taskId: task.id, sessionId: s.id, leaseOwner: old.lease.owner, leaseToken: old.lease.token, leaseGeneration: old.lease.generation, leaseExpiresAtMs: old.lease.expiresAtMs, bindingGeneration: 0, step: "rebind_submitting", attemptId: "a", savedAtMs: Date.now(), rebindState: { newExternalSessionRef: "first", newResumeUri: "https://chatgpt.com/c/first", expectedGeneration: 0 } });
      const doc = new MockDocument();
      const win = new MockWindow();
      win.location.href = "https://chatgpt.com/";
      doc.body.appendChild(new MockElement("textarea", { id: "prompt-textarea" }));
      const send = new MockElement("button", { "data-testid": "send-button" });
      doc.body.appendChild(send);
      let sends = 0;
      send.addEventListener("click", () => {
        sends++;
        win.location.href = "https://chatgpt.com/c/unauthorized-bootstrap";
        const msg = new MockElement("div", { "data-message-author-role": "assistant" });
        msg.textContent = "Ready for Symphony tasks";
        doc.body.appendChild(msg);
      });
      const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window, stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 100 });
      const driver = new DecisionTabDriver({ transport: e.transport, checkpointStore: cp, adapter });
      await driver.runOnce().catch(() => null);
      expect(e.service.getTask(task.id)?.lease?.token).toBe(newer.lease.token);
      expect(sends).toBe(0);
    } finally { await e.close(); }
  });
});
