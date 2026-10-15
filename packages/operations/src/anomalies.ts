/**
 * Pure, deterministic Operational Anomaly Detection (NEST-116 / GitHub #112).
 *
 * Detects impossible or suspicious combinations across GitHub, runtime,
 * Decision Plane, and executor facts from normalized operational facts.
 * Pure and side-effect free: no I/O, no timers, no global clock access, and no mutation.
 */
import {
  formatWorkKey,
  parseWorkKey,
  type DecisionTaskFacts,
  type DecisionTaskStatus,
  type DecisionWorkFacts,
  type GitHubWorkFacts,
  type OperationalAnomaly,
  type OperationFactCollection,
  type OperationSourceResult,
  type ProjectionEvidence,
  type RunAttemptStatus,
  type RuntimeWorkFacts,
  type SourceFreshness,
  type UtcTimestampMs,
  type WorkKey,
} from "@symphony/domain";

// ---------------------------------------------------------------------------
// Active status helpers
// ---------------------------------------------------------------------------

export const ACTIVE_DECISION_TASK_STATUSES = [
  "pending",
  "claimed",
  "running",
] as const satisfies readonly DecisionTaskStatus[];

export function isDecisionTaskActive(status: DecisionTaskStatus | null | undefined): boolean {
  return (
    status !== undefined &&
    status !== null &&
    (ACTIVE_DECISION_TASK_STATUSES as readonly DecisionTaskStatus[]).includes(status)
  );
}

const ACTIVE_RUN_ATTEMPT_STATUSES = [
  "preparing_workspace",
  "building_prompt",
  "launching_agent_process",
  "initializing_session",
  "streaming_turn",
  "finishing",
] as const satisfies readonly RunAttemptStatus[];

