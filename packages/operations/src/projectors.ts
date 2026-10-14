/**
 * Pure, deterministic Operational Read Model projection layer (NEST-115 / GitHub #111).
 *
 * Implements derived-only work and system projections from normalized operational facts.
 * Every projector function in this module is pure, deterministic, and side-effect free:
 * no I/O, no timers, no global clock access, and no mutation of input facts or external stores.
 */
import {
  formatWorkKey,
  isExactHeadSha,
  OPERATIONAL_SNAPSHOT_SCHEMA_VERSION,
  parseWorkKey,
  type AttentionState,
  type DecisionResultFacts,
  type DecisionTaskFacts,
  type DecisionWorkFacts,
  type ExecutionProjection,
  type ExecutorFacts,
  type ExecutorProjection,
  type GitHubWorkFacts,
  type OperationalAnomaly,
  type OperationalSnapshot,
  type OperationalSnapshotSummary,
  type OperationFactCollection,
  type OperationSourceResult,
  type PlanningProjection,
  type ProjectionEvidence,
  type PullRequestProjection,
  type ReviewApprovalState,
  type ReviewProjection,
  type RunAttemptStatus,
  type RuntimeWorkFacts,
  type SourceFreshness,
  type SourceStatus,
  type SystemHealth,
  type UtcTimestampMs,
  type WorkFreshness,
  type WorkKey,
  type WorkPhase,
  type WorkProjection,
  type WorkProjectionWorkItem,
  type WorkWaiting,
} from "@symphony/domain";

// ---------------------------------------------------------------------------
// Run attempt activity helper
// ---------------------------------------------------------------------------

export const ACTIVE_RUN_ATTEMPT_STATUSES = [
  "preparing_workspace",
  "building_prompt",
  "launching_agent_process",
  "initializing_session",
  "streaming_turn",
  "finishing",
] as const satisfies readonly RunAttemptStatus[];

export function isRunAttemptActive(status: RunAttemptStatus | null | undefined): boolean {
  return (
    status !== undefined &&
    status !== null &&
    (ACTIVE_RUN_ATTEMPT_STATUSES as readonly RunAttemptStatus[]).includes(status)
  );
}

// ---------------------------------------------------------------------------
// Context & normalization
// ---------------------------------------------------------------------------

export interface WorkDerivationContext {
  readonly workKey: WorkKey;
  readonly collection?: OperationFactCollection;
  readonly github?: OperationSourceResult<GitHubWorkFacts> | null;
  readonly runtime?: OperationSourceResult<readonly RuntimeWorkFacts[]> | RuntimeWorkFacts | null;
  readonly decision?: OperationSourceResult<DecisionWorkFacts> | null;
  readonly executor?: OperationSourceResult<readonly ExecutorFacts[]> | null;
}

export interface ProjectWorkInput {
  readonly workKey?: WorkKey;
  readonly collection?: OperationFactCollection;
  readonly github?: OperationSourceResult<GitHubWorkFacts> | null;
  readonly runtime?: OperationSourceResult<readonly RuntimeWorkFacts[]> | RuntimeWorkFacts | null;
  readonly decision?: OperationSourceResult<DecisionWorkFacts> | null;
  readonly executor?: OperationSourceResult<readonly ExecutorFacts[]> | null;
}

interface NormalizedWorkContext {
  readonly workKey: WorkKey;
  readonly githubFreshness: SourceFreshness;
  readonly githubFacts: GitHubWorkFacts | null;
  readonly runtimeFreshness: SourceFreshness;
  readonly runtimeRow: RuntimeWorkFacts | null;
  readonly decisionFreshness: SourceFreshness;
  readonly decisionFacts: DecisionWorkFacts | null;
  readonly latestPlanTask: DecisionTaskFacts | null;
  readonly latestPlanResult: DecisionResultFacts | null;
  readonly latestReviewTask: (DecisionTaskFacts & { readonly kind: "review" }) | null;
  readonly latestReviewResult: DecisionResultFacts | null;
}

const UNKNOWN_FRESHNESS: SourceFreshness = {
  status: "unknown",
  lastAttemptAt: null,
  reason: null,
};

function isNormalizedWorkContext(input: unknown): input is NormalizedWorkContext {
  return (
    typeof input === "object" &&
    input !== null &&
    "githubFreshness" in input &&
    "decisionFreshness" in input &&
    "runtimeFreshness" in input &&
    "workKey" in input
  );
}

function resolveWorkKey(input: ProjectWorkInput | WorkDerivationContext): WorkKey {
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
  throw new TypeError("workKey is required to derive work projections");
}

