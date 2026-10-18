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
* `HostWorkObservationSource` builds the observation from tracker + orchestrator runtime (`running` / `retryAttempts`, **stable progress instant**, stall deadline) + Decision facts (`session`, latest plan/review task and its **verdict**, lease expiry) + the workspace's `.symphony/delivery-state.json`.
  * Activity is judged from the **refreshed** issue against the current active/terminal configuration, not from the fact that the scan saw it.
  * Activity means **work is active**, not "dispatch-eligible". Removing `symphony-ready` is the normal pause step: the issue is still active work and a pending handoff can still be compensated. Dispatch eligibility stays with the authority.
  * Idle coding work is owned by the orchestrator's poll loop (`owner: orchestrator`, progress `unknown`), so reconciliation never becomes a second dispatcher.
  * A claimed/running Decision task past its lease expiry is `owner_not_observable` → `reclaim`; a paused Delivery handoff with a concrete `handoffId` is `compensate`.
  * A pending Decision task is `awaiting_external` only when the session has a **bound adapter** (a real external executor), never a fabricated scheduled recovery from a binding generation; with no bound adapter it is `blocked`.
  * Completed tasks consume their verdict: approved review → Delivery resume, `changes_requested` → repair, `needs_human` / missing verdict → `blocked`; a ready plan → coding. A failed/cancelled/superseded task falls back to the earlier stage instead of holding the current one.
* `createGitHubPrReader` reads authoritative PR facts with `gh pr list --head <branch> --state all --json number,state,headRefOid,isDraft,mergeable,statusCheckRollup`, projecting the rollup into `none` / `pending` / `passing` / `failing`. Reads are cached for 10s per `repo#branch`.
  * The rollup mixes check runs (`status` + `conclusion`) and legacy commit statuses (`state` = `EXPECTED` / `PENDING` / `SUCCESS` / `FAILURE` / `ERROR`); both are interpreted, so a pending or failing status is never mistaken for passing.
  * Each fact carries `readAt`, and the github source entry is stamped with that real read time rather than the moment the observation was assembled.
  * The read is only issued when the work item has **review or delivery evidence** (a review task or a persisted delivery state). A PR cannot exist before the Delivery skill ran, and the skill always persists its state before any remote action, so planning/coding ticks stay free of external calls.
  * `pending` CI -> `ci` stage with `await_external` (GitHub Actions owns the wait); `failing` -> `repair`; `MERGED` -> `merge` stage waiting for the tracker to reflect it; `CLOSED` (unmerged) -> `blocked`.
  * Only a review task whose **full target** (`repository`, `prNumber` and `headSha`) equals the current PR may own the review stage; a task recorded against an older HEAD — or another PR that happens to share a commit SHA — is stale and is never continued or reused.
  * The target filter runs **before** ordering. Among matching tasks the effective one is chosen by numeric `revision` first, then `updatedAtMs`, then task id — `updatedAtMs` alone is ambiguous (a superseded revision can share its replacement's timestamp, and an older task can be touched later), and string task-id comparison orders `9` before `10`.
  * A verdict is matched to the task's exact `revision` (falling back to that task's highest revision), so an older revision's approve/changes_requested can never decide the current one.
  * The bridge reader fetches results for every completed task ordered by revision, not just the most recently touched one. Green CI with no current review task reports the review stage with no task reference, and the Decision adapter reports `unavailable` rather than guessing one.
  * A read failure marks the GitHub source `unavailable` and, when the work item depends on it, makes the whole observation `observation_unavailable` - it never looks like "no PR".
  * The coordinator's pre-action and post-action reads call `reobserve()`, which bypasses the TTL cache; the cache therefore only shortens the first (diagnostic) read and can never hide a HEAD change from the decision that acts on it.
* `createHostWorkContinuity` wires only the authority ports actually backed by a real authority; `createHost()` passes the coordinator into `OrchestratorLoop`, so a real process runs it every tick before dispatch.
* `createWorkspaceDeliveryCompensationPort` takes an atomic `mkdir` mutex in the workspace and re-validates handoff id / HEAD before calling `recoverDeliveryHandoff`; that function additionally re-reads the persisted state before each remote mutation and refuses a stale handoff.

### 4. Delivery authority: one mutex and one version check for every writer

The filesystem mutex lives in the **Delivery authority**, not in the coordinator caller:

