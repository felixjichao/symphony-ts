/**
 * Operational Read Model contract tests (NEST-113 / GitHub #109).
 *
 * 主体是**编译期形状**（readonly、必填 / nullable、判别联合、literal 版本号），
 * 运行时断言只固化显式契约语义（freshness 四态、absence 与读取失败区分、exact
 * HEAD SHA、phase/attention 正交、partial source failure）。`@ts-expect-error` 均为
 * 负例类型断言（见 issue.test.ts 头注）；本分片不包含任何推导函数，因此不测试
 * phase / waiting / attention 的推导结果，只测试它们可以被合法表达。
 */
import { describe, expect, it } from "vitest";

import {
  ATTENTION_STATES,
  EXACT_HEAD_SHA_PATTERN,
  OPERATIONAL_SNAPSHOT_SCHEMA_VERSION,
  SYSTEM_HEALTH_STATES,
  WAITING_REASONS,
  WORK_PHASES,
  formatWorkKey,
  githubWorkKey,
  isExactHeadSha,
  parseReviewTarget,
  parseWorkKey,
  type DecisionTaskFacts,
  type DecisionWorkFacts,
  type ExecutorFacts,
  type FactProvenance,
  type GitHubWorkFacts,
  type OperationalSnapshot,
  type ReviewProjection,
  type RuntimeWorkFacts,
  type SourceFreshness,
  type SourceStatus,
  type WorkKey,
  type WorkProjection,
} from "./index";

const OWNER = "owner";
const REPO = "repo";
const ISSUE = 109;
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const key = githubWorkKey(OWNER, REPO, ISSUE);
const provenance: FactProvenance = { source: "github", instance: "github:owner/repo", observedAt: 1_700_000_000_000 };

describe("WorkKey identity (GitHub Issue root)", () => {
  it("canonicalizes owner/repo case and formats the key", () => {
    const canonical = githubWorkKey("Owner", "Repo", 109);
    expect(canonical).toEqual({ provider: "github", key: "owner/repo#109" });
    expect(formatWorkKey(canonical)).toBe("github:owner/repo#109");
    expect(formatWorkKey(key)).toBe("github:owner/repo#109");
  });

  it("round-trips through the strict parser and rejects illegal GitHub roots", () => {
    expect(parseWorkKey({ provider: "github", key: "owner/repo#109" })).toEqual(key);
    expect(parseWorkKey({ provider: "work-items", key: "project:abc#1" })).toEqual({ provider: "work-items", key: "project:abc#1" });
    expect(() => parseWorkKey({ provider: "github", key: "owner/repo#0" })).toThrow();
    expect(() => parseWorkKey({ provider: "github", key: "owner/repo" })).toThrow();
    expect(() => parseWorkKey({ provider: "GitHub", key: "owner/repo#1" })).toThrow();
    expect(() => githubWorkKey("owner", "repo", 0)).toThrow();
    expect(() => githubWorkKey("owner/evil", "repo", 1)).toThrow();
  });

  it("is a readonly value at the type level and requires both fields", () => {
    const alias: WorkKey = { provider: "github", key: "owner/repo#109" };
    const mutate = (value: WorkKey): void => {
      // @ts-expect-error WorkKey is a readonly value object.
      value.key = "owner/repo#110";
    };
    // @ts-expect-error WorkKey requires provider and key.
    const missingField: WorkKey = { provider: "github" };
    void mutate; void alias; void missingField;
  });
});

