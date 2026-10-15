import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  formatWorkKey,
  githubWorkKey,
  type DecisionWorkFacts,
  type GitHubObservation,
  type GitHubWorkFacts,
  type OperationSourceKind,
  type RuntimeWorkFacts,
  type SnapshotResult,
  type WorkKey,
} from "@symphony/domain";
import { DecisionService, DurableDecisionStore } from "@symphony/decision";
import {
  createDecisionReader,
  createExecutorReader,
  createGitHubReader,
  createOperationalQueryService,
  createRuntimeReader,
  type SourceReader,
} from "./index";

const NOW = 1_700_000_000_000;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function mockReader<T>(source: OperationSourceKind, instance: string, facts: T | null, freshnessStatus: "fresh" | "stale" | "unavailable" | "unknown" = "fresh"): SourceReader<T> {
  return {
    async read() {
      return {
        source,
        instance,
        facts,
        freshness: freshnessStatus === "fresh"
          ? { status: "fresh", observedAt: NOW - 500, lastAttemptAt: NOW }
          : freshnessStatus === "stale"
          ? { status: "stale", observedAt: NOW - 60_000, lastAttemptAt: NOW }
          : freshnessStatus === "unavailable"
          ? { status: "unavailable", observedAt: null, lastAttemptAt: NOW, reason: "network_error" }
          : { status: "unknown", lastAttemptAt: null, reason: "source_not_configured" },
      };
    },
  };
}

describe("OperationalQueryService API contracts", () => {
  const keyA = githubWorkKey("owner", "repo", 1);
  const keyB = githubWorkKey("owner", "repo", 2);

  it("exposes getOperationalSnapshot, listWork, getWork, and listExecutors", async () => {
    const service = createOperationalQueryService({
      clock: () => NOW,
      workKeys: [keyA, keyB],
      githubReader: mockReader("github", "gh", {
        workKey: keyA,
        issue: { state: "open", url: "https://github.com/owner/repo/issues/1" },
        pullRequest: null,
        ci: null,
        provenance: { source: "github", instance: "gh", observedAt: NOW },
      }),
      executorReader: mockReader("executor", "exec", [
        {
          id: "exec-1",
          role: "implementer",
          adapter: "codex",
          host: "host-1",
          status: "online",
          lastHeartbeatAtMs: NOW - 1000,
          bindingGeneration: 1,
          currentWorkKey: null,
          provenance: { source: "executor", instance: "exec", observedAt: NOW },
        },
      ]),
    });

    const snapshot = await service.getOperationalSnapshot();
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.generatedAt).toBe(NOW);
    expect(snapshot.work).toHaveLength(2);
    expect(snapshot.executors).toHaveLength(1);
    expect(snapshot.executors[0]?.id).toBe("exec-1");

    // listWork is backed by the same projection rules
    const workList = await service.listWork();
    expect(workList).toEqual(snapshot.work);

    // getWork returns matching item
    const workA = await service.getWork(keyA);
    expect(workA).toEqual(snapshot.work[0]);

    // getWork accepts string formats
    const workAByString = await service.getWork("owner/repo#1");
    expect(workAByString).toEqual(snapshot.work[0]);
    const workAByCanonical = await service.getWork("github:owner/repo#1");
    expect(workAByCanonical).toEqual(snapshot.work[0]);

    // getWork returns null for valid key outside scope
    const workOther = await service.getWork(githubWorkKey("owner", "repo", 999));
    expect(workOther).toBeNull();

    // getWork throws TypeError for invalid key
    await expect(service.getWork("invalid-key")).rejects.toThrow(TypeError);
    await expect(service.getWork({ provider: "invalid!", key: "bad" } as unknown as WorkKey)).rejects.toThrow(TypeError);

    // listExecutors returns projected executors without coupling work identity to hosts/machines
    const executors = await service.listExecutors();
    expect(executors).toEqual(snapshot.executors);
    expect(executors[0]).toMatchObject({
      id: "exec-1",
      role: "implementer",
      adapter: "codex",
      host: "host-1",
      status: "online",
      lastHeartbeatAt: NOW - 1000,
      currentWork: null,
    });
  });

  it("deduplicates and stably sorts work keys", async () => {
    const service = createOperationalQueryService({
      clock: () => NOW,
      // Pass duplicate and out-of-order keys
      workKeys: [
        keyB,
        keyA,
        keyB,
        "github:owner/repo#1",
      ],
    });

    const work = await service.listWork();
    expect(work).toHaveLength(2);
    expect(formatWorkKey(work[0]!.key)).toBe("github:owner/repo#1");
    expect(formatWorkKey(work[1]!.key)).toBe("github:owner/repo#2");
  });

  it("supports dynamic workKeys provider function", async () => {
    let callCount = 0;
    const service = createOperationalQueryService({
      clock: () => NOW,
      workKeys: async () => {
        callCount++;
        return [keyA];
      },
    });

    const work = await service.listWork();
    expect(work).toHaveLength(1);
    expect(callCount).toBe(1);

    await service.getOperationalSnapshot();
    expect(callCount).toBe(2);
  });
});

