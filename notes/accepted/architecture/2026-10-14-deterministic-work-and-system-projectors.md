# Agent Note: Deterministic work and system projectors

Status: accepted

## Problem

Following the operational contracts established in NEST-113 (#109) and normalized source readers in NEST-114 (#110), consumers (CLI status, JSON API, TUI, alerts) require a pure, deterministic projection layer that transforms provider-neutral facts into consumer-facing work and system projections (`WorkProjection`, `OperationalSnapshot`). This layer must derive `WorkPhase`, `WaitingReason`, `AttentionState`, and `SystemHealth` without mutating source facts, without persisting state back into source systems, and without allowing historical or stale data to disguise as authoritative live progress.

## Decision

Implement pure, deterministic projector functions in `@symphony/operations` (`deriveWorkPhase`, `deriveWaitingReason`, `deriveAttention`, `deriveReviewProjection`, `projectWork`, `projectExecutor`, `deriveSystemHealth`, `deriveSnapshotSummary`, `projectOperationalSnapshot`). All projection logic is side-effect-free, accepts immutable facts and explicit timestamps, and performs no I/O, timers, or background scheduling.

- **Phase precedence**: Fresh GitHub terminal facts take precedence to derive `completed`; active runtime execution is classified as `repair` (if preceded by CI failure or `changes_requested`) or `coding`; `landing` strictly requires fresh open non-draft PR, exact HEAD CI success, and `approved_current_head`; stale or unavailable GitHub facts degrade safely to `unknown`.
- **Review approval safety**: Retains `currentHeadSha`, task review target, and result review target; approvals against older SHAs yield `approved_stale_head` and strictly refuse to authorize landing.
- **Orthogonality**: `WorkPhase` and `AttentionState` are strictly orthogonal. Completed items clear active waiting conditions, but source health anomalies continue to surface as `degraded` attention.
- **Snapshot summary & system health**: Summary counters (`active`, `waiting`, `retrying`, `needsHuman`) are orthogonal cross-counts. System health differentiates `healthy`, `degraded`, `unavailable`, and `unknown` without false certainty.
- **Array order stability**: Tasks, results, work items, executors, and sources are sorted deterministically before evaluation, ensuring array shuffle invariance.

## Alternatives considered

- Persist derived `WorkPhase` or `WaitingReason` back into Decision Plane store records or orchestrator state: rejected because consumer display projections are derived-only observation views; persisting them would create duplicate truth sources, state drift, and illegal back-propagation.
- Allow stale Decision approvals to authorize landing when commit SHA matches: rejected because stale sources cannot prove current PR state or fresh reviewer endorsement; landing requires active, fresh verification from all relevant sources.
- Derive `blocked_by_dependency` from open issues or missing plans: rejected because current normalized facts contain no dependency graph facts; inventing dependencies without observation violates the read-only contract.

## Consequences

Consumers obtain unified, deterministic projections and explainability breadcrumbs across GitHub, orchestrator runtime, Decision Plane, and executor inventory. Input array ordering is neutralized via deterministic sorting. The boundary guard (`boundaries.test.ts`) verifies zero I/O, domain-only imports, and absence of mutation APIs (`setWorkPhase`, `setWaitingReason`, etc.). Source packages continue to be prohibited from reverse-importing `@symphony/operations`. Full cross-source anomaly detection is deferred to NEST-116.