describe("Source freshness discriminant (fresh / stale / unavailable / unknown)", () => {
  it("keeps an observation time for fresh and stale, a reason for failures", () => {
    const states: readonly SourceFreshness[] = [
      { status: "fresh", observedAt: 1_700_000_000_000, lastAttemptAt: 1_700_000_000_000 },
      { status: "stale", observedAt: 1_600_000_000_000, lastAttemptAt: 1_700_000_000_000 },
      { status: "unavailable", observedAt: 1_600_000_000_000, lastAttemptAt: 1_700_000_000_000, reason: "github_unreachable" },
      { status: "unavailable", observedAt: null, lastAttemptAt: 1_700_000_000_000, reason: "github_unreachable" },
      { status: "unknown", lastAttemptAt: null, reason: null },
    ];
    // A stale observation still carries the real observation time, not "now".
    const stale = states[1]!;
    expect(stale.status).toBe("stale");
    expect(stale.status === "stale" ? stale.observedAt < stale.lastAttemptAt : false).toBe(true);
    // Failure before any success is unavailable-with-null, distinct from unknown.
    const failedBeforeSuccess = states[3]!;
    const neverAttempted = states[4]!;
    expect(failedBeforeSuccess).not.toEqual(neverAttempted);
  });

  it("rejects impossible freshness shapes at the type level", () => {
    // @ts-expect-error fresh freshness requires a successful observation timestamp.
    const freshWithoutObserved: SourceFreshness = { status: "fresh", lastAttemptAt: 1 };
    // @ts-expect-error unavailable freshness requires an explicit failure reason.
    const unavailableWithoutReason: SourceFreshness = { status: "unavailable", observedAt: null, lastAttemptAt: 1 };
    // @ts-expect-error status must be one of the four freshness states.
    const bogusStatus: SourceFreshness = { status: "offline", lastAttemptAt: null, reason: null };
    void freshWithoutObserved; void unavailableWithoutReason; void bogusStatus;
  });
});

describe("Normalized facts provenance and absence", () => {
  it("carries source provenance on every fact bundle", () => {
    const github: { readonly provenance: FactProvenance } = { provenance };
    expect(github.provenance.source).toBe("github");
    expect(github.provenance.observedAt).toBe(1_700_000_000_000);
  });

  it("expresses confirmed absence as null, distinct from a failed read", () => {
    const noPullRequest: GitHubWorkFacts = {
      workKey: key,
      issue: { state: "open", url: "https://github.com/owner/repo/issues/109" },
      pullRequest: null,
      ci: null,
      provenance,
    };
    const noSession: DecisionWorkFacts = {
      workKey: key,
      session: null,
      tasks: [],
      results: [],
      provenance: { source: "decision", instance: "decision:local", observedAt: 6 },
    };
    const unavailable: SourceFreshness = { status: "unavailable", observedAt: null, lastAttemptAt: 1, reason: "github_unreachable" };
    // null nested object = read succeeded, nothing there; unavailable = the read failed.
    expect(noPullRequest.pullRequest).toBeNull();
    expect(noPullRequest.ci).toBeNull();
    expect(noSession.session).toBeNull();
    expect(unavailable.status).toBe("unavailable");
  });

  it("rejects impossible fact shapes at the type level", () => {
    // @ts-expect-error GitHubWorkFacts requires an issue object.
    const missingIssue: GitHubWorkFacts = { workKey: key, pullRequest: null, ci: null, provenance };
    void missingIssue;
  });

  it("keeps runtime facts unlinked (null workKey) instead of inventing an identity", () => {
    const unlinked: RuntimeWorkFacts = {
      workKey: null,
      issueId: "provider-item-001",
      attempt: null,
      retry: { issueId: "provider-item-001", identifier: null, attempt: 2, retryInMs: 4_000, error: "boom" },
      provenance: { source: "runtime", instance: "orchestrator:local", observedAt: 1 },
    };
    expect(unlinked.workKey).toBeNull();
    expect(unlinked.retry?.retryInMs).toBe(4_000);
  });

  it("keeps decision tasks/results without leaking store-only fields", () => {
    const reviewTask: DecisionTaskFacts = { taskId: "t1", kind: "review", revision: 1, status: "running", target: { repository: "owner/repo", prNumber: 120, headSha: HEAD_A }, createdAtMs: 1, updatedAtMs: 2 };
    const planTask: DecisionTaskFacts = { taskId: "t2", kind: "plan", revision: 1, status: "completed", createdAtMs: 1, updatedAtMs: 2 };
    const decision: DecisionWorkFacts = {
      workKey: key,
      session: { sessionId: "github:owner/repo#109", status: "active", bindingGeneration: 2, adapter: "chatgpt-web", updatedAtMs: 5 },
      tasks: [reviewTask, planTask],
      results: [{ taskId: "t0", revision: 1, createdAtMs: 1, outcome: { kind: "review", verdict: "approve", target: { repository: "owner/repo", prNumber: 120, headSha: HEAD_A } } }],
      provenance: { source: "decision", instance: "decision:local", observedAt: 6 },
    };
    const first = decision.tasks[0]!;
    expect(first.kind === "review" ? first.target.headSha : null).toBe(HEAD_A);
    expect(decision.tasks[1]?.kind).toBe("plan");
    expect(decision.results[0]?.outcome.kind).toBe("review");
  });

  it("makes a review task without an exact target and a plan task with one unrepresentable", () => {
    // @ts-expect-error a review task must carry its exact repository / PR / HEAD target.
    const reviewWithoutTarget: DecisionTaskFacts = { taskId: "t1", kind: "review", revision: 1, status: "running", createdAtMs: 1, updatedAtMs: 2 };
    // @ts-expect-error a plan task must not carry a review target.
    const planWithTarget: DecisionTaskFacts = { taskId: "t2", kind: "plan", revision: 1, status: "pending", target: { repository: "owner/repo", prNumber: 120, headSha: HEAD_A }, createdAtMs: 1, updatedAtMs: 2 };
    void reviewWithoutTarget; void planWithTarget;
  });

  it("models executor host as observation metadata only", () => {
    const executor: ExecutorFacts = {
      id: "exec-1",
      role: "reviewer",
      adapter: "chatgpt-web",
      host: "machine-a",
      status: "offline",
      lastHeartbeatAtMs: null,
      currentWorkKey: key,
      provenance: { source: "executor", instance: "chatgpt-web:machine-a", observedAt: 9 },
    };
    expect(executor.host).toBe("machine-a");
    expect(executor.status).toBe("offline");
  });
});

