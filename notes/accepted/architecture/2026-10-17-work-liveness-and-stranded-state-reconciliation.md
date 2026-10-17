# Agent Note: Work-level Liveness and Stranded-State Reconciliation

Status: accepted

## Problem

Under the execution continuity contracts defined in #146 (NEST-130), work spans multiple lifecycle stages: planning, coding, CI wait, review, repair, delivery compensation, and merge. In complex production environments, work items can become stranded across stage transitions due to abrupt process restarts, transient network drops, worker crashes, expired browser session leases, or lost delivery handoffs.

Prior to this change:
- Orchestrator only monitored active local workers and scheduled retry timers for coding tasks (§7, §8, §14);
- Decision store tracked task claims and leases but lacked automated release of expired browser agent leases;
- Delivery handoffs supported single-shot recovery (`recoverDeliveryHandoff`) but lacked multi-process coordination locking;
- No component evaluated end-to-end work continuity across stage boundaries to detect when an active issue had fallen between cracks (e.g. CI checks finished and PR is awaiting review session, or review requested changes but repair was never scheduled).

Without a coordinated yet thin reconciliation mechanism, stranded work would remain perpetually stalled without operator manual intervention, or multiple components would race to recover the same work, violating single-writer invariants.

## Decision

Implement work-level liveness evaluation and stranded-state reconciliation as a thin, bounded coordinator in `@symphony/orchestrator` (`WorkContinuityCoordinator`) operating on normalized cross-source facts (`WorkItemFacts`), accompanied by authoritative mutation safeguards in `@symphony/decision` and `@symphony/agent`:

### 1. Thin Coordinator & Authority Boundaries
- The coordinator does **not** introduce a secondary workflow engine or monolithic state machine.
- The coordinator only observes facts and delegates bounded recovery proposals to the respective authoritative component stores:
  - **Orchestrator authority**: Controls worker dispatch, stall termination, and retry timers.
  - **Decision authority**: Controls task claim release via `releaseExpiredTaskClaim` with transaction-level revision, claim generation, and lease expiration checks.
  - **Delivery authority**: Controls handoff compensation via `recoverDeliveryHandoff` with mutex lock fencing and `expectedLastUpdated` validation.
- Orchestrator depends only on `@symphony/domain` contracts, never directly importing `@symphony/decision` or internal delivery packages (preserving the dependency invariant in `AGENTS.md`).

### 2. Five-Step Safe Reconciliation Protocol
Every reconciliation cycle follows an explicit 5-step safety protocol:
1. **Observe**: Read authoritative facts across sources for active work items.
2. **Pure Derive**: Evaluate liveness, stage, condition, and recovery proposals through pure function `deriveWorkContinuity(facts, now, options)`.
3. **Pre-action Re-observe**: Immediately before delegating a recovery action, re-read facts to verify that the state is still stranded and the recovery proposal matches. If facts converged or changed in the interim, the recovery is safely cancelled.
4. **Delegate to Authority**: Invoke the authoritative component's adapter with strict fencing credentials.
5. **Post-action Re-observe**: Re-read facts post-action to verify updated state and prevent duplicate side-effects.

### 3. Stage Derivation Matrix
Pure derivation covers all supported lifecycle stages:
- **Planning**: If planning is enabled and no session exists -> stranded (`decision_dispatch_plan`). If lease expired -> stranded (`decision_release_expired_claim`). If clarification needed -> `blocked`. If active with valid lease -> `making_progress`.
- **Coding**: If worker running and making progress -> `making_progress`. If worker stalled past `stallTimeoutMs` -> stranded (`orchestrator_stop_stalled`). If active issue without worker or retry -> stranded (`orchestrator_dispatch`). If retry scheduled -> `retry_scheduled`.
- **CI Wait**: If PR checks pending and within timeout -> `external_wait`.
- **Review**: If CI green and no review task -> stranded (`decision_dispatch_review`). If review task lease expired -> stranded (`decision_release_expired_claim`). If approved -> transition to merge.
- **Repair**: If review requested changes and no repair worker running -> stranded (`delivery_resume_repair`).
- **Delivery Compensate**: If delivery paused with pending compensation -> stranded (`delivery_compensate`).
- **Merge**: If checks green and approved -> `making_progress`.
- **Completed**: If issue closed or PR merged -> `completed`.
- **Observation Failure**: If tracker or GitHub source reports unavailable -> `observation_unavailable` (fail-safe; no mutations triggered).

### 4. Authoritative Store Commit Verification
- **Decision Store**: Added `releaseExpiredTaskClaim` to `DecisionService`, executing inside an exclusive database transaction. It verifies `expectedRevision`, `expectedClaimGeneration`, `expectedBindingGeneration`, and asserts that the current wall clock has exceeded `lease.expiresAtMs`. If any check fails (e.g. claim was refreshed or completed), the release is rejected without mutation.
- **Delivery Recovery**: Enhanced `recoverDeliveryHandoff` with an optional `DeliveryLock` and `expectedLastUpdated` fencing, preventing concurrent recovery runs from corrupting delivery handoff markers.

