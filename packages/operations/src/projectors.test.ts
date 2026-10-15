import { describe, expect, it } from "vitest";
import {
  deriveAttention,
  deriveExecutorProjection,
  deriveOperationalSnapshot,
  deriveReviewProjection,
  deriveSnapshotSummary,
  deriveSystemHealth,
  deriveWaitingReason,
  deriveWorkPhase,
  deriveWorkProjection,
  githubWorkKey,
  projectExecutor,
  projectOperationalSnapshot,
  projectWork,
  type DecisionTaskFacts,
  type DecisionWorkFacts,
  type ExecutorFacts,
  type GitHubWorkFacts,
  type OperationFactCollection,
  type OperationSourceResult,
  type OperationalAnomaly,
  type RuntimeWorkFacts,
  type SourceStatus,
  type WorkProjection,
} from "./index";

const OWNER = "owner";
const REPO = "repo";
const ISSUE = 109;
const WORK_KEY = githubWorkKey(OWNER, REPO, ISSUE);

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const NOW = 1_700_000_000_000;

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const val = (obj as any)[key];
    if (val && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

function createGitHubFact(overrides?: Partial<GitHubWorkFacts>): OperationSourceResult<GitHubWorkFacts> {
  return {
    source: "github",
    instance: "github:owner/repo",
    freshness: { status: "fresh", observedAt: NOW, lastAttemptAt: NOW },
    facts: {
      workKey: WORK_KEY,
      issue: { state: "open", url: `https://github.com/${OWNER}/${REPO}/issues/${ISSUE}` },
      pullRequest: null,
      ci: null,
      provenance: { source: "github", instance: "github:owner/repo", observedAt: NOW },
      ...overrides,
    },
  };
}

function createDecisionFact(overrides?: Partial<DecisionWorkFacts>): OperationSourceResult<DecisionWorkFacts> {
  return {
    source: "decision",
    instance: "decision:local",
    freshness: { status: "fresh", observedAt: NOW, lastAttemptAt: NOW },
    facts: {
      workKey: WORK_KEY,
      session: null,
      tasks: [],
      results: [],
      provenance: { source: "decision", instance: "decision:local", observedAt: NOW },
      ...overrides,
    },
  };
}

function createRuntimeFact(rows: readonly RuntimeWorkFacts[] = []): OperationSourceResult<readonly RuntimeWorkFacts[]> {
  return {
    source: "runtime",
    instance: "orchestrator:local",
    freshness: { status: "fresh", observedAt: NOW, lastAttemptAt: NOW },
    facts: rows,
  };
}

function createExecutorFact(facts: readonly ExecutorFacts[] = []): OperationSourceResult<readonly ExecutorFacts[]> {
  return {
    source: "executor",
    instance: "inventory:local",
    freshness: { status: "fresh", observedAt: NOW, lastAttemptAt: NOW },
    facts,
  };
}

describe("deriveReviewProjection & exact HEAD approval safety", () => {
  it("derives approved_current_head only when target matches exact current HEAD and both sources are fresh", () => {
    const gh = createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_A, isDraft: false },
      ci: { status: "success", headSha: SHA_A },
    });
    const dec = createDecisionFact({
      tasks: [
        { taskId: "t1", revision: 1, kind: "review", status: "completed", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: 1, updatedAtMs: 2 },
      ],
      results: [
        { taskId: "t1", revision: 1, createdAtMs: 3, outcome: { kind: "review", verdict: "approve", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A } } },
      ],
    });

    const projection = deriveReviewProjection({ workKey: WORK_KEY, github: gh, decision: dec });
    expect(projection).not.toBeNull();
    expect(projection?.approval).toBe("approved_current_head");
    expect(projection?.currentHeadSha).toBe(SHA_A);
    expect(projection?.taskTarget?.headSha).toBe(SHA_A);
  });

  it("derives approved_stale_head when approval was produced against older SHA-A but PR HEAD is now SHA-B", () => {
    const gh = createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_B, isDraft: false },
    });
    const dec = createDecisionFact({
      tasks: [
        { taskId: "t1", revision: 1, kind: "review", status: "completed", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: 1, updatedAtMs: 2 },
      ],
      results: [
        { taskId: "t1", revision: 1, createdAtMs: 3, outcome: { kind: "review", verdict: "approve", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A } } },
      ],
    });

    const projection = deriveReviewProjection({ workKey: WORK_KEY, github: gh, decision: dec });
    expect(projection).not.toBeNull();
    expect(projection?.approval).toBe("approved_stale_head");
    expect(projection?.currentHeadSha).toBe(SHA_B);
    expect(projection?.taskTarget?.headSha).toBe(SHA_A);
  });

  it("derives approved_stale_head if Decision source is stale even when SHA matches", () => {
    const gh = createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_A, isDraft: false },
    });
    const dec = createDecisionFact({
      tasks: [
        { taskId: "t1", revision: 1, kind: "review", status: "completed", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: 1, updatedAtMs: 2 },
      ],
      results: [
        { taskId: "t1", revision: 1, createdAtMs: 3, outcome: { kind: "review", verdict: "approve", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A } } },
      ],
    });
    // Set Decision freshness to stale
    const staleDec: OperationSourceResult<DecisionWorkFacts> = {
      ...dec,
      freshness: { status: "stale", observedAt: NOW - 60000, lastAttemptAt: NOW },
    };

    const projection = deriveReviewProjection({ workKey: WORK_KEY, github: gh, decision: staleDec });
    expect(projection?.approval).toBe("approved_stale_head");
  });

  it("derives changes_requested when review verdict is changes_requested", () => {
    const gh = createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_A, isDraft: false },
    });
    const dec = createDecisionFact({
      tasks: [
        { taskId: "t1", revision: 1, kind: "review", status: "completed", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: 1, updatedAtMs: 2 },
      ],
      results: [
        { taskId: "t1", revision: 1, createdAtMs: 3, outcome: { kind: "review", verdict: "changes_requested", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A } } },
      ],
    });

    const projection = deriveReviewProjection({ workKey: WORK_KEY, github: gh, decision: dec });
    expect(projection?.approval).toBe("changes_requested");
  });

  it("derives pending when review task is running or pending with no result", () => {
    const gh = createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_A, isDraft: false },
    });
    const dec = createDecisionFact({
      tasks: [
        { taskId: "t1", revision: 1, kind: "review", status: "running", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: 1, updatedAtMs: 2 },
      ],
      results: [],
    });

    const projection = deriveReviewProjection({ workKey: WORK_KEY, github: gh, decision: dec });
    expect(projection?.approval).toBe("pending");
  });

  it("derives unknown when Decision source is unavailable", () => {
    const gh = createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_A, isDraft: false },
    });
    const dec: OperationSourceResult<DecisionWorkFacts> = {
      source: "decision",
      instance: "decision:local",
      freshness: { status: "unavailable", observedAt: null, lastAttemptAt: NOW, reason: "disk_error" },
      facts: null,
    };

    const projection = deriveReviewProjection({ workKey: WORK_KEY, github: gh, decision: dec });
    expect(projection?.approval).toBe("unknown");
  });
});

