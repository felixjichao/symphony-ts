# Agent Note: Native durable handoffs and startup recovery
Status: proposed

## Problem

NEST-133 / GitHub #149 requires cross-stage effects to survive service interruption
without losing continuation or replaying unknown executor effects. The implementation
is complete and pending independent review. SPEC §4 adjacent, §7/§8/§14 and §17/§18.
Baseline: `main@1a8eb105a29d6d4340cd05243644f8312ff3f8ca`.

## Decision

| Native boundary | Durable intent / recovery |
| --- | --- |
| Coordinator → authority | Unique invocation persisted before delegation; startup discovers its WorkKey even outside current tracker inventory. Native idempotent/fenced replay retains the original slot until readback; unavailable or ambiguous facts retain suppression. |
| Coding/CI → Review | Existing owned PR + current HEAD + CI + eligible plan authorize the stage entry. Delivery stores target and operation key before ensuring Review, then task ID/revision. Receipt adoption explicitly permits reuse of an existing completed task for the same plan/target without creating a review round. |
| Review result → Delivery | Re-read task ID/revision/target and verdict, record result identity, then continue from CI/Review/landing. Initial validation, commit and push are skipped. Needs-human is paused; repair authorization is preserved, but a started repair with an unknown outcome blocks rather than replaying arbitrary commands. |
| Delivery pause → compensation | Preserve pause/deadline/budgets and handoff ID. Re-read current Issue labels and PR ownership/HEAD before mutation. Complete label removal/reporting through the existing compensation code; repeated recovery deduplicates the handoff marker. Compensation never resumes coding. |
| Landing → confirmation | Skill and `pr land` use the same `LandingIntent` in the existing Delivery state and the same filesystem authority. Persist explicit opt-in and exact PR/HEAD before gates/effect; observe merged/merge commit before acknowledging. A timeout can follow success, so exit status alone is never the merge result. Already-merged recovery only acknowledges, without another merge or closing an Issue. |
| Retry reservation → worker | Persist UTC due time, attempt, kind, error and a unique incarnation/token before timer registration. Refresh current tracker/stage/admission on expiry. Persist `launch_pending` before invoking the worker; never erase the only durable record between reservation and launch. |

These are small native records, not a second business lifecycle or a generic
transaction engine. GitHub, Decision and the Orchestrator retain their authorities;
Operations remains read-only. Library adapters without a durable storage capability
retain their in-memory semantics; the native CLI/host supplies the file ports.

## Retry launch ambiguity: resolution of the initial design gap

The initial foundation identified a gap if a retry reservation were simply cleared
around `startWorker`. The continued implementation, requested by the user, resolves
it using the original analysis's explicit durable-block outcome:

- A scheduled reservation restores automatically with its original UTC deadline
  and attempt; the new monotonic clock is used only for the new timer.
- `launch_pending` is written before **any** executor invocation. A restart that
  cannot prove the old executor finished changes that record to `blocked`, retains
  the claim and refuses another coding launch. A new UUID is not executor revocation.
- A normally settled attempt replaces the launch record with the next reservation
  or removes it on a definitive release. Clean shutdown waits for attempt/transport/
  hook settlement and retains a safe scheduled reservation; SIGKILL cannot take
  that path. Storage failure retains the launch evidence and prevents new work.
- Replacement, cancellation and launch writes compare the previous durable token.
  Old process callbacks cannot consume a newer incarnation's reservation.

This intentionally does not introduce a process supervisor or claim that an orphan
coding executor can always be revoked. Ambiguous launch/repair/subprocess records
carry explicit operator verification conditions, rather than silently stranding work
or automatically running a second possible executor.

## Storage and filesystem authority

Host invocation and retry records live in `<workspace.root>/.symphony-host/`, outside
individual issue workspace cleanup. Schema-validated snapshots use mode 0600,
file fsync, atomic replacement and directory fsync. Observation versions are hashes,
so complete service configuration is not written into invocation records. The
existing Delivery state carries continuation, landing, budget and pause facts;
ordinary budget writes preserve unfinished steps. Foreign work identity and malformed
new records fail closed. Acknowledgements compare unique invocation identities.

Synchronous file commits and asynchronous Delivery operations share one native lock
primitive. Lock metadata records PID, hostname, nonce and subprocess uncertainty.
Reclamation is serialized and requires a proven dead same-host owner and no pending
subprocess. No lock is stolen by age. Release checks nonce. The native git/gh runners
mark uncertainty **before** spawning and clear it only on confirmed child close;
if an action returns before close, the authority remains held until close. A parent
that dies with an ambiguous child therefore cannot be treated as safely stopped.
Missing/legacy metadata, an interrupted reclaim, cross-host ownership and uncertain
subprocess effects require operator verification. Admission surfaces these lock
conditions as explicit blocks. PID reuse conservatively prevents automatic reclaim.

