import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { githubDecisionRoot } from "@symphony/domain";
import { DecisionBridge, DecisionBridgeClient, DecisionService, DurableDecisionStore, type ReclaimDecisionClaim } from "./index";

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "continuity-"));
  let now = 1000;
  const store = new DurableDecisionStore({ storeDir: dir });
  await store.open();
  const service = new DecisionService(store, { clock: () => now });
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