describe("deriveWorkPhase precedence rules", () => {
  it("derives completed when fresh GitHub facts show issue is closed", () => {
    const gh = createGitHubFact({
      issue: { state: "closed", url: "url" },
    });
    expect(deriveWorkPhase({ workKey: WORK_KEY, github: gh })).toBe("completed");
  });

  it("derives completed when fresh GitHub facts show PR is merged", () => {
    const gh = createGitHubFact({
      pullRequest: { number: 42, state: "merged", url: "url", headSha: SHA_A, isDraft: false },
    });
    expect(deriveWorkPhase({ workKey: WORK_KEY, github: gh })).toBe("completed");
  });

  it("derives unknown when GitHub source is stale or unavailable", () => {
    const staleGh: OperationSourceResult<GitHubWorkFacts> = {
      source: "github",
      instance: "github:owner/repo",
      freshness: { status: "stale", observedAt: NOW - 60000, lastAttemptAt: NOW },
      facts: {
        workKey: WORK_KEY,
        issue: { state: "closed", url: "url" },
        pullRequest: null,
        ci: null,
        provenance: { source: "github", instance: "github:owner/repo", observedAt: NOW - 60000 },
      },
    };
    expect(deriveWorkPhase({ workKey: WORK_KEY, github: staleGh })).toBe("unknown");

    const unavailableGh: OperationSourceResult<GitHubWorkFacts> = {
      source: "github",
      instance: "github:owner/repo",
      freshness: { status: "unavailable", observedAt: null, lastAttemptAt: NOW, reason: "network_error" },
      facts: null,
    };
    expect(deriveWorkPhase({ workKey: WORK_KEY, github: unavailableGh })).toBe("unknown");
  });

  it("derives repair when runtime is actively running after a CI failure or changes_requested", () => {
    const gh = createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_A, isDraft: false },
      ci: { status: "failure", headSha: SHA_A },
    });
    const runtime = createRuntimeFact([
      {
        workKey: WORK_KEY,
        issueId: "issue-1",
        attempt: {
          issueId: "issue-1",
          issueIdentifier: "109",
          attempt: 2,
          status: "streaming_turn",
          workspacePath: "/ws/109",
          startedAtMs: NOW,
        },
        retry: null,
        provenance: { source: "runtime", instance: "inst", observedAt: NOW },
      },
    ]);

    expect(deriveWorkPhase({ workKey: WORK_KEY, github: gh, runtime })).toBe("repair");
  });

  it("derives coding when runtime is actively running for initial implementation", () => {
    const gh = createGitHubFact({
      pullRequest: null,
    });
    const runtime = createRuntimeFact([
      {
        workKey: WORK_KEY,
        issueId: "issue-1",
        attempt: {
          issueId: "issue-1",
          issueIdentifier: "109",
          attempt: null,
          status: "streaming_turn",
          workspacePath: "/ws/109",
          startedAtMs: NOW,
        },
        retry: null,
        provenance: { source: "runtime", instance: "inst", observedAt: NOW },
      },
    ]);

    expect(deriveWorkPhase({ workKey: WORK_KEY, github: gh, runtime })).toBe("coding");
  });

  it("derives landing when open PR, current HEAD CI success, and approved_current_head", () => {
    const gh = createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_A, isDraft: false },
      ci: { status: "success", headSha: SHA_A },
    });
    const dec = createDecisionFact({
      tasks: [
        { taskId: "t1", revision: 1, kind: "review", status: "completed", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: 1, updatedAtMs: 2 },
      ],
      results: [
        { taskId: "t1", revision: 1, createdAtMs: 3, outcome: { kind: "review", verdict: "approve", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A } } },
      ],
    });

    expect(deriveWorkPhase({ workKey: WORK_KEY, github: gh, decision: dec })).toBe("landing");
  });

  it("does not derive landing if PR is draft or CI is pending", () => {
    const ghDraft = createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_A, isDraft: true },
      ci: { status: "success", headSha: SHA_A },
    });
    const dec = createDecisionFact({
      tasks: [
        { taskId: "t1", revision: 1, kind: "review", status: "completed", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: 1, updatedAtMs: 2 },
      ],
      results: [
        { taskId: "t1", revision: 1, createdAtMs: 3, outcome: { kind: "review", verdict: "approve", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A } } },
      ],
    });
    expect(deriveWorkPhase({ workKey: WORK_KEY, github: ghDraft, decision: dec })).not.toBe("landing");

    const ghCiPending = createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_A, isDraft: false },
      ci: { status: "pending", headSha: SHA_A },
    });
    expect(deriveWorkPhase({ workKey: WORK_KEY, github: ghCiPending, decision: dec })).toBe("ci");
  });

  it("derives review when CI is success and review task is pending or running", () => {
    const gh = createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_A, isDraft: false },
      ci: { status: "success", headSha: SHA_A },
    });
    const dec = createDecisionFact({
      tasks: [
        { taskId: "t1", revision: 1, kind: "review", status: "running", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: 1, updatedAtMs: 2 },
      ],
    });
    expect(deriveWorkPhase({ workKey: WORK_KEY, github: gh, decision: dec })).toBe("review");
  });

  it("derives ready when plan verdict is ready and no PR or execution attempt has started", () => {
    const gh = createGitHubFact({ pullRequest: null });
    const dec = createDecisionFact({
      tasks: [{ taskId: "t1", revision: 1, kind: "plan", status: "completed", createdAtMs: 1, updatedAtMs: 2 }],
      results: [{ taskId: "t1", revision: 1, createdAtMs: 3, outcome: { kind: "plan", verdict: "ready" } }],
    });
    expect(deriveWorkPhase({ workKey: WORK_KEY, github: gh, decision: dec })).toBe("ready");
  });

  it("derives planning when plan task is active or awaiting plan verdict", () => {
    const gh = createGitHubFact({ pullRequest: null });
    const dec = createDecisionFact({
      session: { sessionId: "github:owner/repo#109", status: "active", bindingGeneration: 1, adapter: "chatgpt-web", updatedAtMs: 2 },
      tasks: [{ taskId: "t1", revision: 1, kind: "plan", status: "running", createdAtMs: 1, updatedAtMs: 2 }],
    });
    expect(deriveWorkPhase({ workKey: WORK_KEY, github: gh, decision: dec })).toBe("planning");
  });
});