function isAttemptActive(status: RunAttemptStatus | null | undefined): boolean {
  return (
    status !== undefined &&
    status !== null &&
    (ACTIVE_RUN_ATTEMPT_STATUSES as readonly RunAttemptStatus[]).includes(status)
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface DetectWorkAnomaliesInput {
  readonly workKey?: WorkKey | undefined;
  readonly collection?: OperationFactCollection | undefined;
  readonly github?: OperationSourceResult<GitHubWorkFacts> | null | undefined;
  readonly runtime?: OperationSourceResult<readonly RuntimeWorkFacts[]> | RuntimeWorkFacts | null | undefined;
  readonly decision?: OperationSourceResult<DecisionWorkFacts> | null | undefined;
  readonly detectedAt?: UtcTimestampMs | undefined;
}

export interface DetectCollectionAnomaliesInput {
  readonly collection: OperationFactCollection;
  readonly detectedAt?: UtcTimestampMs | undefined;
}

const UNKNOWN_FRESHNESS: SourceFreshness = {
  status: "unknown",
  lastAttemptAt: null,
  reason: null,
};

function extractTargetRepo(workKey: WorkKey): string {
  const parts = workKey.key.split("#");
  return parts[0] ?? workKey.key;
}

function resolveWorkKey(input: DetectWorkAnomaliesInput): WorkKey {
  if (input.workKey) {
    return parseWorkKey(input.workKey);
  }
  if (input.github?.facts?.workKey) {
    return parseWorkKey(input.github.facts.workKey);
  }
  if (input.collection?.github.facts?.workKey) {
    return parseWorkKey(input.collection.github.facts.workKey);
  }
  if (input.decision?.facts?.workKey) {
    return parseWorkKey(input.decision.facts.workKey);
  }
  if (input.collection?.decision.facts?.workKey) {
    return parseWorkKey(input.collection.decision.facts.workKey);
  }
  throw new TypeError("workKey is required for anomaly detection");
}

// ---------------------------------------------------------------------------
// Single Work Anomaly Detection
// ---------------------------------------------------------------------------

/**
 * Pure anomaly detection for a single work item.
 */
export function detectWorkAnomalies(input: DetectWorkAnomaliesInput): readonly OperationalAnomaly[] {
  const workKey = resolveWorkKey(input);
  const formattedTargetKey = formatWorkKey(workKey);
  const targetRepo = extractTargetRepo(workKey).toLowerCase();
  const detectedAt = input.detectedAt ?? 0;

  // Resolve sources
  const githubSource = input.github ?? input.collection?.github ?? null;
  const githubFreshness = githubSource?.freshness ?? UNKNOWN_FRESHNESS;
  const rawGithubFacts = githubSource?.facts ?? null;
  const githubFacts =
    rawGithubFacts && formatWorkKey(rawGithubFacts.workKey) === formattedTargetKey
      ? rawGithubFacts
      : null;

  const decisionSource = input.decision ?? input.collection?.decision ?? null;
  const decisionFreshness = decisionSource?.freshness ?? UNKNOWN_FRESHNESS;
  const rawDecisionFacts = decisionSource?.facts ?? null;
  const decisionFacts =
    rawDecisionFacts && formatWorkKey(rawDecisionFacts.workKey) === formattedTargetKey
      ? rawDecisionFacts
      : null;

  const runtimeInput = input.runtime ?? input.collection?.runtime ?? null;
  let runtimeFreshness: SourceFreshness = UNKNOWN_FRESHNESS;
  let runtimeRows: readonly RuntimeWorkFacts[] = [];

  if (runtimeInput) {
    if ("facts" in runtimeInput && "freshness" in runtimeInput) {
      runtimeFreshness = runtimeInput.freshness;
      runtimeRows = runtimeInput.facts ?? [];
    } else if ("provenance" in runtimeInput && "issueId" in runtimeInput) {
      runtimeFreshness = {
        status: "fresh",
        observedAt: runtimeInput.provenance.observedAt,
        lastAttemptAt: runtimeInput.provenance.observedAt,
      };
      runtimeRows = [runtimeInput];
    }
  }

  const anomalies: OperationalAnomaly[] = [];

  const isGitHubFresh = githubFreshness.status === "fresh" && githubFacts !== null;
  const isDecisionFresh = decisionFreshness.status === "fresh" && decisionFacts !== null;
  const isRuntimeFresh = runtimeFreshness.status === "fresh";

  // -------------------------------------------------------------------------
  // Rule 1: review_target_head_mismatch (warning)
  // Current repository/PR active review task targets a SHA different from fresh GitHub HEAD.
  // -------------------------------------------------------------------------
  if (isGitHubFresh && isDecisionFresh && githubFacts.pullRequest !== null && githubFacts.pullRequest.headSha) {
    const prHeadSha = githubFacts.pullRequest.headSha;
    const prNumber = githubFacts.pullRequest.number;

    for (const task of decisionFacts.tasks) {
      if (
        task.kind === "review" &&
        isDecisionTaskActive(task.status) &&
        task.target.repository.toLowerCase() === targetRepo &&
        task.target.prNumber === prNumber
      ) {
        if (task.target.headSha.toLowerCase() !== prHeadSha.toLowerCase()) {
          const evidence: ProjectionEvidence[] = [
            {
              source: "github",
              instance: githubFacts.provenance.instance,
              code: "pr_head_sha",
              detail: `PR #${prNumber} HEAD ${prHeadSha.slice(0, 7)}`,
              observedAt: githubFacts.provenance.observedAt,
              freshnessStatus: "fresh",
              ruleId: "review_target_head_mismatch",
              role: "supporting",
              workKey,
              headSha: prHeadSha,
              field: "pullRequest.headSha",
              value: prHeadSha,
            },
            {
              source: "decision",
              instance: decisionFacts.provenance.instance,
              code: "review_task_target",
              detail: `task ${task.taskId} target ${task.target.headSha.slice(0, 7)}`,
              observedAt: decisionFacts.provenance.observedAt,
              entityTimestampMs: task.updatedAtMs,
              freshnessStatus: "fresh",
              ruleId: "review_target_head_mismatch",
              role: "supporting",
              workKey,
              taskId: task.taskId,
              revision: task.revision,
              target: task.target,
              headSha: task.target.headSha,
              field: "task.target.headSha",
              value: task.target.headSha,
            },
          ];

          anomalies.push({
            code: "review_target_head_mismatch",
            severity: "warning",
            workKey,
            message: `Active review task '${task.taskId}' targets SHA ${task.target.headSha.slice(0, 7)}, but current PR #${prNumber} HEAD is ${prHeadSha.slice(0, 7)}`,
            detectedAt,
            evidence,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rule 2: review_approval_head_mismatch (error)
  // Current effective completed review approve result targets an older SHA than fresh GitHub PR HEAD.
  // -------------------------------------------------------------------------
  if (isGitHubFresh && isDecisionFresh && githubFacts.pullRequest !== null && githubFacts.pullRequest.headSha) {
    const prHeadSha = githubFacts.pullRequest.headSha;
    const prNumber = githubFacts.pullRequest.number;

    const completedReviewTasks = decisionFacts.tasks.filter(
      (t): t is DecisionTaskFacts & { readonly kind: "review" } =>
        t.kind === "review" &&
        t.status === "completed" &&
        t.target.repository.toLowerCase() === targetRepo &&
        t.target.prNumber === prNumber,
    );

    // Sort to locate the latest completed review task
    const sortedCompleted = completedReviewTasks.sort((a, b) => {
      if (b.revision !== a.revision) return b.revision - a.revision;
      if (b.updatedAtMs !== a.updatedAtMs) return b.updatedAtMs - a.updatedAtMs;
      return b.taskId.localeCompare(a.taskId);
    });

    const latestCompletedTask = sortedCompleted[0] ?? null;

    if (latestCompletedTask) {
      const matchingResult = decisionFacts.results.find(
        (r) =>
          r.taskId === latestCompletedTask.taskId &&
          r.revision === latestCompletedTask.revision &&
          r.outcome.kind === "review",
      );

      if (
        matchingResult &&
        matchingResult.outcome.kind === "review" &&
        matchingResult.outcome.verdict === "approve"
      ) {
        if (latestCompletedTask.target.headSha.toLowerCase() !== prHeadSha.toLowerCase()) {
          const evidence: ProjectionEvidence[] = [
            {
              source: "github",
              instance: githubFacts.provenance.instance,
              code: "pr_head_sha",
              detail: `PR #${prNumber} HEAD ${prHeadSha.slice(0, 7)}`,
              observedAt: githubFacts.provenance.observedAt,
              freshnessStatus: "fresh",
              ruleId: "review_approval_head_mismatch",
              role: "supporting",
              workKey,
              headSha: prHeadSha,
              field: "pullRequest.headSha",
              value: prHeadSha,
            },
            {
              source: "decision",
              instance: decisionFacts.provenance.instance,
              code: "review_task_target",
              detail: `task ${latestCompletedTask.taskId} target ${latestCompletedTask.target.headSha.slice(0, 7)}`,
              observedAt: decisionFacts.provenance.observedAt,
              entityTimestampMs: latestCompletedTask.updatedAtMs,
              freshnessStatus: "fresh",
              ruleId: "review_approval_head_mismatch",
              role: "supporting",
              workKey,
              taskId: latestCompletedTask.taskId,
              revision: latestCompletedTask.revision,
              target: latestCompletedTask.target,
              headSha: latestCompletedTask.target.headSha,
              field: "task.target.headSha",
              value: latestCompletedTask.target.headSha,
            },
            {
              source: "decision",
              instance: decisionFacts.provenance.instance,
              code: "review_verdict_approve",
              detail: `result approval target ${matchingResult.outcome.target.headSha.slice(0, 7)}`,
              observedAt: decisionFacts.provenance.observedAt,
              entityTimestampMs: matchingResult.createdAtMs,
              freshnessStatus: "fresh",
              ruleId: "review_approval_head_mismatch",
              role: "supporting",
              workKey,
              taskId: matchingResult.taskId,
              revision: matchingResult.revision,
              target: matchingResult.outcome.target,
              headSha: matchingResult.outcome.target.headSha,
              field: "result.outcome.verdict",
              value: "approve",
            },
          ];

          anomalies.push({
            code: "review_approval_head_mismatch",
            severity: "error",
            workKey,
            message: `Completed review approval for task '${latestCompletedTask.taskId}' targets old SHA ${latestCompletedTask.target.headSha.slice(0, 7)}, but current PR #${prNumber} HEAD is ${prHeadSha.slice(0, 7)}`,
            detectedAt,
            evidence,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rule 3: review_result_target_mismatch (error)
  // Review result target does not match task target for the same taskId and revision.
  // -------------------------------------------------------------------------
  if (isDecisionFresh) {
    for (const result of decisionFacts.results) {
      if (result.outcome.kind === "review") {
        const task = decisionFacts.tasks.find(
          (t) => t.taskId === result.taskId && t.revision === result.revision,
        );
        if (task && task.kind === "review") {
          const taskTarget = task.target;
          const resultTarget = result.outcome.target;

          const repoMismatch =
            taskTarget.repository.toLowerCase() !== resultTarget.repository.toLowerCase();
          const prMismatch = taskTarget.prNumber !== resultTarget.prNumber;
          const shaMismatch =
            taskTarget.headSha.toLowerCase() !== resultTarget.headSha.toLowerCase();

          if (repoMismatch || prMismatch || shaMismatch) {
            const evidence: ProjectionEvidence[] = [
              {
                source: "decision",
                instance: decisionFacts.provenance.instance,
                code: "review_task_target",
                detail: `task target ${taskTarget.repository}#${taskTarget.prNumber}@${taskTarget.headSha.slice(0, 7)}`,
                observedAt: decisionFacts.provenance.observedAt,
                entityTimestampMs: task.updatedAtMs,
                freshnessStatus: "fresh",
                ruleId: "review_result_target_mismatch",
                role: "supporting",
                workKey,
                taskId: task.taskId,
                revision: task.revision,
                target: taskTarget,
                headSha: taskTarget.headSha,
                field: "task.target",
                value: `${taskTarget.repository}#${taskTarget.prNumber}@${taskTarget.headSha}`,
              },
              {
                source: "decision",
                instance: decisionFacts.provenance.instance,
                code: "review_result_target",
                detail: `result target ${resultTarget.repository}#${resultTarget.prNumber}@${resultTarget.headSha.slice(0, 7)}`,
                observedAt: decisionFacts.provenance.observedAt,
                entityTimestampMs: result.createdAtMs,
                freshnessStatus: "fresh",
                ruleId: "review_result_target_mismatch",
                role: "supporting",
                workKey,
                taskId: result.taskId,
                revision: result.revision,
                target: resultTarget,
                headSha: resultTarget.headSha,
                field: "result.outcome.target",
                value: `${resultTarget.repository}#${resultTarget.prNumber}@${resultTarget.headSha}`,
              },
            ];

            anomalies.push({
              code: "review_result_target_mismatch",
              severity: "error",
              workKey,
              message: `Review result target mismatch for task '${task.taskId}' (rev ${result.revision}): result targets ${resultTarget.repository}#${resultTarget.prNumber}@${resultTarget.headSha.slice(0, 7)} but task targets ${taskTarget.repository}#${taskTarget.prNumber}@${taskTarget.headSha.slice(0, 7)}`,
              detectedAt,
              evidence,
            });
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rule 4: execution_on_terminal_work (warning)
  // Fresh runtime has active execution attempt, but fresh GitHub issue is closed or PR is merged.
  // -------------------------------------------------------------------------
  if (isRuntimeFresh && isGitHubFresh) {
    const isTerminal =
      githubFacts.issue.state === "closed" || githubFacts.pullRequest?.state === "merged";

    if (isTerminal) {
      const activeAttempts = runtimeRows.filter(
        (r) =>
          r.workKey !== null &&
          formatWorkKey(r.workKey) === formattedTargetKey &&
          isAttemptActive(r.attempt?.status),
      );

      for (const row of activeAttempts) {
        if (row.attempt) {
          const terminalEvidence: ProjectionEvidence[] = [];

          if (githubFacts.pullRequest?.state === "merged") {
            terminalEvidence.push({
              source: "github",
              instance: githubFacts.provenance.instance,
              code: "pr_merged",
              detail: `PR #${githubFacts.pullRequest.number} is merged`,
              observedAt: githubFacts.provenance.observedAt,
              freshnessStatus: "fresh",
              ruleId: "execution_on_terminal_work",
              role: "supporting",
              workKey,
              target: {
                repository: extractTargetRepo(workKey),
                prNumber: githubFacts.pullRequest.number,
                headSha: githubFacts.pullRequest.headSha,
              },
              headSha: githubFacts.pullRequest.headSha,
              field: "pullRequest.state",
              value: "merged",
            });
          }

          if (githubFacts.issue.state === "closed") {
            terminalEvidence.push({
              source: "github",
              instance: githubFacts.provenance.instance,
              code: "issue_closed",
              detail: "issue state is closed",
              observedAt: githubFacts.provenance.observedAt,
              freshnessStatus: "fresh",
              ruleId: "execution_on_terminal_work",
              role: "supporting",
              workKey,
              field: "issue.state",
              value: "closed",
            });
          }

          const runtimeEvidence: ProjectionEvidence = {
            source: "runtime",
            instance: row.provenance.instance,
            code: `attempt_${row.attempt.status}`,
            detail: `attempt ${row.attempt.attempt ?? 1} status ${row.attempt.status}`,
            observedAt: row.provenance.observedAt,
            entityTimestampMs: row.attempt.startedAtMs,
            freshnessStatus: "fresh",
            ruleId: "execution_on_terminal_work",
            role: "supporting",
            workKey,
            field: "attempt.status",
            value: row.attempt.status,
          };

          const isPrMerged = githubFacts.pullRequest?.state === "merged";
          const isIssueClosed = githubFacts.issue.state === "closed";
          const terminalReason =
            isIssueClosed && isPrMerged
              ? "issue closed and PR merged"
              : isIssueClosed
                ? "issue closed"
                : "PR merged";

          anomalies.push({
            code: "execution_on_terminal_work",
            severity: "warning",
            workKey,
            message: `Active runtime attempt ${row.attempt.attempt ?? 1} (${row.attempt.status}) observed on terminal GitHub work (${terminalReason})`,
            detectedAt,
            evidence: [...terminalEvidence, runtimeEvidence],
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rule 5: decision_active_task_without_session (error)
  // Fresh Decision successfully observed session=null, but has active tasks.
  // -------------------------------------------------------------------------
  if (isDecisionFresh && decisionFacts.session === null) {
    const activeTasks = decisionFacts.tasks.filter((t) => isDecisionTaskActive(t.status));
    if (activeTasks.length > 0) {
      const evidence: ProjectionEvidence[] = [
        {
          source: "decision",
          instance: decisionFacts.provenance.instance,
          code: "session_null",
          detail: "session is null",
          observedAt: decisionFacts.provenance.observedAt,
          freshnessStatus: "fresh",
          ruleId: "decision_active_task_without_session",
          role: "supporting",
          workKey,
          field: "session",
          value: null,
        },
        ...activeTasks.map((t) => ({
          source: "decision" as const,
          instance: decisionFacts.provenance.instance,
          code: `task_${t.status}`,
          detail: `task ${t.taskId} status ${t.status}`,
          observedAt: decisionFacts.provenance.observedAt,
          entityTimestampMs: t.updatedAtMs,
          freshnessStatus: "fresh" as const,
          ruleId: "decision_active_task_without_session",
          role: "supporting" as const,
          workKey,
          taskId: t.taskId,
          revision: t.revision,
          field: "task.status",
          value: t.status,
        })),
      ];

      anomalies.push({
        code: "decision_active_task_without_session",
        severity: "error",
        workKey,
        message: `Decision plane has ${activeTasks.length} active task(s) but no session exists`,
        detectedAt,
        evidence,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Rule 6: decision_active_task_on_completed_session (error)
  // Completed Decision session still has active tasks.
  // -------------------------------------------------------------------------
  if (
    isDecisionFresh &&
    decisionFacts.session !== null &&
    decisionFacts.session.status === "completed"
  ) {
    const activeTasks = decisionFacts.tasks.filter((t) => isDecisionTaskActive(t.status));
    if (activeTasks.length > 0) {
      const evidence: ProjectionEvidence[] = [
        {
          source: "decision",
          instance: decisionFacts.provenance.instance,
          code: "session_completed",
          detail: `session ${decisionFacts.session.sessionId} completed`,
          observedAt: decisionFacts.provenance.observedAt,
          entityTimestampMs: decisionFacts.session.updatedAtMs,
          freshnessStatus: "fresh",
          ruleId: "decision_active_task_on_completed_session",
          role: "supporting",
          workKey,
          sessionId: decisionFacts.session.sessionId,
          field: "session.status",
          value: "completed",
        },
        ...activeTasks.map((t) => ({
          source: "decision" as const,
          instance: decisionFacts.provenance.instance,
          code: `task_${t.status}`,
          detail: `task ${t.taskId} status ${t.status}`,
          observedAt: decisionFacts.provenance.observedAt,
          entityTimestampMs: t.updatedAtMs,
          freshnessStatus: "fresh" as const,
          ruleId: "decision_active_task_on_completed_session",
          role: "supporting" as const,
          workKey,
          taskId: t.taskId,
          revision: t.revision,
          field: "task.status",
          value: t.status,
        })),
      ];

      anomalies.push({
        code: "decision_active_task_on_completed_session",
        severity: "error",
        workKey,
        message: `Decision plane has ${activeTasks.length} active task(s) while session '${decisionFacts.session.sessionId}' is completed`,
        detectedAt,
        evidence,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Rule 7: decision_result_without_task (error)
  // Decision result exists without a matching task for the same taskId and revision.
  // -------------------------------------------------------------------------
  if (isDecisionFresh) {
    for (const result of decisionFacts.results) {
      const taskExists = decisionFacts.tasks.some(
        (t) => t.taskId === result.taskId && t.revision === result.revision,
      );
      if (!taskExists) {
        const evidence: ProjectionEvidence[] = [
          {
            source: "decision",
            instance: decisionFacts.provenance.instance,
            code: "result_orphan",
            detail: `result for taskId ${result.taskId} rev ${result.revision} has no task`,
            observedAt: decisionFacts.provenance.observedAt,
            entityTimestampMs: result.createdAtMs,
            freshnessStatus: "fresh",
            ruleId: "decision_result_without_task",
            role: "supporting",
            workKey,
            taskId: result.taskId,
            revision: result.revision,
            field: "result.taskId",
            value: result.taskId,
          },
        ];

        anomalies.push({
          code: "decision_result_without_task",
          severity: "error",
          workKey,
          message: `Decision result exists for task '${result.taskId}' (rev ${result.revision}) but no matching task was found`,
          detectedAt,
          evidence,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rule 8: conflicting_active_review_tasks (error)
  // Multiple active review tasks exist concurrently for the same repository and PR.
  // -------------------------------------------------------------------------
  if (isDecisionFresh) {
    const activeReviewTasks = decisionFacts.tasks.filter(
      (t): t is DecisionTaskFacts & { readonly kind: "review" } =>
        t.kind === "review" && isDecisionTaskActive(t.status),
    );

    // Group by repo + prNumber
    const groups = new Map<string, Array<DecisionTaskFacts & { readonly kind: "review" }>>();
    for (const task of activeReviewTasks) {
      const groupKey = `${task.target.repository.toLowerCase()}#${task.target.prNumber}`;
      const existing = groups.get(groupKey);
      if (existing) {
        existing.push(task);
      } else {
        groups.set(groupKey, [task]);
      }
    }

    for (const [groupKey, tasks] of groups) {
      // Must have distinct taskIds
      const sortedTasks = [...tasks].sort((a, b) => {
        if (a.taskId !== b.taskId) return a.taskId.localeCompare(b.taskId);
        return a.revision - b.revision;
      });
      const uniqueTaskIds = Array.from(new Set(sortedTasks.map((t) => t.taskId)));
      if (uniqueTaskIds.length >= 2) {
        const evidence: ProjectionEvidence[] = sortedTasks.map((t) => ({
          source: "decision" as const,
          instance: decisionFacts.provenance.instance,
          code: `active_review_task_${t.status}`,
          detail: `task ${t.taskId} (rev ${t.revision}) targeting SHA ${t.target.headSha.slice(0, 7)}`,
          observedAt: decisionFacts.provenance.observedAt,
          entityTimestampMs: t.updatedAtMs,
          freshnessStatus: "fresh" as const,
          ruleId: "conflicting_active_review_tasks",
          role: "supporting" as const,
          workKey,
          taskId: t.taskId,
          revision: t.revision,
          target: t.target,
          headSha: t.target.headSha,
          field: "task.status",
          value: t.status,
        }));

        anomalies.push({
          code: "conflicting_active_review_tasks",
          severity: "error",
          workKey,
          message: `Multiple active review tasks (${uniqueTaskIds.sort().join(", ")}) exist for ${groupKey}`,
          detectedAt,
          evidence,
        });
      }
    }
  }

  return sortAndDeduplicateAnomalies(anomalies);
}

// ---------------------------------------------------------------------------
// Multi-work Collection Anomaly Detection
// ---------------------------------------------------------------------------

/**
 * Pure anomaly detection across an entire OperationFactCollection.
 */
export function detectCollectionAnomalies(
  input: DetectCollectionAnomaliesInput,
): readonly OperationalAnomaly[] {
  const { collection } = input;
  const detectedAt = input.detectedAt ?? 0;
  const workKeyMap = new Map<string, WorkKey>();

  if (collection.github.facts?.workKey) {
    const k = parseWorkKey(collection.github.facts.workKey);
    workKeyMap.set(formatWorkKey(k), k);
  }

  if (collection.decision.facts?.workKey) {
    const k = parseWorkKey(collection.decision.facts.workKey);
    workKeyMap.set(formatWorkKey(k), k);
  }

  if (collection.runtime.facts) {
    for (const row of collection.runtime.facts) {
      if (row.workKey) {
        const k = parseWorkKey(row.workKey);
        workKeyMap.set(formatWorkKey(k), k);
      }
    }
  }

  const allAnomalies: OperationalAnomaly[] = [];
  for (const workKey of workKeyMap.values()) {
    const workAnomalies = detectWorkAnomalies({
      collection,
      workKey,
      detectedAt,
    });
    allAnomalies.push(...workAnomalies);
  }

  return sortAndDeduplicateAnomalies(allAnomalies);
}

// ---------------------------------------------------------------------------
// Boolean check helper (zero-timestamp detection check)
// ---------------------------------------------------------------------------

export function hasWorkAnomalies(input: DetectWorkAnomaliesInput): boolean {
  return detectWorkAnomalies({ ...input, detectedAt: 0 }).length > 0;
}

// ---------------------------------------------------------------------------
// Deterministic sorting and deduplication
// ---------------------------------------------------------------------------

function sortEvidence(
  evidence: readonly ProjectionEvidence[] | undefined,
): readonly ProjectionEvidence[] | undefined {
  if (!evidence || evidence.length <= 1) return evidence;
  return [...evidence].sort((a, b) => {
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    if (a.code !== b.code) return a.code.localeCompare(b.code);
    const aTaskId = a.taskId ?? "";
    const bTaskId = b.taskId ?? "";
    if (aTaskId !== bTaskId) return aTaskId.localeCompare(bTaskId);
    const aSha = a.headSha ?? "";
    const bSha = b.headSha ?? "";
    if (aSha !== bSha) return aSha.localeCompare(bSha);
    const aDetail = a.detail ?? "";
    const bDetail = b.detail ?? "";
    return aDetail.localeCompare(bDetail);
  });
}

export function sortAndDeduplicateAnomalies(
  anomalies: readonly OperationalAnomaly[],
): readonly OperationalAnomaly[] {
  const sorted = [...anomalies]
    .map((item) => ({
      ...item,
      evidence: sortEvidence(item.evidence),
    }))
    .sort((a, b) => {
      if (a.code !== b.code) return a.code.localeCompare(b.code);
      if (a.detectedAt !== b.detectedAt) return a.detectedAt - b.detectedAt;
      const aKey = a.workKey ? formatWorkKey(a.workKey) : "";
      const bKey = b.workKey ? formatWorkKey(b.workKey) : "";
      if (aKey !== bKey) return aKey.localeCompare(bKey);
      if (a.severity !== b.severity) return a.severity.localeCompare(b.severity);
      if (a.message !== b.message) return a.message.localeCompare(b.message);
      const aEv = a.evidence ? JSON.stringify(a.evidence) : "";
      const bEv = b.evidence ? JSON.stringify(b.evidence) : "";
      return aEv.localeCompare(bEv);
    });

  // Deduplicate identical code + workKey + message
  const deduplicated: OperationalAnomaly[] = [];
  const seen = new Set<string>();

  for (const item of sorted) {
    const key = `${item.code}:${item.workKey ? formatWorkKey(item.workKey) : ""}:${item.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(item);
    }
  }

  return deduplicated;
}
