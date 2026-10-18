# Agent Note: Work-Level Liveness and Stranded-State Reconciliation

Status: accepted

## Problem

Individual Symphony subsystems can each be locally consistent while the overall work item is stranded. A Decision task exists, the browser executor disappeared, Delivery is waiting, the orchestrator has no running worker, and GitHub work is still active. No subsystem treats this as *its own* fatal inconsistency, so the work can stay active indefinitely.

NEST-130 / GitHub #146 established the shared continuity vocabulary (`ExecutionContinuityDescriptor`, `OwnershipFence`, liveness metadata, failure taxonomy) but only as declarative contracts with canonical examples. Nothing derived an actual expected next action from live facts, nothing scanned work that had no running worker, and nothing could classify "this work has no valid owner and no scheduled recovery" without inventing a second workflow engine.

## Decision

Add a **thin, provider-neutral reconciliation layer** in two parts.

### 1. `@symphony/domain` — `work-continuity.ts`

* `WorkContinuityObservation` is the authoritative-fact snapshot for one `WorkKey`: stage facts, expected action, current owner + fence, liveness, scheduled recovery, external wait, explicit blocked state, per-source availability, and `requiredSources`.
* `deriveWorkContinuity()` is a pure function returning a `WorkContinuityVerdict` with one of `healthy` / `awaiting_external` / `blocked` / `retry_scheduled` / `stranded` / `contradictory` / `observation_unavailable` / `terminal`.
  * Evaluation order is the contract: observation failure first (fail safe), terminal next, contradictions before ownership (never pick a winner), `blocked` before ownership (blocked work is never auto-retried), legitimate external/human waits before stranded, already-scheduled recovery before stranded, and only then ownership/liveness.
  * `blocked`, `awaiting_external`, `retry_scheduled` and `stranded` are separate diagnoses with separate recovery semantics.
  * A due or overdue retry stays `retry_scheduled`; it is never duplicated.
  * Missing progress evidence yields `measured: false`, not a fabricated timestamp. Process presence alone never counts as progress.
* `deriveStageExpectation()` turns stage facts (`planning` / `coding` / `ci` / `review` / `repair` / `delivery` / `merge`) into the expected next action + owning authority, so "what must happen next" is derived rather than injected.
* `workContinuityFingerprint()` produces a stable, time-independent fingerprint of everything a recovery decision depends on: owner fence **and** the recovery's expected fence, `taskRef` (id + revision), review `target` (repository / PR / exact HEAD) and `handoffRef.handoffId`. `observedAt` is excluded so re-reading the same facts still compares equal, but a new HEAD / task revision / handoff always produces a new fingerprint and a new idempotency key.
* `validateWorkContinuityObservation()` rejects observations that cannot support a safe decision. A source named in `requiredSources` but absent from `sources` is treated exactly like an `unavailable` read: `observation_unavailable`, no recovery.

### 2. `@symphony/orchestrator` — `work-continuity.ts` + `work-continuity-authorities.ts`

`WorkContinuityCoordinator` runs the fixed protocol per work item:

```text
observe authoritative facts
        ↓
derive expected action + owner + diagnosis
        ↓
re-observe and compare fingerprint (abandon stale plan on any change)
        ↓
delegate one bounded recovery class to the owning authority port
        ↓
re-observe to report convergence (never replay the side effect)
```

Boundaries that keep it thin:

* **No second lifecycle.** The coordinator is stateless with respect to work; it only holds an in-flight set and a short repeat-suppression window.
* **No source mutation.** Mutations go through `WorkRecoveryAuthority` adapters, and each adapter delegates to a port implemented by the state owner (`OrchestratorRecoveryPort`, `DecisionClaimRecoveryPort`, `DeliveryHandoffRecoveryPort`). A missing authority is `authority_unavailable`, never a direct write.
* **No duplicate recovery.** `inFlight` serializes concurrent passes per key; `recentDelegations` suppresses an identical fingerprint for `repeatSuppressionMs`; the authority's own commit-time fence remains the real guarantee.
* **Fail safe.** A failed observation (required source, missing required source, or thrown read) produces `observation_unavailable` / `observation_failed` and changes nothing. A failed *post-action* read reports `unverified` instead of retrying.
* **No replay after an uncertain outcome.** The delegation is recorded **before** `recover()` is called. If the authority throws (for example the side effect committed but the response was lost), the coordinator keeps the suppression record, re-observes to report convergence honestly, and returns `unverified`; the same delegation is not re-issued before the suppression window elapses.
* **Stop closes admission synchronously.** `WorkContinuityCoordinator.stop()` sets a closed flag before its first `await`, `OrchestratorLoop.stop()` calls it in the synchronous shutdown prefix, every work item and every delegation re-checks the flag, and `stop()` awaits in-flight delegations.

`OrchestratorLoop` accepts an optional `workContinuity` runner. When wired it runs every tick **after** running-worker reconciliation and **before** candidate dispatch, so work with no live worker is still examined and not double-dispatched. A failure is isolated to a `work_continuity_failed` diagnostic.

