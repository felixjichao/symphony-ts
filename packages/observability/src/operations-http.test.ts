import { afterEach, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { githubWorkKey, type DecisionWorkFacts, type OperationSourceResult, type OperationalSnapshot } from "@symphony/domain";
import { createOperationalQueryService, type OperationalQueryService } from "@symphony/operations";
import { startOperationsHttpServer } from "./index";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});
async function start(service: OperationalQueryService): Promise<string> {
  const server = await startOperationsHttpServer(service);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  expect(address.address).toBe("127.0.0.1");
  return `http://127.0.0.1:${address.port}`;
}
const a = githubWorkKey("owner", "repo", 1);
const b = githubWorkKey("other", "repo", 1);
const currentHead = "b".repeat(40);
const target = { repository: "owner/repo", prNumber: 10, headSha: "a".repeat(40) };
function realService(): OperationalQueryService {
  const decision: OperationSourceResult<DecisionWorkFacts> = {
    source: "decision", instance: "dec", workKey: a,
    freshness: { status: "fresh", observedAt: 100, lastAttemptAt: 100 },
    facts: { workKey: a,
      session: { sessionId: "s", status: "active", bindingGeneration: 1, adapter: "browser", updatedAtMs: 100 },
      tasks: [{ taskId: "t", revision: 1, kind: "review", status: "completed", target, createdAtMs: 90, updatedAtMs: 100 }],
      results: [{ taskId: "t", revision: 1, createdAtMs: 100, outcome: { kind: "review", verdict: "approve", target } }],
      provenance: { source: "decision", instance: "dec", observedAt: 100 },
    },
  };
  return createOperationalQueryService({
    clock: () => 100, workKeys: [b, a],
    getGitHubReader: (workKey) => ({ async read() {
      if (workKey.key === b.key) throw new Error("source_read_failed");
      return { source: "github", instance: "gh", workKey,
        freshness: { status: "fresh", observedAt: 100, lastAttemptAt: 100 },
        facts: { workKey, issue: { state: "open", url: "https://github.com/owner/repo/issues/1" },
          pullRequest: { number: 10, state: "open", url: "https://github.com/owner/repo/pull/10", headSha: currentHead, isDraft: false },
          ci: { status: "success", headSha: currentHead }, provenance: { source: "github", instance: "gh", observedAt: 100 } },
      };
    } }),
    // Reused reader must be isolated by the actual query service for work B.
    decisionReader: { async read() { return decision; } },
    executorReader: { async read() { return { source: "executor", instance: "exec",
      freshness: { status: "stale", observedAt: 1, lastAttemptAt: 100 },
      facts: [{ id: "executor", role: "reviewer", adapter: "browser", host: "host", status: "offline",
        lastHeartbeatAtMs: 1, bindingGeneration: 1, currentWorkKey: a,
        provenance: { source: "executor", instance: "exec", observedAt: 1 } }],
    }; } },
  });
}

it("serializes the complete fixed snapshot deterministically with one query per GET", async () => {
  const snapshot = await realService().getOperationalSnapshot();
  const before = structuredClone(snapshot);
  const getOperationalSnapshot = vi.fn(async () => snapshot);
  const base = await start({ ...realService(), getOperationalSnapshot });
  for (let index = 0; index < 2; index++) {
    const response = await fetch(`${base}/api/operations/snapshot?view=full`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(snapshot);
  }
  expect(getOperationalSnapshot).toHaveBeenCalledTimes(2);
  expect(snapshot).toEqual(before);
});

it("keeps partial failures, WorkKeys, freshness, anomalies and exact HEAD evidence through the real query boundary", async () => {
  const service = realService();
  const expected = await service.getOperationalSnapshot();
  const base = await start(service);
  const response = await fetch(`${base}/api/operations/snapshot`);
  expect(response.status).toBe(200);
  const snapshot = await response.json() as OperationalSnapshot;
  expect(snapshot).toEqual(expected);
  expect(snapshot.schemaVersion).toBe(1);
  expect(snapshot.generatedAt).toBe(100);
  expect(snapshot.health).toBe("degraded");
  expect(snapshot.summary).toEqual(expected.summary);
  expect(new Set(snapshot.sources.map((source) => source.freshness.status)))
    .toEqual(new Set(["fresh", "stale", "unknown", "unavailable"]));
  const workA = snapshot.work.find((work) => work.key.key === a.key)!;
  const workB = snapshot.work.find((work) => work.key.key === b.key)!;
  expect(workA.pullRequest?.headSha).toBe(currentHead);
  expect(workA.review).toMatchObject({ currentHeadSha: currentHead, taskTarget: target,
    task: { target }, result: { outcome: { target, verdict: "approve" } }, approval: "approved_stale_head" });
  expect(workA.evidence.length).toBeGreaterThan(0);
  expect(snapshot.anomalies).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "review_approval_head_mismatch", workKey: a, evidence: expect.any(Array) }),
  ]));
  expect(workB.freshness.github.status).toBe("unavailable");
  expect(workB.review?.taskTarget).toBeNull();
  expect(workB.review?.result).toBeNull();
  expect(workB.pullRequest).toBeNull();
  expect(snapshot.executors[0]).toMatchObject({ id: "executor", currentWork: a, lastHeartbeatAt: 1 });
});

