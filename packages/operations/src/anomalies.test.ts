import { describe, expect, it } from "vitest";
import {
  detectCollectionAnomalies,
  detectWorkAnomalies,
  hasWorkAnomalies,
  isDecisionTaskActive,
  projectOperationalSnapshot,
  projectWork,
  projectWorkWithAnomalies,
  type DecisionTaskFacts,
  type DecisionWorkFacts,
  type GitHubWorkFacts,
  type OperationFactCollection,
  type OperationSourceResult,
  type OperationalAnomaly,
  type RuntimeWorkFacts,
} from "./index";
import { githubWorkKey } from "@symphony/domain";

const OWNER = "owner";
const REPO = "repo";
const ISSUE = 109;
const WORK_KEY = githubWorkKey(OWNER, REPO, ISSUE);

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const NOW = 1_700_000_000_000;
const DETECTED_AT = NOW + 1000;

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
      session: { sessionId: "session-1", status: "active", bindingGeneration: 1, adapter: "chatgpt-web", updatedAtMs: NOW },
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

function createExecutorFact(): OperationSourceResult<readonly []> {
  return {
    source: "executor",
    instance: "inventory:local",
    freshness: { status: "fresh", observedAt: NOW, lastAttemptAt: NOW },
    facts: [],
  };
}

function createCleanCollection(): OperationFactCollection {
  return {
    github: createGitHubFact({
      pullRequest: { number: 42, state: "open", url: `https://github.com/${OWNER}/${REPO}/pull/42`, headSha: SHA_A, isDraft: false },
      ci: { status: "success", headSha: SHA_A },
    }),
    runtime: createRuntimeFact([
      {
        workKey: WORK_KEY,
        issueId: "issue-109",
        attempt: { issueId: "issue-109", issueIdentifier: "109", attempt: 1, status: "streaming_turn", workspacePath: "/ws/109", startedAtMs: NOW },
        retry: null,
        provenance: { source: "runtime", instance: "orchestrator:local", observedAt: NOW },
      },
    ]),
    decision: createDecisionFact({
      session: { sessionId: "session-1", status: "active", bindingGeneration: 1, adapter: "chatgpt-web", updatedAtMs: NOW },
      tasks: [
        { taskId: "task-1", revision: 1, kind: "review", status: "running", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: NOW, updatedAtMs: NOW },
      ],
      results: [],
    }),
    executor: createExecutorFact(),
  };
}

