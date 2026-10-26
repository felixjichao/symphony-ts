import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { DecisionService, DurableDecisionStore } from "@symphony/decision";
import { GitHubDeliveryService, type GhRunner } from "@symphony/tracker";
import { DeliveryError, formatPrBody, type ObservabilitySnapshot, type GitHubObservation } from "@symphony/domain";
import {
  collectOperationFacts, createGitHubReader, createRuntimeReader, createDecisionReader,
  createExecutorReader, githubWorkKey, type ReaderOptions,
} from "./index";

const key = githubWorkKey("acme", "repo", 1);
const options: ReaderOptions = { instance: "test", clock: () => 2000, maxAgeMs: 1000 };
const github: GitHubObservation = { workKey: key, issue: { state: "open", url: "https://github.com/acme/repo/issues/1" }, pullRequest: null, ci: null };
function snapshot(generatedAt = 2000): ObservabilitySnapshot {
  return { generatedAt, pollIntervalMs: 30000, maxConcurrentAgents: 2, running: [], retrying: [],
    rateLimits: null, codexTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 } };
}

it("collects all sources; successful absence differs from unavailable and unconfigured", async () => {
  const readers = {
    github: createGitHubReader(options, async () => github),
    runtime: createRuntimeReader(options, () => ({ status: "available", snapshot: snapshot() })),
    decision: createDecisionReader(options, () => ({ workKey: key, session: null, tasks: [], results: [] })),
    executor: createExecutorReader(options, () => ({ observedAt: 2000, facts: [] })),
  };
  const facts = await collectOperationFacts(readers);
  for (const source of Object.values(facts)) expect(source.freshness.status).toBe("fresh");
  expect(facts.github.facts?.pullRequest).toBeNull();
  expect(facts.github.facts?.ci).toBeNull();
  expect(facts.decision.facts?.session).toBeNull();
  expect(facts.runtime.facts).toEqual([]);
  expect(facts.executor.facts).toEqual([]);
  expect((await createExecutorReader(options, null).read()).freshness.status).toBe("unknown");
  const partial = await collectOperationFacts({ ...readers, github: createGitHubReader(options, async () => {
    throw new Error("secret provider payload");
  }) });
  expect(partial.github).toMatchObject({ facts: null, freshness: { status: "unavailable", reason: "source_read_failed" } });
  expect(partial.decision).toEqual(facts.decision);
  expect(partial.runtime).toEqual(facts.runtime);
  expect(partial.executor).toEqual(facts.executor);
  expect(JSON.stringify(partial)).not.toContain("secret");
});

it("preserves snapshot time, retry delay, UTC start, sessions and unlinked/cross-repository rows", async () => {
  // Domain snapshot fixture: snapshot projection itself is covered by observability.
  const observed: ObservabilitySnapshot = { ...snapshot(999),
    running: ([["a", "https://github.com/acme/repo/issues/1"], ["b", "https://github.com/other/repo/issues/1"], ["c", null]] as const).map(([id, url]) => ({
      issueId: id, issueIdentifier: id, issueUrl: url ?? null, issueState: "Todo", attempt: null,
      status: "preparing_workspace", workspacePath: "/w", startedAt: 900, elapsedMs: 30,
      sessionId: null, threadId: null, turnId: null, codexAppServerPid: null, turnCount: null,
      lastCodexEvent: null, lastCodexMessage: null, lastCodexTimestamp: null, tokens: null,
    })),
    retrying: [{ issueId: "r", issueIdentifier: null, issueUrl: null, attempt: 2, retryInMs: 60, error: null }],
  };
  const read = createRuntimeReader(options, () => ({ status: "available", snapshot: observed }));
  const result = await read.read();
  expect(result.freshness).toEqual({ status: "stale", observedAt: 999, lastAttemptAt: 2000 });
  expect(result.facts?.map((row) => row.workKey)).toEqual([key, githubWorkKey("other", "repo", 1), null, null]);
  expect(result.facts?.[0]?.attempt).toMatchObject({ startedAtMs: 900, sessionId: null });
  expect(result.facts?.[3]?.retry?.retryInMs).toBe(60);
  expect(result.facts?.[0]?.provenance.observedAt).toBe(999);
  expect(JSON.stringify(result)).not.toMatch(/workerHandle|timerHandle|private|elapsedMs/);
  Object.assign(result.facts![0]!.attempt!, { workspacePath: "changed" });
  expect(observed.running[0]?.workspacePath).toBe("/w");
  expect((await createRuntimeReader(options, () => ({ status: "available", snapshot: { ...observed, generatedAt: 1000 } })).read()).freshness.status).toBe("fresh");
});

it("uses reported executor heartbeat/binding only, strips extras and makes defensive copies", async () => {
  const entry = { id: "executor-1", role: null, adapter: "browser", host: null, currentWorkKey: { ...key },
    bindingGeneration: 3, secret: "private" };
  const result = await createExecutorReader(options, () => ({ observedAt: 1000, facts: [entry] })).read();
  expect(result.facts?.[0]).toMatchObject({ status: "unknown", lastHeartbeatAtMs: null, bindingGeneration: 3 });
  expect(JSON.stringify(result)).not.toContain("secret");
  Object.assign(result.facts![0]!.currentWorkKey!, { key: "other/repo#1" });
  expect(entry.currentWorkKey).toEqual(key);
  const reported = await createExecutorReader(options, () => ({ observedAt: 1000,
    facts: [{ ...entry, status: "offline", lastHeartbeatAtMs: 500 }] })).read();
  expect(reported.facts?.[0]).toMatchObject({ status: "offline", lastHeartbeatAtMs: 500 });
});

