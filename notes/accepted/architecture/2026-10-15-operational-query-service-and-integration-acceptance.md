# Agent Note: Operational query service and integration acceptance

Status: accepted

## Problem

Following the normalization of operational facts (NEST-113, NEST-114), deterministic projection rules (NEST-115), and cross-source anomaly detection (NEST-116), consumers such as future CLI commands, JSON APIs, Web Dashboards, and alerting workers require a single, stable in-process query entry point. Without this service, consumers would be forced to independently coordinate reads across four heterogeneous sources (GitHub, orchestrator runtime, Decision Plane, executor inventory), re-implement work identity and scoping rules, and manage multi-source failure degradation.

The query service must satisfy strict architectural boundaries: it resides in the Observation Plane, remains strictly read-only, does not act as a workflow coordinator or scheduler, does not introduce background polling or caching timers, and ensures that partial source failures gracefully degrade output without crashing queries or misrepresenting work state.

## Decision

Implement `OperationalQueryService` and `createOperationalQueryService` in `@symphony/operations` as the canonical in-process query boundary closing parent epic GitHub #108:

- **Public Query Surface**:
  - `getOperationalSnapshot()`: Returns the full system-level `OperationalSnapshot` including health, summary, work item projections, executor projections, source freshness envelopes, and cross-source anomalies.
  - `listWork()`: Returns canonical work item projections in scope, sorted deterministically by `WorkKey`.
  - `getWork(workKey)`: Retrieves the projection for a specific canonical work item in scope. Valid keys outside scope return `null`; invalid keys throw `TypeError`. Failures in underlying sources degrade the projection rather than returning `null`.
  - `listExecutors()`: Exposes executor operational state and active `currentWorkKey` without coupling work identity to hosts, machines, or process handles.
- **Single-Round Bounded Assembly**:
  - Each query executes a single, bounded round of concurrent reads: global sources (runtime, executor inventory) are read exactly once per query round and shared across all work projections; work-scoped sources (GitHub, Decision Plane) are read concurrently per configured `WorkKey`.
  - No background polling, persistent caching, retry coordinators, or background timeout lifecycles are introduced.
- **Explicit Work Scope Boundaries**:
  - Work identity is strictly anchored to canonical `WorkKey` references injected by the host (either static array or dynamic provider function).
  - Runtime records that match an in-scope `WorkKey` enrich that work item's execution facts; runtime records outside scope or unlinked do not fabricate new work items.
- **Partial Failure and Multi-Work Isolation**:
  - Source read errors or unconfigured ports safely yield `unavailable` or `unknown` freshness envelopes without throwing or rejecting the query.
  - Failures are isolated per work item: an unavailable GitHub reader for Work B degrades Work B to `attention: "degraded"` while Work A remains healthy and unaffected.
  - System health faithfully reflects partial failure (`degraded` when any source/work is degraded, `unavailable` when all sources are unavailable).
- **Domain Contract Compatibility**:
  - Extend `SourceStatus` in `@symphony/domain` with optional `workKey?: WorkKey | null` so system snapshots retain per-work source provenance when multiple work items share a source instance name.
  - Tie-break source status sorting in `projectOperationalSnapshot` by `workKey` and `freshness.status` to ensure strict deterministic ordering regardless of asynchronous read completion.
- **Strict Identity Verification & Cross-Work Isolation**:
  - When per-work readers return source envelopes or facts, both the query service and underlying projectors strictly verify that `facts.workKey` and `envelope.workKey` match the requested `WorkKey`.
  - Mismatched reader facts (such as when a fallback single-item reader is reused across a multi-work scope) are strictly isolated and degraded to `unavailable` with reason `work_key_mismatch` rather than relabeling or leaking into other work items.
- **Consumer Mutation Isolation**:
  - Query return values (`OperationalSnapshot`, `WorkProjection`, `ExecutorProjection`) and internal source reader inputs are deeply cloned at the query boundaries using `deepClone` (`structuredClone`).
  - Consumers mutating nested properties on returned projections (e.g., `work.freshness.github`, `review.taskTarget`, `evidence`, `executors`) cannot corrupt reader state or bleed into subsequent query rounds.

## Alternatives considered

- *Introduce background cache and TTL polling inside the query service*: Rejected. Background polling introduces asynchronous timers, concurrency races, cache invalidation complexity, and hidden memory lifecycles into the observation plane. Source ports already manage underlying subprocess or HTTP caching budgets; the query service executes bounded on-demand assembly.
- *Infer work scope by scanning runtime or tracker issues globally*: Rejected. Global scanning bypasses host intent, risks unbounded API usage, and compromises multi-tenant or workspace isolation. Anchoring work scope to explicit canonical `WorkKeys` guarantees predictability.
- *Fail the entire query if any source reader fails*: Rejected. Operational observers must provide high availability. If Decision Plane or GitHub has a transient outage, the observer should display degraded facts from available sources rather than an empty screen or error crash.
- *Bundle HTTP/WebSocket transport and Web Dashboard into this slice*: Rejected. As specified in #108 and #113, transport layers and UI dashboards belong to separate downstream deliverables. Keeping the core query service in-process preserves strict dependency layering (`operations -> domain`).

## Consequences

Consumers across CLI, JSON API, Dashboard, and alerts now have a single, stable, deterministic in-process query API. All 10 acceptance criteria for #113 and the overarching requirements for epic #108 are satisfied and verified by end-to-end integration tests. The Observation Plane remains pure, read-only, and cleanly decoupled from the Control Plane.