describe("Operational Anomaly Detection (NEST-116)", () => {
  describe("Clean state", () => {
    it("detects zero anomalies on consistent, healthy facts", () => {
      const collection = createCleanCollection();
      deepFreeze(collection);

      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      expect(anomalies).toHaveLength(0);
      expect(hasWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT })).toBe(false);
    });
  });

  describe("Rule 1: review_target_head_mismatch (warning)", () => {
    it("detects active review task targeting a SHA different from fresh GitHub PR HEAD", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        github: createGitHubFact({
          pullRequest: { number: 42, state: "open", url: "https://github.com/owner/repo/pull/42", headSha: SHA_B, isDraft: false },
        }),
        decision: createDecisionFact({
          tasks: [
            { taskId: "task-1", revision: 1, kind: "review", status: "running", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: NOW, updatedAtMs: NOW },
          ],
        }),
      };
      deepFreeze(collection);

      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      expect(anomalies).toHaveLength(1);

      const anomaly = anomalies[0]!;
      expect(anomaly.code).toBe("review_target_head_mismatch");
      expect(anomaly.severity).toBe("warning");
      expect(anomaly.workKey).toEqual(WORK_KEY);
      expect(anomaly.detectedAt).toBe(DETECTED_AT);
      expect(anomaly.message).toContain("Active review task 'task-1' targets SHA");
      expect(anomaly.evidence).toHaveLength(2);

      const githubEv = anomaly.evidence?.find((e) => e.source === "github");
      const decisionEv = anomaly.evidence?.find((e) => e.source === "decision");
      expect(githubEv?.freshnessStatus).toBe("fresh");
      expect(githubEv?.headSha).toBe(SHA_B);
      expect(githubEv?.role).toBe("supporting");

      expect(decisionEv?.taskId).toBe("task-1");
      expect(decisionEv?.headSha).toBe(SHA_A);
      expect(decisionEv?.role).toBe("supporting");
    });

    it("does not report mismatch when task is completed, failed, cancelled, or superseded", () => {
      for (const status of ["completed", "failed", "cancelled", "superseded"] as const) {
        const collection: OperationFactCollection = {
          ...createCleanCollection(),
          github: createGitHubFact({
            pullRequest: { number: 42, state: "open", url: "https://github.com/owner/repo/pull/42", headSha: SHA_B, isDraft: false },
          }),
          decision: createDecisionFact({
            tasks: [
              { taskId: "task-1", revision: 1, kind: "review", status, target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: NOW, updatedAtMs: NOW },
            ],
          }),
        };
        const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
        const targetMismatch = anomalies.filter((a) => a.code === "review_target_head_mismatch");
        expect(targetMismatch).toHaveLength(0);
      }
    });
  });

  describe("Rule 2: review_approval_head_mismatch (error)", () => {
    it("detects effective completed review approval targeting an older SHA than fresh PR HEAD", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        github: createGitHubFact({
          pullRequest: { number: 42, state: "open", url: "https://github.com/owner/repo/pull/42", headSha: SHA_B, isDraft: false },
        }),
        decision: createDecisionFact({
          tasks: [
            { taskId: "task-rev1", revision: 1, kind: "review", status: "completed", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: NOW - 5000, updatedAtMs: NOW - 3000 },
          ],
          results: [
            { taskId: "task-rev1", revision: 1, createdAtMs: NOW - 3000, outcome: { kind: "review", verdict: "approve", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A } } },
          ],
        }),
      };
      deepFreeze(collection);

      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      expect(anomalies).toHaveLength(1);

      const anomaly = anomalies[0]!;
      expect(anomaly.code).toBe("review_approval_head_mismatch");
      expect(anomaly.severity).toBe("error");
      expect(anomaly.message).toContain("Completed review approval for task 'task-rev1' targets old SHA");
      expect(anomaly.evidence).toHaveLength(3);

      const githubEv = anomaly.evidence?.find((e) => e.source === "github");
      const taskEv = anomaly.evidence?.find((e) => e.source === "decision" && e.code === "review_task_target");
      const resultEv = anomaly.evidence?.find((e) => e.source === "decision" && e.code === "review_verdict_approve");
      expect(githubEv?.headSha).toBe(SHA_B);
      expect(taskEv?.taskId).toBe("task-rev1");
      expect(resultEv?.value).toBe("approve");
    });

    it("does not report mismatch when old review was superseded", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        github: createGitHubFact({
          pullRequest: { number: 42, state: "open", url: "https://github.com/owner/repo/pull/42", headSha: SHA_B, isDraft: false },
        }),
        decision: createDecisionFact({
          tasks: [
            { taskId: "task-rev1", revision: 1, kind: "review", status: "superseded", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: NOW - 5000, updatedAtMs: NOW - 3000 },
          ],
          results: [
            { taskId: "task-rev1", revision: 1, createdAtMs: NOW - 3000, outcome: { kind: "review", verdict: "approve", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A } } },
          ],
        }),
      };
      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      expect(anomalies.filter((a) => a.code === "review_approval_head_mismatch")).toHaveLength(0);
    });

    it("does not report mismatch when PR HEAD matches the approval SHA", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        github: createGitHubFact({
          pullRequest: { number: 42, state: "open", url: "https://github.com/owner/repo/pull/42", headSha: SHA_A, isDraft: false },
        }),
        decision: createDecisionFact({
          tasks: [
            { taskId: "task-rev1", revision: 1, kind: "review", status: "completed", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: NOW - 5000, updatedAtMs: NOW - 3000 },
          ],
          results: [
            { taskId: "task-rev1", revision: 1, createdAtMs: NOW - 3000, outcome: { kind: "review", verdict: "approve", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A } } },
          ],
        }),
      };
      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      expect(anomalies).toHaveLength(0);
    });
  });

  describe("Rule 3: review_result_target_mismatch (error)", () => {
    it("detects target mismatch between review task and review result", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        decision: createDecisionFact({
          tasks: [
            { taskId: "task-1", revision: 1, kind: "review", status: "completed", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: NOW - 5000, updatedAtMs: NOW - 3000 },
          ],
          results: [
            { taskId: "task-1", revision: 1, createdAtMs: NOW - 3000, outcome: { kind: "review", verdict: "approve", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_B } } },
          ],
        }),
      };
      deepFreeze(collection);

      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      const mismatch = anomalies.find((a) => a.code === "review_result_target_mismatch");
      expect(mismatch).toBeDefined();
      expect(mismatch?.severity).toBe("error");
      expect(mismatch?.message).toContain("Review result target mismatch for task 'task-1'");
      expect(mismatch?.evidence).toHaveLength(2);

      const taskEv = mismatch?.evidence?.find((e) => e.code === "review_task_target");
      const resultEv = mismatch?.evidence?.find((e) => e.code === "review_result_target");
      expect(taskEv?.headSha).toBe(SHA_A);
      expect(resultEv?.headSha).toBe(SHA_B);
    });
  });

  describe("Rule 4: execution_on_terminal_work (warning)", () => {
    it("detects active execution attempt when GitHub issue is closed", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        github: createGitHubFact({
          issue: { state: "closed", url: "https://github.com/owner/repo/issues/109" },
        }),
        runtime: createRuntimeFact([
          {
            workKey: WORK_KEY,
            issueId: "issue-109",
            attempt: { issueId: "issue-109", issueIdentifier: "109", attempt: 2, status: "streaming_turn", workspacePath: "/ws/109", startedAtMs: NOW },
            retry: null,
            provenance: { source: "runtime", instance: "orchestrator:local", observedAt: NOW },
          },
        ]),
      };
      deepFreeze(collection);

      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      const terminalAnomaly = anomalies.find((a) => a.code === "execution_on_terminal_work");
      expect(terminalAnomaly).toBeDefined();
      expect(terminalAnomaly?.severity).toBe("warning");
      expect(terminalAnomaly?.message).toContain("Active runtime attempt 2 (streaming_turn) observed on terminal GitHub work (issue closed)");
      expect(terminalAnomaly?.evidence).toHaveLength(2);
      expect(terminalAnomaly?.evidence?.[0]?.value).toBe("closed");
      expect(terminalAnomaly?.evidence?.[1]?.value).toBe("streaming_turn");
    });

    it("detects active execution attempt when PR is merged", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        github: createGitHubFact({
          issue: { state: "open", url: "https://github.com/owner/repo/issues/109" },
          pullRequest: { number: 42, state: "merged", url: "https://github.com/owner/repo/pull/42", headSha: SHA_A, isDraft: false },
        }),
        runtime: createRuntimeFact([
          {
            workKey: WORK_KEY,
            issueId: "issue-109",
            attempt: { issueId: "issue-109", issueIdentifier: "109", attempt: 1, status: "launching_agent_process", workspacePath: "/ws/109", startedAtMs: NOW },
            retry: null,
            provenance: { source: "runtime", instance: "orchestrator:local", observedAt: NOW },
          },
        ]),
      };
      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      const terminalAnomaly = anomalies.find((a) => a.code === "execution_on_terminal_work");
      expect(terminalAnomaly).toBeDefined();
      expect(terminalAnomaly?.message).toContain("(PR merged)");
    });

    it("does not report anomaly when PR is closed unmerged while issue remains open", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        github: createGitHubFact({
          issue: { state: "open", url: "https://github.com/owner/repo/issues/109" },
          pullRequest: { number: 42, state: "closed", url: "https://github.com/owner/repo/pull/42", headSha: SHA_A, isDraft: false },
        }),
        runtime: createRuntimeFact([
          {
            workKey: WORK_KEY,
            issueId: "issue-109",
            attempt: { issueId: "issue-109", issueIdentifier: "109", attempt: 1, status: "streaming_turn", workspacePath: "/ws/109", startedAtMs: NOW },
            retry: null,
            provenance: { source: "runtime", instance: "orchestrator:local", observedAt: NOW },
          },
        ]),
      };
      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      expect(anomalies.filter((a) => a.code === "execution_on_terminal_work")).toHaveLength(0);
    });

    it("does not report anomaly for retry-only row (no active attempt)", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        github: createGitHubFact({
          issue: { state: "closed", url: "https://github.com/owner/repo/issues/109" },
        }),
        runtime: createRuntimeFact([
          {
            workKey: WORK_KEY,
            issueId: "issue-109",
            attempt: null,
            retry: { issueId: "issue-109", identifier: "109", attempt: 2, retryInMs: 15000, error: null },
            provenance: { source: "runtime", instance: "orchestrator:local", observedAt: NOW },
          },
        ]),
      };
      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      expect(anomalies.filter((a) => a.code === "execution_on_terminal_work")).toHaveLength(0);
    });

    it("does not report anomaly when runtime workKey is null (never guess identity)", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        github: createGitHubFact({
          issue: { state: "closed", url: "https://github.com/owner/repo/issues/109" },
        }),
        runtime: createRuntimeFact([
          {
            workKey: null,
            issueId: "issue-109",
            attempt: { issueId: "issue-109", issueIdentifier: "109", attempt: 1, status: "streaming_turn", workspacePath: "/ws/109", startedAtMs: NOW },
            retry: null,
            provenance: { source: "runtime", instance: "orchestrator:local", observedAt: NOW },
          },
        ]),
      };
      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      expect(anomalies.filter((a) => a.code === "execution_on_terminal_work")).toHaveLength(0);
    });
  });

  describe("Rule 5 & 6: Decision active task vs session inconsistencies (error)", () => {
    it("detects active tasks when session is null", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        decision: createDecisionFact({
          session: null,
          tasks: [
            { taskId: "task-1", revision: 1, kind: "plan", status: "pending", createdAtMs: NOW, updatedAtMs: NOW },
          ],
        }),
      };
      deepFreeze(collection);

      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      const anomaly = anomalies.find((a) => a.code === "decision_active_task_without_session");
      expect(anomaly).toBeDefined();
      expect(anomaly?.severity).toBe("error");
      expect(anomaly?.message).toContain("Decision plane has 1 active task(s) but no session exists");
      expect(anomaly?.evidence?.[0]?.code).toBe("session_null");
      expect(anomaly?.evidence?.[1]?.taskId).toBe("task-1");
    });

    it("detects active tasks when session is completed", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        decision: createDecisionFact({
          session: { sessionId: "session-1", status: "completed", bindingGeneration: 1, adapter: "chatgpt-web", updatedAtMs: NOW },
          tasks: [
            { taskId: "task-1", revision: 1, kind: "review", status: "running", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: NOW, updatedAtMs: NOW },
          ],
        }),
      };
      deepFreeze(collection);

      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      const anomaly = anomalies.find((a) => a.code === "decision_active_task_on_completed_session");
      expect(anomaly).toBeDefined();
      expect(anomaly?.severity).toBe("error");
      expect(anomaly?.message).toContain("while session 'session-1' is completed");
      expect(anomaly?.evidence?.[0]?.code).toBe("session_completed");
      expect(anomaly?.evidence?.[1]?.taskId).toBe("task-1");
    });

    it("does not report session anomalies when tasks are all completed, cancelled, or superseded", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        decision: createDecisionFact({
          session: null,
          tasks: [
            { taskId: "task-1", revision: 1, kind: "plan", status: "completed", createdAtMs: NOW, updatedAtMs: NOW },
            { taskId: "task-2", revision: 1, kind: "plan", status: "superseded", createdAtMs: NOW, updatedAtMs: NOW },
          ],
        }),
      };
      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      expect(anomalies.filter((a) => a.code.startsWith("decision_active_task"))).toHaveLength(0);
    });
  });

  describe("Rule 7: decision_result_without_task (error)", () => {
    it("detects orphan result when no matching task exists for taskId and revision", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        decision: createDecisionFact({
          tasks: [
            { taskId: "task-1", revision: 1, kind: "plan", status: "completed", createdAtMs: NOW, updatedAtMs: NOW },
          ],
          results: [
            { taskId: "task-2", revision: 1, createdAtMs: NOW, outcome: { kind: "plan", verdict: "ready" } },
          ],
        }),
      };
      deepFreeze(collection);

      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      const orphan = anomalies.find((a) => a.code === "decision_result_without_task");
      expect(orphan).toBeDefined();
      expect(orphan?.severity).toBe("error");
      expect(orphan?.message).toContain("Decision result exists for task 'task-2' (rev 1) but no matching task was found");
      expect(orphan?.evidence?.[0]?.taskId).toBe("task-2");
    });

    it("detects orphan result when revision differs", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        decision: createDecisionFact({
          tasks: [
            { taskId: "task-1", revision: 1, kind: "plan", status: "completed", createdAtMs: NOW, updatedAtMs: NOW },
          ],
          results: [
            { taskId: "task-1", revision: 2, createdAtMs: NOW, outcome: { kind: "plan", verdict: "ready" } },
          ],
        }),
      };
      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      expect(anomalies.find((a) => a.code === "decision_result_without_task")).toBeDefined();
    });
  });

  describe("Rule 8: conflicting_active_review_tasks (error)", () => {
    it("detects multiple active review tasks for the same PR (same SHA duplicate)", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        decision: createDecisionFact({
          tasks: [
            { taskId: "task-1", revision: 1, kind: "review", status: "pending", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: NOW, updatedAtMs: NOW },
            { taskId: "task-2", revision: 1, kind: "review", status: "running", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: NOW, updatedAtMs: NOW },
          ],
        }),
      };
      deepFreeze(collection);

      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      const conflict = anomalies.find((a) => a.code === "conflicting_active_review_tasks");
      expect(conflict).toBeDefined();
      expect(conflict?.severity).toBe("error");
      expect(conflict?.message).toContain("Multiple active review tasks (task-1, task-2) exist for owner/repo#42");
      expect(conflict?.evidence).toHaveLength(2);
    });

    it("detects multiple active review tasks for the same PR (different SHA conflict)", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        decision: createDecisionFact({
          tasks: [
            { taskId: "task-1", revision: 1, kind: "review", status: "running", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: NOW, updatedAtMs: NOW },
            { taskId: "task-2", revision: 1, kind: "review", status: "claimed", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_B }, createdAtMs: NOW, updatedAtMs: NOW },
          ],
        }),
      };
      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      expect(anomalies.find((a) => a.code === "conflicting_active_review_tasks")).toBeDefined();
    });

    it("does not report conflict when active review tasks belong to different PRs", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        decision: createDecisionFact({
          tasks: [
            { taskId: "task-1", revision: 1, kind: "review", status: "running", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: NOW, updatedAtMs: NOW },
            { taskId: "task-2", revision: 1, kind: "review", status: "running", target: { repository: "owner/repo", prNumber: 43, headSha: SHA_A }, createdAtMs: NOW, updatedAtMs: NOW },
          ],
        }),
      };
      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      expect(anomalies.filter((a) => a.code === "conflicting_active_review_tasks")).toHaveLength(0);
    });
  });

  describe("Source freshness & missing source guards", () => {
    it("does not falsely report cross-source anomalies when GitHub is unavailable", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        github: {
          source: "github",
          instance: "github:owner/repo",
          freshness: { status: "unavailable", observedAt: null, lastAttemptAt: NOW, reason: "network_error" },
          facts: null,
        },
        decision: createDecisionFact({
          tasks: [
            { taskId: "task-1", revision: 1, kind: "review", status: "running", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: NOW, updatedAtMs: NOW },
          ],
        }),
        runtime: createRuntimeFact([
          {
            workKey: WORK_KEY,
            issueId: "issue-109",
            attempt: { issueId: "issue-109", issueIdentifier: "109", attempt: 1, status: "streaming_turn", workspacePath: "/ws/109", startedAtMs: NOW },
            retry: null,
            provenance: { source: "runtime", instance: "orchestrator:local", observedAt: NOW },
          },
        ]),
      };
      deepFreeze(collection);

      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      // GitHub is unavailable: review_target_head_mismatch and execution_on_terminal_work MUST NOT fire
      expect(anomalies).toHaveLength(0);
    });

    it("detects Decision-internal inconsistencies even when GitHub is unavailable", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        github: {
          source: "github",
          instance: "github:owner/repo",
          freshness: { status: "unavailable", observedAt: null, lastAttemptAt: NOW, reason: "network_error" },
          facts: null,
        },
        decision: createDecisionFact({
          session: null,
          tasks: [
            { taskId: "task-1", revision: 1, kind: "plan", status: "pending", createdAtMs: NOW, updatedAtMs: NOW },
          ],
        }),
      };
      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]?.code).toBe("decision_active_task_without_session");
    });

    it("does not report Decision anomalies when Decision source is stale or unavailable", () => {
      for (const status of ["stale", "unavailable", "unknown"] as const) {
        const collection: OperationFactCollection = {
          ...createCleanCollection(),
          decision: {
            source: "decision",
            instance: "decision:local",
            freshness: status === "unavailable"
              ? { status: "unavailable", observedAt: null, lastAttemptAt: NOW, reason: "db_error" }
              : status === "stale"
                ? { status: "stale", observedAt: NOW - 50000, lastAttemptAt: NOW }
                : { status: "unknown", lastAttemptAt: null, reason: null },
            facts: {
              workKey: WORK_KEY,
              session: null,
              tasks: [
                { taskId: "task-1", revision: 1, kind: "plan", status: "pending", createdAtMs: NOW, updatedAtMs: NOW },
              ],
              results: [],
              provenance: { source: "decision", instance: "decision:local", observedAt: NOW },
            },
          },
        };
        const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
        expect(anomalies.filter((a) => a.code === "decision_active_task_without_session")).toHaveLength(0);
      }
    });

    it("does not report review_target_head_mismatch when source is stale but SHA is identical", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        github: {
          source: "github",
          instance: "github:owner/repo",
          freshness: { status: "stale", observedAt: NOW - 10000, lastAttemptAt: NOW },
          facts: {
            workKey: WORK_KEY,
            issue: { state: "open", url: `https://github.com/${OWNER}/${REPO}/issues/${ISSUE}` },
            pullRequest: { number: 42, state: "open", url: `https://github.com/${OWNER}/${REPO}/pull/42`, headSha: SHA_A, isDraft: false },
            ci: null,
            provenance: { source: "github", instance: "github:owner/repo", observedAt: NOW - 10000 },
          },
        },
        decision: createDecisionFact({
          tasks: [
            { taskId: "task-1", revision: 1, kind: "review", status: "running", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: NOW, updatedAtMs: NOW },
          ],
        }),
      };
      const anomalies = detectWorkAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      expect(anomalies).toHaveLength(0);
    });
  });

  describe("detectCollectionAnomalies multi-work detection", () => {
    it("aggregates anomalies across all works in an OperationFactCollection", () => {
      const workKey2 = githubWorkKey(OWNER, REPO, 110);
      const collection: OperationFactCollection = {
        github: createGitHubFact({
          workKey: WORK_KEY,
          issue: { state: "closed", url: "https://github.com/owner/repo/issues/109" },
        }),
        runtime: createRuntimeFact([
          {
            workKey: WORK_KEY,
            issueId: "issue-109",
            attempt: { issueId: "issue-109", issueIdentifier: "109", attempt: 1, status: "streaming_turn", workspacePath: "/ws/109", startedAtMs: NOW },
            retry: null,
            provenance: { source: "runtime", instance: "orchestrator:local", observedAt: NOW },
          },
          {
            workKey: workKey2,
            issueId: "issue-110",
            attempt: null,
            retry: null,
            provenance: { source: "runtime", instance: "orchestrator:local", observedAt: NOW },
          },
        ]),
        decision: createDecisionFact({
          workKey: WORK_KEY,
          session: null,
          tasks: [
            { taskId: "task-1", revision: 1, kind: "plan", status: "pending", createdAtMs: NOW, updatedAtMs: NOW },
          ],
        }),
        executor: createExecutorFact(),
      };
      deepFreeze(collection);

      const all = detectCollectionAnomalies({ collection, detectedAt: DETECTED_AT });
      expect(all).toHaveLength(2);
      const codes = all.map((a) => a.code);
      expect(codes).toContain("execution_on_terminal_work");
      expect(codes).toContain("decision_active_task_without_session");
    });
  });

  describe("Deterministic sorting and shuffle invariance", () => {
    it("produces identical anomaly lists regardless of input task order", () => {
      const task1: DecisionTaskFacts = {
        taskId: "task-1",
        revision: 1,
        kind: "review",
        status: "running",
        target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A },
        createdAtMs: NOW,
        updatedAtMs: NOW,
      };
      const task2: DecisionTaskFacts = {
        taskId: "task-2",
        revision: 1,
        kind: "review",
        status: "pending",
        target: { repository: "owner/repo", prNumber: 42, headSha: SHA_B },
        createdAtMs: NOW,
        updatedAtMs: NOW,
      };

      const c1: OperationFactCollection = {
        ...createCleanCollection(),
        github: createGitHubFact({
          pullRequest: { number: 42, state: "open", url: "https://github.com/owner/repo/pull/42", headSha: SHA_C, isDraft: false },
        }),
        decision: createDecisionFact({
          tasks: [task1, task2],
        }),
      };

      const c2: OperationFactCollection = {
        ...c1,
        decision: createDecisionFact({
          tasks: [task2, task1],
        }),
      };

      const res1 = detectWorkAnomalies({ collection: c1, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      const res2 = detectWorkAnomalies({ collection: c2, workKey: WORK_KEY, detectedAt: DETECTED_AT });

      expect(res1).toEqual(res2);
    });
  });

  describe("End-to-end Projector Integration with Anomalies", () => {
    it("projectWorkWithAnomalies returns both projection and anomalies", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        github: createGitHubFact({
          pullRequest: { number: 42, state: "open", url: "https://github.com/owner/repo/pull/42", headSha: SHA_B, isDraft: false },
        }),
        decision: createDecisionFact({
          tasks: [
            { taskId: "task-1", revision: 1, kind: "review", status: "running", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: NOW, updatedAtMs: NOW },
          ],
        }),
      };
      deepFreeze(collection);

      const result = projectWorkWithAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      expect(result.anomalies).toHaveLength(1);
      expect(result.anomalies[0]?.code).toBe("review_target_head_mismatch");

      // Anomaly degrades attention to degraded
      expect(result.projection.attention).toBe("degraded");
      expect(result.projection.evidence.length).toBeGreaterThan(0);
    });

    it("projectWork directly degrades attention when anomalies are present", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        github: createGitHubFact({
          pullRequest: { number: 42, state: "open", url: "https://github.com/owner/repo/pull/42", headSha: SHA_B, isDraft: false },
        }),
        decision: createDecisionFact({
          tasks: [
            { taskId: "task-1", revision: 1, kind: "review", status: "running", target: { repository: "owner/repo", prNumber: 42, headSha: SHA_A }, createdAtMs: NOW, updatedAtMs: NOW },
          ],
        }),
      };

      const projection = projectWork({ collection, workKey: WORK_KEY });
      expect(projection.attention).toBe("degraded");
    });

    it("preserves completed phase and sets degraded attention for execution_on_terminal_work", () => {
      const collection: OperationFactCollection = {
        ...createCleanCollection(),
        github: createGitHubFact({
          issue: { state: "closed", url: "https://github.com/owner/repo/issues/109" },
        }),
        runtime: createRuntimeFact([
          {
            workKey: WORK_KEY,
            issueId: "issue-109",
            attempt: { issueId: "issue-109", issueIdentifier: "109", attempt: 1, status: "streaming_turn", workspacePath: "/ws/109", startedAtMs: NOW },
            retry: null,
            provenance: { source: "runtime", instance: "orchestrator:local", observedAt: NOW },
          },
        ]),
      };

      const { projection, anomalies } = projectWorkWithAnomalies({ collection, workKey: WORK_KEY, detectedAt: DETECTED_AT });
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]?.code).toBe("execution_on_terminal_work");

      // Phase is completed (from GitHub), attention is degraded (from anomaly)
      expect(projection.phase).toBe("completed");
      expect(projection.attention).toBe("degraded");
    });

    it("projectOperationalSnapshot degrades system health when anomalies exist", () => {
      const work = projectWork({ collection: createCleanCollection(), workKey: WORK_KEY });
      const anomaly: OperationalAnomaly = {
        code: "decision_active_task_without_session",
        severity: "error",
        workKey: WORK_KEY,
        message: "Active task without session",
        detectedAt: DETECTED_AT,
      };

      const sources = [
        { source: "github" as const, instance: "github:owner/repo", freshness: { status: "fresh" as const, observedAt: NOW, lastAttemptAt: NOW } },
        { source: "decision" as const, instance: "decision:local", freshness: { status: "fresh" as const, observedAt: NOW, lastAttemptAt: NOW } },
      ];

      const cleanSnapshot = projectOperationalSnapshot({
        generatedAt: NOW,
        work: [work],
        sources,
        anomalies: [],
      });
      expect(cleanSnapshot.health).toBe("healthy");

      const snapshotWithAnomaly = projectOperationalSnapshot({
        generatedAt: NOW,
        work: [work],
        sources,
        anomalies: [anomaly],
      });
      expect(snapshotWithAnomaly.health).toBe("degraded");
      expect(snapshotWithAnomaly.anomalies).toHaveLength(1);
    });

    it("projectOperationalSnapshot preserves unavailable and unknown system health when sources dictate", () => {
      const work = projectWork({ collection: createCleanCollection(), workKey: WORK_KEY });
      const anomaly: OperationalAnomaly = {
        code: "decision_result_without_task",
        severity: "error",
        workKey: WORK_KEY,
        message: "Result without task",
        detectedAt: DETECTED_AT,
      };

      const unknownSources = [
        { source: "github" as const, instance: "github:owner/repo", freshness: { status: "unknown" as const, lastAttemptAt: null, reason: null } },
      ];

      const unknownSnapshot = projectOperationalSnapshot({
        generatedAt: NOW,
        work: [work],
        sources: unknownSources,
        anomalies: [anomaly],
      });
      expect(unknownSnapshot.health).toBe("unknown");

      const unavailableSources = [
        { source: "github" as const, instance: "github:owner/repo", freshness: { status: "unavailable" as const, observedAt: null, lastAttemptAt: NOW, reason: "down" } },
      ];

      const unavailableSnapshot = projectOperationalSnapshot({
        generatedAt: NOW,
        work: [work],
        sources: unavailableSources,
        anomalies: [anomaly],
      });
      expect(unavailableSnapshot.health).toBe("unavailable");
    });
  });

  describe("Active status helpers", () => {
    it("isDecisionTaskActive correctly identifies pending, claimed, and running statuses", () => {
      expect(isDecisionTaskActive("pending")).toBe(true);
      expect(isDecisionTaskActive("claimed")).toBe(true);
      expect(isDecisionTaskActive("running")).toBe(true);
      expect(isDecisionTaskActive("completed")).toBe(false);
      expect(isDecisionTaskActive("failed")).toBe(false);
      expect(isDecisionTaskActive("cancelled")).toBe(false);
      expect(isDecisionTaskActive("superseded")).toBe(false);
      expect(isDecisionTaskActive(null)).toBe(false);
      expect(isDecisionTaskActive(undefined)).toBe(false);
    });
  });
});
