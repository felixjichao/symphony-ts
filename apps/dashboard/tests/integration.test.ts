import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createOperationalQueryService, type OperationalQueryService } from "@symphony/operations";
import { startDemo, close } from "../examples/server";
import { demoService } from "../examples/sources";
import { validateSnapshot } from "../src/validate";
describe("real reader → query → HTTP → same-origin proxy", () => {
  it("cleans up after a static listener startup failure and closes both listeners on stop", async () => {
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("No address");
    try { await expect(startDemo(demoService(), { port: address.port })).rejects.toMatchObject({ code: "EADDRINUSE" }); } finally { await close(occupied); }
    const host = await startDemo(demoService()); await host.stop();
    expect(host.upstream.listening).toBe(false);
    await expect(fetch(host.url)).rejects.toThrow();
  });
  it.each(["populated", "empty", "unavailable", "stale", "unknown"] as const)("serves %s through real composition", async scenario => {
    const real = demoService(scenario); let queries = 0;
    const service = { ...real, async getOperationalSnapshot() { queries++; return real.getOperationalSnapshot(); } };
    const host = await startDemo(service);
    try {
      const response = await fetch(`${host.url}/api/operations/snapshot`); expect(response.status).toBe(200); const data: unknown = await response.json(); validateSnapshot(data);
      expect(queries).toBe(1); expect(data.schemaVersion).toBe(1); expect(data.summary.anomalyCount).toBe(data.anomalies.length);
      if (scenario === "populated") { expect(data.work.map(w => w.key.key)).toEqual(["demo/alpha#1", "demo/beta#1"]); expect(data.work[0]?.waiting?.reason).toBe("waiting_for_ci"); }
      if (scenario === "empty") expect(data.work).toEqual([]);
      if (["stale", "unknown", "unavailable"].includes(scenario)) expect(data.sources.every(s => s.freshness.status === scenario)).toBe(true);
      const method = await fetch(`${host.url}/api/operations/snapshot`, { method: "POST" }); expect(method.status).toBe(405); expect(method.headers.get("allow")).toBe("GET"); expect(queries).toBe(1);
      expect((await fetch(`${host.url}/api/unknown`)).status).toBe(404); expect(queries).toBe(1);
      await close(host.upstream); expect((await fetch(`${host.url}/api/operations/snapshot`)).status).toBe(502);
    } finally { await host.stop(); }
  });
  it("preserves complete JSON bytes and upstream 500 sanitization", async () => {
    const real = createOperationalQueryService({ clock: () => 5, workKeys: [] });
    const data = await real.getOperationalSnapshot(); const good = await startDemo(real);
    try { expect(await (await fetch(`${good.url}/api/operations/snapshot`)).text()).toBe(JSON.stringify(data)); } finally { await good.stop(); }
    const bad = await startDemo({ ...real, async getOperationalSnapshot() { throw new Error("private"); } } satisfies OperationalQueryService);
    try { const response = await fetch(`${bad.url}/api/operations/snapshot`); expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "operational_snapshot_failed" }); } finally { await bad.stop(); }
  });
});
