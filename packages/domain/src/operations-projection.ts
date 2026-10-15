/**
 * Operational Read Model — read-only projection contracts (NEST-113 / GitHub #109).
 *
 * Everything in this file is a *derived* observation surface: `WorkPhase`,
 * `WaitingReason`, `AttentionState` and `SystemHealth` describe what a consumer should
 * show, not an authoritative workflow state. There is deliberately no setter, no
 * transition function and no command that writes these values back into GitHub, the
 * Decision Plane or the orchestrator runtime. Projection contracts are side-effect free
 * and consumer-independent: no Dashboard, HTTP, React or history-store type appears here.
 */
import type { DecisionSessionStatus, DecisionReviewTarget, DecisionTaskStatus } from "./decision";
import type { PrMergeability } from "./delivery";
import type { RunAttemptStatus } from "./run";
import type { UtcTimestampMs } from "./time";
import type {
  DecisionResultFacts,
  DecisionTaskFacts,
  ExecutorRole,
  ExecutorStatusFacts,
  GitHubCiStatusFacts,
  GitHubPullRequestStateFacts,
  OperationSourceKind,
  SourceFreshness,
  SourceFreshnessStatus,
  SourceStatus,
  WorkKey,
} from "./operations-facts";

// ---------------------------------------------------------------------------
// Derived display concepts
// ---------------------------------------------------------------------------

/**
 * Derived lifecycle phase for display. A projection of facts only — it is NOT a second
 * workflow state machine and MUST NOT feed scheduling, retry or merge decisions.
 */
export type WorkPhase =
  | "planning"
  | "ready"
  | "coding"
  | "ci"
  | "review"
  | "repair"
  | "landing"
  | "completed"
  | "unknown";

export const WORK_PHASES = [
  "planning", "ready", "coding", "ci", "review", "repair", "landing", "completed", "unknown",
] as const satisfies readonly WorkPhase[];

/**
 * Derived reason the work item is currently waiting. Display-only; MUST NOT be written
 * back into a Decision task or orchestrator state.
 */
export type WaitingReason =
  | "waiting_for_plan"
  | "waiting_for_executor"
  | "waiting_for_ci"
  | "waiting_for_review"
  | "retry_backoff"
  | "needs_clarification"
  | "needs_human"
  | "blocked_by_dependency";

export const WAITING_REASONS = [
  "waiting_for_plan", "waiting_for_executor", "waiting_for_ci", "waiting_for_review",
  "retry_backoff", "needs_clarification", "needs_human", "blocked_by_dependency",
] as const satisfies readonly WaitingReason[];

/**
 * Derived attention level, orthogonal to {@link WorkPhase}. An item can be e.g. in
 * `review` phase with `degraded` attention without overloading a single `error` phase.
 */
export type AttentionState = "normal" | "waiting" | "degraded" | "needs_human" | "failed";

export const ATTENTION_STATES = [
  "normal", "waiting", "degraded", "needs_human", "failed",
] as const satisfies readonly AttentionState[];

/** Derived system-level health; `unavailable` and `unknown` are distinct. */
export type SystemHealth = "healthy" | "degraded" | "unavailable" | "unknown";

export const SYSTEM_HEALTH_STATES = ["healthy", "degraded", "unavailable", "unknown"] as const satisfies readonly SystemHealth[];

/**
 * Derived approval condition for a pull request. Only `approved_current_head` reflects
 * an approval of the exact current HEAD; an approval produced against a different SHA
 * is retained as `approved_stale_head` and MUST NOT authorize a merge.
 */
export type ReviewApprovalState =
  | "approved_current_head"
  | "approved_stale_head"
  | "changes_requested"
  | "pending"
  | "not_approved"
  | "unknown";

// ---------------------------------------------------------------------------
// Work projections
// ---------------------------------------------------------------------------

export interface WorkProjectionWorkItem {
  readonly identifier: string;
  readonly title: string | null;
  readonly url: string | null;
}

export interface WorkWaiting {
  readonly reason: WaitingReason;
  /** UTC epoch ms when the wait began; `null` when unknown. */
  readonly since: UtcTimestampMs | null;
}

export interface PlanningProjection {
  readonly sessionStatus: DecisionSessionStatus | null;
  readonly taskStatus: DecisionTaskStatus | null;
  readonly planVerdict: "ready" | "needs_clarification" | "needs_human" | null;
}