it("rejects mismatched CI HEAD and exposes safe timeout codes without losing successful sources", async () => {
  const pr = { number: 2, state: "open" as const, url: "https://github.com/acme/repo/pull/2", headSha: "a".repeat(40), isDraft: false };
  const bad = await createGitHubReader(options, async () => ({ ...github, pullRequest: pr,
    ci: { status: "success", headSha: "b".repeat(40) } })).read();
  expect(bad.freshness).toMatchObject({ status: "unavailable", reason: "head_changed" });
  const timeout = await createGitHubReader(options, async () => { throw new DeliveryError("private", { code: "timeout" }); }).read();
  expect(timeout.freshness).toMatchObject({ status: "unavailable", reason: "timeout" });
  expect((await createRuntimeReader(options, () => ({ status: "unavailable", reason: "runtime_unavailable" })).read()).facts).toBeNull();
});

it("reads real Decision committed state, retaining historical SHA/expired lease without file writes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "operations-decision-"));
  let now = 1000;
  const store = new DurableDecisionStore({ storeDir: directory, clock: () => now });
  const service = new DecisionService(store, { clock: () => now });
  try {
    expect((await createDecisionReader(options, () => service.observeWork(key)).read()).freshness.status).toBe("unavailable");
    await store.open();
    const session = await service.createSession(key);
    await service.putBinding(session.id, { adapter: "browser", externalSessionRef: "private-session", resumeUri: null });
    const old = await service.createReviewTask(session.id, { target: { repository: "acme/repo", prNumber: 2, headSha: "a".repeat(40) } });
    const claim = await service.claimTask(old.id, { owner: "executor", ttlMs: 100 });
    await service.startTask(old.id, { owner: "executor", token: claim.lease.token, generation: claim.lease.generation });
    await service.submitResult(old.id, { owner: "executor", token: claim.lease.token, generation: claim.lease.generation,
      result: { schemaVersion: 1, sessionId: session.id, taskId: old.id, kind: "review", revision: old.revision,
        createdAtMs: now, target: { repository: "acme/repo", prNumber: 2, headSha: "a".repeat(40) }, verdict: "approve", findings: [] } });
    const current = await service.createReviewTask(session.id, { target: { repository: "acme/repo", prNumber: 2, headSha: "b".repeat(40) } });
    await service.claimTask(current.id, { owner: "executor", ttlMs: 100 });
    now = 2000;
    const before = store.getState();
    const bytes = await fs.readFile(path.join(directory, "store.json"), "utf8");
    const result = await createDecisionReader(options, () => service.observeWork(key)).read();
    expect(result.facts?.tasks.map((task) => task.kind === "review" ? task.target.headSha : null)).toEqual(["a".repeat(40), "b".repeat(40)]);
    expect(result.facts?.results[0]?.outcome).toMatchObject({ verdict: "approve", target: { headSha: "a".repeat(40) } });
    expect(result.facts?.tasks[1]).toMatchObject({ status: "claimed", claimGeneration: 1, claimBindingGeneration: 1,
      lease: { owner: "executor", generation: 1, expiresAtMs: 1100 } });
    expect(JSON.stringify(result)).not.toMatch(/token|receipt|context|private-session/);
    Object.assign(result.facts!.tasks[1]!.lease!, { owner: "changed" });
    expect(store.getState()).toEqual(before);
    expect(await fs.readFile(path.join(directory, "store.json"), "utf8")).toBe(bytes);
    const absent = await createDecisionReader(options, () => service.observeWork(githubWorkKey("other", "repo", 1))).read();
    expect(absent.facts).toMatchObject({ session: null, tasks: [], results: [] });
  } finally { await store.close(); await fs.rm(directory, { recursive: true, force: true }); }
});


it("collects through the real tracker public observation and excludes Decision port extras", async () => {
  const context = { repo: "acme/repo", issueNumber: 1, workspaceKey: "GH-1", headBranch: "symphony/GH-1", baseBranch: "main" };
  const sha = "a".repeat(40);
  const runner: GhRunner = { async exec(args) {
    return { stdout: JSON.stringify(args[0] === "issue" ? { state: "CLOSED", url: github.issue.url } : {
      number: 2, body: formatPrBody({ context }), state: "MERGED", isDraft: false,
      headRefName: context.headBranch, headRefOid: sha, baseRefName: "main", url: "https://github.com/acme/repo/pull/2",
      isCrossRepository: false, headRepository: null, headRepositoryOwner: null, statusCheckRollup: [],
    }), stderr: "", exitCode: 0 };
  } };
  const service = new GitHubDeliveryService(runner);
  const source = { workKey: key, session: null, tasks: [], results: [], contexts: { secret: "private" } };
  const facts = await collectOperationFacts({
    github: createGitHubReader(options, () => service.observeWork(context, { prNumber: 2 })),
    runtime: createRuntimeReader(options, null),
    decision: createDecisionReader(options, () => source), executor: createExecutorReader(options, null),
  });
  expect(facts.github.facts).toMatchObject({ issue: { state: "closed" }, pullRequest: { state: "merged", headSha: sha }, ci: null });
  expect(facts.decision.facts).toMatchObject({ session: null, tasks: [], results: [] });
  expect(JSON.stringify(facts)).not.toMatch(/contexts|private/);
});
