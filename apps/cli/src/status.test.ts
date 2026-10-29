import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DecisionBridge, DecisionBridgeClient, DecisionService, DurableDecisionStore } from "@symphony/decision";
import { formatWorkKey, type OperationalSnapshot } from "@symphony/domain";
import { parseCliArgs } from "./args";
import { createStatusQuery, githubStatusSource, startStatusSurface } from "./status";
import { statusFacts, statusKeys, statusScenarios, statusTime } from "./status-fixtures";
const assets = fileURLToPath(new URL("../dist/status-assets", import.meta.url));
describe("production status composition (SPEC §13 adjacent / #140)", () => {
  it.each(statusScenarios)("preserves operations meaning and work isolation: %s", async scenario => {
    const sources = statusFacts(scenario);
    const site = await startStatusSurface({ workKeys: statusKeys, assets }, sources);
    try {
      const result = await fetch(`${site.url}/api/operations/snapshot`);
      expect(result.status).toBe(200);
      const wire = await result.json() as OperationalSnapshot;
      expect(wire).toEqual(await createStatusQuery({ workKeys: statusKeys }, sources).getOperationalSnapshot());
      expect(wire.work.map((work: { key: unknown }) => work.key)).toEqual(statusKeys);
      const a = wire.work[0]!;
      if (scenario === "healthy") { expect(a.phase).toBe("coding"); expect(wire.health).toBe("healthy"); }
      if (scenario === "ci") expect(a.waiting?.reason).toBe("waiting_for_ci");
      if (scenario === "review") expect(a.waiting?.reason).toBe("waiting_for_review");
      if (scenario === "executor-wait") expect(a.waiting?.reason).toBe("waiting_for_executor");
      if (scenario === "needs_human" || scenario === "needs_clarification") { expect(a.attention).toBe("needs_human"); expect(a.waiting?.reason).toBe(scenario); }
      if (scenario === "stale") expect(a.freshness.runtime.status).toBe("stale");
      if (scenario === "partial") { expect(a.freshness.github.status).toBe("unavailable"); expect(wire.work[1]!.freshness.github.status).toBe("fresh"); expect(JSON.stringify(wire)).not.toContain("private credential"); }
      if (scenario === "active-inventory") {
        expect(wire.executors.map(({ id, status, currentWork }) => ({ id, status, currentWork }))).toEqual([
          { id: "active", status: "busy", currentWork: statusKeys[0] },
          { id: "idle", status: "online", currentWork: null },
        ]);
      }
      if (scenario === "empty-inventory" || scenario === "unknown-inventory" || scenario === "unavailable-inventory") {
        expect(wire.executors).toEqual([]);
        expect(wire.sources.find((source: { source: string }) => source.source === "executor")?.freshness.status).toBe(scenario === "empty-inventory" ? "fresh" : scenario === "unknown-inventory" ? "unknown" : "unavailable");
      }
      if (scenario === "completed" || scenario === "terminal") expect(a.phase).toBe("completed");
      const code = { conflict: "conflicting_active_review_tasks", "target-mismatch": "review_target_head_mismatch", "approval-mismatch": "review_approval_head_mismatch", "result-mismatch": "review_result_target_mismatch", terminal: "execution_on_terminal_work" }[scenario as "conflict"];
      if (code) { expect(wire.anomalies.some((anomaly: { code: string }) => anomaly.code === code)).toBe(true); expect(wire.health).toBe("degraded"); }
      for (const work of wire.work) {
        for (const anomaly of wire.anomalies.filter((item: { workKey: unknown }) => item.workKey && JSON.stringify(item.workKey) === JSON.stringify(work.key))) {
          expect(JSON.stringify(anomaly)).not.toContain(work.key.key === statusKeys[0]!.key ? statusKeys[1]!.key : statusKeys[0]!.key);
        }
      }
      const html = await fetch(site.url).then(response => response.text());
      expect(html).toContain('data-mode="production"'); expect(html).not.toContain('/src/');
      for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) expect((await fetch(`${site.url}/api/operations/snapshot`, { method })).status).toBe(405);
      expect((await fetch(`${site.url}/api/unknown`)).status).toBe(404);
    } finally { await site.stop(); }
  });
  it("validates every new option and supports explicit empty/deduplicated scope", async () => {
    for (const args of [["--status-port"], ["--status-port", "3"], ["--status", "--status-port", "65536"], ["--status", "--status-work", "github:OTHER/repo#1"], ["--status-work", "github:a/b#1"], ["--status-typo"]]) expect(() => parseCliArgs(args)).toThrow();
    expect(parseCliArgs(["--status"]).status?.workKeys).toEqual([]);
    const query = createStatusQuery({ workKeys: [...statusKeys, ...statusKeys] }, statusFacts("healthy"));
    expect(await query.listWork()).toHaveLength(2);
    expect((await createStatusQuery({ workKeys: [] }, statusFacts("healthy")).listWork())).toEqual([]);
  });
  it("uses only verified read commands with an actual per-observation subprocess budget", async () => {
    const calls: readonly string[][] = [];
    const mutable = calls as string[][];
    const source = githubStatusSource({ async exec(args, options) {
      mutable.push([...args]); expect(options?.timeoutMs).toBeGreaterThan(0); expect(options?.timeoutMs).toBeLessThanOrEqual(3000);
      if (args[0] === "repo") return { stdout: JSON.stringify({ nameWithOwner: "acceptance/alpha", defaultBranchRef: { name: "trunk" } }), stderr: "", exitCode: 0 };
      if (args[0] === "issue") return { stdout: JSON.stringify({ state: "OPEN", url: "https://github.com/acceptance/alpha/issues/1" }), stderr: "", exitCode: 0 };
      if (args[0] === "api") return { stdout: "[]", stderr: "", exitCode: 0 };
      throw new Error("Unexpected command");
    } });
    expect((await source(statusKeys[0]!)).pullRequest).toBeNull();
    expect(calls.map(args => args.slice(0, 2))).toEqual([["repo", "view"], ["issue", "view"], ["api", "repos/acceptance/alpha/pulls?state=all&per_page=100"]]);
  });
  it("rolls back occupied ports and missing assets without source reads", async () => {
    const blocker = createServer(); await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
    try {
      const address = blocker.address(); if (!address || typeof address === "string") throw new Error("address");
      const sources = { ...statusFacts("healthy"), runtime: () => { throw new Error("must not collect at startup"); } };
      await expect(startStatusSurface({ workKeys: statusKeys, assets, port: address.port }, sources)).rejects.toThrow();
      await expect(startStatusSurface({ workKeys: statusKeys, assets: "/missing-status-assets" }, sources)).rejects.toThrow();
    } finally { await new Promise<void>(resolve => blocker.close(() => resolve())); }
  });
  it("fences new reads synchronously and drains disconnected in-flight observations before shutdown", async () => {
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const sources = statusFacts("healthy");
    const site = await startStatusSurface({ workKeys: statusKeys, assets }, { ...sources, runtime: async () => { entered(); await blocked; return sources.runtime(); } });
    const request = fetch(`${site.url}/api/operations/snapshot`).catch(() => null);
    await started;
    let settled = false; const stopped = site.stop().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    release(); await stopped; await request;
    await expect(fetch(`${site.url}/api/operations/snapshot`)).rejects.toThrow();
  });
  it("reads the same real committed Decision store locally and through authenticated Bridge without writes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "status-decision-"));
    let now = statusTime;
    const store = new DurableDecisionStore({ storeDir: dir, clock: () => now }); await store.open();
    const service = new DecisionService(store, { clock: () => now });
    const bridge = new DecisionBridge(service, { port: 0, authToken: "test-secret" });
    try {
      const key = statusKeys[0]!; const session = await service.createSession(key);
      await service.putBinding(session.id, { adapter: "controlled", externalSessionRef: "private-session", resumeUri: null });
      const oldTarget = { repository: "acceptance/alpha", prNumber: 2, headSha: "b".repeat(40) };
      const old = await service.createReviewTask(session.id, { target: oldTarget });
      const claim = await service.claimTask(old.id, { owner: "executor", ttlMs: 100 });
      const credentials = { owner: "executor", token: claim.lease.token, generation: claim.lease.generation };
      await service.startTask(old.id, credentials);
      await service.submitResult(old.id, { ...credentials, result: { schemaVersion: 1, sessionId: session.id,
        taskId: old.id, revision: old.revision, createdAtMs: now, kind: "review", verdict: "approve", target: oldTarget, findings: [] } });
      const current = await service.createReviewTask(session.id, { target: { ...oldTarget, headSha: "a".repeat(40) } });
      await service.claimTask(current.id, { owner: "executor", ttlMs: 100 });
      now += 1000;
      const expectedApproval = service.verifyReviewApproval(session.id, { ...oldTarget, headSha: "a".repeat(40) });
      expect(expectedApproval.approved).toBe(false);
      const before = await readFile(path.join(dir, "store.json"), "utf8");
      const { port } = await bridge.start(); const url = `http://127.0.0.1:${port}`;
      const client = new DecisionBridgeClient(url, { authToken: "test-secret" });
      const local = createStatusQuery({ workKeys: statusKeys }, { ...statusFacts("review"), decision: key => service.observeWork(key) });
      const remote = createStatusQuery({ workKeys: statusKeys }, { ...statusFacts("review"), decision: key => client.observeWork(key) });
      expect(await remote.getOperationalSnapshot()).toEqual(await local.getOperationalSnapshot());
      const endpoint = `${url}/v1/observations/work?provider=github&key=acceptance%2Falpha%231`;
      expect((await fetch(endpoint)).status).toBe(401);
      expect((await fetch(endpoint, { headers: { Authorization: "Bearer test-secret", Origin: "http://evil.invalid" } })).status).toBe(403);
      expect((await fetch(`${url}/v1/observations/work?provider=github&key=bad`, { headers: { Authorization: "Bearer test-secret" } })).status).toBe(400);
      expect(await readFile(path.join(dir, "store.json"), "utf8")).toBe(before);
      const observation = await client.observeWork(key);
      expect(JSON.stringify(observation)).not.toMatch(/token|receipt|context|private-session/);
      expect(observation.tasks.find(task => task.taskId === current.id)).toMatchObject({ status: "claimed", lease: { expiresAtMs: statusTime + 100 } });
      expect(service.verifyReviewApproval(session.id, { ...oldTarget, headSha: "a".repeat(40) })).toEqual(expectedApproval);
      await store.close();
      await expect(client.observeWork(key)).rejects.toThrow();
      expect(formatWorkKey(key)).toBe(session.id);
    } finally { await bridge.stop(); await store.close(); await rm(dir, { recursive: true, force: true }); }
  });
});


it("Bridge observation cancels and settles a real stalled HTTP request", async () => {
  let finish!: () => void;
  const closed = new Promise<void>(resolve => { finish = resolve; });
  const server = createServer((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.write("{"); });
  server.on("connection", socket => socket.on("close", finish));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("address");
    const client = new DecisionBridgeClient(`http://127.0.0.1:${address.port}`);
    await expect(client.observeWork(statusKeys[0]!)).rejects.toThrow();
    // Wait for the actual socket close event, not a race against an abandoned request.
    await closed;
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


it("passes sanitized query 500 through the production proxy and recovers on the next read", async () => {
  let failed = true;
  const site = await startStatusSurface({ workKeys: statusKeys, assets }, { ...statusFacts("review"), clock: () => { if (failed) throw new Error("secret-clock"); return statusTime; } });
  try {
    const first = await fetch(`${site.url}/api/operations/snapshot`); expect(first.status).toBe(500);
    expect(await first.text()).toBe('{"error":"operational_snapshot_failed"}');
    failed = false;
    expect((await fetch(`${site.url}/api/operations/snapshot`)).status).toBe(200);
  } finally { await site.stop(); }
});