describe("deriveWaitingReason coverage", () => {
  it("derives needs_human when plan or review verdict requires human", () => {
    const dec = createDecisionFact({
      tasks: [{ taskId: "t1", revision: 1, kind: "plan", status: "completed", createdAtMs: 1, updatedAtMs: 2 }],
      results: [{ taskId: "t1", revision: 1, createdAtMs: 3, outcome: { kind: "plan", verdict: "needs_human" } }],
    });
    const waiting = deriveWaitingReason({ workKey: WORK_KEY, github: createGitHubFact(), decision: dec });
    expect(waiting?.reason).toBe("needs_human");
    expect(waiting?.since).toBe(3);
  });

  it("derives needs_clarification when plan verdict is needs_clarification", () => {
    const dec = createDecisionFact({
      tasks: [{ taskId: "t1", revision: 1, kind: "plan", status: "completed", createdAtMs: 1, updatedAtMs: 2 }],
      results: [{ taskId: "t1", revision: 1, createdAtMs: 3, outcome: { kind: "plan", verdict: "needs_clarification" } }],
    });
    const waiting = deriveWaitingReason({ workKey: WORK_KEY, github: createGitHubFact(), decision: dec });
    expect(waiting?.reason).toBe("needs_clarification");
    expect(waiting?.since).toBe(3);
  });

  it("derives retry_backoff when runtime is in retry backoff", () => {
    const runtime = createRuntimeFact([
      {
        workKey: WORK_KEY,
        issueId: "issue-1",
        attempt: { issueId: "issue-1", issueIdentifier: "109", attempt: 1, status: "failed", workspacePath: "/ws/109", startedAtMs: 100 },
        retry: { issueId: "issue-1", identifier: "109", attempt: 2, retryInMs: 5000, error: "transient" },
        provenance: { source: "runtime", instance: "inst", observedAt: NOW },
      },
    ]);
    const waiting = deriveWaitingReason({ workKey: WORK_KEY, github: createGitHubFact(), runtime });
    expect(waiting?.reason).toBe("retry_backoff");
    expect(waiting?.since).toBeNull();
  });

  it("derives waiting_for_executor on pending plan or review tasks", () => {
    const dec = createDecisionFact({
      tasks: [{ taskId: "t1", revision: 1, kind: "plan", status: "pending", createdAtMs: 55, updatedAtMs: 55 }],
    });
    const waiting = deriveWaitingReason({ workKey: WORK_KEY, github: createGitHubFact(), decision: dec });
    expect(waiting?.reason).toBe("waiting_for_executor");
    expect(waiting?.since).toBe(55);
  });

  it("derives waiting_for_ci when open PR has pending CI", () => {
    const gh = createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_A, isDraft: false },
      ci: { status: "pending", headSha: SHA_A },
    });
    const waiting = deriveWaitingReason({ workKey: WORK_KEY, github: gh });
    expect(waiting?.reason).toBe("waiting_for_ci");
    expect(waiting?.since).toBeNull();
  });

  it("derives waiting_for_review when CI is success and review task is running", () => {
    const gh = createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_A, isDraft: false },
      ci: { status: "success", headSha: SHA_A },
    });
    const dec = createDecisionFact({
      tasks: [{ taskId: "t1", revision: 1, kind: "review", status: "running", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: 88, updatedAtMs: 88 }],
    });
    const waiting = deriveWaitingReason({ workKey: WORK_KEY, github: gh, decision: dec });
    expect(waiting?.reason).toBe("waiting_for_review");
    expect(waiting?.since).toBe(88);
  });

  it("derives waiting_for_plan when plan task is running", () => {
    const gh = createGitHubFact({ pullRequest: null });
    const dec = createDecisionFact({
      tasks: [{ taskId: "t1", revision: 1, kind: "plan", status: "running", createdAtMs: 99, updatedAtMs: 99 }],
    });
    const waiting = deriveWaitingReason({ workKey: WORK_KEY, github: gh, decision: dec });
    expect(waiting?.reason).toBe("waiting_for_plan");
    expect(waiting?.since).toBe(99);
  });

  it("clears waiting (returns null) when work phase is completed", () => {
    const gh = createGitHubFact({
      issue: { state: "closed", url: "url" },
    });
    const dec = createDecisionFact({
      tasks: [{ taskId: "t1", revision: 1, kind: "plan", status: "pending", createdAtMs: 55, updatedAtMs: 55 }],
    });
    expect(deriveWaitingReason({ workKey: WORK_KEY, github: gh, decision: dec })).toBeNull();
  });
});