Startup preflight/terminal cleanup precede timer restoration. Cleanup consults the
durable reservation source before deleting anything, refusing workspaces that may
still belong to an old executor even before in-memory restoration. Startup and later ticks
use the existing coordinator and native readers. Native stage recovery takes the
same Delivery lock, revalidates observation/plan/target, and yields on pending CI or
Review rather than sleeping inside the host scan. Shutdown synchronously fences new
calls; already-started writes/effects are awaited and their durable records survive.
Nonstandard branch/base contexts are restored from the native Delivery intent.

## Alternatives considered

- Persist monotonic `dueAtMs`: rejected; it cannot survive a new process clock.
- Clear a reservation immediately before or after launch: rejected; either order
  loses a crash window. Retain a launch intent and block genuinely ambiguous starts.
- Use a new UUID as proof the old worker stopped: rejected; it does not revoke an
  external process. Tokens fence durable writes; uncertainty remains explicit.
- Restore the whole CLI command: rejected; stage recovery must skip coding and must
  not blindly repeat an uncertain repair or invent merge opt-in.
- Give every recovery a new Review operation key: rejected; it can create a new
  round and lose a completed result. Stable target/plan identity and explicit
  completed-task receipt adoption preserve existing rounds.
- Steal crash locks by age or parent PID alone: rejected; a child may still mutate
  GitHub. Unknown child outcomes block, even if the parent is dead.
- Add a generic workflow/transaction framework: rejected; injected native file
  ports and explicit per-boundary markers suffice.

## Consequences

The native host can restore safe reservations and stage continuations automatically,
while genuinely unknown executor outcomes require explicit verification. File-backed
adapters carry the new guarantees; custom adapters must supply equivalent durability
and child-lifecycle evidence. Runtime `.symphony` files are excluded from Delivery
source commits, including locks and leftover snapshot temporaries. Changing the
configured workspace root requires stopping the host and preserving/migrating its
host recovery records; no automatic cross-root migration is claimed.

### Evidence

`durable-delivery.test.ts` bundles production stage entry, FileDeliveryStateStorage
and Decision store into a separate child process. SIGKILL covers Review intent,
effect and acknowledgement; merge intent, effect and acknowledgement; repair start;
and remote handoff receipt loss. Reopening validates task reuse, exact-HEAD drift,
no coding replay, one merge/report, preserved budgets and paused compensation.
Additional cases cover competing locks, stale nonce release and ambiguous child locks.

`durable-retry.test.ts` SIGKILLs after reservation persistence and at executor launch,
then restores the real authority with a different monotonic clock. It covers expiry,
attempt preservation, missing/inactive/new-stage admission, source outage, old-token
callbacks, cancellation, write failure and clean shutdown. `landing-recovery.test.ts`
exercises the tracker landing path with real file storage and lost receipts on both
sides of the effect. The real host startup/tick test ensures a Review and consumes its
stored result without launching coding, then reopens the host without a new round.
Existing Decision fencing, coordinator single-flight, unavailable-read, storage,
Delivery and whole-repository regressions remain part of `npm run gate`.

These are local fixtures at external GitHub/Codex boundaries. They do not claim a
real GitHub/Codex smoke, cross-machine distributed ownership, exactly-once effects,
power-loss certification, or automatic resolution of unknowable executor outcomes.

### Delivery cleanup and explicit halt

Delivery run, halt, recovery and landing acquire a lifecycle mutex under the
workspace parent's `.symphony-host/delivery-authorities/` before the existing
in-workspace authority. The key hashes the canonical parent and workspace name,
so deletion/recreation cannot remove or change the exclusion key. Subprocess
uncertainty is recorded in both authorities. Host native cleanup holds the same
outside mutex through containment checks, hooks and removal, and refuses legacy
owners, unknown children, corrupt snapshots, pending compensation and unfinished
continuation/landing intents even when GitHub has already closed the Issue after
merge. An observed landing and ready continuation can be cleaned once the owner
has released its authority. Auto-land instead completes from `result_observed`:
cleanup also accepts an approved result only when the observed merge commit
belongs to the exact same PR, HEAD, head branch and base branch. Existing in-workspace locks remain honored.

Explicit halt preserves continuation, landing, budgets and work identity in every
checkpoint, including failed compensation. Corrupt or foreign snapshots fail
before remote mutation or replacement. The native host startup and formal halt
CLI regressions cover these refusal and acknowledgement windows.

Handoff reports persist `reportDestination` independently of the business PR
number. Explicit halt reports to the Issue even when it retains a PR target;
native Delivery reports to the PR when one exists. Compensation observes and
posts to that persisted destination, so an accepted report whose response was
lost cannot move to another comment collection. Older handoffs with a PR and a unique marker inspect both collections before
persisting the recovered destination; unavailable evidence blocks replay.
Unmarked legacy records retain their conservative legacy receipt checks.
