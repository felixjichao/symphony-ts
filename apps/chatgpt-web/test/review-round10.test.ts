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

describe("bootstrap reference capture", () => {
  it("does not replace the recorded bootstrap conversation after navigation to unrelated history", async () => {
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
      let firstRecordedRef: string | null | undefined;
      const controller = new AbortController();
      send.addEventListener("click", () => {
        sends++;
        win.location.href = "https://chatgpt.com/c/created-by-this-attempt";
        setTimeout(() => {
          firstRecordedRef = cp.get()?.targetConvId;
          win.location.href = "https://chatgpt.com/c/unrelated-history";
          controller.abort();
        }, 10);
      });
      const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window, stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 500 });
      // Install the real driver's checkpoint listener for the creation phase.
      new DecisionTabDriver({ transport, checkpointStore: cp, adapter });
      await adapter.createSession(session, { signal: controller.signal }).catch(() => null);

      expect(firstRecordedRef).toBe("created-by-this-attempt");
      expect(sends).toBe(1);
      expect(cp.get()?.step).toBe("bootstrap_waiting");
      const recordedAtInterruption = cp.get()?.targetConvId;

      // The tab is rebuilt on unrelated history: recovery must fail closed rather than
      // binding that history or re-sending the bootstrap.
      const reloadedDoc = new MockDocument();
      const reloadedWin = new MockWindow();
      reloadedWin.location.href = "https://chatgpt.com/c/unrelated-history";
      reloadedDoc.body.appendChild(new MockElement("textarea", { id: "prompt-textarea" }));
      reloadedDoc.body.appendChild(new MockElement("button", { "data-testid": "send-button" }));
      const msg = new MockElement("div", { "data-message-author-role": "assistant" });
      msg.textContent = "Ready for Symphony tasks";
      reloadedDoc.body.appendChild(msg);
      const reloadedAdapter = new ChatGptWebAdapter({ doc: reloadedDoc as unknown as Document, win: reloadedWin as unknown as Window, stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 500 });
      const recoveryDriver = new DecisionTabDriver({ transport, checkpointStore: cp, adapter: reloadedAdapter });
      await recoveryDriver.runOnce();

      expect(sends).toBe(1);
      expect(service.getSession(session.id)?.binding?.externalSessionRef).not.toBe("unrelated-history");
      expect(recordedAtInterruption).toBe("created-by-this-attempt");
      expect(service.getSession(session.id)?.bindingGeneration).toBe(1);
      expect(cp.get()).toBeNull();
    } finally { await bridge.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });

});
