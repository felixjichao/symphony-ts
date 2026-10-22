import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DecisionService, DurableDecisionStore } from "@symphony/decision";
import { githubDecisionRoot, type DecisionExecutionRequest } from "@symphony/domain/decision";
import { ChatGptWebAdapter } from "../src/adapter";
import { DecisionTabDriver } from "../src/driver";
import { MemoryCheckpointStore } from "../src/checkpoint";
import type { BridgeTransport } from "../src/transport";
import { MockDocument, MockElement, MockWindow } from "./mock-dom";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function turn(text: string) {
  const node = new MockElement("div", { "data-message-author-role": "assistant" });
  node.textContent = text;
  return node;
}

async function fixture(restored = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "windowed-progress-"));
  const store = new DurableDecisionStore({ storeDir: dir });
  await store.open();
  let now = 1000;
  const service = new DecisionService(store, { clock: () => now });
  let session = await service.createSession(githubDecisionRoot("owner", "repo", 156));
  session = await service.putBinding(session.id, { adapter: "chatgpt-web", externalSessionRef: "conv", resumeUri: "https://chatgpt.com/c/conv" });
  const task = await service.createPlanTask(session.id);
  const claim = await service.claimTask(task.id, { owner: "web" });
  const doc = new MockDocument();
  const win = new MockWindow();
  win.location.href = "https://chatgpt.com/c/conv";
  doc.body.appendChild(new MockElement("textarea", { id: "prompt-textarea" }));
  const send = new MockElement("button", { "data-testid": "send-button" });
  doc.body.appendChild(send);
  const old = Array.from({ length: 20 }, (_, i) => turn(`Old response ${i}`));
  old.forEach(node => doc.body.appendChild(node));
  const response = turn("New response");
  const stop = new MockElement("button", { "data-testid": "stop-button" });
  let sent = false;
  send.addEventListener("click", () => {
    old.slice(0, 13).forEach(node => doc.body.removeChild(node));
    doc.body.appendChild(response);
    doc.body.appendChild(stop);
    sent = true;
  });
  let adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window,
    responseTimeoutMs: 3_600_000, checkIntervalMs: 1, stabilizationMs: 1 });
  const cp = new MemoryCheckpointStore();
  cp.set({ schemaVersion: 1, tabId: cp.tabId, taskId: task.id, sessionId: session.id,
    leaseOwner: claim.lease.owner, leaseToken: claim.lease.token, leaseGeneration: claim.lease.generation,
    leaseExpiresAtMs: claim.lease.expiresAtMs, bindingGeneration: session.bindingGeneration,
    step: "started", attemptId: "attempt", savedAtMs: now, targetConvId: "conv" });
  const errors: unknown[] = [];
  const requests: Promise<unknown>[] = [];
  const transport: BridgeTransport = { baseUrl: "http://local", authToken: undefined,
    request: async <T>(_method: string, _url: string, body?: unknown): Promise<T> => {
      try {
        const request = service.heartbeatTask(task.id, body as Parameters<DecisionService["heartbeatTask"]>[1]);
        requests.push(request.catch(() => undefined));
        return await request as T;
      }
      catch (error) { errors.push(error); throw error; }
    } };
  let driver = new DecisionTabDriver({ transport, adapter, checkpointStore: cp, heartbeatIntervalMs: 1000 });
  const request: DecisionExecutionRequest = { task, session, context: { strategy: "connector", workItem: session.root,
    repository: "owner/repo", prNumber: null, headSha: null } };
  let abort = new AbortController();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let pending = adapter.executeTask(request, { signal: abort.signal }).catch(error => error);
  await vi.waitFor(() => expect(sent).toBe(true));
  if (restored) {
    abort.abort();
    await pending;
    abort = new AbortController();
    adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window,
      responseTimeoutMs: 3_600_000, checkIntervalMs: 1, stabilizationMs: 1 });
    driver = new DecisionTabDriver({ transport, adapter, checkpointStore: cp, heartbeatIntervalMs: 1000 });
    pending = adapter.waitForExistingResponse(task, { baselineCount: 20, signal: abort.signal }).catch(error => error);
  }
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  driver.startHeartbeat(task, claim.lease);
  return { doc, win, old, response, stop, adapter, task, service, errors,
    tick: async (time: number) => { now = time; await vi.advanceTimersByTimeAsync(1000); await Promise.all(requests); },
    cleanup: async () => { driver.stopHeartbeat(); abort.abort(); await pending; await store.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}

describe("DOM windowing through Driver → Decision progress authority (SPEC §4 extension)", () => {
  it.each([false, true])("renews a growing windowed response beyond ten minutes (restored=%s)", async restored => {
    const f = await fixture(restored);
    try {
      for (let i = 1; i <= 14; i++) {
        f.response.textContent += ` more content ${i}`;
        await f.tick(1000 + i * 50_000);
      }
      expect(f.errors).toEqual([]);
      expect(f.service.getExecution(f.task.id)?.lastProgressAtMs).toBe(701_000);
      expect(f.service.getTask(f.task.id)?.lease?.expiresAtMs).toBeGreaterThan(701_000);
    } finally { await f.cleanup(); }
  });
  it("still rejects renewal ten minutes after response growth stops", async () => {
    const f = await fixture();
    try {
      f.response.textContent += " growth";
      await f.tick(51_000);
      const last = f.service.getExecution(f.task.id)!.lastProgressAtMs;
      for (let i = 2; i <= 14; i++) await f.tick(1000 + i * 50_000);
      expect(f.service.getExecution(f.task.id)?.lastProgressAtMs).toBe(last);
      expect(f.errors.some(error => String(error).includes("progress deadline"))).toBe(true);
    } finally { await f.cleanup(); }
  });

  it.each(["old-turn", "route-drift", "static-rerender"])("does not renew from %s changes", async scenario => {
    const f = await fixture();
    try {
      if (scenario !== "route-drift") f.doc.body.removeChild(f.response);
      else f.win.location.href = "https://chatgpt.com/c/other";
      for (let i = 1; i <= 14; i++) {
        if (scenario === "old-turn") f.old.at(-1)!.textContent += ` old edit ${i}`;
        if (scenario === "route-drift") f.response.textContent += ` wrong route ${i}`;
        if (scenario === "static-rerender") {
          const clone = turn("Old response 19");
          f.doc.body.appendChild(clone);
          await f.tick(1000 + i * 50_000);
          f.doc.body.removeChild(clone);
        } else await f.tick(1000 + i * 50_000);
      }
      expect(f.service.getExecution(f.task.id)?.responseLength).toBe(0);
      expect(f.errors.some(error => String(error).includes("progress deadline"))).toBe(true);
    } finally { await f.cleanup(); }
  });
});