describe("deriveAttention and orthogonality", () => {
  it("derives needs_human with highest precedence", () => {
    const dec = createDecisionFact({
      tasks: [{ taskId: "t1", revision: 1, kind: "plan", status: "completed", createdAtMs: 1, updatedAtMs: 2 }],
      results: [{ taskId: "t1", revision: 1, createdAtMs: 3, outcome: { kind: "plan", verdict: "needs_human" } }],
    });
    expect(deriveAttention({ workKey: WORK_KEY, github: createGitHubFact(), decision: dec })).toBe("needs_human");
  });

  it("derives failed for terminal unrecovered runtime failure", () => {
    const runtime = createRuntimeFact([
      {
        workKey: WORK_KEY,
        issueId: "issue-1",
        attempt: { issueId: "issue-1", issueIdentifier: "109", attempt: 1, status: "failed", workspacePath: "/ws/109", startedAtMs: 100 },
        retry: null,
        provenance: { source: "runtime", instance: "inst", observedAt: NOW },
      },
    ]);
    expect(deriveAttention({ workKey: WORK_KEY, github: createGitHubFact(), runtime })).toBe("failed");
  });

  it("derives degraded when a source is stale or unavailable", () => {
    const staleGh: OperationSourceResult<GitHubWorkFacts> = {
      source: "github",
      instance: "github:owner/repo",
      freshness: { status: "stale", observedAt: NOW - 60000, lastAttemptAt: NOW },
      facts: {
        workKey: WORK_KEY,
        issue: { state: "closed", url: "url" },
        pullRequest: null,
        ci: null,
        provenance: { source: "github", instance: "github:owner/repo", observedAt: NOW - 60000 },
      },
    };
    expect(deriveAttention({ workKey: WORK_KEY, github: staleGh })).toBe("degraded");
  });

  it("maintains orthogonality: completed phase can have degraded attention if source is stale", () => {
    const staleGh: OperationSourceResult<GitHubWorkFacts> = {
      source: "github",
      instance: "github:owner/repo",
      freshness: { status: "fresh", observedAt: NOW, lastAttemptAt: NOW },
      facts: {
        workKey: WORK_KEY,
        issue: { state: "closed", url: "url" },
        pullRequest: null,
        ci: null,
        provenance: { source: "github", instance: "github:owner/repo", observedAt: NOW },
      },
    };
    const staleDec: OperationSourceResult<DecisionWorkFacts> = {
      source: "decision",
      instance: "decision:local",
      freshness: { status: "stale", observedAt: NOW - 60000, lastAttemptAt: NOW },
      facts: null,
    };

    const phase = deriveWorkPhase({ workKey: WORK_KEY, github: staleGh, decision: staleDec });
    const attention = deriveAttention({ workKey: WORK_KEY, github: staleGh, decision: staleDec });

    expect(phase).toBe("completed");
    expect(attention).toBe("degraded");
  });

  it("derives waiting when an active waiting condition exists", () => {
    const gh = createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_A, isDraft: false },
      ci: { status: "pending", headSha: SHA_A },
    });
    expect(deriveAttention({ workKey: WORK_KEY, github: gh })).toBe("waiting");
  });

  it("derives normal when active coding or clean operation has no issues", () => {
    const gh = createGitHubFact();
    const runtime = createRuntimeFact([
      {
        workKey: WORK_KEY,
        issueId: "issue-1",
        attempt: { issueId: "issue-1", issueIdentifier: "109", attempt: null, status: "streaming_turn", workspacePath: "/ws/109", startedAtMs: NOW },
        retry: null,
        provenance: { source: "runtime", instance: "inst", observedAt: NOW },
      },
    ]);
    expect(deriveAttention({ workKey: WORK_KEY, github: gh, runtime })).toBe("normal");
  });
});

