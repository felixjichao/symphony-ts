import { describe, it, expect, vi } from "vitest";
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

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-121-"));
  const store = new DurableDecisionStore({ storeDir: dir });
  await store.open();
  const service = new DecisionService(store);
  const bridge = new DecisionBridge(service, { port: 0 });
  await bridge.start();
  const transport = new FetchBridgeTransport({ baseUrl: `http://127.0.0.1:${bridge.getPort()}` });
  return { service, transport, async close() { await bridge.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}

describe("NEST-121 independent review regressions", () => {
  it("preserves first-bind extracted result checkpoint on reload", async () => {
    const env = await setup();
    try {
      const root = githubDecisionRoot("owner", "repo", 1);
      const session = await env.service.createSession(root);
      const task = await env.service.createPlanTask(session.id);
      const context = { strategy: "connector" as const, workItem: root, repository: "owner/repo", prNumber: null, headSha: null };
      await env.service.putTaskContext(task.id, context);
      const claim = await env.service.claimTask(task.id, { owner: "review" });
      const cp = new MemoryCheckpointStore();
      const wait = vi.fn().mockRejectedValue(new Error("reload test ends here"));
      const adapter: DecisionExecutorAdapter & { waitForExistingResponse: typeof wait } = {
        name: "chatgpt-web", supportedTaskKinds: ["plan"], supportedContextStrategies: ["connector"],
        inspectBinding: async () => ({ status: "none" }),
        createSession: async () => ({ binding: { schemaVersion: 1, adapter: "chatgpt-web", externalSessionRef: "new", resumeUri: "https://chatgpt.com/c/new", generation: 1 } }),
        resumeSession: async (_s, binding) => ({ binding }),
        executeTask: async () => ({ result: { schemaVersion: 1, taskId: task.id, sessionId: session.id, kind: "plan", revision: 1, verdict: "ready", content: { plan: "done", acceptanceCriteria: [], risks: [], clarifications: [] }, createdAtMs: Date.now() } }),
        waitForExistingResponse: wait,
      };
      const transport = { baseUrl: env.transport.baseUrl, authToken: env.transport.authToken, request: async <T>(method: string, url: string, body?: unknown): Promise<T> => {
        if (url.endsWith("/result")) throw new BridgeHttpError("temporary outage", "unavailable", 503);
        return env.transport.request<T>(method, url, body);
      } };
      const driver = new DecisionTabDriver({ transport, checkpointStore: cp, adapter, ownerId: "review" });
      await expect(driver.executeClaimedTask(claim.task, claim.session, claim.lease, context)).rejects.toThrow("temporary outage");
      expect(env.service.getSession(session.id)?.bindingGeneration).toBe(1);
      expect(env.service.getTask(task.id)?.status).toBe("running");
      expect(cp.get()?.step).toBe("result_extracted");
      expect(cp.get()?.bindingGeneration).toBe(0);
      const reloaded = new DecisionTabDriver({ transport: env.transport, checkpointStore: cp, adapter, ownerId: "new-runtime" });
      const recovered = await reloaded.resumeCheckpointIfAvailable();
      expect(recovered?.status).toBe("completed");
    } finally { await env.close(); }
  });

  it("keeps a pending rebind checkpoint after transient HTTP 503", async () => {
    const env = await setup();
    try {
      const root = githubDecisionRoot("owner", "repo", 2);
      let session = await env.service.createSession(root);
      session = await env.service.putBinding(session.id, { adapter: "chatgpt-web", externalSessionRef: "old", resumeUri: null });
      const task = await env.service.createPlanTask(session.id);
      const claim = await env.service.claimTask(task.id, { owner: "review" });
      const cp = new MemoryCheckpointStore();
      cp.set({ schemaVersion: 1, tabId: cp.tabId, taskId: task.id, sessionId: session.id, leaseOwner: claim.lease.owner, leaseToken: claim.lease.token, leaseGeneration: claim.lease.generation, leaseExpiresAtMs: claim.lease.expiresAtMs, bindingGeneration: 1, step: "rebind_submitting", attemptId: "a", savedAtMs: Date.now(), rebindState: { newExternalSessionRef: "new", newResumeUri: null, expectedGeneration: 1 } });
      const transport = { ...env.transport, baseUrl: env.transport.baseUrl, authToken: env.transport.authToken, request: async <T>(method: string, url: string, body?: unknown): Promise<T> => {
        if (url.endsWith("/rebind")) throw new BridgeHttpError("temporary outage", "unavailable", 503);
        return env.transport.request<T>(method, url, body);
      } };
      const driver = new DecisionTabDriver({ transport, checkpointStore: cp });
      await driver.resumeCheckpointIfAvailable();
      expect(env.service.getSession(session.id)?.bindingGeneration).toBe(1);
      expect(cp.get()?.rebindState?.newExternalSessionRef).toBe("new");
    } finally { await env.close(); }
  });

  it("does not mark a healthy conversation broken from ordinary task text", async () => {
    const doc = new MockDocument();
    doc.body.appendChild(new MockElement("textarea", { id: "prompt-textarea" }));
    doc.body.textContent = "Please fix the error message Conversation not found in this PR.";
    const win = new MockWindow();
    win.location.href = "https://chatgpt.com/c/healthy";
    const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window });
    const binding = { schemaVersion: 1 as const, adapter: "chatgpt-web", externalSessionRef: "healthy", resumeUri: win.location.href, generation: 1 };
    const session = { schemaVersion: 1 as const, id: "github:owner/repo#3", root: githubDecisionRoot("owner", "repo", 3), status: "active" as const, binding, bindingGeneration: 1, createdAtMs: Date.now(), updatedAtMs: Date.now() };
    await expect(adapter.resumeSession(session, binding)).resolves.toMatchObject({ binding });
  });
});
