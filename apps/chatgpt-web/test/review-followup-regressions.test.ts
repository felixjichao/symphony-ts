import { describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DecisionBridge,
  DecisionBridgeClient,
  DurableDecisionStore,
  DecisionService,
} from "@symphony/decision";
import {
  githubDecisionRoot,
  DECISION_MAX_TRANSPORT_RECOVERIES,
  type DecisionContextBundle,
  type DecisionResult,
} from "@symphony/domain/decision";
import { DecisionTabDriver } from "../src/driver";
import { MemoryCheckpointStore } from "../src/checkpoint";
import { BridgeHttpError, FetchBridgeTransport, type BridgeTransport } from "../src/transport";
import { ChatGptWebAdapter } from "../src/adapter";
import { MockDocument, MockElement, MockWindow } from "./mock-dom";

const context: DecisionContextBundle = {
  strategy: "connector",
  workItem: { provider: "github", key: "owner/repo#1" },
  repository: "owner/repo",
  prNumber: null,
  headSha: null,
};

async function realChain(seq: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-followup-"));
  const store = new DurableDecisionStore({ storeDir: dir });
  await store.open();
  const service = new DecisionService(store);
  const bridge = new DecisionBridge(service, { port: 0 });
  await bridge.start();
  const root = githubDecisionRoot("owner", "repo", seq);
  let session = await service.createSession(root);
  session = await service.putBinding(session.id, {
    adapter: "chatgpt-web",
    externalSessionRef: "conv-1",
    resumeUri: "https://chatgpt.com/c/conv-1",
  });
  const task = await service.createPlanTask(session.id);
  await service.putTaskContext(task.id, { ...context, workItem: root });
  const claim = await service.claimTask(task.id, { owner: "tab-a" });
  return {
    service, session, task, claim,
    baseUrl: `http://127.0.0.1:${bridge.getPort()}`,
    close: async () => {
      await bridge.stop();
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function page(href: string, withComposer = true) {
  const doc = new MockDocument();
  const win = new MockWindow();
  win.location.href = href;
  let sends = 0;
  if (withComposer) {
    doc.body.appendChild(new MockElement("textarea", { id: "prompt-textarea" }));
  }
  const send = new MockElement("button", { "data-testid": "send-button" });
  send.addEventListener("click", () => { sends++; });
  doc.body.appendChild(send);
  return { doc, win, sends: () => sends };
}

/**
 * Wraps the real HTTP transport and runs `during` once the named request has been answered,
 * modelling another tab persisting shared state while this tab's authorization is in flight.
 */
function transportWithHook(
  baseUrl: string,
  hook: { method: string; suffix: string; when?: (body: unknown) => boolean; during: () => void }
): BridgeTransport {
  const inner = new FetchBridgeTransport({ baseUrl });
  return {
    baseUrl,
    authToken: undefined,
    request: async <T>(method: string, url: string, body?: unknown, options?: { allow204?: boolean; signal?: AbortSignal }): Promise<T> => {
      const response = await inner.request<T>(method, url, body, options);
      if (method === hook.method && url.endsWith(hook.suffix) && (!hook.when || hook.when(body))) hook.during();
      return response;
    },
  };
}

const authorizingPhase = (phase: string) => (body: unknown): boolean =>
  (body as { progress?: { phase?: string } } | undefined)?.progress?.phase === phase;

describe("persisted Stop written during page authorization", () => {
  it("does not send after another tab persists Stop while the prompt authorization is in flight", async () => {
    const f = await realChain(21);
    try {
      const cp = new MemoryCheckpointStore();
      cp.set({
        schemaVersion: 1, tabId: cp.tabId, taskId: f.task.id, sessionId: f.session.id,
        leaseOwner: f.claim.lease.owner, leaseToken: f.claim.lease.token,
        leaseGeneration: f.claim.lease.generation, leaseExpiresAtMs: f.claim.lease.expiresAtMs,
        bindingGeneration: 1, step: "claimed", attemptId: "a", savedAtMs: Date.now(),
      });
      // Shared persisted run intent, as the userscript stores it per bridge URL.
      let enabled = true;
      const transport = transportWithHook(f.baseUrl, {
        method: "POST", suffix: "/heartbeat",
        when: authorizingPhase("prompt_submitting"),
        during: () => { enabled = false; },
      });
      const p = page("https://chatgpt.com/c/conv-1");
      const adapter = new ChatGptWebAdapter({
        doc: p.doc as unknown as Document, win: p.win as unknown as Window,
        stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 100,
      });
      const driver = new DecisionTabDriver({
        transport, checkpointStore: cp, adapter, shouldRun: () => enabled,
      });
      const outcome = await driver.runOnce();
      expect(p.sends()).toBe(0);
      expect(outcome?.status).not.toBe("completed");
      expect(f.service.getReceipt(f.task.id)?.type).not.toBe("result");
    } finally { await f.close(); }
  });

  it("does not navigate after another tab persists Stop while the navigation authorization is in flight", async () => {
    const f = await realChain(22);
    try {
      const cp = new MemoryCheckpointStore();
      cp.set({
        schemaVersion: 1, tabId: cp.tabId, taskId: f.task.id, sessionId: f.session.id,
        leaseOwner: f.claim.lease.owner, leaseToken: f.claim.lease.token,
        leaseGeneration: f.claim.lease.generation, leaseExpiresAtMs: f.claim.lease.expiresAtMs,
        bindingGeneration: 1, step: "claimed", attemptId: "a", savedAtMs: Date.now(),
      });
      let enabled = true;
      const transport = transportWithHook(f.baseUrl, {
        method: "POST", suffix: "/heartbeat",
        when: authorizingPhase("navigating"),
        during: () => { enabled = false; },
      });
      const p = page("https://chatgpt.com/");
      const adapter = new ChatGptWebAdapter({
        doc: p.doc as unknown as Document, win: p.win as unknown as Window,
        stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 100,
      });
      new DecisionTabDriver({ transport, checkpointStore: cp, adapter, shouldRun: () => enabled });
      const binding = f.service.getSession(f.session.id)!.binding!;
      await expect(adapter.resumeSession(f.service.getSession(f.session.id)!, binding))
        .rejects.toThrow("Driver disabled while authorizing the page action");
      expect(p.win.location.href).toBe("https://chatgpt.com/");
      expect(p.sends()).toBe(0);
    } finally { await f.close(); }
  });
});

describe("candidate evidence survives an unresolved block", () => {
  it("keeps the candidate across polls and page rebuilds until the operator resolves the block", async () => {
    const f = await realChain(23);
    try {
      const result: DecisionResult = {
        schemaVersion: 1, taskId: f.task.id, sessionId: f.session.id, kind: "plan",
        revision: f.task.revision, verdict: "ready",
        content: { plan: "p", acceptanceCriteria: [], risks: [], clarifications: [] },
        createdAtMs: Date.now(),
      };
      const cp = new MemoryCheckpointStore();
      cp.set({
        schemaVersion: 1, tabId: cp.tabId, taskId: f.task.id, sessionId: f.session.id,
        leaseOwner: f.claim.lease.owner, leaseToken: f.claim.lease.token,
        leaseGeneration: f.claim.lease.generation, leaseExpiresAtMs: f.claim.lease.expiresAtMs,
        bindingGeneration: 1, step: "result_extracted", candidateResult: result,
        attemptId: "a", savedAtMs: Date.now(),
      });
      let submissions = 0;
      const inner = new FetchBridgeTransport({ baseUrl: f.baseUrl });
      const transport: BridgeTransport = {
        baseUrl: f.baseUrl, authToken: undefined,
        request: async <T>(method: string, url: string, body?: unknown, options?: { allow204?: boolean; signal?: AbortSignal }): Promise<T> => {
          if (method === "POST" && url.endsWith("/result")) {
            submissions++;
            throw new Error("network unavailable");
          }
          return inner.request<T>(method, url, body, options);
        },
      };
      const p = page("https://chatgpt.com/c/conv-1", false);
      const adapter = new ChatGptWebAdapter({
        doc: p.doc as unknown as Document, win: p.win as unknown as Window,
        stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 100,
      });
      const driver = new DecisionTabDriver({ transport, checkpointStore: cp, adapter });

      for (let poll = 0; poll < DECISION_MAX_TRANSPORT_RECOVERIES; poll++) {
        await expect(driver.runOnce()).rejects.toThrow("network unavailable");
      }
      expect(submissions).toBe(DECISION_MAX_TRANSPORT_RECOVERIES);

      const exhausted = await driver.runOnce();
      expect(exhausted?.status).toBe("blocked");
      expect(f.service.getExecution(f.task.id)?.blocked?.reason).toBe("recovery_exhausted");
      expect(f.service.getReceipt(f.task.id)).toBeNull();
      expect(cp.get()?.candidateResult).toEqual(result);

      // Subsequent polls see the authoritative block; neither the candidate nor the receipt
      // obligation may be dropped while the block is unresolved.
      for (let poll = 0; poll < 3; poll++) {
        const settled = await driver.runOnce();
        expect(settled?.status).toBe("blocked");
        expect(cp.get()?.candidateResult).toEqual(result);
      }
      // A rebuilt page/driver resumes the same retained evidence.
      const rebuilt = new DecisionTabDriver({
        transport, checkpointStore: cp,
        adapter: new ChatGptWebAdapter({
          doc: p.doc as unknown as Document, win: p.win as unknown as Window,
          stabilizationMs: 1, checkIntervalMs: 1, timeoutMs: 100,
        }),
      });
      const afterRebuild = await rebuilt.runOnce();
      expect(afterRebuild?.status).toBe("blocked");
      expect(cp.get()?.candidateResult).toEqual(result);
      expect(submissions).toBe(DECISION_MAX_TRANSPORT_RECOVERIES);

      // Explicit operator resolution through the real client/bridge releases the block.
      const execution = f.service.getExecution(f.task.id)!;
      const client = new DecisionBridgeClient(f.baseUrl);
      expect(await client.unblockExecution({
        taskId: f.task.id, revision: f.task.revision,
        claimGeneration: f.claim.lease.generation, bindingGeneration: 1,
        leaseExpiresAtMs: f.claim.lease.expiresAtMs, blockedAtMs: execution.blocked!.atMs,
      })).toBe(true);

      await rebuilt.runOnce();
      // The stale candidate is never re-submitted, and the local evidence is dropped only
      // once the authority has released the blocked execution.
      expect(submissions).toBe(DECISION_MAX_TRANSPORT_RECOVERIES);
      expect(cp.get()?.candidateResult).toBeUndefined();
    } finally { await f.close(); }
  });
});


describe("PR156 active response recovery", () => {
  it.each([401, 403])("reports active heartbeat authentication failure %s immediately", async status => {
    const f = await realChain(31);
    const errors: Error[] = [];
    const auth = new BridgeHttpError("Unauthorized", "unauthorized", status);
    const driver = new DecisionTabDriver({
      transport: { baseUrl: f.baseUrl, authToken: undefined, request: async () => { throw auth; } },
      heartbeatIntervalMs: 10, onError: error => errors.push(error),
    });
    vi.useFakeTimers();
    try {
      driver.startHeartbeat(f.task, f.claim.lease);
      await vi.advanceTimersByTimeAsync(10);
      expect(errors).toEqual([auth]);
      await expect(driver.submitFailure(f.task.id, { ...f.claim.lease, error: "execution_failed" }))
        .rejects.toBe(auth);
    } finally { driver.stop(); vi.useRealTimers(); await f.close(); }
  });

  it("uses authoritative renewed expiry instead of dropping a stale local waiting checkpoint", async () => {
    const f = await realChain(32);
    try {
      await f.service.startTask(f.task.id, f.claim.lease);
      const cp = new MemoryCheckpointStore();
      cp.set({ schemaVersion: 1, tabId: cp.tabId, taskId: f.task.id, sessionId: f.session.id,
        leaseOwner: f.claim.lease.owner, leaseToken: f.claim.lease.token,
        leaseGeneration: 1, leaseExpiresAtMs: Date.now() - 1, bindingGeneration: 1,
        step: "waiting_response", baselineCount: 0, attemptId: "a", savedAtMs: Date.now() });
      const p = page("https://chatgpt.com/c/conv-1");
      const adapter = new ChatGptWebAdapter({ doc: p.doc as unknown as Document, win: p.win as unknown as Window });
      const result: DecisionResult = { schemaVersion: 1, taskId: f.task.id, sessionId: f.session.id,
        kind: "plan", revision: 1, verdict: "ready", createdAtMs: Date.now(),
        content: { plan: "p", acceptanceCriteria: [], risks: [], clarifications: [] } };
      const wait = vi.spyOn(adapter, "waitForExistingResponse").mockResolvedValue({ result });
      const driver = new DecisionTabDriver({ transport: new FetchBridgeTransport({ baseUrl: f.baseUrl }), checkpointStore: cp, adapter });
      expect((await driver.runOnce())?.status).toBe("completed");
      expect(wait).toHaveBeenCalledOnce();
      expect(f.service.getReceipt(f.task.id)?.claimGeneration).toBe(1);
      expect(p.sends()).toBe(0);
    } finally { await f.close(); }
  });

  it.each(["before", "during"])("blocks conversation drift %s response extraction without resending", async timing => {
    const f = await realChain(33);
    try {
      await f.service.startTask(f.task.id, f.claim.lease);
      const cp = new MemoryCheckpointStore();
      cp.set({ schemaVersion: 1, tabId: cp.tabId, taskId: f.task.id, sessionId: f.session.id,
        leaseOwner: f.claim.lease.owner, leaseToken: f.claim.lease.token,
        leaseGeneration: 1, leaseExpiresAtMs: f.claim.lease.expiresAtMs, bindingGeneration: 1,
        step: "waiting_response", baselineCount: 0, attemptId: "a", savedAtMs: Date.now() });
      const p = page(timing === "before" ? "https://chatgpt.com/c/unrelated" : "https://chatgpt.com/c/conv-1");
      const adapter = new ChatGptWebAdapter({ doc: p.doc as unknown as Document, win: p.win as unknown as Window });
      const wait = vi.spyOn(adapter, "waitForExistingResponse").mockImplementation(async () => {
        p.win.location.href = "https://chatgpt.com/c/unrelated";
        return { result: { schemaVersion: 1, taskId: f.task.id, sessionId: f.session.id,
          kind: "plan", revision: 1, verdict: "ready", createdAtMs: Date.now(),
          content: { plan: "p", acceptanceCriteria: [], risks: [], clarifications: [] } } };
      });
      const driver = new DecisionTabDriver({ transport: new FetchBridgeTransport({ baseUrl: f.baseUrl }), checkpointStore: cp, adapter });
      expect((await driver.runOnce())?.status).toBe("blocked");
      expect(wait).toHaveBeenCalledTimes(timing === "before" ? 0 : 1);
      expect(p.sends()).toBe(0);
      expect(f.service.getReceipt(f.task.id)).toBeNull();
      expect(f.service.getExecution(f.task.id)?.blocked?.reason).toBe("human_required");
    } finally { await f.close(); }
  });
});


it("preserves active response evidence on heartbeat auth interruption without a failure receipt", async () => {
  const f = await realChain(34);
  try {
    await f.service.startTask(f.task.id, f.claim.lease);
    const cp = new MemoryCheckpointStore();
    cp.set({ schemaVersion: 1, tabId: cp.tabId, taskId: f.task.id, sessionId: f.session.id,
      leaseOwner: f.claim.lease.owner, leaseToken: f.claim.lease.token,
      leaseGeneration: 1, leaseExpiresAtMs: f.claim.lease.expiresAtMs, bindingGeneration: 1,
      step: "waiting_response", baselineCount: 0, attemptId: "a", savedAtMs: Date.now() });
    const p = page("https://chatgpt.com/c/conv-1");
    const adapter = new ChatGptWebAdapter({ doc: p.doc as unknown as Document, win: p.win as unknown as Window });
    let waiting = false;
    vi.spyOn(adapter, "waitForExistingResponse").mockImplementation(async (_task, options) => {
      waiting = true;
      return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
    });
    const inner = new FetchBridgeTransport({ baseUrl: f.baseUrl });
    const auth = new BridgeHttpError("Unauthorized", "unauthorized", 401);
    const transport: BridgeTransport = { baseUrl: f.baseUrl, authToken: undefined,
      request: async <T>(method: string, url: string, body?: unknown, options?: { allow204?: boolean; signal?: AbortSignal }): Promise<T> => {
        if (waiting && url.endsWith("/heartbeat")) throw auth;
        return inner.request<T>(method, url, body, options);
      } };
    const errors: Error[] = [];
    const driver = new DecisionTabDriver({ transport, checkpointStore: cp, adapter,
      heartbeatIntervalMs: 5, onError: error => { errors.push(error); driver.stop(); } });
    await expect(driver.runOnce()).rejects.toThrow("Aborted");
    expect(errors).toEqual([auth]);
    expect(cp.get()?.step).toBe("waiting_response");
    expect(f.service.getReceipt(f.task.id)).toBeNull();
    expect(f.service.getTask(f.task.id)?.status).toBe("running");
    expect(p.sends()).toBe(0);
    waiting = false;
    const result: DecisionResult = { schemaVersion: 1, taskId: f.task.id, sessionId: f.session.id,
      kind: "plan", revision: 1, verdict: "ready", createdAtMs: Date.now(),
      content: { plan: "p", acceptanceCriteria: [], risks: [], clarifications: [] } };
    vi.mocked(adapter.waitForExistingResponse).mockResolvedValueOnce({ result });
    expect((await driver.runOnce())?.status).toBe("completed");
    expect(f.service.getReceipt(f.task.id)?.claimGeneration).toBe(1);
    expect(p.sends()).toBe(0);
  } finally { await f.close(); }
});


it("retains an actually expired sent checkpoint across native human blocking", async () => {
  const f = await realChain(35);
  try {
    await f.service.startTask(f.task.id, f.claim.lease);
    await f.service.heartbeatTask(f.task.id, { ...f.claim.lease, progress: { phase: "waiting_response", responseLength: 0 } });
    const task = f.service.getTask(f.task.id)!;
    const cp = new MemoryCheckpointStore();
    cp.set({ schemaVersion: 1, tabId: cp.tabId, taskId: f.task.id, sessionId: f.session.id,
      leaseOwner: f.claim.lease.owner, leaseToken: f.claim.lease.token,
      leaseGeneration: 1, leaseExpiresAtMs: task.lease!.expiresAtMs, bindingGeneration: 1,
      step: "waiting_response", baselineCount: 0, attemptId: "a", savedAtMs: Date.now() });
    const driver = new DecisionTabDriver({ transport: new FetchBridgeTransport({ baseUrl: f.baseUrl }), checkpointStore: cp });
    const now = vi.spyOn(Date, "now").mockReturnValue(task.lease!.expiresAtMs + 1);
    try {
      expect((await driver.runOnce())?.status).toBe("blocked");
      expect(cp.get()?.step).toBe("waiting_response");
      expect(await f.service.reclaimExpiredClaim({ taskId: task.id, revision: task.revision,
        claimGeneration: 1, bindingGeneration: 1, leaseExpiresAtMs: task.lease!.expiresAtMs })).toBe(true);
      expect((await driver.runOnce())?.status).toBe("blocked");
      expect(cp.get()?.step).toBe("waiting_response");
      expect(f.service.getTask(task.id)?.claimGeneration).toBe(1);
      expect(f.service.getReceipt(task.id)).toBeNull();
    } finally { now.mockRestore(); }
  } finally { await f.close(); }
});