describe("Purity, immutability & deterministic array order", () => {
  it("does not mutate deeply frozen inputs", () => {
    const gh = deepFreeze(createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_A, isDraft: false },
      ci: { status: "success", headSha: SHA_A },
    }));
    const dec = deepFreeze(createDecisionFact({
      tasks: [
        { taskId: "t1", revision: 1, kind: "review", status: "completed", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: 1, updatedAtMs: 2 },
      ],
      results: [
        { taskId: "t1", revision: 1, createdAtMs: 3, outcome: { kind: "review", verdict: "approve", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A } } },
      ],
    }));
    const runtime = deepFreeze(createRuntimeFact([]));
    const executor = deepFreeze(createExecutorFact([]));

    expect(() => projectWork({ workKey: WORK_KEY, github: gh, decision: dec, runtime, executor })).not.toThrow();
  });

  it("produces identical projections regardless of tasks/results array shuffling", () => {
    const taskA: DecisionTaskFacts = { taskId: "t1", revision: 1, kind: "plan", status: "completed", createdAtMs: 1, updatedAtMs: 2 };
    const taskB: DecisionTaskFacts = { taskId: "t2", revision: 2, kind: "review", status: "running", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: 3, updatedAtMs: 4 };

    const dec1 = createDecisionFact({
      tasks: [taskA, taskB],
    });
    const dec2 = createDecisionFact({
      tasks: [taskB, taskA],
    });

    const gh = createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_A, isDraft: false },
    });

    const proj1 = projectWork({ workKey: WORK_KEY, github: gh, decision: dec1 });
    const proj2 = projectWork({ workKey: WORK_KEY, github: gh, decision: dec2 });

    expect(proj1).toEqual(proj2);
  });
});