describe("Exact HEAD SHA and review projections", () => {
  it("accepts only a full lowercase 40-hex SHA", () => {
    expect(isExactHeadSha(HEAD_A)).toBe(true);
    expect(EXACT_HEAD_SHA_PATTERN.test(HEAD_B)).toBe(true);
    expect(isExactHeadSha(HEAD_A.toUpperCase())).toBe(false);
    expect(isExactHeadSha(HEAD_A.slice(0, 39))).toBe(false);
    expect(isExactHeadSha(`${"g".repeat(39)}0`)).toBe(false);
  });

  it("validates a review target's repository, PR number and exact SHA", () => {
    const target = parseReviewTarget({ repository: "owner/repo", prNumber: 120, headSha: HEAD_A });
    expect(target).toEqual({ repository: "owner/repo", prNumber: 120, headSha: HEAD_A });
    expect(() => parseReviewTarget({ repository: "owner/repo", prNumber: 120, headSha: HEAD_A.toUpperCase() })).toThrow();
    expect(() => parseReviewTarget({ repository: "owner/repo", prNumber: 0, headSha: HEAD_A })).toThrow();
  });

  it("represents an approval against an older SHA without approving the current HEAD", () => {
    const review: ReviewProjection = {
      currentHeadSha: HEAD_B,
      taskTarget: { repository: "owner/repo", prNumber: 120, headSha: HEAD_A },
      task: { taskId: "t1", kind: "review", revision: 1, status: "completed", target: { repository: "owner/repo", prNumber: 120, headSha: HEAD_A }, createdAtMs: 1, updatedAtMs: 2 },
      result: { taskId: "t1", revision: 1, createdAtMs: 3, outcome: { kind: "review", verdict: "approve", target: { repository: "owner/repo", prNumber: 120, headSha: HEAD_A } } },
      approval: "approved_stale_head",
    };
    expect(review.currentHeadSha).toBe(HEAD_B);
    expect(review.result?.outcome.kind === "review" ? review.result.outcome.target.headSha : null).toBe(HEAD_A);
    expect(review.approval).not.toBe("approved_current_head");
  });
});

