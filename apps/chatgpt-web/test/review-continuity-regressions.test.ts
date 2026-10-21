import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DurableDecisionStore, DecisionService } from "@symphony/decision";
import {
  githubDecisionRoot,
  DECISION_MAX_TRANSPORT_RECOVERIES,
  type DecisionContextBundle,
  type DecisionResult,
  type DecisionSession,
} from "@symphony/domain/decision";
import { ChatGptWebAdapter } from "../src/adapter";
import { DecisionTabDriver } from "../src/driver";
import { MemoryCheckpointStore } from "../src/checkpoint";
import type { BridgeTransport } from "../src/transport";
import { MockDocument, MockElement, MockWindow } from "./mock-dom";

const context: DecisionContextBundle = {
  strategy: "connector",
  workItem: { provider: "github", key: "owner/repo#1" },
  repository: "owner/repo",
  prNumber: null,
  headSha: null,
};

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "continuity-regression-"));
  const store = new DurableDecisionStore({ storeDir: dir });
  await store.open();
  const service = new DecisionService(store);
  const session = await service.createSession(githubDecisionRoot("owner", "repo", 1));
  const task = await service.createPlanTask(session.id);
  const claim = await service.claimTask(task.id, { owner: "web" });
  return {
    store, service, session, task, claim,
    cleanup: async () => {
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function page(href: string) {
  const doc = new MockDocument();
  const win = new MockWindow();
  win.location.href = href;
  doc.body.appendChild(new MockElement("textarea", { id: "prompt-textarea" }));
  const send = new MockElement("button", { "data-testid": "send-button" });
  doc.body.appendChild(send);
  let clicks = 0;
  send.addEventListener("click", () => { clicks++; });
  return { doc, win, clicks: () => clicks };
}

describe("authorized awaits re-check cancellation before page side effects", () => {
  it("Stop during the bootstrap authorization await never sends", async () => {
    const f = await fixture();
    try {
      const { doc, win, clicks } = page("https://chatgpt.com/");
      const abort = new AbortController();
      const adapter = new ChatGptWebAdapter({
        doc: doc as unknown as Document,
        win: win as unknown as Window,
        checkIntervalMs: 1,
        timeoutMs: 20,
      });
      adapter.setStepListener(async (step) => {
        if (step === "bootstrap_submitting") {
          await Promise.resolve();
          abort.abort();
        }
      });
      await expect(adapter.createSession(f.session, { signal: abort.signal }))
        .rejects.toThrow("Aborted before sending the bootstrap prompt");
      expect(clicks()).toBe(0);
    } finally { await f.cleanup(); }
  });

  it("Stop during the task-prompt authorization await never sends", async () => {
    const f = await fixture();
    try {
      const { doc, win, clicks } = page("https://chatgpt.com/c/conv-1");
      const abort = new AbortController();
      const adapter = new ChatGptWebAdapter({
        doc: doc as unknown as Document,
        win: win as unknown as Window,
        checkIntervalMs: 1,
        timeoutMs: 20,
      });
      adapter.setStepListener(async (step) => {
        if (step === "prompt_submitting") {
          await Promise.resolve();
          abort.abort();
        }
      });
      const session: DecisionSession = {
        ...f.session,
        binding: { schemaVersion: 1, adapter: "chatgpt-web", externalSessionRef: "conv-1", resumeUri: null, generation: 1 },
        bindingGeneration: 1,
      };
      await expect(adapter.executeTask(
        { task: f.task, session, context },
        { signal: abort.signal }
      )).rejects.toThrow("Aborted before sending the task prompt");
      expect(clicks()).toBe(0);
    } finally { await f.cleanup(); }
  });

  it("a page that leaves the bound conversation during the await is never sent to", async () => {
    const f = await fixture();
    try {
      const { doc, win, clicks } = page("https://chatgpt.com/c/conv-1");
      const adapter = new ChatGptWebAdapter({
        doc: doc as unknown as Document,
        win: win as unknown as Window,
        checkIntervalMs: 1,
        timeoutMs: 20,
      });
      adapter.setStepListener(async (step) => {
        if (step === "prompt_submitting") {
          await Promise.resolve();
          win.location.href = "https://chatgpt.com/c/other-conversation";
        }
      });
      const session: DecisionSession = {
        ...f.session,
        binding: { schemaVersion: 1, adapter: "chatgpt-web", externalSessionRef: "conv-1", resumeUri: null, generation: 1 },
        bindingGeneration: 1,
      };
      await expect(adapter.executeTask({ task: f.task, session, context }))
        .rejects.toThrow(/left bound conversation "conv-1"/);
      expect(clicks()).toBe(0);
    } finally { await f.cleanup(); }
  });
});

describe("candidate result recovery budget", () => {
  it("stops re-submitting at the budget, verifies the receipt first and blocks with the candidate retained", async () => {
    const f = await fixture();
    try {
      const cp = new MemoryCheckpointStore();
      const result: DecisionResult = {
        schemaVersion: 1,
        taskId: f.task.id,
        sessionId: f.session.id,
        kind: "plan",
        revision: f.task.revision,
        verdict: "ready",
        content: { plan: "p", acceptanceCriteria: [], risks: [], clarifications: [] },
        createdAtMs: Date.now(),
      };
      cp.set({
        schemaVersion: 1, tabId: cp.tabId, taskId: f.task.id, sessionId: f.session.id,
        leaseOwner: f.claim.lease.owner, leaseToken: f.claim.lease.token,
        leaseGeneration: f.claim.lease.generation, leaseExpiresAtMs: f.claim.lease.expiresAtMs,
        bindingGeneration: 0, step: "result_extracted", candidateResult: result,
        attemptId: "regression", savedAtMs: Date.now(),
      });
      let submissions = 0;
      let blocks = 0;
      let receiptReads = 0;
      const transport: BridgeTransport = {
        baseUrl: "http://regression",
        request: async <T>(method: string, url: string, body?: unknown): Promise<T> => {
          if (method === "POST" && url.endsWith("/result")) {
            submissions++;
            throw new Error("network unavailable");
          }
          if (method === "POST" && url.endsWith("/block")) {
            blocks++;
            const fence = body as { owner: string; token: string; generation: number; reason: string };
            await f.service.blockExecution(f.task.id, fence);
            return {} as T;
          }
          if (url.endsWith("/receipt")) {
            receiptReads++;
            return { receipt: f.service.getReceipt(f.task.id) } as T;
          }
          if (url.includes("/sessions/")) {
            return { session: f.service.getSession(f.session.id) } as T;
          }
          return { task: f.service.getTask(f.task.id), execution: f.service.getExecution(f.task.id) } as T;
        },
      };
      const driver = new DecisionTabDriver({ transport, checkpointStore: cp });

      for (let attempt = 0; attempt < DECISION_MAX_TRANSPORT_RECOVERIES; attempt++) {
        await expect(driver.runOnce()).rejects.toThrow("network unavailable");
      }
      expect(submissions).toBe(DECISION_MAX_TRANSPORT_RECOVERIES);
      expect(cp.get()?.candidateResult).toEqual(result);

      const exhausted = await driver.runOnce();
      expect(exhausted?.status).toBe("blocked");
      expect((exhausted as { reason?: string }).reason).toBe("recovery_exhausted");
      // Receipt verified before the budget ended the attempt; no seventh submission.
      expect(receiptReads).toBeGreaterThan(0);
      expect(submissions).toBe(DECISION_MAX_TRANSPORT_RECOVERIES);
      expect(blocks).toBe(1);
      expect(f.service.getExecution(f.task.id)?.blocked?.reason).toBe("recovery_exhausted");
      expect(f.service.getReceipt(f.task.id)).toBeNull();
      // The candidate and its verification duty survive the block.
      expect(cp.get()?.candidateResult).toEqual(result);

      const settled = await driver.runOnce();
      expect(settled?.status).toBe("blocked");
      expect(submissions).toBe(DECISION_MAX_TRANSPORT_RECOVERIES);
      expect(cp.get()).toBeNull();
    } finally { await f.cleanup(); }
  });

  it("a receipt that already accepted the candidate completes without another submission", async () => {
    const f = await fixture();
    try {
      const cp = new MemoryCheckpointStore();
      const result: DecisionResult = {
        schemaVersion: 1,
        taskId: f.task.id,
        sessionId: f.session.id,
        kind: "plan",
        revision: f.task.revision,
        verdict: "ready",
        content: { plan: "p", acceptanceCriteria: [], risks: [], clarifications: [] },
        createdAtMs: Date.now(),
      };
      cp.set({
        schemaVersion: 1, tabId: cp.tabId, taskId: f.task.id, sessionId: f.session.id,
        leaseOwner: f.claim.lease.owner, leaseToken: f.claim.lease.token,
        leaseGeneration: f.claim.lease.generation, leaseExpiresAtMs: f.claim.lease.expiresAtMs,
        bindingGeneration: 0, step: "result_extracted", candidateResult: result,
        attemptId: "regression", savedAtMs: Date.now(),
        recoveryFailures: DECISION_MAX_TRANSPORT_RECOVERIES,
      });
      await f.service.startTask(f.task.id, {
        owner: f.claim.lease.owner, token: f.claim.lease.token,
        generation: f.claim.lease.generation,
      });
      await f.service.submitResult(f.task.id, {
        owner: f.claim.lease.owner, token: f.claim.lease.token,
        generation: f.claim.lease.generation, result,
      });
      let submissions = 0;
      const transport: BridgeTransport = {
        baseUrl: "http://regression",
        request: async <T>(method: string, url: string): Promise<T> => {
          if (method === "POST" && url.endsWith("/result")) submissions++;
          if (url.endsWith("/receipt")) return { receipt: f.service.getReceipt(f.task.id) } as T;
          if (url.includes("/sessions/")) return { session: f.service.getSession(f.session.id) } as T;
          return { task: f.service.getTask(f.task.id), execution: f.service.getExecution(f.task.id) } as T;
        },
      };
      const driver = new DecisionTabDriver({ transport, checkpointStore: cp });
      const outcome = await driver.runOnce();
      expect(outcome?.status).toBe("completed");
      expect(submissions).toBe(0);
      expect(cp.get()).toBeNull();
    } finally { await f.cleanup(); }
  });
});