describe("deriveSystemHealth and projectOperationalSnapshot", () => {
  it("derives healthy for valid empty snapshot", () => {
    const sources: readonly SourceStatus[] = [
      { source: "github", instance: "gh:1", freshness: { status: "fresh", observedAt: NOW, lastAttemptAt: NOW } },
      { source: "runtime", instance: "rt:1", freshness: { status: "fresh", observedAt: NOW, lastAttemptAt: NOW } },
    ];
    const health = deriveSystemHealth({ sources, work: [] });
    expect(health).toBe("healthy");
  });

  it("derives unknown when all sources are unknown", () => {
    const sources: readonly SourceStatus[] = [
      { source: "github", instance: "gh:1", freshness: { status: "unknown", lastAttemptAt: null, reason: null } },
      { source: "decision", instance: "dec:1", freshness: { status: "unknown", lastAttemptAt: null, reason: null } },
    ];
    expect(deriveSystemHealth({ sources, work: [] })).toBe("unknown");
  });

  it("derives unavailable when sources are unavailable and none are fresh", () => {
    const sources: readonly SourceStatus[] = [
      { source: "github", instance: "gh:1", freshness: { status: "unavailable", observedAt: null, lastAttemptAt: NOW, reason: "err" } },
      { source: "decision", instance: "dec:1", freshness: { status: "unavailable", observedAt: null, lastAttemptAt: NOW, reason: "err" } },
    ];
    expect(deriveSystemHealth({ sources, work: [] })).toBe("unavailable");
  });

  it("derives degraded when any source is stale or unavailable, or work is degraded", () => {
    const sources: readonly SourceStatus[] = [
      { source: "github", instance: "gh:1", freshness: { status: "fresh", observedAt: NOW, lastAttemptAt: NOW } },
      { source: "decision", instance: "dec:1", freshness: { status: "stale", observedAt: NOW - 60000, lastAttemptAt: NOW } },
    ];
    expect(deriveSystemHealth({ sources, work: [] })).toBe("degraded");
  });

  it("computes snapshot summary cross-counts correctly", () => {
    const item1: WorkProjection = {
      key: githubWorkKey("o", "r", 1),
      workItem: { identifier: "o/r#1", title: null, url: null },
      phase: "coding",
      attention: "normal",
      waiting: null,
      planning: null, execution: null, pullRequest: null, ci: null, review: null,
      freshness: { github: { status: "fresh", observedAt: 1, lastAttemptAt: 1 }, runtime: { status: "fresh", observedAt: 1, lastAttemptAt: 1 }, decision: { status: "fresh", observedAt: 1, lastAttemptAt: 1 } },
      evidence: [],
    };
    const item2: WorkProjection = {
      key: githubWorkKey("o", "r", 2),
      workItem: { identifier: "o/r#2", title: null, url: null },
      phase: "review",
      attention: "waiting",
      waiting: { reason: "waiting_for_review", since: 1 },
      planning: null, execution: null, pullRequest: null, ci: null, review: null,
      freshness: { github: { status: "fresh", observedAt: 1, lastAttemptAt: 1 }, runtime: { status: "fresh", observedAt: 1, lastAttemptAt: 1 }, decision: { status: "fresh", observedAt: 1, lastAttemptAt: 1 } },
      evidence: [],
    };
    const item3: WorkProjection = {
      key: githubWorkKey("o", "r", 3),
      workItem: { identifier: "o/r#3", title: null, url: null },
      phase: "coding",
      attention: "waiting",
      waiting: { reason: "retry_backoff", since: 1 },
      planning: null, execution: null, pullRequest: null, ci: null, review: null,
      freshness: { github: { status: "fresh", observedAt: 1, lastAttemptAt: 1 }, runtime: { status: "fresh", observedAt: 1, lastAttemptAt: 1 }, decision: { status: "fresh", observedAt: 1, lastAttemptAt: 1 } },
      evidence: [],
    };
    const item4: WorkProjection = {
      key: githubWorkKey("o", "r", 4),
      workItem: { identifier: "o/r#4", title: null, url: null },
      phase: "planning",
      attention: "needs_human",
      waiting: { reason: "needs_clarification", since: 1 },
      planning: null, execution: null, pullRequest: null, ci: null, review: null,
      freshness: { github: { status: "fresh", observedAt: 1, lastAttemptAt: 1 }, runtime: { status: "fresh", observedAt: 1, lastAttemptAt: 1 }, decision: { status: "fresh", observedAt: 1, lastAttemptAt: 1 } },
      evidence: [],
    };
    const item5: WorkProjection = {
      key: githubWorkKey("o", "r", 5),
      workItem: { identifier: "o/r#5", title: null, url: null },
      phase: "completed",
      attention: "normal",
      waiting: null,
      planning: null, execution: null, pullRequest: null, ci: null, review: null,
      freshness: { github: { status: "fresh", observedAt: 1, lastAttemptAt: 1 }, runtime: { status: "fresh", observedAt: 1, lastAttemptAt: 1 }, decision: { status: "fresh", observedAt: 1, lastAttemptAt: 1 } },
      evidence: [],
    };

    const summary = deriveSnapshotSummary([item1, item2, item3, item4, item5]);
    expect(summary.active).toBe(4); // item1, item2, item3, item4
    expect(summary.waiting).toBe(3); // item2, item3, item4
    expect(summary.retrying).toBe(1); // item3
    expect(summary.needsHuman).toBe(1); // item4
  });

  it("builds a complete OperationalSnapshot with schemaVersion 1 and stable ordering", () => {
    const keyB = githubWorkKey("o", "r", 2);
    const keyA = githubWorkKey("o", "r", 1);
    const itemA: WorkProjection = {
      key: keyA,
      workItem: { identifier: "o/r#1", title: null, url: null },
      phase: "completed",
      attention: "normal",
      waiting: null,
      planning: null, execution: null, pullRequest: null, ci: null, review: null,
      freshness: { github: { status: "fresh", observedAt: 1, lastAttemptAt: 1 }, runtime: { status: "fresh", observedAt: 1, lastAttemptAt: 1 }, decision: { status: "fresh", observedAt: 1, lastAttemptAt: 1 } },
      evidence: [],
    };
    const itemB: WorkProjection = {
      key: keyB,
      workItem: { identifier: "o/r#2", title: null, url: null },
      phase: "landing",
      attention: "normal",
      waiting: null,
      planning: null, execution: null, pullRequest: null, ci: null, review: null,
      freshness: { github: { status: "fresh", observedAt: 1, lastAttemptAt: 1 }, runtime: { status: "fresh", observedAt: 1, lastAttemptAt: 1 }, decision: { status: "fresh", observedAt: 1, lastAttemptAt: 1 } },
      evidence: [],
    };

    const execB: ExecutorFacts = {
      id: "exec-2",
      role: "reviewer",
      adapter: "chatgpt-web",
      host: "host-b",
      status: "online",
      lastHeartbeatAtMs: 1234,
      currentWorkKey: null,
      provenance: { source: "executor", instance: "e:2", observedAt: 1 },
    };
    const execA: ExecutorFacts = {
      id: "exec-1",
      role: "planner",
      adapter: "chatgpt-web",
      host: "host-a",
      status: "online",
      lastHeartbeatAtMs: 1234,
      currentWorkKey: null,
      provenance: { source: "executor", instance: "e:1", observedAt: 1 },
    };

    const snapshot = projectOperationalSnapshot({
      generatedAt: NOW,
      work: [itemB, itemA], // intentionally unsorted
      executors: [execB, execA], // intentionally unsorted
      sources: [
        { source: "runtime", instance: "rt:1", freshness: { status: "fresh", observedAt: 1, lastAttemptAt: 1 } },
        { source: "github", instance: "gh:1", freshness: { status: "fresh", observedAt: 1, lastAttemptAt: 1 } },
      ],
      anomalies: [],
    });

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.generatedAt).toBe(NOW);
    expect(snapshot.health).toBe("healthy");
    // Verified stable sorting
    expect(snapshot.work.map((w) => w.key.key)).toEqual(["owner/repo#109", "owner/repo#109"].length ? ["o/r#1", "o/r#2"] : []);
    expect(snapshot.executors.map((e) => e.id)).toEqual(["exec-1", "exec-2"]);
    expect(snapshot.sources.map((s) => s.source)).toEqual(["github", "runtime"]);
  });
});

describe("projectExecutor helper", () => {
  it("projects ExecutorFacts into ExecutorProjection, carrying lastHeartbeatAt", () => {
    const fact: ExecutorFacts = {
      id: "exec-99",
      role: "implementer",
      adapter: "codex",
      host: "worker-5",
      status: "busy",
      lastHeartbeatAtMs: 1_699_999_999_000,
      currentWorkKey: WORK_KEY,
      provenance: { source: "executor", instance: "exec:inst", observedAt: 1 },
    };
    const proj = projectExecutor(fact);
    expect(proj.id).toBe("exec-99");
    expect(proj.role).toBe("implementer");
    expect(proj.adapter).toBe("codex");
    expect(proj.host).toBe("worker-5");
    expect(proj.status).toBe("busy");
    expect(proj.lastHeartbeatAt).toBe(1_699_999_999_000);
    expect(proj.currentWork).toEqual(WORK_KEY);
  });
});