* `DeliveryStateStorage` gains an optional `withExclusive()` critical section. **Every Delivery handoff mutation** uses it: `recoverDeliveryHandoff` (whole recovery), `delivery-skill halt` (state read → label removal → comment → final write) and the runner's `haltDispatch`. A concurrent compensator either waits or receives a conflict — it never observes the same pending handoff and posts a second report.
* `FileDeliveryStateStorage.writeState()` takes the same atomic `mkdir` lock and performs **compare‑and‑set** against the raw content it last read. A write based on a stale version throws `DeliveryStateConflictError` instead of overwriting the newer handoff / HEAD.
* The lock is a **ticket-directory** mutex, not a single shared lock path:
  * each acquirer creates `lockRoot/tickets/<n>/` and publishes `owner.json` inside it; the lowest live (or still-unpublished) ticket owns the critical section;
  * allocation is not assumed atomic: the candidate is computed from the highest visible number (including retained `released-<n>` tombstones, so a freed number is never reused below a running owner), and **after publishing it is re-validated**. If any other ticket has a number at least as large, the candidate is abandoned and retried — a number derived from a stale snapshot can therefore never enter below a live owner;
  * the published ticket is re-read to prove the directory was not reaped during the two-syscall registration; if it was, the acquirer retries instead of entering;
  * an **unpublished** ticket is a blocking contender at its number, never skipped. A higher ticket cannot enter while a lower registration is in flight; only a registration that is **provably absent** (`ENOENT`) *and* older than a grace period is treated as crashed and tombstoned, and a live registrant detects that through its post-publish verification;
  * a failed owner read or a failed stat is **evidence unavailable**, not death. It keeps the ticket as a blocking contender and can never trigger retirement — a transient `EMFILE`/`EACCES` must not let another process take over a lock that is still held;
  * only a ticket whose recorded pid is provably gone (`kill(pid, 0)`) is retired, and each ticket lives at its own path, so retiring one can never touch a live one; release retires this instance's own ticket only.
* Because ownership is never taken over and the shared namespace is never vacated, there is no window in which two processes both believe they own the section. Ordering comes from ticket numbers and directory exclusivity, not from wall clocks, so cross-process clock skew cannot reorder owners. This replaces the earlier age-based reclaim and rename-then-verify attempts, both of which left a gap where a live owner's directory was momentarily out of the checked namespace.
* Before each remote mutation `recoverDeliveryHandoff` still re-reads and compares the handoff id / HEAD (`expectedHandoff`), so a change between validation and the remote call aborts without writing.
* The compensation port re-checks that the refreshed issue is still **active work** before touching the workspace.

### 5. `@symphony/decision` — `DecisionService.releaseExpiredClaim` and bridge sweep

Lease expiry previously only happened lazily inside `getNextTask` / `claimTask`, i.e. only when an executor happened to ask for work. `releaseExpiredClaim(taskId, { expectedRevision, expectedClaimGeneration })` lets a reconciler ask the Decision authority to release a lease it observed as expired. Inside one store transaction it re-reads and requires the same revision, the same claim generation, a `claimed`/`running` task, and a lease still expired **at commit time**. Any mismatch returns `superseded` / `not_expired` / `not_found`; the coordinator never impersonates the Web executor, and the normal executor claims the released task afterwards.

`DecisionBridge` also runs its own sweep (`expirySweepIntervalMs`, default 2s, unref'd, cleared on stop) that calls `releaseExpiredClaims()`, so a dead executor is noticed even when no browser polls again. The bridge exposes `POST /v1/tasks/:id/release-expired-claim` and `DecisionBridgeClient.releaseExpiredClaim()` so a host using the remote bridge has the same commit primitive as one with a local store.

Bridge observation failures are **not** absence: only an explicit 404 / `not_found` means "no session". A 503, timeout or auth failure propagates and the observer records the Decision source as `unavailable`, which blocks every ownership change for that work item.

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
* `createHost()` assembles and runs the coordinator by default and observes the full stage set: tracker, runtime, Decision, workspace Delivery, and **authoritative GitHub PR / CI / HEAD / merge facts**. CI waiting, stale-HEAD review and merged/closed PRs are derived from those facts rather than inferred.
* Progress evidence comes from `AgentTelemetryState.lastProgressAt`, which advances only on reliable turn/session lifecycle events and positive token deltas. Notifications, repeated usage snapshots and process existence never advance it.
* The **same** evidence drives native stall detection (`stallActivityBaselineMs`), so a worker that only emits telemetry actually stalls and is stopped by the existing stall → outcome → retry path.
* A work-level `reclaim` is executed by `OrchestratorAuthority.reclaimStalledAttempt({issueId, expectedAttemptToken})`. In the **same synchronous commit section** as the stop decision it re-checks: attempt token, that stall detection is still enabled, and that the attempt is still stalled at the authority's current clock. Work that resumed progress (a turn transition or a positive token delta) returns `skipped`; only then does it use the bounded `worker.stop({kind:"stall"})` reduction. Reconciliation never stops a healthy owner and never dispatches on top of a live attempt.