export interface ExecutionProjection {
  readonly issueId: string;
  readonly attempt: number | null;
  readonly status: RunAttemptStatus | null;
  readonly workspacePath: string | null;
  readonly startedAtMs: UtcTimestampMs | null;
  /** Remaining retry delay in ms when the item is backing off; `null` otherwise. */
  readonly retryInMs: number | null;
}

export interface PullRequestProjection {
  readonly number: number;
  readonly url: string;
  readonly state: GitHubPullRequestStateFacts;
  readonly isDraft: boolean;
  /** Exact current HEAD SHA; carried through unchanged from the GitHub fact. */
  readonly headSha: string;
  readonly mergeable: PrMergeability | null;
}

export interface CiProjection {
  readonly status: GitHubCiStatusFacts;
}

/**
 * Review projection. `currentHeadSha`, `taskTarget` and `resultTarget` are kept separate
 * so an approval against an older SHA can be shown as history without ever implying the
 * current HEAD is approved.
 */
export interface ReviewProjection {
  /** Exact current PR HEAD, or `null` when there is no PR / no observation. */
  readonly currentHeadSha: string | null;
  /** Target the review task was created against, when one exists. */
  readonly taskTarget: DecisionReviewTarget | null;
  readonly task: DecisionTaskFacts | null;
  readonly result: DecisionResultFacts | null;
  readonly approval: ReviewApprovalState;
}

/** Per-source freshness carried on a single work projection (supports partial reads). */
export interface WorkFreshness {
  readonly github: SourceFreshness;
  readonly runtime: SourceFreshness;
  readonly decision: SourceFreshness;
}

export type ProjectionEvidenceRole =
  | "supporting"
  | "superseding"
  | "discarded_freshness"
  | "historical";

export const PROJECTION_EVIDENCE_ROLES = [
  "supporting",
  "superseding",
  "discarded_freshness",
  "historical",
] as const satisfies readonly ProjectionEvidenceRole[];

/** A single explainability breadcrumb supporting a future `explainProjection(workKey)`. */
export interface ProjectionEvidence {
  readonly source: OperationSourceKind;
  /** Stable machine code, e.g. `pr_open`, `ci_success`, `review_task_running`. */
  readonly code: string;
  readonly detail: string | null;
  readonly observedAt: UtcTimestampMs | null;

  // Structured provenance/explanation fields (NEST-116):
  readonly instance?: string | undefined;
  readonly freshnessStatus?: SourceFreshnessStatus | undefined;
  readonly ruleId?: string | undefined;
  readonly role?: ProjectionEvidenceRole | undefined;
  readonly workKey?: WorkKey | undefined;
  readonly sessionId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly resultId?: string | undefined;
  readonly revision?: number | undefined;
  readonly target?: DecisionReviewTarget | undefined;
  readonly headSha?: string | undefined;
  readonly field?: string | undefined;
  readonly value?: string | number | boolean | null | undefined;
  /** Timestamp of the underlying entity event (e.g. startedAtMs, updatedAtMs, createdAtMs), distinct from source observedAt. */
  readonly entityTimestampMs?: UtcTimestampMs | undefined;
}

/** Consumer-facing read-only projection of one work item. */
export interface WorkProjection {
  readonly key: WorkKey;

  readonly workItem: WorkProjectionWorkItem;

  readonly phase: WorkPhase;
  readonly attention: AttentionState;

  readonly waiting: WorkWaiting | null;

  readonly planning: PlanningProjection | null;
  readonly execution: ExecutionProjection | null;
  readonly pullRequest: PullRequestProjection | null;
  readonly ci: CiProjection | null;
  readonly review: ReviewProjection | null;

  readonly freshness: WorkFreshness;
  readonly evidence: readonly ProjectionEvidence[];
}

// ---------------------------------------------------------------------------
// System-level projection
// ---------------------------------------------------------------------------

export interface ExecutorProjection {
  readonly id: string;
  readonly role: ExecutorRole | null;
  readonly adapter: string;
  /** Observation metadata only; never used as work identity. */
  readonly host: string | null;
  readonly status: ExecutorStatusFacts;
  readonly lastHeartbeatAt: UtcTimestampMs | null;
  readonly currentWork: WorkKey | null;
}