function normalizeWorkContext(input: WorkDerivationContext | ProjectWorkInput | NormalizedWorkContext): NormalizedWorkContext {
  if (isNormalizedWorkContext(input)) {
    return input;
  }

  const workKey = resolveWorkKey(input);
  const formattedTargetKey = formatWorkKey(workKey);

  // GitHub source
  const githubSource = input.github ?? input.collection?.github ?? null;
  const githubFreshness = githubSource?.freshness ?? UNKNOWN_FRESHNESS;
  const githubFacts = githubSource?.facts ?? null;

  // Decision source
  const decisionSource = input.decision ?? input.collection?.decision ?? null;
  const decisionFreshness = decisionSource?.freshness ?? UNKNOWN_FRESHNESS;
  const decisionFacts = decisionSource?.facts ?? null;

  // Runtime source
  const runtimeInput = input.runtime ?? input.collection?.runtime ?? null;
  let runtimeFreshness: SourceFreshness = UNKNOWN_FRESHNESS;
  let runtimeRow: RuntimeWorkFacts | null = null;

  if (runtimeInput) {
    if ("facts" in runtimeInput && "freshness" in runtimeInput) {
      runtimeFreshness = runtimeInput.freshness;
      const rows: readonly RuntimeWorkFacts[] = runtimeInput.facts ?? [];
      const matching = rows.filter(
        (r: RuntimeWorkFacts) => r.workKey !== null && formatWorkKey(r.workKey) === formattedTargetKey,
      );
      if (matching.length > 0) {
        // Deterministic sort: prefer running attempts, then highest attempt, then latest start, then stable issueId
        const sorted = [...matching].sort((a, b) => {
          const aRunning = isRunAttemptActive(a.attempt?.status) ? 1 : 0;
          const bRunning = isRunAttemptActive(b.attempt?.status) ? 1 : 0;
          if (bRunning !== aRunning) return bRunning - aRunning;
          const aAttempt = a.attempt?.attempt ?? a.retry?.attempt ?? 0;
          const bAttempt = b.attempt?.attempt ?? b.retry?.attempt ?? 0;
          if (bAttempt !== aAttempt) return bAttempt - aAttempt;
          const aStart = a.attempt?.startedAtMs ?? 0;
          const bStart = b.attempt?.startedAtMs ?? 0;
          if (bStart !== aStart) return bStart - aStart;
          return a.issueId.localeCompare(b.issueId);
        });
        runtimeRow = sorted[0] ?? null;
      }
    } else if ("provenance" in runtimeInput && "issueId" in runtimeInput) {
      runtimeFreshness = {
        status: "fresh",
        observedAt: runtimeInput.provenance.observedAt,
        lastAttemptAt: runtimeInput.provenance.observedAt,
      };
      runtimeRow = runtimeInput;
    }
  }

  // Decision tasks and results deterministic sorting
  const rawTasks = decisionFacts?.tasks ? [...decisionFacts.tasks] : [];
  const rawResults = decisionFacts?.results ? [...decisionFacts.results] : [];

  const expectedRepo = extractTargetRepo(workKey).toLowerCase();
  const currentPrNumber =
    githubFacts?.pullRequest !== undefined
      ? githubFacts.pullRequest !== null
        ? githubFacts.pullRequest.number
        : null
      : undefined;

  function taskStatusPriority(status: DecisionTaskFacts["status"]): number {
    switch (status) {
      case "running":
      case "claimed":
      case "pending":
        return 3;
      case "completed":
        return 2;
      case "failed":
      case "cancelled":
      case "superseded":
      default:
        return 1;
    }
  }

  // Plan tasks
  const planTasks = rawTasks.filter(
    (t): t is DecisionTaskFacts & { readonly kind: "plan" } => t.kind === "plan",
  );
  const sortedPlanTasks = planTasks.sort((a, b) => {
    const aPrio = taskStatusPriority(a.status);
    const bPrio = taskStatusPriority(b.status);
    if (bPrio !== aPrio) return bPrio - aPrio;
    if (b.revision !== a.revision) return b.revision - a.revision;
    if (b.updatedAtMs !== a.updatedAtMs) return b.updatedAtMs - a.updatedAtMs;
    return b.taskId.localeCompare(a.taskId);
  });
  const latestPlanTask = sortedPlanTasks[0] ?? null;

  const latestPlanResult = latestPlanTask
    ? (rawResults.find(
        (r) =>
          r.taskId === latestPlanTask.taskId &&
          r.revision === latestPlanTask.revision &&
          r.outcome.kind === "plan",
      ) ?? null)
    : null;

  // Review tasks: strictly filtered by current repository and PR (if known)
  const reviewTasks = rawTasks.filter(
    (t): t is DecisionTaskFacts & { readonly kind: "review" } => {
      if (t.kind !== "review") return false;
      if (t.target.repository.toLowerCase() !== expectedRepo) return false;
      if (currentPrNumber !== undefined) {
        if (currentPrNumber === null) return false;
        if (t.target.prNumber !== currentPrNumber) return false;
      }
      return true;
    },
  );

  const sortedReviewTasks = reviewTasks.sort((a, b) => {
    const aPrio = taskStatusPriority(a.status);
    const bPrio = taskStatusPriority(b.status);
    if (bPrio !== aPrio) return bPrio - aPrio;
    if (b.revision !== a.revision) return b.revision - a.revision;
    if (b.updatedAtMs !== a.updatedAtMs) return b.updatedAtMs - a.updatedAtMs;
    return b.taskId.localeCompare(a.taskId);
  });
  const latestReviewTask = sortedReviewTasks[0] ?? null;

  const latestReviewResult = latestReviewTask
    ? (rawResults.find(
        (r) =>
          r.taskId === latestReviewTask.taskId &&
          r.revision === latestReviewTask.revision &&
          r.outcome.kind === "review",
      ) ?? null)
    : null;

  return {
    workKey,
    githubFreshness,
    githubFacts,
    runtimeFreshness,
    runtimeRow,
    decisionFreshness,
    decisionFacts,
    latestPlanTask,
    latestPlanResult,
    latestReviewTask,
    latestReviewResult,
  };
}