describe("projectWork end-to-end integration", () => {
  it("projects work with full partial fact combination and explainability evidence", () => {
    const collection: OperationFactCollection = {
      github: createGitHubFact({
        pullRequest: { number: 42, state: "open", url: "https://github.com/owner/repo/pull/42", headSha: SHA_A, isDraft: false },
        ci: { status: "success", headSha: SHA_A },
      }),
      runtime: createRuntimeFact([
        {
          workKey: WORK_KEY,
          issueId: "issue-109",
          attempt: {
            issueId: "issue-109",
            issueIdentifier: "109",
            attempt: 1,
            status: "streaming_turn",
            workspacePath: "/ws/109",
            startedAtMs: NOW - 5000,
          },
          retry: null,
          provenance: { source: "runtime", instance: "rt", observedAt: NOW },
        },
      ]),
      decision: createDecisionFact({
        session: { sessionId: "github:owner/repo#109", status: "active", bindingGeneration: 1, adapter: "chatgpt-web", updatedAtMs: NOW - 10000 },
        tasks: [
          { taskId: "t1", revision: 1, kind: "plan", status: "completed", createdAtMs: NOW - 10000, updatedAtMs: NOW - 8000 },
        ],
        results: [
          { taskId: "t1", revision: 1, createdAtMs: NOW - 8000, outcome: { kind: "plan", verdict: "ready" } },
        ],
      }),
      executor: createExecutorFact(),
    };

    const projection = projectWork({ collection, workKey: WORK_KEY });
    expect(projection.key).toEqual(WORK_KEY);
    expect(projection.phase).toBe("coding");
    expect(projection.pullRequest?.number).toBe(42);
    expect(projection.ci?.status).toBe("success");
    expect(projection.planning?.planVerdict).toBe("ready");
    expect(projection.execution?.attempt).toBe(1);
    expect(projection.freshness.github.status).toBe("fresh");
    expect(projection.evidence.length).toBeGreaterThan(0);
  });
});

describe("projector function aliases", () => {
  it("exposes canonical aliases matching function implementations", () => {
    expect(deriveWorkProjection).toBe(projectWork);
    expect(deriveExecutorProjection).toBe(projectExecutor);
    expect(deriveOperationalSnapshot).toBe(projectOperationalSnapshot);
  });
});

