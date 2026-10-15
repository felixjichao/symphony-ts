/**
 * @symphony/operations — provider-neutral Operational Read Model contracts
 * (NEST-113 / GitHub #109, first implementation slice of #108).
 *
 * This package is the public boundary for operational observers (CLI status, JSON API,
 * TUI, Dashboard, alerts). It depends on `@symphony/domain` and re-exports the
 * read-only fact/projection contracts defined there. Source readers use injected read-only
 * ports; projectors land later. No HTTP, Dashboard, history store or mutation command is present.
 */
export {
  EXACT_HEAD_SHA_PATTERN,
  ATTENTION_STATES,
  OPERATIONAL_ANOMALY_CATALOG,
  OPERATIONAL_ANOMALY_CODES,
  OPERATIONAL_SNAPSHOT_SCHEMA_VERSION,
  PROJECTION_EVIDENCE_ROLES,
  SYSTEM_HEALTH_STATES,
  WAITING_REASONS,
  WORK_PHASES,
  formatWorkKey,
  githubWorkKey,
  isExactHeadSha,
  parseReviewTarget,
  parseWorkKey,
} from "@symphony/domain";

export type {
  WorkKey,
  OperationSourceKind,
  FactProvenance,
  SourceFreshnessStatus,
  FreshSourceFreshness,
  StaleSourceFreshness,
  UnavailableSourceFreshness,
  UnknownSourceFreshness,
  SourceFreshness,
  SourceStatus,
  GitHubIssueStateFacts,
  GitHubPullRequestStateFacts,
  GitHubCiStatusFacts,
  GitHubIssueFacts,
  GitHubPullRequestFacts,
  GitHubCiFacts,
  GitHubWorkFacts,
  RuntimeAttemptFacts,
  RuntimeRetryFacts,
  RuntimeWorkFacts,
  DecisionSessionFacts,
  DecisionPlanTaskFacts,
  DecisionReviewTaskFacts,
  DecisionTaskFacts,
  DecisionPlanVerdictFacts,
  DecisionReviewVerdictFacts,
  DecisionVerdictFacts,
  DecisionResultFacts,
  DecisionWorkFacts,
  ExecutorStatusFacts,
  ExecutorRole,
  ExecutorFacts,
  WorkPhase,
  WaitingReason,
  AttentionState,
  SystemHealth,
  ReviewApprovalState,
  WorkProjectionWorkItem,
  WorkWaiting,
  PlanningProjection,
  ExecutionProjection,
  PullRequestProjection,
  CiProjection,
  ReviewProjection,
  WorkFreshness,
  ProjectionEvidence,
  ProjectionEvidenceRole,
  WorkProjection,
  ExecutorProjection,
  OperationalAnomaly,
  OperationalAnomalyCode,
  OperationalAnomalySeverity,
  OperationalAnomalyDefinition,
  OperationalSnapshotSummary,
  OperationalSnapshot,
} from "@symphony/domain";

export * from "./readers";
export * from "./projectors";
export * from "./anomalies";
export type { OperationSourceResult, OperationFactCollection, DecisionObservation, GitHubObservation } from "@symphony/domain";