// ---------------------------------------------------------------------------
// Review approval derivation
// ---------------------------------------------------------------------------

function extractTargetRepo(workKey: WorkKey): string {
  const parts = workKey.key.split("#");
  return parts[0] ?? workKey.key;
}

/**
 * Derives the consumer-facing review projection.
 *
 * Preserves the exact HEAD SHA, task review target, and result review target.
 * Mismatched review target vs current HEAD SHA yields `approved_stale_head` and
 * strictly refuses to authorize landing.
 */
export function deriveReviewProjection(context: WorkDerivationContext | ProjectWorkInput | NormalizedWorkContext): ReviewProjection | null {
  const ctx = normalizeWorkContext(context);
  const {
    workKey,
    githubFacts,
    githubFreshness,
    decisionFreshness,
    latestReviewTask,
    latestReviewResult,
  } = ctx;

  const currentHeadSha = githubFacts?.pullRequest?.headSha ?? null;

  const task = latestReviewTask;
  const result = latestReviewResult;
  const taskTarget = task ? task.target : result?.outcome.kind === "review" ? result.outcome.target : null;

  // If no PR exists and no review tasks/results exist, review projection is absent
  if (githubFacts?.pullRequest === null && task === null && result === null) {
    return null;
  }

  let approval: ReviewApprovalState = "not_approved";

  if (decisionFreshness.status === "unavailable" || decisionFreshness.status === "unknown") {
    approval = "unknown";
  } else if (task === null) {
    approval = "not_approved";
  } else if (task.status === "superseded" || task.status === "cancelled" || task.status === "failed") {
    // Superseded, cancelled, or failed tasks cannot authorize approval
    approval = "not_approved";
  } else if (task.status === "running" || task.status === "claimed" || task.status === "pending") {
    approval = "pending";
  } else if (task.status === "completed") {
    // Canonical review approval requires task.status === "completed" and matching result
    if (
      result !== null &&
      result.outcome.kind === "review" &&
      result.taskId === task.taskId &&
      result.revision === task.revision
    ) {
      const verdict = result.outcome.verdict;
      if (verdict === "needs_human") {
        approval = "not_approved";
      } else if (verdict === "changes_requested") {
        approval = decisionFreshness.status === "fresh" ? "changes_requested" : "not_approved";
      } else if (verdict === "approve") {
        const expectedRepo = extractTargetRepo(workKey).toLowerCase();
        const taskTargetRepo = task.target.repository.toLowerCase();
        const resultTarget = result.outcome.target;
        const resultTargetRepo = resultTarget.repository.toLowerCase();

        const targetConsistent =
          taskTargetRepo === resultTargetRepo &&
          task.target.prNumber === resultTarget.prNumber &&
          task.target.headSha.toLowerCase() === resultTarget.headSha.toLowerCase();

        const reposMatch = taskTargetRepo === expectedRepo;
        const prNumberMatch =
          githubFacts?.pullRequest ? task.target.prNumber === githubFacts.pullRequest.number : true;

        if (targetConsistent && reposMatch && prNumberMatch) {
          const shaMatch =
            currentHeadSha !== null &&
            isExactHeadSha(currentHeadSha) &&
            task.target.headSha.toLowerCase() === currentHeadSha.toLowerCase();
          const sourcesFresh =
            githubFreshness.status === "fresh" && decisionFreshness.status === "fresh";

          if (shaMatch && sourcesFresh) {
            approval = "approved_current_head";
          } else {
            approval = "approved_stale_head";
          }
        } else {
          approval = "not_approved";
        }
      }
    } else {
      approval = "not_approved";
    }
  }

  return {
    currentHeadSha,
    taskTarget,
    task,
    result,
    approval,
  };
}

