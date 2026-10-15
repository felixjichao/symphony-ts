# Agent Note: Cross-source anomaly detection and projection explanations

Status: accepted

## Problem

Building upon normalized facts (NEST-113, NEST-114) and deterministic projectors (NEST-115), consumers require unified cross-source anomaly detection to identify semantic inconsistencies and split-brain states across GitHub, orchestrator runtime, Decision Plane, and executor observations. These domain anomalies (e.g., review approval targeting a stale or foreign HEAD, active execution running on a closed/merged PR, active tasks detached from sessions or on completed sessions, multiple conflicting active review tasks) must be detected deterministically without mutating underlying source facts. Furthermore, anomalies and projections require structured, inspectable evidence breadcrumbs that downstream explanation tools (`explainProjection(workKey)`) can consume without ambiguous string parsing.

## Decision

Implement pure, deterministic anomaly detection and structured evidence breadcrumbs in `@symphony/domain` and `@symphony/operations` (`detectWorkAnomalies`, `detectCollectionAnomalies`, `hasWorkAnomalies`, `sortAndDeduplicateAnomalies`):

- **8 Canonical Domain Anomalies**:
  1. `review_target_head_mismatch` (`warning`): Review task target SHA differs from observed GitHub PR HEAD SHA.
  2. `review_approval_head_mismatch` (`error`): Decision review approved a commit SHA that differs from the observed GitHub PR HEAD SHA.
  3. `review_result_target_mismatch` (`error`): Decision review result commit SHA differs from its own task review target SHA.
  4. `execution_on_terminal_work` (`warning`): Orchestrator runtime attempt is actively running or claimed while GitHub work is already terminal (`issue.state === 'closed'` or `pullRequest.state === 'merged'`).
  5. `decision_active_task_without_session` (`error`): Active Decision task references a session ID that is absent from observed Decision facts.
  6. `decision_active_task_on_completed_session` (`error`): Active Decision task belongs to a Decision session marked as `completed`.
  7. `decision_result_without_task` (`error`): Decision result references a task ID that is absent from observed Decision tasks.
  8. `conflicting_active_review_tasks` (`error`): Multiple distinct active review tasks exist concurrently for the same work item.
- **Severity Classification**:
  - Inconsistencies that threaten merge safety, session protocol integrity, or cause split-brain decision state are classified as `error`.
  - Inconsistencies caused by transient in-flight updates or lagging source reads (such as runtime attempting cleanup after PR merge, or review task target lagging PR push before result evaluation) are classified as `warning`.
- **Stale/Unavailable Input Safety Guards**:
  - Missing or failed reads (`unavailable`, `unknown`, or absent facts) must not trigger false-positive domain anomalies.
  - When facts are stale or sources are not fresh, domain anomalies requiring current active consistency are not raised; stale facts are safely preserved as historical evidence.
- **Source WorkKey Scoping in Multi-Work Collections**:
  - In `detectCollectionAnomalies`, collection-level facts (`githubFacts`, `decisionFacts`) are filtered by work item identity (`workKey`) to prevent cross-issue leakage or false positives across distinct work items.
- **Structured Projection Evidence Breadcrumbs**:
  - `ProjectionEvidence` in `@symphony/domain` is extended with structured fields: `role` (`supporting`, `historical`, `discarded_freshness`), `workKey`, `taskId`, `revision`, `target`, `headSha`, `field`, `value`, and `entityTimestampMs` (distinguishing entity event timestamps from source observation freshness).
  - Projectors and anomaly detectors populate structured breadcrumbs so explanations can trace root causes back to source instances and fields without guessing.
- **Attention and System Health Wiring**:
  - `deriveAttention` incorporates detected anomalies: any work item with active anomalies degrades to `degraded` attention unless already in higher priority states (`needs_human` or `failed`).
  - `deriveSystemHealth` incorporates anomalies: system health cannot be `healthy` if domain anomalies are present, falling back to `degraded` (while preserving `unavailable` if all sources fail).
- **Array Order & Evidence Shuffle Invariance**:
  - All anomalies are sorted by code, target/workKey, and message.
  - To guarantee complete shuffle invariance regardless of input fact order, `evidence` arrays inside each anomaly are also deterministically sorted by source, role, field, and value.

## Alternatives considered

- Auto-repair anomalies on detection (e.g. automatically cancel orphan tasks or terminate runtime attempts): rejected because `@symphony/operations` is an observation-only projection surface; taking remediation actions from read paths creates feedback loops, bypasses proper authority control, and violates read-only architecture invariants.
- Embed textual human explanations inside anomaly definitions: rejected in favor of structured `ProjectionEvidence` breadcrumbs with well-defined codes and catalog definitions; downstream consumers and explainers format messages according to their own presentation needs (CLI, TUI, HTTP, localization).
- Derive anomalies across un-correlated work items: rejected; anomaly rules are strictly scoped to matching `workKey` identities to prevent accidental cross-tenant or cross-issue contamination.

## Consequences

Consumers have a deterministic, complete anomaly detection suite across all four operational sources with machine-inspectable breadcrumbs. Projection explanations can trace why attention is degraded or why review approval does not allow landing. Purity and boundary tests verify zero I/O, domain-only imports, and absence of mutation APIs. In-process query service and CLI commands are deferred to subsequent issues (NEST-117).