/**
 * Canonical anomaly codes detecting impossible or suspicious combinations across GitHub,
 * runtime, Decision Plane, and executor facts (NEST-116 / GitHub #112).
 */
export type OperationalAnomalyCode =
  | "review_target_head_mismatch"
  | "review_approval_head_mismatch"
  | "review_result_target_mismatch"
  | "execution_on_terminal_work"
  | "decision_active_task_without_session"
  | "decision_active_task_on_completed_session"
  | "decision_result_without_task"
  | "conflicting_active_review_tasks";

export const OPERATIONAL_ANOMALY_CODES = [
  "review_target_head_mismatch",
  "review_approval_head_mismatch",
  "review_result_target_mismatch",
  "execution_on_terminal_work",
  "decision_active_task_without_session",
  "decision_active_task_on_completed_session",
  "decision_result_without_task",
  "conflicting_active_review_tasks",
] as const satisfies readonly OperationalAnomalyCode[];

export type OperationalAnomalySeverity = "warning" | "error";

export interface OperationalAnomalyDefinition {
  readonly code: OperationalAnomalyCode;
  readonly severity: OperationalAnomalySeverity;
  readonly description: string;
}

export const OPERATIONAL_ANOMALY_CATALOG: readonly OperationalAnomalyDefinition[] = [
  {
    code: "review_target_head_mismatch",
    severity: "warning",
    description: "Active review task targets a SHA different from the fresh GitHub PR HEAD",
  },
  {
    code: "review_approval_head_mismatch",
    severity: "error",
    description: "Current effective completed review approval targets an older SHA than the fresh GitHub PR HEAD",
  },
  {
    code: "review_result_target_mismatch",
    severity: "error",
    description: "Review result target does not match its corresponding task target",
  },
  {
    code: "execution_on_terminal_work",
    severity: "warning",
    description: "Active runtime execution attempt observed on closed issue or merged PR",
  },
  {
    code: "decision_active_task_without_session",
    severity: "error",
    description: "Active Decision tasks exist but session observation is null",
  },
  {
    code: "decision_active_task_on_completed_session",
    severity: "error",
    description: "Active Decision tasks exist while session is completed",
  },
  {
    code: "decision_result_without_task",
    severity: "error",
    description: "Decision result exists without a matching task for the same taskId and revision",
  },
  {
    code: "conflicting_active_review_tasks",
    severity: "error",
    description: "Multiple active review tasks exist concurrently for the same work item, repository, and pull request",
  },
] as const satisfies readonly OperationalAnomalyDefinition[];

/** A detected cross-source inconsistency or domain anomaly (NEST-116 / GitHub #112). */
export interface OperationalAnomaly {
  readonly code: OperationalAnomalyCode | string;
  readonly severity: OperationalAnomalySeverity;
  readonly workKey: WorkKey | null;
  readonly message: string;
  readonly detectedAt: UtcTimestampMs;
  readonly evidence?: readonly ProjectionEvidence[] | undefined;
}

export interface OperationalSnapshotSummary {
  readonly active: number;
  readonly waiting: number;
  readonly retrying: number;
  readonly needsHuman: number;
}

export const OPERATIONAL_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * System-level read-only snapshot. An empty-but-valid snapshot (no work) is distinct
 * from one whose sources are all `unknown` / `unavailable`.
 */
export interface OperationalSnapshot {
  readonly schemaVersion: 1;
  readonly generatedAt: UtcTimestampMs;

  readonly health: SystemHealth;

  readonly summary: OperationalSnapshotSummary;

  readonly work: readonly WorkProjection[];
  readonly executors: readonly ExecutorProjection[];
  readonly sources: readonly SourceStatus[];
  readonly anomalies: readonly OperationalAnomaly[];
}

// ---------------------------------------------------------------------------
// Pure helpers (identity / shape only)
// ---------------------------------------------------------------------------

/** Exact PR HEAD SHA semantics reused across review projections. */
export const EXACT_HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** True only for a full lowercase 40-hex SHA. */
export function isExactHeadSha(value: string): boolean {
  return EXACT_HEAD_SHA_PATTERN.test(value);
}

/**
 * Parse and validate an exact review target. Re-exported from the canonical Decision
 * contract so there is a single definition of repository / PR / exact-SHA semantics.
 */
export { parseDecisionReviewTarget as parseReviewTarget } from "./decision";