describe("Integration scenarios", () => {
  const key = githubWorkKey("owner", "repo", 100);

  it("scenario 1: normal execution (coding phase, running attempt)", async () => {
    const githubReader = mockReader<GitHubWorkFacts>("github", "gh", {
      workKey: key,
      issue: { state: "open", url: "https://github.com/owner/repo/issues/100" },
      pullRequest: null,
      ci: null,
      provenance: { source: "github", instance: "gh", observedAt: NOW },
    });

    const runtimeReader = mockReader<readonly RuntimeWorkFacts[]>("runtime", "rt", [
      {
        workKey: key,
        issueId: "issue-100",
        attempt: {
          issueId: "issue-100",
          issueIdentifier: "owner/repo#100",
          attempt: 1,
          status: "streaming_turn",
          workspacePath: "/tmp/ws",
          startedAtMs: NOW - 5000,
          sessionId: "sess-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
        retry: null,
        provenance: { source: "runtime", instance: "rt", observedAt: NOW },
      },
    ]);

    const decisionReader = mockReader<DecisionWorkFacts>("decision", "dec", {
      workKey: key,
      session: {
        sessionId: "sess-1",
        status: "active",
        bindingGeneration: 1,
        adapter: "codex",
        updatedAtMs: NOW - 5000,
      },
      tasks: [],
      results: [],
      provenance: { source: "decision", instance: "dec", observedAt: NOW },
    });

    const service = createOperationalQueryService({
      clock: () => NOW,
      workKeys: [key],
      githubReader,
      runtimeReader,
      decisionReader,
    });

    const snapshot = await service.getOperationalSnapshot();
    expect(snapshot.health).toBe("healthy");
    expect(snapshot.summary.active).toBe(1);
    expect(snapshot.summary.waiting).toBe(0);

    const work = snapshot.work[0]!;
    expect(work.phase).toBe("coding");
    expect(work.waiting).toBeNull();
    expect(work.attention).toBe("normal");
    expect(work.execution?.attempt).toBe(1);
    expect(work.execution?.status).toBe("streaming_turn");
  });

  it("scenario 2: waiting for CI", async () => {
    const githubReader = mockReader<GitHubWorkFacts>("github", "gh", {
      workKey: key,
      issue: { state: "open", url: "https://github.com/owner/repo/issues/100" },
      pullRequest: {
        number: 10,
        state: "open",
        url: "https://github.com/owner/repo/pull/10",
        headSha: SHA_A,
        isDraft: false,
      },
      ci: { status: "pending", headSha: SHA_A },
      provenance: { source: "github", instance: "gh", observedAt: NOW },
    });

    const decisionReader = mockReader<DecisionWorkFacts>("decision", "dec", {
      workKey: key,
      session: {
        sessionId: "sess-1",
        status: "active",
        bindingGeneration: 1,
        adapter: "codex",
        updatedAtMs: NOW - 5000,
      },
      tasks: [
        {
          taskId: "plan-1",
          kind: "plan",
          status: "completed",
          revision: 1,
          createdAtMs: NOW - 10000,
          updatedAtMs: NOW - 8000,
        },
      ],
      results: [
        {
          taskId: "plan-1",
          revision: 1,
          createdAtMs: NOW - 8000,
          outcome: { kind: "plan", verdict: "ready" },
        },
      ],
      provenance: { source: "decision", instance: "dec", observedAt: NOW },
    });

    const runtimeReader = mockReader<readonly RuntimeWorkFacts[]>("runtime", "rt", []);

    const service = createOperationalQueryService({
      clock: () => NOW,
      workKeys: [key],
      githubReader,
      runtimeReader,
      decisionReader,
    });

    const work = await service.getWork(key);
    expect(work?.phase).toBe("ci");
    expect(work?.waiting).toMatchObject({ reason: "waiting_for_ci" });
    expect(work?.attention).toBe("waiting");
  });

  it("scenario 3: waiting for web executor / review", async () => {
    const githubReader = mockReader<GitHubWorkFacts>("github", "gh", {
      workKey: key,
      issue: { state: "open", url: "https://github.com/owner/repo/issues/100" },
      pullRequest: {
        number: 10,
        state: "open",
        url: "https://github.com/owner/repo/pull/10",
        headSha: SHA_A,
        isDraft: false,
      },
      ci: { status: "success", headSha: SHA_A },
      provenance: { source: "github", instance: "gh", observedAt: NOW },
    });

    const decisionReader = mockReader<DecisionWorkFacts>("decision", "dec", {
      workKey: key,
      session: {
        sessionId: "sess-1",
        status: "active",
        bindingGeneration: 1,
        adapter: "codex",
        updatedAtMs: NOW - 5000,
      },
      tasks: [
        {
          taskId: "rev-1",
          kind: "review",
          status: "pending",
          revision: 1,
          target: { repository: "owner/repo", prNumber: 10, headSha: SHA_A },
          createdAtMs: NOW - 2000,
          updatedAtMs: NOW - 2000,
        },
      ],
      results: [],
      provenance: { source: "decision", instance: "dec", observedAt: NOW },
    });

    const service = createOperationalQueryService({
      clock: () => NOW,
      workKeys: [key],
      githubReader,
      decisionReader,
    });

    const work = await service.getWork(key);
    expect(work?.phase).toBe("review");
    expect(work?.waiting?.reason).toBe("waiting_for_executor");
    expect(work?.attention).toBe("waiting");
  });

  it("scenario 4: retry backoff", async () => {
    const runtimeReader = mockReader<readonly RuntimeWorkFacts[]>("runtime", "rt", [
      {
        workKey: key,
        issueId: "issue-100",
        attempt: null,
        retry: {
          issueId: "issue-100",
          identifier: "owner/repo#100",
          attempt: 2,
          retryInMs: 15_000,
          error: "process_terminated_unexpectedly",
        },
        provenance: { source: "runtime", instance: "rt", observedAt: NOW },
      },
    ]);

    const service = createOperationalQueryService({
      clock: () => NOW,
      workKeys: [key],
      runtimeReader,
    });

    const snapshot = await service.getOperationalSnapshot();
    expect(snapshot.summary.retrying).toBe(1);

    const work = snapshot.work[0]!;
    expect(work.waiting?.reason).toBe("retry_backoff");
    expect(work.execution?.retryInMs).toBe(15_000);
  });

  it("scenario 5: needs-human attention state", async () => {
    const decisionReader = mockReader<DecisionWorkFacts>("decision", "dec", {
      workKey: key,
      session: {
        sessionId: "sess-1",
        status: "active",
        bindingGeneration: 1,
        adapter: "codex",
        updatedAtMs: NOW - 5000,
      },
      tasks: [
        {
          taskId: "plan-1",
          kind: "plan",
          status: "completed",
          revision: 1,
          createdAtMs: NOW - 10000,
          updatedAtMs: NOW - 5000,
        },
      ],
      results: [
        {
          taskId: "plan-1",
          revision: 1,
          createdAtMs: NOW - 5000,
          outcome: { kind: "plan", verdict: "needs_human" },
        },
      ],
      provenance: { source: "decision", instance: "dec", observedAt: NOW },
    });

    const service = createOperationalQueryService({
      clock: () => NOW,
      workKeys: [key],
      decisionReader,
    });

    const snapshot = await service.getOperationalSnapshot();
    expect(snapshot.summary.needsHuman).toBe(1);
    expect(snapshot.work[0]?.attention).toBe("needs_human");
  });

  it("scenario 6: stale source degrades attention and system health", async () => {
    const githubReader = mockReader<GitHubWorkFacts>("github", "gh", {
      workKey: key,
      issue: { state: "open", url: "https://github.com/owner/repo/issues/100" },
      pullRequest: null,
      ci: null,
      provenance: { source: "github", instance: "gh", observedAt: NOW - 60_000 },
    }, "stale");

    const runtimeReader = mockReader<readonly RuntimeWorkFacts[]>("runtime", "rt", [], "fresh");

    const service = createOperationalQueryService({
      clock: () => NOW,
      workKeys: [key],
      githubReader,
      runtimeReader,
    });

    const snapshot = await service.getOperationalSnapshot();
    expect(snapshot.health).toBe("degraded");
    expect(snapshot.work[0]?.attention).toBe("degraded");
    expect(snapshot.work[0]?.freshness.github.status).toBe("stale");
  });

  it("scenario 7: partial source failure (source unavailable) preserves useful facts", async () => {
    const githubReader = mockReader<GitHubWorkFacts>("github", "gh", {
      workKey: key,
      issue: { state: "open", url: "https://github.com/owner/repo/issues/100" },
      pullRequest: null,
      ci: null,
      provenance: { source: "github", instance: "gh", observedAt: NOW },
    }, "fresh");

    // Decision reader fails with unavailable status
    const decisionReader = mockReader<DecisionWorkFacts>("decision", "dec", null, "unavailable");

    const service = createOperationalQueryService({
      clock: () => NOW,
      workKeys: [key],
      githubReader,
      decisionReader,
    });

    const snapshot = await service.getOperationalSnapshot();
    expect(snapshot.health).toBe("degraded");

    const work = snapshot.work[0]!;
    expect(work.attention).toBe("degraded");
    expect(work.freshness.decision.status).toBe("unavailable");
    expect(work.freshness.github.status).toBe("fresh");
    expect(work.workItem.identifier).toBe("owner/repo#100");
  });

  it("scenario 8: review SHA mismatch detects anomaly with evidence breadcrumbs", async () => {
    const githubReader = mockReader<GitHubWorkFacts>("github", "gh", {
      workKey: key,
      issue: { state: "open", url: "https://github.com/owner/repo/issues/100" },
      pullRequest: {
        number: 10,
        state: "open",
        url: "https://github.com/owner/repo/pull/10",
        headSha: SHA_A,
        isDraft: false,
      },
      ci: { status: "success", headSha: SHA_A },
      provenance: { source: "github", instance: "gh", observedAt: NOW },
    });

    // Review task targets SHA_B, but PR HEAD is SHA_A
    const decisionReader = mockReader<DecisionWorkFacts>("decision", "dec", {
      workKey: key,
      session: {
        sessionId: "sess-1",
        status: "active",
        bindingGeneration: 1,
        adapter: "codex",
        updatedAtMs: NOW - 5000,
      },
      tasks: [
        {
          taskId: "rev-1",
          kind: "review",
          status: "pending",
          revision: 1,
          target: { repository: "owner/repo", prNumber: 10, headSha: SHA_B },
          createdAtMs: NOW - 2000,
          updatedAtMs: NOW - 2000,
        },
      ],
      results: [],
      provenance: { source: "decision", instance: "dec", observedAt: NOW },
    });

    const service = createOperationalQueryService({
      clock: () => NOW,
      workKeys: [key],
      githubReader,
      decisionReader,
    });

    const snapshot = await service.getOperationalSnapshot();
    expect(snapshot.health).toBe("degraded");
    expect(snapshot.anomalies.length).toBeGreaterThan(0);

    const mismatch = snapshot.anomalies.find((a) => a.code === "review_target_head_mismatch");
    expect(mismatch).toBeDefined();
    expect(mismatch?.severity).toBe("warning");
    expect(mismatch?.evidence?.length ?? 0).toBeGreaterThan(0);
    expect(snapshot.work[0]?.attention).toBe("degraded");
  });

  it("scenario 9: terminal / merged work and execution on terminal work", async () => {
    const githubReader = mockReader<GitHubWorkFacts>("github", "gh", {
      workKey: key,
      issue: { state: "closed", url: "https://github.com/owner/repo/issues/100" },
      pullRequest: {
        number: 10,
        state: "merged",
        url: "https://github.com/owner/repo/pull/10",
        headSha: SHA_A,
        isDraft: false,
      },
      ci: null,
      provenance: { source: "github", instance: "gh", observedAt: NOW },
    });

    // Attempt is still actively running on terminal work
    const runtimeReader = mockReader<readonly RuntimeWorkFacts[]>("runtime", "rt", [
      {
        workKey: key,
        issueId: "issue-100",
        attempt: {
          issueId: "issue-100",
          issueIdentifier: "owner/repo#100",
          attempt: 1,
          status: "streaming_turn",
          workspacePath: "/tmp/ws",
          startedAtMs: NOW - 5000,
          sessionId: "sess-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
        retry: null,
        provenance: { source: "runtime", instance: "rt", observedAt: NOW },
      },
    ]);

    const service = createOperationalQueryService({
      clock: () => NOW,
      workKeys: [key],
      githubReader,
      runtimeReader,
    });

    const snapshot = await service.getOperationalSnapshot();
    const work = snapshot.work[0]!;
    expect(work.phase).toBe("completed");
    expect(work.attention).toBe("degraded");

    const terminalAnomaly = snapshot.anomalies.find((a) => a.code === "execution_on_terminal_work");
    expect(terminalAnomaly).toBeDefined();
    expect(terminalAnomaly?.severity).toBe("warning");
  });
});

describe("System health, edge cases, and determinism", () => {
  const keyA = githubWorkKey("owner", "repo", 1);
  const keyB = githubWorkKey("owner", "repo", 2);

  it("multi-work isolation: failure of one work does not affect another work", async () => {
    const service = createOperationalQueryService({
      clock: () => NOW,
      workKeys: [keyA, keyB],
      getGitHubReader: (workKey: WorkKey) => {
        if (workKey.key === "owner/repo#1") {
          return mockReader<GitHubWorkFacts>("github", "gh:1", {
            workKey,
            issue: { state: "open", url: "https://github.com/owner/repo/issues/1" },
            pullRequest: null,
            ci: null,
            provenance: { source: "github", instance: "gh:1", observedAt: NOW },
          }, "fresh");
        }
        // Work B fails
        return mockReader<GitHubWorkFacts>("github", "gh:2", null, "unavailable");
      },
    });

    const snapshot = await service.getOperationalSnapshot();
    expect(snapshot.health).toBe("degraded");

    const itemA = snapshot.work.find((w) => formatWorkKey(w.key) === "github:owner/repo#1");
    const itemB = snapshot.work.find((w) => formatWorkKey(w.key) === "github:owner/repo#2");

    expect(itemA?.attention).toBe("normal");
    expect(itemA?.freshness.github.status).toBe("fresh");

    expect(itemB?.attention).toBe("degraded");
    expect(itemB?.freshness.github.status).toBe("unavailable");

    // Both work items' source statuses recorded
    expect(snapshot.sources.some((s) => s.workKey?.key === "owner/repo#1" && s.freshness.status === "fresh")).toBe(true);
    expect(snapshot.sources.some((s) => s.workKey?.key === "owner/repo#2" && s.freshness.status === "unavailable")).toBe(true);
  });

  it("handles throwing readers gracefully by degrading to unavailable", async () => {
    const throwingReader: SourceReader<GitHubWorkFacts> = {
      async read() {
        throw new Error("unexpected connection failure");
      },
    };

    const service = createOperationalQueryService({
      clock: () => NOW,
      workKeys: [keyA],
      githubReader: throwingReader,
    });

    const snapshot = await service.getOperationalSnapshot();
    expect(snapshot.health).toBe("unavailable");
    expect(snapshot.work[0]?.attention).toBe("degraded");
    expect(snapshot.work[0]?.freshness.github.status).toBe("unavailable");
  });

  it("handles empty work keys list gracefully", async () => {
    const service = createOperationalQueryService({
      clock: () => NOW,
      workKeys: [],
      runtimeReader: mockReader("runtime", "rt", [], "fresh"),
    });

    const snapshot = await service.getOperationalSnapshot();
    expect(snapshot.health).toBe("healthy");
    expect(snapshot.summary.active).toBe(0);
    expect(snapshot.work).toEqual([]);
    expect(await service.listWork()).toEqual([]);
    expect(await service.getWork(keyA)).toBeNull();
  });

  it("all sources unavailable results in system health unavailable", async () => {
    const service = createOperationalQueryService({
      clock: () => NOW,
      workKeys: [keyA],
      githubReader: mockReader<GitHubWorkFacts>("github", "gh", null, "unavailable"),
      runtimeReader: mockReader<readonly RuntimeWorkFacts[]>("runtime", "rt", null, "unavailable"),
      decisionReader: mockReader<DecisionWorkFacts>("decision", "dec", null, "unavailable"),
    });

    const snapshot = await service.getOperationalSnapshot();
    expect(snapshot.health).toBe("unavailable");
  });

  it("query results are deterministic and order-invariant", async () => {
    const key1 = githubWorkKey("a", "b", 1);
    const key2 = githubWorkKey("a", "b", 2);
    const key3 = githubWorkKey("a", "b", 3);

    const makeService = (keys: WorkKey[]) => createOperationalQueryService({
      clock: () => NOW,
      workKeys: keys,
      githubReader: mockReader("github", "gh", {
        workKey: key1,
        issue: { state: "open", url: "https://github.com/a/b/issues/1" },
        pullRequest: null,
        ci: null,
        provenance: { source: "github", instance: "gh", observedAt: NOW },
      }),
    });

    const snapshotForward = await makeService([key1, key2, key3]).getOperationalSnapshot();
    const snapshotBackward = await makeService([key3, key1, key2]).getOperationalSnapshot();

    expect(snapshotForward).toEqual(snapshotBackward);
    expect(snapshotForward.work.map((w) => formatWorkKey(w.key))).toEqual([
      "github:a/b#1",
      "github:a/b#2",
      "github:a/b#3",
    ]);
  });

  it("ensures mutation isolation on returned objects", async () => {
    const service = createOperationalQueryService({
      clock: () => NOW,
      workKeys: [keyA],
    });

    const list1 = await service.listWork();
    // @ts-expect-error - testing consumer mutation isolation
    list1.push("corrupted");

    const list2 = await service.listWork();
    expect(list2).toHaveLength(1);
    expect(list2).not.toContain("corrupted");
  });
});

describe("Real Decision service & readers end-to-end integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-query-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("integrates end-to-end with real DurableDecisionStore and DecisionService", async () => {
    const key = githubWorkKey("owner", "repo", 42);
    const store = new DurableDecisionStore({ storeDir: tmpDir, clock: () => NOW });
    const decision = new DecisionService(store, { clock: () => NOW });

    await store.open();
    try {
      const session = await decision.createSession(key);
      await decision.putBinding(session.id, {
        adapter: "codex",
        externalSessionRef: "sess-ext-1",
        resumeUri: null,
      });

      const planTask = await decision.createPlanTask(session.id);
      const claim = await decision.claimTask(planTask.id, { owner: "executor-1", ttlMs: 10_000 });
      await decision.startTask(planTask.id, {
        owner: "executor-1",
        token: claim.lease.token,
        generation: claim.lease.generation,
      });
      await decision.submitResult(planTask.id, {
        owner: "executor-1",
        token: claim.lease.token,
        generation: claim.lease.generation,
        result: {
          schemaVersion: 1,
          sessionId: session.id,
          taskId: planTask.id,
          kind: "plan",
          revision: planTask.revision,
          createdAtMs: NOW,
          verdict: "ready",
          content: {
            plan: "Implement feature",
            acceptanceCriteria: ["Feature works"],
            risks: [],
            clarifications: [],
          },
        },
      });

      const decisionReader = createDecisionReader(
        { instance: "dec:main", clock: () => NOW, maxAgeMs: 5000 },
        () => decision.observeWork(key),
      );

      const githubReader = createGitHubReader(
        { instance: "gh:main", clock: () => NOW, maxAgeMs: 5000 },
        async (): Promise<GitHubObservation> => ({
          workKey: key,
          issue: { state: "open", url: "https://github.com/owner/repo/issues/42" },
          pullRequest: {
            number: 5,
            state: "open",
            url: "https://github.com/owner/repo/pull/5",
            headSha: SHA_A,
            isDraft: false,
          },
          ci: { status: "pending", headSha: SHA_A },
        }),
      );

      const runtimeReader = createRuntimeReader(
        { instance: "rt:main", clock: () => NOW, maxAgeMs: 5000 },
        async (): Promise<SnapshotResult> => ({
          status: "available",
          snapshot: {
            generatedAt: NOW - 200,
            pollIntervalMs: 1000,
            maxConcurrentAgents: 1,
            running: [],
            retrying: [],
            codexTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
            rateLimits: null,
          },
        }),
      );

      const executorReader = createExecutorReader(
        { instance: "exec:main", clock: () => NOW, maxAgeMs: 5000 },
        async () => ({
          observedAt: NOW - 100,
          facts: [
            {
              id: "executor-1",
              role: "implementer",
              adapter: "codex",
              host: "local",
              status: "online",
              lastHeartbeatAtMs: NOW - 100,
              currentWorkKey: null,
            },
          ],
        }),
      );

      const service = createOperationalQueryService({
        clock: () => NOW,
        workKeys: [key],
        githubReader,
        decisionReader,
        runtimeReader,
        executorReader,
      });

      const snapshot = await service.getOperationalSnapshot();
      expect(snapshot.health).toBe("healthy");
      expect(snapshot.work).toHaveLength(1);

      const work = snapshot.work[0]!;
      expect(work.key).toEqual(key);
      expect(work.phase).toBe("ci");
      expect(work.waiting?.reason).toBe("waiting_for_ci");
      expect(work.planning?.planVerdict).toBe("ready");
      expect(work.pullRequest?.number).toBe(5);
      expect(work.ci?.status).toBe("pending");
      expect(work.freshness.github.status).toBe("fresh");
      expect(work.freshness.decision.status).toBe("fresh");
      expect(work.freshness.runtime.status).toBe("fresh");

      const executors = await service.listExecutors();
      expect(executors).toHaveLength(1);
      expect(executors[0]?.id).toBe("executor-1");
    } finally {
      await store.close();
    }
  });
});
