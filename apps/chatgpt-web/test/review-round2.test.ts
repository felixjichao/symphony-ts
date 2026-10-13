import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DurableDecisionStore, DecisionService, DecisionBridge } from "@symphony/decision";
import { githubDecisionRoot, type DecisionExecutorAdapter } from "@symphony/domain/decision";
import { DecisionTabDriver } from "../src/driver";
import { MemoryCheckpointStore } from "../src/checkpoint";
import { FetchBridgeTransport, BridgeHttpError } from "../src/transport";
import { ChatGptWebAdapter } from "../src/adapter";
import { MockDocument, MockElement, MockWindow } from "./mock-dom";

describe("NEST-121 second review", () => {
  it("runOnce must retain pending rebind when another session has ready work", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-round2-"));
    const store = new DurableDecisionStore({ storeDir: dir });
    await store.open();
    const service = new DecisionService(store);
    const bridge = new DecisionBridge(service, { port: 0 });
    await bridge.start();
    try {
      const real = new FetchBridgeTransport({ baseUrl: `http://127.0.0.1:${bridge.getPort()}` });
      const rootA = githubDecisionRoot("owner", "repo", 1);
      let a = await service.createSession(rootA);
      a = await service.putBinding(a.id, { adapter: "chatgpt-web", externalSessionRef: "old-a", resumeUri: null });
      const ta = await service.createPlanTask(a.id);
      const ca = await service.claimTask(ta.id, { owner: "a-worker" });
      const rootB = githubDecisionRoot("owner", "repo", 2);
      let b = await service.createSession(rootB);
      b = await service.putBinding(b.id, { adapter: "chatgpt-web", externalSessionRef: "healthy-b", resumeUri: null });
      const tb = await service.createPlanTask(b.id);
      await service.putTaskContext(tb.id, { strategy: "connector", workItem: rootB, repository: "owner/repo", prNumber: null, headSha: null });
      const cp = new MemoryCheckpointStore();
      cp.set({ schemaVersion: 1, tabId: cp.tabId, taskId: ta.id, sessionId: a.id, leaseOwner: ca.lease.owner, leaseToken: ca.lease.token, leaseGeneration: ca.lease.generation, leaseExpiresAtMs: ca.lease.expiresAtMs, bindingGeneration: 1, step: "rebind_submitting", attemptId: "a", savedAtMs: Date.now(), rebindState: { newExternalSessionRef: "new-a", newResumeUri: null, expectedGeneration: 1, operationKey: "a-rollover" } });
      let failRebind = true;
      const transport = { baseUrl: real.baseUrl, authToken: real.authToken, request: async <T>(method: string, url: string, body?: unknown, options?: { allow204?: boolean }): Promise<T> => {
        if (url.endsWith("/rebind") && failRebind) throw new BridgeHttpError("rebind temporarily unavailable", "unavailable", 503);
        return real.request<T>(method, url, body, options);
      } };
      const adapter: DecisionExecutorAdapter = {
        name: "chatgpt-web", supportedTaskKinds: ["plan"], supportedContextStrategies: ["connector"],
        inspectBinding: async (s) => ({ status: "usable", binding: s.binding! }),
        resumeSession: async (_s, binding) => ({ binding }),
        createSession: async () => { throw new Error("must not create"); },
        executeTask: async ({ task, session }) => ({ result: { schemaVersion: 1, taskId: task.id, sessionId: session.id, kind: "plan", revision: task.revision, verdict: "ready", content: { plan: "done", acceptanceCriteria: [], risks: [], clarifications: [] }, createdAtMs: Date.now() } }),
      };
      const driver = new DecisionTabDriver({ transport, checkpointStore: cp, adapter });
      await driver.runOnce().catch(() => null);
      expect(service.getSession(a.id)?.bindingGeneration).toBe(1);
      // Confirm that the outer polling path blocked claiming new work (retaining A's rebind retry)
      // so task B remains pending rather than overwriting and losing A's operationKey
      expect(service.getTask(tb.id)?.status).toBe("pending");
      expect(cp.get()?.rebindState?.operationKey).toBe("a-rollover");

      // Once the transient 503 is resolved, subsequent runOnce rebinds A cleanly
      failRebind = false;
      await driver.runOnce();
      expect(service.getSession(a.id)?.bindingGeneration).toBe(2);
      expect(cp.get()).toBeNull();

      // Subsequent runOnce claims and completes task B
      await driver.runOnce();
      expect(service.getTask(tb.id)?.status).toBe("completed");
    } finally { await bridge.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("explicit conversation error must win over a composer still present in the shell", async () => {
    const doc = new MockDocument();
    doc.body.appendChild(new MockElement("textarea", { id: "prompt-textarea" }));
    doc.body.appendChild(new MockElement("div", { "data-testid": "conversation-not-found" }));
    const win = new MockWindow();
    win.location.href = "https://chatgpt.com/c/deleted";
    const binding = { schemaVersion: 1 as const, adapter: "chatgpt-web", externalSessionRef: "deleted", resumeUri: win.location.href, generation: 1 };
    const session = { schemaVersion: 1 as const, id: "github:owner/repo#1", root: githubDecisionRoot("owner", "repo", 1), status: "active" as const, binding, bindingGeneration: 1, createdAtMs: Date.now(), updatedAtMs: Date.now() };
    const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window });
    await expect(adapter.resumeSession(session, binding)).rejects.toMatchObject({ code: "binding_broken", suggestedAction: "rebind" });
  });
});
