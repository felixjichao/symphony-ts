import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateStoreRecord } from "./store";
import { describe, expect, it } from "vitest";
import { githubDecisionRoot } from "@symphony/domain";
import { DecisionBridge, DecisionBridgeClient, DecisionService, DurableDecisionStore, type ReclaimDecisionClaim } from "./index";

async function fixture(authorizeExecution?: () => Promise<boolean>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "continuity-"));
  let now = 1000;
  const store = new DurableDecisionStore({ storeDir: dir });
  await store.open();
  const service = new DecisionService(store, { clock: () => now, authorizeExecution });
  const session = await service.createSession(githubDecisionRoot("owner", "repo", 1));
  const task = await service.createPlanTask(session.id);
  const claimed = await service.claimTask(task.id, { owner: "web", ttlMs: 1000 });
  const expected: ReclaimDecisionClaim = { taskId: task.id, revision: task.revision,
    claimGeneration: claimed.task.claimGeneration, bindingGeneration: 0,
    leaseExpiresAtMs: claimed.task.lease!.expiresAtMs };
  return { service, store, expected, claimed, setTime: (time: number) => { now = time; },
    cleanup: async () => { await store.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}
describe("Decision continuity authority", () => {
  it("keeps valid claims, atomically releases one expired generation, and rejects stale reclaim", async () => {
    const f = await fixture();
    try {
      expect(await f.service.reclaimExpiredClaim(f.expected)).toBe(false);
      f.setTime(2000);
      const results = await Promise.all([f.service.reclaimExpiredClaim(f.expected), f.service.reclaimExpiredClaim(f.expected)]);
      expect(results.sort()).toEqual([false, true]);
      expect(f.service.getTask(f.expected.taskId)?.status).toBe("pending");
      const next = await f.service.claimTask(f.expected.taskId, { owner: "new-web" });
      expect(next.task.claimGeneration).toBeGreaterThan(f.expected.claimGeneration);
      expect(await f.service.reclaimExpiredClaim(f.expected)).toBe(false);
      expect(f.service.getTask(f.expected.taskId)?.lease?.owner).toBe("new-web");
      expect(JSON.stringify(f.service.continuityWork())).not.toContain(f.claimed.task.lease!.token);
    } finally { await f.cleanup(); }
  });
  it("a renewed lease and stale binding/revision cannot be reclaimed", async () => {
    const f = await fixture();
    try {
      f.setTime(1500);
      await f.service.heartbeatTask(f.expected.taskId, { owner: "web", token: f.claimed.task.lease!.token, generation: f.expected.claimGeneration, ttlMs: 2000 });
      f.setTime(2100);
      expect(await f.service.reclaimExpiredClaim(f.expected)).toBe(false);
      expect(f.service.getTask(f.expected.taskId)?.lease?.expiresAtMs).toBe(3500);
      f.setTime(4000);
      expect(await f.service.reclaimExpiredClaim({ ...f.expected, leaseExpiresAtMs: 3500, bindingGeneration: 1 })).toBe(false);
      expect(await f.service.reclaimExpiredClaim({ ...f.expected, leaseExpiresAtMs: 3500, revision: f.expected.revision + 1 })).toBe(false);
    } finally { await f.cleanup(); }
  });
  it("supports authenticated remote observation and explicit fenced reclaim", async () => {
    const f = await fixture();
    const bridge = new DecisionBridge(f.service, { port: 0, authToken: "continuity-test" });
    try {
      const { port } = await bridge.start();
      const client = new DecisionBridgeClient(`http://127.0.0.1:${port}`, { authToken: "continuity-test" });
      expect((await client.continuityWork())[0]?.tasks[0]?.owner).toBe("web");
      f.setTime(2000);
      expect(await client.reclaimExpiredClaim(f.expected)).toBe(true);
      expect((await client.continuityWork())[0]?.tasks[0]?.status).toBe("pending");
      const again = await f.service.claimTask(f.expected.taskId, { owner: "web", ttlMs: 1000 });
      f.setTime(again.task.lease!.expiresAtMs);
      expect(await client.reclaimExpiredClaim({ ...f.expected, claimGeneration: again.task.claimGeneration,
        leaseExpiresAtMs: again.task.lease!.expiresAtMs })).toBe(true);
      expect((await client.continuityWork())[0]?.tasks[0]?.status).toBe("pending");
      const denied = await fetch(`http://127.0.0.1:${port}/v1/continuity/reclaim`, { method: "POST", body: "{}" });
      expect(denied.status).toBe(401);
    } finally { await bridge.stop(); await f.cleanup(); }
  });
});

it("bridge startup preserves expired claims until work-level policy delegates reclaim", async () => {
  const f = await fixture();
  const bridge = new DecisionBridge(f.service, { port: 0 });
  try {
    f.setTime(f.expected.leaseExpiresAtMs);
    const { port } = await bridge.start();
    const client = new DecisionBridgeClient(`http://127.0.0.1:${port}`);
    expect((await client.continuityWork())[0]?.tasks[0]?.status).toBe("claimed");
    expect(f.service.getTask(f.expected.taskId)?.lease).toEqual(f.claimed.task.lease);
  } finally { await bridge.stop(); await f.cleanup(); }
});

it("bridge stop shares a completion barrier and a stopped bridge can restart safely", async () => {
  const f = await fixture();
  const bridge = new DecisionBridge(f.service, { port: 0 });
  try {
    await Promise.all([bridge.start(), bridge.start()]);
    const first = bridge.stop();
    expect(bridge.stop()).toBe(first);
    await first;
    expect(bridge.getPort()).toBe(null);
    await bridge.start();
    expect(bridge.getPort()).not.toBe(null);
  } finally { await bridge.stop(); await f.cleanup(); }
});

it("heartbeat does not manufacture progress and stalled execution cannot renew forever", async () => {
  const f = await fixture();
  try {
    const credentials = { owner: "web", token: f.claimed.lease.token, generation: f.claimed.lease.generation };
    const before = f.service.getExecution(f.expected.taskId)!;
    f.setTime(1500);
    await f.service.heartbeatTask(f.expected.taskId, { ...credentials, ttlMs: 1_000_000 });
    expect(f.service.getExecution(f.expected.taskId)?.lastProgressAtMs).toBe(before.lastProgressAtMs);
    f.setTime(before.deadlineAtMs + 1);
    await expect(f.service.heartbeatTask(f.expected.taskId, credentials)).rejects.toThrow("progress deadline");
    expect(f.service.getTask(f.expected.taskId)?.lease?.expiresAtMs).toBe(1_001_500);
  } finally { await f.cleanup(); }
});

it("new response growth advances progress but repeated phase/content and backward stages do not", async () => {
  const f = await fixture();
  try {
    const credentials = { owner: "web", token: f.claimed.lease.token, generation: f.claimed.lease.generation };
    f.setTime(1100);
    await f.service.heartbeatTask(f.expected.taskId, { ...credentials, progress: { phase: "waiting_response", responseLength: 10 } });
    const progress = f.service.getExecution(f.expected.taskId)!;
    f.setTime(1200);
    await f.service.heartbeatTask(f.expected.taskId, { ...credentials, progress: { phase: "waiting_response", responseLength: 10 } });
    expect(f.service.getExecution(f.expected.taskId)).toEqual(progress);
    f.setTime(1300);
    await f.service.heartbeatTask(f.expected.taskId, { ...credentials, progress: { phase: "navigating", responseLength: 0 } });
    expect(f.service.getExecution(f.expected.taskId)).toEqual(progress);
    f.setTime(1400);
    await f.service.heartbeatTask(f.expected.taskId, { ...credentials, progress: { phase: "waiting_response", responseLength: 11 } });
    expect(f.service.getExecution(f.expected.taskId)?.lastProgressAtMs).toBe(1400);
  } finally { await f.cleanup(); }
});

it("lost execution after a possible prompt is blocked durably rather than replayed", async () => {
  const f = await fixture();
  try {
    const credentials = { owner: "web", token: f.claimed.lease.token, generation: f.claimed.lease.generation };
    await f.service.heartbeatTask(f.expected.taskId, { ...credentials, ttlMs: 1000, progress: { phase: "prompt_submitting", responseLength: 0 } });
    f.setTime(2000);
    expect(await f.service.reclaimExpiredClaim(f.expected)).toBe(true);
    expect(f.service.getExecution(f.expected.taskId)?.blocked?.reason).toBe("human_required");
    expect(await f.service.getNextTask()).toBeNull();
    await f.store.close(); await f.store.open();
    expect(f.service.continuityWork()[0]?.tasks[0]?.execution?.blocked?.unblock).toContain("receipt");
    expect(await f.service.reclaimExpiredClaim(f.expected)).toBe(false);
    await expect(f.service.claimTask(f.expected.taskId, { owner: "other-tab" })).rejects.toThrow();
    expect(await f.service.unblockExecution({ ...f.expected, claimGeneration: 99 })).toBe(false);
    expect(await f.service.unblockExecution(f.expected)).toBe(true);
    const next = await f.service.claimTask(f.expected.taskId, { owner: "other-tab" });
    expect(next.lease.generation).toBe(2);
    await expect(f.service.startTask(f.expected.taskId, credentials)).rejects.toThrow();
  } finally { await f.cleanup(); }
});

it("recovery budget survives reclaim and store reopen, then converges to blocked", async () => {
  const f = await fixture();
  try {
    let expected = f.expected;
    for (let attempt = 0; attempt < 3; attempt++) {
      f.setTime(expected.leaseExpiresAtMs);
      expect(await f.service.reclaimExpiredClaim(expected)).toBe(true);
      const claimed = await f.service.claimTask(expected.taskId, { owner: "replacement", ttlMs: 1000 });
      expected = { ...expected, claimGeneration: claimed.lease.generation, leaseExpiresAtMs: claimed.lease.expiresAtMs };
      await f.store.close(); await f.store.open();
    }
    f.setTime(expected.leaseExpiresAtMs);
    expect(await f.service.reclaimExpiredClaim(expected)).toBe(true);
    expect(f.service.getExecution(expected.taskId)?.blocked?.reason).toBe("recovery_exhausted");
    expect(f.service.getExecution(expected.taskId)?.recoveryAttempts).toBe(3);
    expect(await f.service.getNextTask()).toBeNull();
  } finally { await f.cleanup(); }
});

it("auth blocking is a nonterminal fenced fact, not a failed task or result receipt", async () => {
  const f = await fixture();
  try {
    const credentials = { owner: "web", token: f.claimed.lease.token, generation: f.claimed.lease.generation };
    await f.service.blockExecution(f.expected.taskId, { ...credentials, reason: "auth_required" });
    expect(f.service.getTask(f.expected.taskId)?.status).toBe("claimed");
    expect(f.service.getReceipt(f.expected.taskId)).toBeNull();
    expect(f.service.getPlan(f.expected.taskId)?.status).toBe("pending");
    await expect(f.service.startTask(f.expected.taskId, credentials)).rejects.toThrow("blocked");
    await expect(f.service.heartbeatTask(f.expected.taskId, credentials)).rejects.toThrow("blocked");
    const serialized = JSON.stringify(f.service.continuityWork());
    expect(serialized).not.toContain(f.claimed.lease.token);
    await f.service.blockExecution(f.expected.taskId, { ...credentials, reason: "auth_required" });
    expect(f.service.getExecution(f.expected.taskId)?.blocked?.reason).toBe("auth_required");
  } finally { await f.cleanup(); }
});

it("rebind budgets are idempotent and old binding/lease progress is fenced", async () => {
  const f = await fixture();
  try {
    let claimed = f.claimed;
    const sid = claimed.session.id;
    for (let binding = 0; binding < 3; binding++) {
      const credentials = { owner: claimed.lease.owner, token: claimed.lease.token, generation: claimed.lease.generation };
      const params = { adapter: "chatgpt-web", externalSessionRef: `conversation-${binding}`, resumeUri: null,
        expectedGeneration: binding, operationKey: `rebind-${binding}`, ...credentials };
      const session = await f.service.rebindSession(sid, params);
      expect(session.bindingGeneration).toBe(binding + 1);
      expect((await f.service.rebindSession(sid, params)).bindingGeneration).toBe(binding + 1);
      expect(f.service.getExecution(claimed.task.id)?.recoveryAttempts).toBe(binding + 1);
      claimed = await f.service.claimTask(claimed.task.id, { owner: "replacement", ttlMs: 1000 });
      await expect(f.service.heartbeatTask(claimed.task.id, { ...credentials,
        progress: { phase: "waiting_response", responseLength: 999 } })).rejects.toThrow();
    }
    await expect(f.service.rebindSession(sid, { adapter: "chatgpt-web", externalSessionRef: "last", resumeUri: null,
      expectedGeneration: 3, operationKey: "exhausted", owner: claimed.lease.owner,
      token: claimed.lease.token, generation: claimed.lease.generation })).rejects.toThrow("blocked");
    expect(f.service.getSession(sid)?.bindingGeneration).toBe(3);
    expect(f.service.getExecution(claimed.task.id)?.blocked?.reason).toBe("recovery_exhausted");
    expect(f.service.getTask(claimed.task.id)?.lease?.generation).toBe(claimed.lease.generation);
  } finally { await f.cleanup(); }
});

it("refreshes external admission before mutation, then revalidates supersede and lease authority", async () => {
  let allowed = false;
  const f = await fixture(async () => allowed);
  try {
    const credentials = { owner: "web", token: f.claimed.lease.token, generation: f.claimed.lease.generation };
    await expect(f.service.heartbeatTask(f.expected.taskId, { ...credentials,
      progress: { phase: "navigating", responseLength: 0 } })).rejects.toThrow("no longer current");
    expect(f.service.getTask(f.expected.taskId)?.lease?.expiresAtMs).toBe(f.expected.leaseExpiresAtMs);
    await expect(f.service.rebindSession(f.claimed.session.id, { ...credentials, adapter: "chatgpt-web",
      externalSessionRef: "new", resumeUri: null, expectedGeneration: 0 })).rejects.toThrow("no longer current");
    expect(f.service.getSession(f.claimed.session.id)?.bindingGeneration).toBe(0);
    allowed = true;
    await f.service.supersedeTask(f.expected.taskId);
    await expect(f.service.heartbeatTask(f.expected.taskId, { ...credentials,
      progress: { phase: "prompt_submitting", responseLength: 0 } })).rejects.toThrow();
    expect(f.service.getTask(f.expected.taskId)?.status).toBe("superseded");
  } finally { await f.cleanup(); }
});

it("rejects corrupted progress phases while preserving compatibility with pre-metadata stores", async () => {
  const f = await fixture();
  try {
    const state = f.store.getState();
    Object.assign(state.executions![f.expected.taskId]!, { phase: "not-an-execution-phase" });
    expect(() => validateStoreRecord(state)).toThrow("Invalid execution facts");
    const legacy = f.store.getState();
    delete (legacy as { executions?: unknown }).executions;
    expect(() => validateStoreRecord(legacy)).not.toThrow();
  } finally { await f.cleanup(); }
});
