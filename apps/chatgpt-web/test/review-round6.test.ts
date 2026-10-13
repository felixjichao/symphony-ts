import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DurableDecisionStore, DecisionService, DecisionBridge } from "@symphony/decision";
import { githubDecisionRoot, type DecisionExecutorAdapter } from "@symphony/domain/decision";
import { DecisionTabDriver } from "../src/driver";
import { MemoryCheckpointStore } from "../src/checkpoint";
import { FetchBridgeTransport } from "../src/transport";
import { ChatGptWebAdapter } from "../src/adapter";
import { MockDocument, MockElement, MockWindow } from "./mock-dom";

async function environment() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-six-"));
  const store = new DurableDecisionStore({ storeDir: dir });
  await store.open();
  const service = new DecisionService(store);
  const bridge = new DecisionBridge(service, { port: 0 });
  await bridge.start();
  const transport = new FetchBridgeTransport({ baseUrl: `http://127.0.0.1:${bridge.getPort()}` });
  return { service, transport, async close() { await bridge.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}

describe("bootstrap recovery authorization and first binding", () => {
  it("uses distinct rebind operation keys for two sessions in the same driver", async () => {
    const e = await environment();
    try {
      const adapter: DecisionExecutorAdapter = {
        name: "chatgpt-web", supportedTaskKinds: ["plan"], supportedContextStrategies: ["connector"],
        inspectBinding: async (s) => ({ status: "unusable", needsRebind: true, reason: "deleted", observedGeneration: s.bindingGeneration }),
        createSession: async (s) => ({ binding: { schemaVersion: 1, adapter: "chatgpt-web", externalSessionRef: `new-${s.id}`, resumeUri: null, generation: s.bindingGeneration + 1 } }),
        resumeSession: async (_s, binding) => ({ binding }),
        executeTask: async () => { throw new Error("old claim must be fenced before execution"); },
      };
      const driver = new DecisionTabDriver({ transport: e.transport, checkpointStore: new MemoryCheckpointStore(), adapter: adapter as ChatGptWebAdapter, ownerId: "one-tab" });
      for (const issue of [3, 4]) {
        const root = githubDecisionRoot("owner", "repo", issue);
        let s = await e.service.createSession(root);
        s = await e.service.putBinding(s.id, { adapter: "chatgpt-web", externalSessionRef: `old-${issue}`, resumeUri: null });
        s = await e.service.breakBinding(s.id);
        const task = await e.service.createPlanTask(s.id);
        const context = { strategy: "connector" as const, workItem: root, repository: "owner/repo", prNumber: null, headSha: null };
        const claim = await e.service.claimTask(task.id, { owner: "one-tab" });
        const outcome = await driver.executeClaimedTask(claim.task, claim.session, claim.lease, context);
        expect(outcome.status).toBe("superseded");
        expect(e.service.getSession(s.id)?.bindingGeneration).toBe(2);
      }
    } finally { await e.close(); }
  });

  it("continues original live claim after recovering first binding 0 to 1", async () => {
    const e = await environment();
    try {
      const root = githubDecisionRoot("owner", "repo", 1);
      const s = await e.service.createSession(root);
      const task = await e.service.createPlanTask(s.id);
      await e.service.putTaskContext(task.id, { strategy: "connector", workItem: root, repository: "owner/repo", prNumber: null, headSha: null });
      const claim = await e.service.claimTask(task.id, { owner: "original-tab" });
      const cp = new MemoryCheckpointStore();
      cp.set({ schemaVersion: 1, tabId: cp.tabId, taskId: task.id, sessionId: s.id, leaseOwner: claim.lease.owner, leaseToken: claim.lease.token, leaseGeneration: claim.lease.generation, leaseExpiresAtMs: claim.lease.expiresAtMs, bindingGeneration: 0, step: "rebind_submitting", attemptId: "a", savedAtMs: Date.now(), rebindState: { newExternalSessionRef: "first-created", newResumeUri: "https://chatgpt.com/c/first-created", expectedGeneration: 0 } });
      const doc = new MockDocument();
      const win = new MockWindow();
      win.location.href = "https://chatgpt.com/c/first-created";
      const composer = new MockElement("textarea", { id: "prompt-textarea" });
      const send = new MockElement("button", { "data-testid": "send-button" });
      doc.body.appendChild(composer);
      doc.body.appendChild(send);
      send.addEventListener("click", () => {
        const msg = new MockElement("div", { "data-message-author-role": "assistant" });
        msg.textContent = "```symphony-result\n" + JSON.stringify({ schemaVersion: 1, taskId: task.id, sessionId: s.id, kind: "plan", revision: 1, verdict: "ready", content: { plan: "done", acceptanceCriteria: [], risks: [], clarifications: [] }, createdAtMs: Date.now() }) + "\n```";
        doc.body.appendChild(msg);
      });
      const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window, checkIntervalMs: 1, stabilizationMs: 1, timeoutMs: 500 });
      const driver = new DecisionTabDriver({ transport: e.transport, checkpointStore: cp, adapter });
      await driver.runOnce();
      await driver.runOnce();
      expect(e.service.getSession(s.id)?.bindingGeneration).toBe(1);
      // A recovered bootstrap must make progress under the live bootstrap claim, without waiting for TTL expiry.
      expect(e.service.getTask(task.id)?.status).toBe("completed");
    } finally { await e.close(); }
  });

  it("does not rebind a known deleted route from a navigating-to-root checkpoint", async () => {
    const e = await environment();
    try {
      const root = githubDecisionRoot("owner", "repo", 2);
      let s = await e.service.createSession(root);
      s = await e.service.putBinding(s.id, { adapter: "chatgpt-web", externalSessionRef: "deleted", resumeUri: "https://chatgpt.com/c/deleted" });
      s = await e.service.breakBinding(s.id);
      const task = await e.service.createPlanTask(s.id);
      await e.service.putTaskContext(task.id, { strategy: "connector", workItem: root, repository: "owner/repo", prNumber: null, headSha: null });
      const claim = await e.service.claimTask(task.id, { owner: "original-tab" });
      const cp = new MemoryCheckpointStore();
      cp.set({ schemaVersion: 1, tabId: cp.tabId, taskId: task.id, sessionId: s.id, leaseOwner: claim.lease.owner, leaseToken: claim.lease.token, leaseGeneration: claim.lease.generation, leaseExpiresAtMs: claim.lease.expiresAtMs, bindingGeneration: 1, step: "navigating", attemptId: "a", savedAtMs: Date.now(), targetUri: "https://chatgpt.com/" });
      const doc = new MockDocument();
      doc.body.appendChild(new MockElement("div", { "data-testid": "conversation-not-found" }));
      const win = new MockWindow();
      win.location.href = "https://chatgpt.com/c/deleted";
      const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window, checkIntervalMs: 1, stabilizationMs: 1, timeoutMs: 50 });
      const driver = new DecisionTabDriver({ transport: e.transport, checkpointStore: cp, adapter });
      await driver.runOnce().catch(() => null);
      expect(e.service.getSession(s.id)?.binding?.externalSessionRef).not.toBe("deleted");
    } finally { await e.close(); }
  });
});