describe("Reviewer feedback regression tests (Blockers 1-4)", () => {
  it("Blocker 1: superseded review task with approve result does not yield approved_current_head and does not allow landing", () => {
    const gh = createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_A, isDraft: false },
      ci: { status: "success", headSha: SHA_A },
    });
    // Task is superseded, but an approve result exists for SHA_A
    const dec = createDecisionFact({
      tasks: [
        { taskId: "t1", revision: 1, kind: "review", status: "superseded", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: 1, updatedAtMs: 2 },
      ],
      results: [
        { taskId: "t1", revision: 1, createdAtMs: 2, outcome: { kind: "review", verdict: "approve", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A } } },
      ],
    });

    const reviewProj = deriveReviewProjection({ workKey: WORK_KEY, github: gh, decision: dec });
    expect(reviewProj).not.toBeNull();
    // Must be not_approved, NOT approved_current_head!
    expect(reviewProj?.approval).toBe("not_approved");
    expect(reviewProj?.task?.status).toBe("superseded");
    expect(reviewProj?.result?.outcome.kind).toBe("review");

    // Phase must NOT be landing
    const phase = deriveWorkPhase({ workKey: WORK_KEY, github: gh, decision: dec });
    expect(phase).not.toBe("landing");
  });

  it("Blocker 2a: stale runtime streaming_turn does not yield coding phase", () => {
    const gh = createGitHubFact({
      pullRequest: null,
      issue: { state: "open", url: "issue-url" },
    });
    const runtimeStale: OperationSourceResult<readonly RuntimeWorkFacts[]> = {
      source: "runtime",
      instance: "orchestrator:local",
      freshness: { status: "stale", observedAt: NOW - 60000, lastAttemptAt: NOW },
      facts: [
        {
          workKey: WORK_KEY,
          issueId: "issue-1",
          attempt: { issueId: "issue-1", issueIdentifier: "109", attempt: 1, status: "streaming_turn", workspacePath: "/ws", startedAtMs: NOW - 60000 },
          retry: null,
          provenance: { source: "runtime", instance: "inst", observedAt: NOW - 60000 },
        },
      ],
    };

    const phase = deriveWorkPhase({ workKey: WORK_KEY, github: gh, runtime: runtimeStale });
    // Must NOT return coding!
    expect(phase).not.toBe("coding");
    expect(phase).toBe("planning");

    const attention = deriveAttention({ workKey: WORK_KEY, github: gh, runtime: runtimeStale });
    expect(attention).toBe("degraded");
  });

  it("Blocker 2b: stale Decision needs_human result does not yield waiting=needs_human and does not bypass degraded attention", () => {
    const gh = createGitHubFact({
      pullRequest: null,
      issue: { state: "open", url: "issue-url" },
    });
    const decStale: OperationSourceResult<DecisionWorkFacts> = {
      source: "decision",
      instance: "store:local",
      freshness: { status: "stale", observedAt: NOW - 60000, lastAttemptAt: NOW },
      facts: {
        workKey: WORK_KEY,
        session: null,
        tasks: [
          { taskId: "t1", revision: 1, kind: "plan", status: "completed", createdAtMs: 1, updatedAtMs: 2 },
        ],
        results: [
          { taskId: "t1", revision: 1, createdAtMs: 2, outcome: { kind: "plan", verdict: "needs_human" } },
        ],
        provenance: { source: "decision", instance: "store", observedAt: NOW - 60000 },
      },
    };

    const waiting = deriveWaitingReason({ workKey: WORK_KEY, github: gh, decision: decStale });
    // Stale facts cannot assert waiting=needs_human!
    expect(waiting?.reason).not.toBe("needs_human");

    const attention = deriveAttention({ workKey: WORK_KEY, github: gh, decision: decStale });
    // Must be degraded, NOT needs_human!
    expect(attention).toBe("degraded");
  });

  it("Blocker 3: old PR task does not override current PR task or pollute waiting/review", () => {
    const gh = createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_B, isDraft: false },
      ci: { status: "pending", headSha: SHA_B },
    });
    // Store has old PR #41 with revision 5 (superseded with changes_requested)
    // and current PR #42 with revision 1 (pending)
    const dec = createDecisionFact({
      tasks: [
        { taskId: "t-old", revision: 5, kind: "review", status: "superseded", target: { repository: "owner/repo", prNumber: 41, headSha: SHA_A }, createdAtMs: 1, updatedAtMs: 2 },
        { taskId: "t-cur", revision: 1, kind: "review", status: "pending", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_B }, createdAtMs: 10, updatedAtMs: 10 },
      ],
      results: [
        { taskId: "t-old", revision: 5, createdAtMs: 2, outcome: { kind: "review", verdict: "changes_requested", target: { repository: "owner/repo", prNumber: 41, headSha: SHA_A } } },
      ],
    });

    const reviewProj = deriveReviewProjection({ workKey: WORK_KEY, github: gh, decision: dec });
    expect(reviewProj?.task?.taskId).toBe("t-cur");
    expect(reviewProj?.approval).toBe("pending");

    const waiting = deriveWaitingReason({ workKey: WORK_KEY, github: gh, decision: dec });
    // For pending review task, waiting_for_executor is preserved!
    expect(waiting?.reason).toBe("waiting_for_executor");

    const phase = deriveWorkPhase({ workKey: WORK_KEY, github: gh, decision: dec });
    // Must NOT be polluted by old PR's changes_requested into repair!
    expect(phase).not.toBe("repair");
  });

  it("Blocker 4: anomaly sorting is shuffle invariant when sharing identical code and detectedAt", () => {
    const anomaly1: OperationalAnomaly = {
      code: "head_mismatch",
      severity: "warning",
      workKey: { provider: "github", key: "owner/repo#1" },
      message: "PR head does not match decision target",
      detectedAt: 1000,
    };
    const anomaly2: OperationalAnomaly = {
      code: "head_mismatch",
      severity: "warning",
      workKey: { provider: "github", key: "owner/repo#2" },
      message: "PR head does not match decision target",
      detectedAt: 1000,
    };

    const snap1 = projectOperationalSnapshot({
      generatedAt: 2000,
      work: [],
      anomalies: [anomaly1, anomaly2],
    });
    const snap2 = projectOperationalSnapshot({
      generatedAt: 2000,
      work: [],
      anomalies: [anomaly2, anomaly1],
    });

    expect(snap1.anomalies).toEqual(snap2.anomalies);
    expect(snap1.anomalies[0]!.workKey).toEqual({ provider: "github", key: "owner/repo#1" });
    expect(snap1.anomalies[1]!.workKey).toEqual({ provider: "github", key: "owner/repo#2" });
  });

  it("Blocker 2 extension: stale Decision with pending/claimed/running review task derives approval=unknown, waiting=null, attention=degraded, and summary.waiting=0", () => {
    const gh = createGitHubFact({
      pullRequest: { number: 42, state: "open", url: "url", headSha: SHA_A, isDraft: false },
      ci: { status: "success", headSha: SHA_A },
    });

    const statuses = ["pending", "claimed", "running"] as const;
    for (const status of statuses) {
      const decStale: OperationSourceResult<DecisionWorkFacts> = {
        source: "decision",
        instance: "store:local",
        freshness: { status: "stale", observedAt: NOW - 60000, lastAttemptAt: NOW },
        facts: {
          workKey: WORK_KEY,
          session: null,
          tasks: [
            { taskId: "t1", revision: 1, kind: "review", status, target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: 1, updatedAtMs: 2 },
          ],
          results: [],
          provenance: { source: "decision", instance: "store", observedAt: NOW - 60000 },
        },
      };

      // 1. deriveReviewProjection must NOT output approval: pending; it must be unknown
      const reviewProj = deriveReviewProjection({ workKey: WORK_KEY, github: gh, decision: decStale });
      expect(reviewProj?.approval).toBe("unknown");
      expect(reviewProj?.task?.status).toBe(status);

      // 2. deriveWaitingReason must NOT output waiting_for_review; it must be null
      const waiting = deriveWaitingReason({ workKey: WORK_KEY, github: gh, decision: decStale });
      expect(waiting).toBeNull();

      // 3. deriveAttention must be degraded
      const attention = deriveAttention({ workKey: WORK_KEY, github: gh, decision: decStale });
      expect(attention).toBe("degraded");

      // 4. projectWork and projectOperationalSnapshot must have summary.waiting === 0
      const workProj = projectWork({ workKey: WORK_KEY, github: gh, decision: decStale });
      expect(workProj.waiting).toBeNull();
      expect(workProj.attention).toBe("degraded");
      expect(workProj.review?.approval).toBe("unknown");

      const snapshot = projectOperationalSnapshot({
        generatedAt: NOW,
        work: [workProj],
      });
      expect(snapshot.summary.waiting).toBe(0);
    }
  });
});