// ---------------------------------------------------------------------------
// Work Phase derivation
// ---------------------------------------------------------------------------

/**
 * Pure derivation of consumer-facing lifecycle phase.
 *
 * Precedence rules:
 * 1. Completed: Fresh GitHub facts show merged PR or closed issue.
 * 2. Unknown: GitHub facts are unavailable, unknown, or stale.
 * 3. Repair: Active coding attempt running with prior CI failure or changes_requested.
 * 4. Coding: Active coding attempt running without prior failure.
 * 5. Landing: Fresh open non-draft PR, exact HEAD CI success, and approved_current_head.
 * 6. Review: Open PR with active review task or pending review approval after CI.
 * 7. CI: Open PR with pending CI.
 * 8. Repair: PR with failed CI or changes_requested awaiting or planning fix.
 * 9. Coding: Pre-PR or draft PR with runtime attempt/retry active.
 * 10. Ready: Plan verdict ready, awaiting execution.
 * 11. Planning: Plan task active or session active awaiting plan.
 * 12. Default: Unknown.
 */
export function deriveWorkPhase(context: WorkDerivationContext | ProjectWorkInput | NormalizedWorkContext): WorkPhase {
  const ctx = normalizeWorkContext(context);
  const {
    githubFreshness,
    githubFacts,
    runtimeFreshness,
    decisionFreshness,
    runtimeRow,
    latestPlanTask,
    latestPlanResult,
    latestReviewTask,
  } = ctx;

  // 1. Completed (only observed when GitHub is fresh)
  if (githubFreshness.status === "fresh" && githubFacts) {
    if (githubFacts.pullRequest?.state === "merged" || githubFacts.issue.state === "closed") {
      return "completed";
    }
  }

  // 2. Freshness check: if GitHub is unavailable, unknown, or stale, workflow phase cannot be trusted
  if (githubFreshness.status === "unavailable" || githubFreshness.status === "unknown" || githubFreshness.status === "stale") {
    return "unknown";
  }

  if (!githubFacts) {
    return "unknown";
  }

  const isRuntimeFresh = runtimeFreshness.status === "fresh";
  const isDecisionFresh = decisionFreshness.status === "fresh";

  const reviewProj = deriveReviewProjection(ctx);
  const reviewApproval = reviewProj?.approval ?? "not_approved";

  const isRuntimeRunning = isRuntimeFresh && isRunAttemptActive(runtimeRow?.attempt?.status);
  const pr = githubFacts.pullRequest;
  const ci = githubFacts.ci;

  // 3 & 4. Active runtime execution (asserted only when runtime facts are fresh)
  if (isRuntimeRunning) {
    const hasPriorFailure =
      ci?.status === "failure" ||
      reviewApproval === "changes_requested" ||
      (runtimeRow?.attempt?.attempt !== null && (runtimeRow?.attempt?.attempt ?? 1) > 1);
    return hasPriorFailure ? "repair" : "coding";
  }

  // 5. Landing
  if (
    pr &&
    pr.state === "open" &&
    !pr.isDraft &&
    isExactHeadSha(pr.headSha) &&
    ci &&
    ci.status === "success" &&
    ci.headSha === pr.headSha &&
    reviewApproval === "approved_current_head" &&
    isDecisionFresh
  ) {
    return "landing";
  }

  // 6. Review
  if (pr && pr.state === "open" && !pr.isDraft) {
    if (isDecisionFresh && latestReviewTask && (latestReviewTask.status === "running" || latestReviewTask.status === "pending")) {
      return "review";
    }
    if (ci?.status === "success") {
      if (reviewApproval !== "changes_requested") {
        return "review";
      }
    }
  }

  // 7. CI
  if (pr && pr.state === "open" && !pr.isDraft) {
    if (ci?.status === "pending" || ci === null) {
      if (!isDecisionFresh || !latestReviewTask || latestReviewTask.status !== "running") {
        return "ci";
      }
    }
  }

  // 8. Repair (waiting/pending fix)
  if (pr && pr.state === "open") {
    if (ci?.status === "failure" || reviewApproval === "changes_requested") {
      return "repair";
    }
  }

  // 9. Coding (pre-PR or draft with fresh runtime attempt/retry)
  if (isRuntimeFresh && runtimeRow && (runtimeRow.attempt !== null || runtimeRow.retry !== null)) {
    return "coding";
  }

  // 10. Ready (requires fresh decision and completed plan task with ready verdict)
  if (
    isDecisionFresh &&
    latestPlanTask?.status === "completed" &&
    latestPlanResult?.outcome.kind === "plan" &&
    latestPlanResult.outcome.verdict === "ready"
  ) {
    if (!pr) {
      return "ready";
    }
  }

  // 11. Planning
  if (isDecisionFresh && latestPlanTask && (latestPlanTask.status === "running" || latestPlanTask.status === "pending")) {
    return "planning";
  }
  if (isDecisionFresh && ctx.decisionFacts?.session?.status === "active") {
    return "planning";
  }
  if (githubFacts.issue.state === "open" && !pr) {
    return "planning";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Waiting Reason derivation
// ---------------------------------------------------------------------------

/**
 * Pure derivation of waiting reason.
 *
 * Distinguishes waiting_for_plan, waiting_for_executor, waiting_for_ci, waiting_for_review,
 * retry_backoff, needs_clarification, needs_human, and blocked_by_dependency.
 * Returns null if work is completed or actively making forward progress.
 */
export function deriveWaitingReason(context: WorkDerivationContext | ProjectWorkInput | NormalizedWorkContext): WorkWaiting | null {
  const ctx = normalizeWorkContext(context);
  const phase = deriveWorkPhase(ctx);

  // Completed work clears waiting
  if (phase === "completed") {
    return null;
  }

  const {
    githubFreshness,
    runtimeFreshness,
    decisionFreshness,
    githubFacts,
    runtimeRow,
    latestPlanTask,
    latestPlanResult,
    latestReviewTask,
    latestReviewResult,
  } = ctx;

  const isGitHubFresh = githubFreshness.status === "fresh";
  const isRuntimeFresh = runtimeFreshness.status === "fresh";
  const isDecisionFresh = decisionFreshness.status === "fresh";

  // 1. needs_human (only from fresh Decision facts where task is completed)
  if (isDecisionFresh) {
    if (
      latestPlanTask?.status === "completed" &&
      latestPlanResult?.outcome.kind === "plan" &&
      latestPlanResult.outcome.verdict === "needs_human"
    ) {
      return { reason: "needs_human", since: latestPlanResult.createdAtMs };
    }
    if (
      latestReviewTask?.status === "completed" &&
      latestReviewResult?.outcome.kind === "review" &&
      latestReviewResult.outcome.verdict === "needs_human"
    ) {
      return { reason: "needs_human", since: latestReviewResult.createdAtMs };
    }
  }

  // 2. needs_clarification (only from fresh Decision facts where task is completed)
  if (isDecisionFresh) {
    if (
      latestPlanTask?.status === "completed" &&
      latestPlanResult?.outcome.kind === "plan" &&
      latestPlanResult.outcome.verdict === "needs_clarification"
    ) {
      return { reason: "needs_clarification", since: latestPlanResult.createdAtMs };
    }
  }

  // 3. retry_backoff (only from fresh runtime facts; attempt.startedAtMs does not prove retry start, so since is null)
  if (isRuntimeFresh && runtimeRow?.retry && runtimeRow.retry.retryInMs > 0) {
    return { reason: "retry_backoff", since: null };
  }

  // 4. waiting_for_executor (pending tasks only, from fresh decision)
  if (isDecisionFresh) {
    if (latestPlanTask && latestPlanTask.status === "pending") {
      return { reason: "waiting_for_executor", since: latestPlanTask.createdAtMs };
    }
    if (latestReviewTask && latestReviewTask.status === "pending") {
      return { reason: "waiting_for_executor", since: latestReviewTask.createdAtMs };
    }
    if (phase === "ready") {
      return { reason: "waiting_for_executor", since: latestPlanResult?.createdAtMs ?? null };
    }
  }

  // 5. waiting_for_ci (only from fresh GitHub facts; observedAt does not prove CI start, so since is null)
  const pr = githubFacts?.pullRequest;
  if (isGitHubFresh && pr && pr.state === "open" && !pr.isDraft) {
    if (githubFacts?.ci?.status === "pending" || githubFacts?.ci === null) {
      return { reason: "waiting_for_ci", since: null };
    }
  }

  // 6. waiting_for_review
  if (isGitHubFresh && pr && pr.state === "open" && !pr.isDraft) {
    if (githubFacts?.ci?.status === "success") {
      const reviewProj = deriveReviewProjection(ctx);
      if (reviewProj?.approval === "pending" || (isDecisionFresh && latestReviewTask?.status === "running")) {
        return {
          reason: "waiting_for_review",
          since: latestReviewTask?.createdAtMs ?? null,
        };
      }
    }
  }

  // 7. waiting_for_plan
  if (isDecisionFresh && phase === "planning") {
    if (latestPlanTask && latestPlanTask.status === "running") {
      return { reason: "waiting_for_plan", since: latestPlanTask.createdAtMs };
    }
    if (ctx.decisionFacts?.session?.status === "active") {
      return { reason: "waiting_for_plan", since: ctx.decisionFacts.session.updatedAtMs };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Attention derivation
// ---------------------------------------------------------------------------

/**
 * Pure derivation of attention state, orthogonal to WorkPhase.
 *
 * Precedence:
 * 1. needs_human (explicit human attention required, including clarification)
 * 2. failed (unrecovered execution or task failure)
 * 3. degraded (stale or unavailable source, stale approval, or unhandled check failure)
 * 4. waiting (work item is currently waiting)
 * 5. normal (clean, healthy operation)
 */
export function deriveAttention(context: WorkDerivationContext | ProjectWorkInput | NormalizedWorkContext): AttentionState {
  const ctx = normalizeWorkContext(context);
  const {
    githubFreshness,
    runtimeFreshness,
    decisionFreshness,
    githubFacts,
    runtimeRow,
    latestPlanTask,
    latestPlanResult,
    latestReviewTask,
    latestReviewResult,
  } = ctx;

  const phase = deriveWorkPhase(ctx);
  const waiting = deriveWaitingReason(ctx);
  const reviewProj = deriveReviewProjection(ctx);
  const reviewApproval = reviewProj?.approval ?? "not_approved";

  const isDecisionFresh = decisionFreshness.status === "fresh";
  const isRuntimeFresh = runtimeFreshness.status === "fresh";
  const isGitHubFresh = githubFreshness.status === "fresh";

  // 1. needs_human (only from fresh Decision facts where task is completed)
  if (isDecisionFresh) {
    if (
      latestPlanTask?.status === "completed" &&
      latestPlanResult?.outcome.kind === "plan" &&
      (latestPlanResult.outcome.verdict === "needs_human" || latestPlanResult.outcome.verdict === "needs_clarification")
    ) {
      return "needs_human";
    }
    if (
      latestReviewTask?.status === "completed" &&
      latestReviewResult?.outcome.kind === "review" &&
      latestReviewResult.outcome.verdict === "needs_human"
    ) {
      return "needs_human";
    }
  }

  // 2. failed (terminal, unrecovered, only from fresh facts)
  if (
    isRuntimeFresh &&
    runtimeRow?.attempt?.status !== undefined &&
    (runtimeRow.attempt.status === "failed" ||
      runtimeRow.attempt.status === "timed_out" ||
      runtimeRow.attempt.status === "stalled" ||
      runtimeRow.attempt.status === "canceled_by_reconciliation") &&
    runtimeRow.retry === null
  ) {
    return "failed";
  }
  if (isDecisionFresh) {
    if (latestPlanTask?.status === "failed" && latestPlanResult === null) {
      return "failed";
    }
    if (latestReviewTask?.status === "failed" && latestReviewResult === null) {
      return "failed";
    }
  }

  // 3. degraded (source health or observational inconsistencies)
  const sourceDegraded =
    githubFreshness.status === "stale" ||
    githubFreshness.status === "unavailable" ||
    runtimeFreshness.status === "stale" ||
    runtimeFreshness.status === "unavailable" ||
    decisionFreshness.status === "stale" ||
    decisionFreshness.status === "unavailable";

  if (sourceDegraded) {
    return "degraded";
  }

  if (reviewApproval === "approved_stale_head") {
    return "degraded";
  }

  if (isGitHubFresh && githubFacts?.ci?.status === "failure" && phase !== "repair") {
    return "degraded";
  }

  if (reviewApproval === "changes_requested" && phase !== "repair") {
    return "degraded";
  }

  // 4. waiting
  if (waiting !== null && phase !== "completed") {
    return "waiting";
  }

  // 5. normal
  return "normal";
}

// ---------------------------------------------------------------------------
// Single Work Projection
// ---------------------------------------------------------------------------

function buildEvidence(ctx: NormalizedWorkContext): readonly ProjectionEvidence[] {
  const evidence: ProjectionEvidence[] = [];
  const { githubFacts, runtimeRow, decisionFacts, latestPlanTask, latestPlanResult, latestReviewTask, latestReviewResult } = ctx;

  if (githubFacts) {
    evidence.push({
      source: "github",
      code: `issue_${githubFacts.issue.state}`,
      detail: githubFacts.issue.url,
      observedAt: githubFacts.provenance.observedAt,
    });
    if (githubFacts.pullRequest) {
      evidence.push({
        source: "github",
        code: `pr_${githubFacts.pullRequest.state}`,
        detail: `PR #${githubFacts.pullRequest.number}`,
        observedAt: githubFacts.provenance.observedAt,
      });
    }
    if (githubFacts.ci) {
      evidence.push({
        source: "github",
        code: `ci_${githubFacts.ci.status}`,
        detail: githubFacts.ci.headSha ? `HEAD ${githubFacts.ci.headSha.slice(0, 7)}` : null,
        observedAt: githubFacts.provenance.observedAt,
      });
    }
  }

  if (runtimeRow) {
    if (runtimeRow.attempt) {
      evidence.push({
        source: "runtime",
        code: `attempt_${runtimeRow.attempt.status}`,
        detail: `attempt ${runtimeRow.attempt.attempt ?? 1}`,
        observedAt: runtimeRow.attempt.startedAtMs,
      });
    }
    if (runtimeRow.retry) {
      evidence.push({
        source: "runtime",
        code: "retry_scheduled",
        detail: `retryInMs: ${runtimeRow.retry.retryInMs}`,
        observedAt: runtimeRow.provenance.observedAt,
      });
    }
  }

  if (decisionFacts) {
    if (decisionFacts.session) {
      evidence.push({
        source: "decision",
        code: `session_${decisionFacts.session.status}`,
        detail: decisionFacts.session.adapter,
        observedAt: decisionFacts.session.updatedAtMs,
      });
    }
    if (latestPlanTask) {
      evidence.push({
        source: "decision",
        code: `plan_task_${latestPlanTask.status}`,
        detail: `rev ${latestPlanTask.revision}`,
        observedAt: latestPlanTask.updatedAtMs,
      });
    }
    if (latestPlanResult && latestPlanResult.outcome.kind === "plan") {
      evidence.push({
        source: "decision",
        code: `plan_verdict_${latestPlanResult.outcome.verdict}`,
        detail: `rev ${latestPlanResult.revision}`,
        observedAt: latestPlanResult.createdAtMs,
      });
    }
    if (latestReviewTask) {
      evidence.push({
        source: "decision",
        code: `review_task_${latestReviewTask.status}`,
        detail: `rev ${latestReviewTask.revision}`,
        observedAt: latestReviewTask.updatedAtMs,
      });
    }
    if (latestReviewResult && latestReviewResult.outcome.kind === "review") {
      evidence.push({
        source: "decision",
        code: `review_verdict_${latestReviewResult.outcome.verdict}`,
        detail: `rev ${latestReviewResult.revision}`,
        observedAt: latestReviewResult.createdAtMs,
      });
    }
  }

  return evidence;
}

/**
 * Projects a single work item from normalized operational facts.
 */
export function projectWork(input: ProjectWorkInput | WorkDerivationContext | NormalizedWorkContext): WorkProjection {
  const ctx = normalizeWorkContext(input);
  const {
    workKey,
    githubFreshness,
    githubFacts,
    runtimeFreshness,
    runtimeRow,
    decisionFreshness,
    decisionFacts,
    latestPlanTask,
    latestPlanResult,
  } = ctx;

  const phase = deriveWorkPhase(ctx);
  const waiting = deriveWaitingReason(ctx);
  const attention = deriveAttention(ctx);
  const review = deriveReviewProjection(ctx);

  const workItem: WorkProjectionWorkItem = {
    identifier: workKey.key,
    title: null,
    url: githubFacts?.issue.url ?? null,
  };

  const planning: PlanningProjection | null = decisionFacts
    ? {
        sessionStatus: decisionFacts.session?.status ?? null,
        taskStatus: latestPlanTask?.status ?? null,
        planVerdict:
          latestPlanResult?.outcome.kind === "plan" ? latestPlanResult.outcome.verdict : null,
      }
    : null;

  const execution: ExecutionProjection | null = runtimeRow
    ? {
        issueId: runtimeRow.issueId,
        attempt: runtimeRow.attempt?.attempt ?? runtimeRow.retry?.attempt ?? null,
        status: runtimeRow.attempt?.status ?? null,
        workspacePath: runtimeRow.attempt?.workspacePath ?? null,
        startedAtMs: runtimeRow.attempt?.startedAtMs ?? null,
        retryInMs: runtimeRow.retry?.retryInMs ?? null,
      }
    : null;

  const pullRequest: PullRequestProjection | null = githubFacts?.pullRequest
    ? {
        number: githubFacts.pullRequest.number,
        url: githubFacts.pullRequest.url,
        state: githubFacts.pullRequest.state,
        isDraft: githubFacts.pullRequest.isDraft,
        headSha: githubFacts.pullRequest.headSha,
        mergeable: null,
      }
    : null;

  const ci = githubFacts?.ci
    ? {
        status: githubFacts.ci.status,
      }
    : null;

  const freshness: WorkFreshness = {
    github: githubFreshness,
    runtime: runtimeFreshness,
    decision: decisionFreshness,
  };

  const evidence = buildEvidence(ctx);

  return {
    key: workKey,
    workItem,
    phase,
    attention,
    waiting,
    planning,
    execution,
    pullRequest,
    ci,
    review,
    freshness,
    evidence,
  };
}

/** Alias for projectWork to align with SPEC derivation naming. */
export const deriveWorkProjection = projectWork;

// ---------------------------------------------------------------------------
// Executor Projection
// ---------------------------------------------------------------------------

/**
 * Projects a single executor inventory fact into an ExecutorProjection.
 */
export function projectExecutor(fact: ExecutorFacts): ExecutorProjection {
  return {
    id: fact.id,
    role: fact.role,
    adapter: fact.adapter,
    host: fact.host,
    status: fact.status,
    lastHeartbeatAt: fact.lastHeartbeatAtMs,
    currentWork: fact.currentWorkKey ? { ...fact.currentWorkKey } : null,
  };
}

/** Alias for projectExecutor. */
export const deriveExecutorProjection = projectExecutor;

// ---------------------------------------------------------------------------
// System Health & Snapshot Projections
// ---------------------------------------------------------------------------

/**
 * Computes snapshot summary metrics across work items.
 *
 * Metrics are orthogonal cross-counts:
 * - active: known non-completed, non-unknown phases.
 * - waiting: has non-null waiting condition.
 * - retrying: currently backing off for retry.
 * - needsHuman: needs human attention or human clarification.
 */
export function deriveSnapshotSummary(work: readonly WorkProjection[]): OperationalSnapshotSummary {
  let active = 0;
  let waiting = 0;
  let retrying = 0;
  let needsHuman = 0;

  for (const item of work) {
    if (item.phase !== "completed" && item.phase !== "unknown") {
      active++;
    }
    if (item.waiting !== null) {
      waiting++;
    }
    if (item.waiting?.reason === "retry_backoff") {
      retrying++;
    }
    if (
      item.attention === "needs_human" ||
      item.waiting?.reason === "needs_human" ||
      item.waiting?.reason === "needs_clarification"
    ) {
      needsHuman++;
    }
  }

  return { active, waiting, retrying, needsHuman };
}

/**
 * Derives system-level health from source statuses and work projections.
 *
 * Rules:
 * - Empty sources: healthy if work is empty, else unknown.
 * - All sources unknown: unknown.
 * - Unavailable sources without any fresh source: unavailable.
 * - Any source unavailable/stale or any work degraded/failed/needs_human: degraded.
 * - Otherwise: healthy.
 */
export function deriveSystemHealth(input: {
  readonly sources: readonly SourceStatus[];
  readonly work: readonly WorkProjection[];
}): SystemHealth {
  const { sources, work } = input;
  if (sources.length === 0) {
    return work.length === 0 ? "healthy" : "unknown";
  }

  const allUnknown = sources.every((s) => s.freshness.status === "unknown");
  if (allUnknown) {
    return "unknown";
  }

  const hasUnavailable = sources.some((s) => s.freshness.status === "unavailable");
  const hasFresh = sources.some((s) => s.freshness.status === "fresh");
  if (hasUnavailable && !hasFresh) {
    return "unavailable";
  }

  const hasStale = sources.some((s) => s.freshness.status === "stale");
  const hasWorkIssue = work.some(
    (w) => w.attention === "degraded" || w.attention === "needs_human" || w.attention === "failed",
  );

  if (hasUnavailable || hasStale || hasWorkIssue) {
    return "degraded";
  }

  return "healthy";
}

export interface ProjectSnapshotInput {
  readonly generatedAt: UtcTimestampMs;
  readonly work: readonly WorkProjection[];
  readonly executors?: readonly (ExecutorProjection | ExecutorFacts)[];
  readonly sources?: readonly SourceStatus[];
  readonly anomalies?: readonly OperationalAnomaly[];
}

/**
 * Builds an OperationalSnapshot from projections or facts.
 *
 * All arrays are deterministically sorted.
 */
export function projectOperationalSnapshot(input: ProjectSnapshotInput): OperationalSnapshot {
  const work = [...input.work].sort((a, b) => formatWorkKey(a.key).localeCompare(formatWorkKey(b.key)));
  const executors = (input.executors ?? [])
    .map((e) => ("lastHeartbeatAtMs" in e ? projectExecutor(e) : e))
    .sort((a, b) => a.id.localeCompare(b.id));
  const sources = [...(input.sources ?? [])].sort((a, b) =>
    `${a.source}:${a.instance}`.localeCompare(`${b.source}:${b.instance}`),
  );
  const anomalies = [...(input.anomalies ?? [])].sort((a, b) => {
    if (a.code !== b.code) return a.code.localeCompare(b.code);
    if (a.detectedAt !== b.detectedAt) return a.detectedAt - b.detectedAt;
    const aKey = a.workKey ? formatWorkKey(a.workKey) : "";
    const bKey = b.workKey ? formatWorkKey(b.workKey) : "";
    if (aKey !== bKey) return aKey.localeCompare(bKey);
    if (a.severity !== b.severity) return a.severity.localeCompare(b.severity);
    return a.message.localeCompare(b.message);
  });

  const summary = deriveSnapshotSummary(work);
  const health = deriveSystemHealth({ sources, work });

  return {
    schemaVersion: OPERATIONAL_SNAPSHOT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    health,
    summary,
    work,
    executors,
    sources,
    anomalies,
  };
}

/** Alias for projectOperationalSnapshot. */
export const deriveOperationalSnapshot = projectOperationalSnapshot;