it("sanitizes query failures, leaves source state untouched, and can serve subsequent requests", async () => {
  const sourceState = Object.freeze({ workKeys: Object.freeze([a, b]) });
  const before = structuredClone(sourceState);
  const workKeys = vi.fn()
    .mockRejectedValueOnce(new Error("provider token=private store path"))
    .mockImplementation(async () => sourceState.workKeys);
  const service = createOperationalQueryService({ workKeys, clock: () => 100 });
  const getOperationalSnapshot = vi.spyOn(service, "getOperationalSnapshot");
  const base = await start(service);
  const response = await fetch(`${base}/api/operations/snapshot`);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "operational_snapshot_failed" });
  expect(sourceState).toEqual(before);
  expect((await fetch(`${base}/api/operations/snapshot`)).status).toBe(200);
  expect(getOperationalSnapshot).toHaveBeenCalledTimes(2);
  expect(workKeys).toHaveBeenCalledTimes(2);
  expect(sourceState).toEqual(before);
});

it("rejects bind failures without querying or interrupting an existing transport", async () => {
  const service = realService();
  const getOperationalSnapshot = vi.spyOn(service, "getOperationalSnapshot");
  const base = await start(service);
  const port = Number(new URL(base).port);
  await expect(startOperationsHttpServer(service, { port })).rejects.toMatchObject({ code: "EADDRINUSE" });
  expect(getOperationalSnapshot).not.toHaveBeenCalled();
  expect((await fetch(`${base}/api/operations/snapshot`)).status).toBe(200);
});

it("isolates repeated server errors after startup and continues serving snapshots", async () => {
  const service = realService();
  const getOperationalSnapshot = vi.spyOn(service, "getOperationalSnapshot");
  const base = await start(service);
  const server = servers[0]!;
  for (let index = 0; index < 2; index++) {
    expect(() => server.emit("error", new Error("runtime transport failure"))).not.toThrow();
  }
  expect(getOperationalSnapshot).not.toHaveBeenCalled();
  const response = await fetch(`${base}/api/operations/snapshot`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(await realService().getOperationalSnapshot());
  expect(getOperationalSnapshot).toHaveBeenCalledTimes(1);
});

it("sanitizes serialization errors before sending snapshot headers or a partial body", async () => {
  const snapshot = await realService().getOperationalSnapshot();
  const getOperationalSnapshot = vi.fn(async () => ({
    ...snapshot,
    toJSON() { throw new Error("private serialization details"); },
  }));
  const base = await start({ ...realService(), getOperationalSnapshot });
  const response = await fetch(`${base}/api/operations/snapshot`);
  expect(response.status).toBe(500);
  expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(await response.json()).toEqual({ error: "operational_snapshot_failed" });
  expect(getOperationalSnapshot).toHaveBeenCalledTimes(1);
});

it("registers no write or source-specific routes and never queries for unsupported requests", async () => {
  const getOperationalSnapshot = vi.fn(realService().getOperationalSnapshot);
  const base = await start({ ...realService(), getOperationalSnapshot });
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
    const response = await fetch(`${base}/api/operations/snapshot`, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  }
  for (const route of ["/", "/api/github", "/api/decision", "/api/sessions", "/api/reviews", "/api/operations/snapshot/command"]) {
    for (const method of ["GET", "POST"]) {
      expect((await fetch(`${base}${route}`, { method })).status).toBe(404);
    }
  }
  expect(getOperationalSnapshot).not.toHaveBeenCalled();
});