### 5. Immutable Delivery retirement claims (review round 11)

The CLI file lock's stale-reclaim retirement authority uses an append-only claim
chain within the inode-specific `.reclaim.retire-*` directory. An owner record is
written to an exclusive candidate file, closed in `finally` on failure, and
published with an atomic hard link. Contenders for the same generation link to
the same destination; `EEXIST` means the other claim won. No owner pathname is
unlinked, truncated, or replaced, and the directory is never moved during recovery.

A live PID without a completion marker prevents takeover regardless of age.
After a confirmed process death, or a completed claim, contenders advance to the
same successor path derived from the predecessor's path and immutable contents.
Only legacy corrupt metadata uses an age threshold, measured from the file itself;
an old directory does not make newly written metadata stale. Each attempt bounds
traversal by the directory snapshot size, so long histories remain recoverable.

The winner rechecks its published record and the observed reclaim inode, mtime,
and token before retiring the stale reclaim file. It publishes a content-bound `.done` marker
only after its protected retirement actions have stopped; a rejected stale token
cannot mark changed owner metadata completed. A failed completion
write leaves the claim conservatively owned until process exit. Unpublished
candidate files left by crashes grant no authority. Failed metadata writes never
publish partial owner records and always close the candidate fd.

This protocol assumes cooperating processes and local filesystem atomic hard-link
semantics. Retained claims/completion markers and crash-left candidates consume
small amounts of disk space; remove them only while all users of that delivery
lock are stopped. Do not run the old mutable-owner retirement protocol concurrently
with this version during an upgrade. NFS/CIFS and real GitHub/Codex integration
are outside the local lock tests.

### 6. Atomic primary and reclaim publication (review round 12)

The main lock and both reclaim acquisition paths now write complete PID/token
metadata into a private `.candidate-*` file before atomically linking it to the
public lock pathname. The successful link is the ownership commit. A writer
paused before that commit holds no public authority; another process may win,
and the late writer's real link must fail with `EEXIST`. Published files already
contain a live PID, so aging them alone cannot permit recovery.

Write/link failure closes the private fd and removes only its candidate pathname.
Failed acquisition never unlinks the public lock: it may belong to the successful
competitor. Both initial main acquisition and post-reclaim main acquisition use
the same publication primitive, as do initial and post-retirement reclaim
acquisition. Crash-left candidates have no authority and use the same quiescent
cleanup boundary as retained arbitration records.

## Alternatives considered

1. **Centralized monolithic workflow state machine in Orchestrator**:
   *Alternative*: Consolidate all lifecycle state (Decision sessions, Delivery states, CI polling, worker tracking) into a new master workflow engine inside `@symphony/orchestrator` that directly writes to SQLite and Git.
   *Rejected because*: Violates subsystem boundaries and single-responsibility principles. Decision and Delivery components already possess robust transactional semantics and domain logic; bypassing them would create dual sources of truth and introduce split-brain risks.

2. **Distributed autonomous background healing in each component**:
   *Alternative*: Allow `@symphony/decision`, `@symphony/agent`, and `@symphony/orchestrator` to each run background auto-reconciliation intervals independently without a central coordinator.
   *Rejected because*: Cross-stage boundaries (such as transitioning from CI completion to review dispatch, or from review rejection to repair dispatch) require correlated cross-source facts that no single component owns. Distributed autonomous timers cause uncoordinated concurrent actions and race conditions.

3. **Optimistic recovery without pre-action re-observation**:
   *Alternative*: Dispatch recovery immediately upon deriving a stranded condition during the initial scan, without re-reading facts right before delegation.
   *Rejected because*: In asynchronous distributed systems, another process or external event (e.g. GitHub webhook or human reviewer action) may have resolved or advanced the issue between the initial scan and action execution. Re-observing immediately before mutation eliminates stale-recovery races.

4. **Mutable owner eviction protected by a timeout-based takeover file**:
   *Rejected because*: deleting an aged takeover file can preempt a paused living
   cleaner. A final inode/token read followed by pathname unlink still allows a
   successor to be deleted. Immutable atomic publication removes that deletion
   race without adding native locking dependencies, at the cost of retained
   arbitration metadata.

## Consequences

- Active work items across planning, coding, CI wait, review, repair, delivery, and merge are continuously and safely monitored for liveness and stranded states.
- Stranded states are automatically reconciled through authoritative adapters without manual human intervention.
- Fail-safe fencing guarantees that stale recovery proposals cannot overwrite newer generation state or valid active leases.
- All 5-step reconciliation actions are idempotent and safe against network partitions or temporary source unavailability.
- Prepares Symphony for seamless coordination with ChatGPT Web browser agent progress tracking in #148.
