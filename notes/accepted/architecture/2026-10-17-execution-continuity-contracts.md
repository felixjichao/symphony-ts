# Agent Note: Execution Continuity, Ownership, and Failure Contracts

Status: accepted

## Problem

Parent epic GitHub #145 / NEST-129 aims to provide cross-stage execution continuity and crash recovery across the entire Symphony lifecycle (planning, coding, CI, review, repair, delivery, and merge). Prior to this change, each subsystem developed isolated, component-specific recovery and retry mechanisms:
- Orchestrator maintains in-process running, retry queues, attempt tokens, and stall detection for agent executions (§7, §8, §14);
- Decision Plane maintains task leases, claim generations, and binding generation rollovers for browser agent sessions (NEST-99, NEST-100, NEST-121);
- ChatGPT Web driver maintains tab checkpoints, navigation deadlines, and result receipt recovery (NEST-102, NEST-120);
- Delivery maintains persistent paused state, handoff compensation markers, and repair budgets (NEST-91, NEST-128);
- Operational Read Model observes facts, anomalies, and freshness across sources without mutation authority (NEST-113–NEST-117).

Without a common, provider-neutral vocabulary and formal invariants (GitHub #146 / NEST-130), adding automated reconciliation loops would risk creating a second conflicting workflow engine, breaking single-source-of-truth boundaries, or conflating distinct failure modes into generic blind retries.

## Decision

Define provider-neutral contracts, invariants, and failure taxonomies in `@symphony/domain` (`packages/domain/src/execution-continuity.ts`) as a §4-adjacent extension. This defines the common language for cross-stage continuity without modifying existing authoritative state stores or introducing a secondary workflow state machine.

### Core Contracts and Semantics

1. **Continuity Scope**:
   Distinguishes four distinct scopes: `work` (entire Issue-rooted lifecycle), `task` (discrete decision task revision), `attempt` (single agent execution run), and `binding` (executor tab / session binding). A task, attempt, or binding completing never falsely marks the overall `work` as completed.

2. **Continuity States**:
   `running`, `retry_queued`, `recovering`, `blocked`, `completed`, and `released`.
   - `blocked` is a first-class **non-terminal** state requiring explicit blocked reason, waiting authority, and unblock condition. Clearing the block leads to re-observation and re-decision.
   - `retry_queued` requires scheduled re-observation; retry is explicitly defined as **re-observe + re-decide**, never blind replay.
   - `recovering` indicates active recovery execution (such as handoff compensation or re-establishing binding), not merely the discovery of a failure.
   - `completed` requires authoritative completion facts from the applicable scope authority.
   - `released` indicates relinquished execution responsibility; it does not close the GitHub work or mark it failed.

3. **Recovery Actions**:
   `none`, `dispatch`, `resume`, `retry`, `rebind`, `reclaim`, `compensate`, `await_external`, `require_human`.

4. **Action Authority**:
   Every active work item must have an expected next action, and every expected action must identify its authority:
   - `internal`: Subsystem coordination authority (e.g. `orchestrator`, `decision`, `delivery`) separated from actual executor provider (e.g. `chatgpt-web`, `codex-agent`).
   - `external`: Explicit external system (e.g. `github`, `ci`) and waiting condition.
   - `human`: Explicit human role (e.g. `reviewer`, `operator`) and instruction.

5. **Multi-dimensional Ownership Fencing**:
   `OwnershipFence` retains multi-dimensional native evidence: retry token, lifecycle generation, reconciliation epoch, Decision lease generation, binding generation, and expected HEAD SHA. These dimensions are not collapsed into a single scalar.
   - Fencing is **fail-closed on both sides**: candidate credentials must be complete and exact-match the authoritative state across all applicable dimensions. Any missing credential (dual-sided missing, authoritative missing, or candidate missing), invalid numeric format (NaN, negative, float, non-finite), superseded generation (smaller than current), or ahead/conflicting generation (greater than current) fails validation.
   - Numeric generation and epoch dimensions (`lifecycleGeneration`, `reconciliationEpoch`, `leaseGeneration`, `bindingGeneration`) are validated as non-negative safe integers (`Number.isSafeInteger(val) && val >= 0`) before exact-match equality checking.
   - Stale continuations may observe but cannot mutate current work.
   - `sanitizeOwnershipFence` strips secret capability tokens (`leaseToken`) before public observation.
   - **Boundary statement**: The `validateOwnershipFence` pure helper provides domain contract checking and classification; it **does NOT replace** source-authority atomic commit-time verification (such as CAS, atomic DB updates, or Git push lease checks at commit/push time).

6. **Liveness and Forward Progress**:
   Tracks `startedAt`, `lastProgressAt` (UTC ms or explicitly `"unknown"`), and `lastObservedAt`. Heartbeats, polling successes, or process existence do not count as forward progress. Missing progress is honestly recorded as `"unknown"`. Continuous observation (e.g. merge confirmation polling) updates `lastObservedAt` but does not advance `lastProgressAt` without concrete new progress evidence.

7. **Failure Taxonomy and Subsystem Mapping**:
   Five orthogonal failure categories:
   - `transient`: Network timeouts, bridge connection drops, temporary tracker rate limits.
   - `recoverable`: Binding broken, navigation lost, process stalled, incomplete delivery handoffs.
   - `blocked_external`: Auth required, CI checks waiting (`ci_checks_pending`), human review/approval required, exhausted repair budgets.
   - `superseded`: Stale generation, stale task revision, stale HEAD SHA, cancelled continuation.
   - `invariant_violation`: Conflicting owners, impossible transitions, conflicting delivery markers.

   Subsystem error mappers (`mapDecisionAdapterFailure`, `mapDeliveryFailure`, `mapDeliveryHandoffReason`, `mapWebDriverFailure`, `mapOrchestratorFailure`) map structured errors into this taxonomy:
   - Adapters strictly distinguish between model output extraction mismatches (e.g. LLM generated wrong revision or HEAD in output JSON while current claimed task remains active) and authoritative facts proving task/HEAD has been superseded. Output mismatches without authoritative proof return explicit `mapped: false` unmapped results to prevent silently dropping active tasks.
   - Delivery `checks_waiting` maps to `blocked_external` with specific reason `ci_checks_pending` and action `await_external`.
   - Where diagnostic context is insufficient (e.g. bare `execution_failed` or `malformed_output`), mappers return an explicit `mapped: false` result with documented gaps rather than guessing `transient`.

### Existing Mechanism Mapping Table

| Subsystem / Mechanism | Existing Facts & Behavior | Mapping into Execution Continuity Model | Gaps / Documented Limits |
|---|---|---|---|
| **Orchestrator** (`authority.ts`, `reconciliation.ts`) | Running entries, retry queue, stall timeout, attempt tokens, lifecycle generation, reconciliation epoch (§7, §8, §14) | Worker running → `running`; retry queued → `retry_queued` with action `retry`; stall detected → `recoverable` / `process_stalled`; stale epoch/generation → `superseded` | In-process timer and retry monotonically measured; must not be persisted as cross-restart UTC deadline |
| **Decision Plane** (`decision.ts`, `service.ts`) | Task status (`pending`, `claimed`, `running`, `completed`, `failed`), lease token, claim generation, binding generation | Task claimed/running → `running`; lease expired but reclaimable → `recoverable` / `stale_claim` / `reclaim`; binding broken → `recoverable` / `stale_binding` / `rebind` | Task completion records task scope completion only; does not declare work scope completed |
| **ChatGPT Web** (`checkpoint.ts`, `driver.ts`) | Driver checkpoint, navigation timeout, result receipt acknowledgement, rollover generation | In-flight execution → `running`; navigation lost → `recoverable` / `navigation_lost` / `rebind`; older checkpoint → `superseded` / `stale_generation` | Checkpoints are recovery hints only; do not confer execution authority |
| **Delivery Skill** (`delivery.ts`, `recover-handoff.ts`) | Persisted paused state, repair budget, handoff report, pending compensation | CI waiting (`checks_waiting`) → `blocked` / `ci_checks_pending` / `await_external`; budget exhausted → `blocked` / `require_human`; pending compensation → `recovering` / `compensate` | Handoff compensation does not close Issue; operator retains recovery control |
| **Operations** (`operations-facts.ts`, `projectors.ts`) | Read-only facts, `WorkPhase`, `WaitingReason`, `AttentionState` | Displays continuity facts and expected next actions; read-only consumer | Operations is strictly read-only; never acts as a second state machine or scheduler |

## Alternatives considered

- **Introduce a centralized workflow engine or durable state store for all components**:
  Rejected. Symphony is designed with decentralized domain authorities (GitHub for issues/PRs, Orchestrator for in-process dispatch, Decision Store for planning/review tasks, Delivery for git/PR lifecycle). Creating a monolithic state machine would violate single-source-of-truth boundaries and require high-risk rewrites of working code.
- **Merge failure categories into binary retryable vs non-retryable**:
  Rejected. A binary flag conflates `blocked_external` (waiting on human or CI) with terminal failure, and confuses `superseded` (stale caller rejected while current work continues) with failures of the current work.
- **Flatten multi-dimensional fencing into a single monotonic version number**:
  Rejected. Orchestrator lifecycle generations, reconciliation epochs, Decision claim generations, and git HEAD SHAs operate on different cadences and across different subsystems. Collapsing them creates false invalidations or misses stale writes across boundaries.
- **Allow generic fallback to transient retry for ambiguous errors**:
  Rejected. Ambiguous errors like `execution_failed` or `malformed_output` could stem from permanent model prompt issues or invariant violations; blindly retrying them creates infinite resource-draining loops. Returning explicit unmapped results forces caller awareness.

## Consequences

- Orchestrator, Decision, Web Driver, Delivery, and future recovery components now share typed, provider-neutral definitions for continuity states, expected actions, ownership fences, and failure classifications.
- Follow-up issues (#147–#151) can implement cross-stage expected action derivation, startup reconciliation, and automated recovery loops against these validated contracts.
- Zero runtime overhead or breaking changes for existing execution paths: contracts are pure domain types and functions with no I/O, timers, or external dependencies.