### 3. Production wiring (`apps/cli`)

* `TrackerWorkIndex` scans the real active tracker states and re-reads one issue by id before every observation (never the scan snapshot).
* `HostWorkObservationSource` builds the observation from tracker + orchestrator runtime (`running` / `retryAttempts`, last Codex timestamp, stall deadline) + Decision facts (`session`, latest plan/review task, lease expiry, plan verdict) + the workspace's `.symphony/delivery-state.json`.
  * Idle coding work is owned by the orchestrator's poll loop (`owner: orchestrator`, progress `unknown`), so reconciliation never becomes a second dispatcher.
  * A claimed/running Decision task past its lease expiry is `owner_not_observable` → `reclaim`; a paused Delivery handoff with a concrete `handoffId` is `compensate`.
* `createHostWorkContinuity` wires only the authority ports actually backed by a real authority; `createHost()` passes the coordinator into `OrchestratorLoop`, so a real process runs it every tick before dispatch.
* `createWorkspaceDeliveryCompensationPort` takes an atomic `mkdir` mutex in the workspace and re-validates handoff id / HEAD before calling `recoverDeliveryHandoff`; that function additionally re-reads the persisted state before each remote mutation and refuses a stale handoff.

### 4. `@symphony/decision` — `DecisionService.releaseExpiredClaim` and bridge sweep

Lease expiry previously only happened lazily inside `getNextTask` / `claimTask`, i.e. only when an executor happened to ask for work. `releaseExpiredClaim(taskId, { expectedRevision, expectedClaimGeneration })` lets a reconciler ask the Decision authority to release a lease it observed as expired. Inside one store transaction it re-reads and requires the same revision, the same claim generation, a `claimed`/`running` task, and a lease still expired **at commit time**. Any mismatch returns `superseded` / `not_expired` / `not_found`; the coordinator never impersonates the Web executor, and the normal executor claims the released task afterwards.

`DecisionBridge` also runs its own sweep (`expirySweepIntervalMs`, default 2s, unref'd, cleared on stop) that calls `releaseExpiredClaims()`, so a dead executor is noticed even when no browser polls again. The bridge exposes `POST /v1/tasks/:id/release-expired-claim` and `DecisionBridgeClient.releaseExpiredClaim()` so a host using the remote bridge has the same commit primitive as one with a local store.

## Alternatives considered

* **A single monolithic workflow engine that owns every stage.** Rejected: it would create a second authoritative lifecycle next to the orchestrator, Decision store and Delivery state, exactly what #145/#146 forbid. It would also have to duplicate every authority's fencing.
* **Let the coordinator write source stores directly (runtime map / Decision store / Delivery file).** Rejected: the pure domain fence helper cannot make a cross-store write atomic, and it would bypass claim generations, exact-HEAD checks and Delivery state transitions. The adapters exist so the mutation always happens under the owner's own transaction or mutex.
* **Keep deriving the expected action at the call site.** Rejected: "what must happen next" is the question the issue asks the system to answer; leaving it to each caller makes the classification untestable and lets two callers disagree. `deriveStageExpectation` keeps it a pure, testable function.
* **Reclaim on any missing progress evidence.** Rejected: heartbeat and process existence are not progress, but neither is their absence proof of failure. Unknown progress keeps ownership; only an explicit deadline overrun or an absent/unobservable owner is stranded.
* **Retry immediately whenever the verdict is stranded, every tick.** Rejected: duplicated retries and duplicate owners. Concurrency is handled by the per-key in-flight guard plus a repeated-fingerprint suppression window, and the authority still refuses stale commits.
* **Blindly replay the last command after a failed post-action read.** Rejected by the issue's "re-observe before deciding" semantics; an unverifiable outcome is reported as unverified and left to the next observation.

## Consequences

* Active supported work can now answer: what must happen next, who owns it, is that owner still alive/making progress, is a recovery already scheduled, is it explicitly blocked, and is it stranded or contradictory.
* `blocked`, legitimate external wait, retry scheduled, stranded, contradictory and observation-unavailable are distinct and tested independently.
* Repeated reconciliation over unchanged facts classifies identically and does not re-delegate; concurrent passes over one key produce at most one delegation.
* The coordinator cannot mutate anything by itself. Every automatic recovery needs a wired authority port, and Delivery compensation additionally requires a concrete `handoffRef.handoffId`.
* Liveness deadlines and progress-source semantics remain the owning subsystem's responsibility (Web checkpoints in #148, durable intents across restarts in #149). This change does not itself provide restart convergence: the in-memory retry timer remains in-memory, and `scheduledRecovery` reflects only what an authority can currently prove.
* Cross-source observation is not atomic. Safety comes from re-observation before action, authority-side commit-time validation, and treating any failed read as `observation_unavailable`.
* `createHost()` now assembles and runs the coordinator by default. It observes the stages this process can actually see (tracker, runtime, Decision, Delivery); GitHub PR/CI facts are not read per tick, so a work item whose next stage is only visible in GitHub is reported through its owning authority rather than inferred.