describe("Derived display enums", () => {
  it("exposes the derived-only phase/waiting/attention/health sets", () => {
    expect(WORK_PHASES).toContain("planning");
    expect(WORK_PHASES).toContain("unknown");
    expect((WORK_PHASES as readonly string[]).includes("attention")).toBe(false);
    expect(WAITING_REASONS).toContain("waiting_for_ci");
    expect(ATTENTION_STATES).toEqual(["normal", "waiting", "degraded", "needs_human", "failed"]);
    expect(SYSTEM_HEALTH_STATES).toEqual(["healthy", "degraded", "unavailable", "unknown"]);
  });

  it("models phase and attention as orthogonal dimensions", () => {
    const projection: WorkProjection = {
      key,
      workItem: { identifier: "owner/repo#109", title: null, url: "https://github.com/owner/repo/issues/109" },
      phase: "review",
      attention: "degraded",
      waiting: { reason: "waiting_for_review", since: 1_700_000_000_000 },
      planning: null,
      execution: null,
      pullRequest: null,
      ci: null,
      review: null,
      freshness: {
        github: { status: "fresh", observedAt: 1_700_000_000_000, lastAttemptAt: 1_700_000_000_000 },
        runtime: { status: "fresh", observedAt: 1_700_000_000_000, lastAttemptAt: 1_700_000_000_000 },
        decision: { status: "unavailable", observedAt: null, lastAttemptAt: 1_700_000_000_000, reason: "decision_unreachable" },
      },
      evidence: [{ source: "github", code: "pr_open", detail: null, observedAt: 1_700_000_000_000 }],
    };
    expect(projection.phase).toBe("review");
    expect(projection.attention).toBe("degraded");
    expect(projection.freshness.decision.status).toBe("unavailable");
  });

  it("is a readonly value at the type level", () => {
    const projection = { phase: "review", attention: "normal" } as WorkProjection;
    const mutate = (value: WorkProjection): void => {
      // @ts-expect-error WorkProjection is a readonly value object.
      value.phase = "completed";
    };
    void mutate; void projection;
  });
});

describe("Operational snapshot", () => {
  const sources: readonly SourceStatus[] = [
    { source: "github", instance: "github:owner/repo", freshness: { status: "fresh", observedAt: 1, lastAttemptAt: 1 } },
    { source: "runtime", instance: "orchestrator:local", freshness: { status: "fresh", observedAt: 1, lastAttemptAt: 1 } },
    { source: "decision", instance: "decision:local", freshness: { status: "unavailable", observedAt: null, lastAttemptAt: 1, reason: "decision_unreachable" } },
  ];

  it("pins the v1 schema version", () => {
    expect(OPERATIONAL_SNAPSHOT_SCHEMA_VERSION).toBe(1);
    // @ts-expect-error schemaVersion is the literal 1.
    const bad: OperationalSnapshot = { schemaVersion: 2, generatedAt: 1, health: "unknown", summary: { active: 0, waiting: 0, retrying: 0, needsHuman: 0 }, work: [], executors: [], sources: [], anomalies: [] };
    void bad;
  });

  it("distinguishes an empty snapshot from an all-unknown-source snapshot", () => {
    const empty: OperationalSnapshot = {
      schemaVersion: 1,
      generatedAt: 1,
      health: "healthy",
      summary: { active: 0, waiting: 0, retrying: 0, needsHuman: 0 },
      work: [],
      executors: [],
      sources: [{ source: "github", instance: "github:owner/repo", freshness: { status: "fresh", observedAt: 1, lastAttemptAt: 1 } }],
      anomalies: [],
    };
    const allUnknown: OperationalSnapshot = {
      schemaVersion: 1,
      generatedAt: 1,
      health: "unknown",
      summary: { active: 0, waiting: 0, retrying: 0, needsHuman: 0 },
      work: [],
      executors: [],
      sources: [{ source: "github", instance: "github:owner/repo", freshness: { status: "unknown", lastAttemptAt: null, reason: null } }],
      anomalies: [],
    };
    expect(empty.health).not.toBe(allUnknown.health);
    expect(empty.sources[0]?.freshness.status).toBe("fresh");
    expect(allUnknown.sources[0]?.freshness.status).toBe("unknown");
  });

  it("allows a partial projection where one source is unavailable", () => {
    const partial: OperationalSnapshot = {
      schemaVersion: 1,
      generatedAt: 1,
      health: "degraded",
      summary: { active: 1, waiting: 0, retrying: 0, needsHuman: 0 },
      work: [],
      executors: [],
      sources,
      anomalies: [{ code: "decision_source_unavailable", severity: "warning", workKey: key, message: "Decision facts unavailable", detectedAt: 1 }],
    };
    expect(partial.sources.map(source => source.freshness.status)).toEqual(["fresh", "fresh", "unavailable"]);
    expect(partial.health).toBe("degraded");
  });
});
