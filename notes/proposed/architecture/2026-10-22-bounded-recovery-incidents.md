# Agent Note: Bounded native recovery and durable incidents
Status: proposed

## Problem

Exponential backoff limits retry frequency, not the number of failing actions.
Native Decision and Web limits already exist, but worker failures and continuity
reconciliation lack a common durable failure identity and operator report.
Unknown cross-boundary outcomes cannot be converted into permission to replay.

## Decision

For NEST-134 / GitHub #150 (SPEC §4 adjacent, §7/§8/§14, §17/§18), domain owns
versioned budget, normalized failure, safe evidence and incident contracts;
orchestrator owns reservation/strategy selection. CLI composes file persistence,
source normalization and the reporter. Decision never imports orchestrator.
Operations and Dashboard remain read-only and own no recovery controls.

Each Work/action scope has a finite epoch budget, independent of timer attempts.
WORKFLOW `agent.recovery.max_attempts` defaults to 6 and
`max_strategy_attempts` to 2; both must be finite safe positive integers.
Policy progresses through the ordered capabilities supplied by the authority;
unsupported strategies are skipped. A sole safe primitive can use the remaining
total budget. Worker recovery supports retry; continuity supports native resume,
reclaim or compensation as appropriate. Existing Decision/Web resume/rebind and
3/6 native limits remain stricter protections. No new login, browser supervisor,
arbitrary command replay or synthetic recovery strategy is introduced.

A SHA-256 fingerprint uses canonical Work identity, expected action, authoritative
target and controlled failure code/class. Error messages, clocks, heartbeats,
lease/binding generations and observation versions do not reset budgets. Task,
revision, HEAD or handoff changes re-scope only the corresponding stage; auth and
irrecoverable-binding blocks use an infrastructure scope. Worker infrastructure
budgets survive successful continuation and HEAD changes. Explicit fenced native
Decision unblock advances a persistent recovery epoch; host-policy authorization
requires the exact current incident ID and retains history. An invariant conflict
whose modeled native facts demonstrably clear can also begin a new fenced epoch;
auth, human and unknown-effect blocks do not clear through elapsed time.

Reservations precede effects and reuse invocation identity. The existing unique
Work invocation slot precedes policy reservation. Certified stale/stopped/unsupported
refusals refund the new reservation. Native fencing and post-I/O admission remain
mandatory. A failed atomic Decision reclaim whose exact unchanged claim is proved by readback
settles as a counted failure, permitting a new bounded invocation. Unknown
subprocess/Send/merge outcomes immediately become an explicit policy block; pending
native invocations stay durable and are not blindly retried. A legacy invocation
without an ID gets a deterministic hashed identity. Restored scheduled retries do
not charge again. When a legacy retry first fails under the new policy, its prior
attempt count is conservatively inherited; old attempts do not silently become zero.
Old Decision records retain their existing count and optional new metadata defaults.

The file ledger serializes cross-process mutations using the existing filesystem
authority, atomic rename and fsync. Budget exhaustion and its incident are one
commit; native Decision blocks can reconstruct an incident on a later scan if the
host dies between native block and host ledger commit. Read/schema/write errors
fail closed. The ledger stores policy evidence, not another business lifecycle.

The reporter consumes committed current incidents. Before publication and receipt
commit it refreshes native observations and checks incident identity and stop intent.
Its outbox claims the POST boundary durably and queries all remote issue comments
for an exact marker. An uncertain send is only verified, never automatically
re-posted. Concurrent reporters cannot independently obtain POST permission.
Reporting gets at most three delivery/verification attempts, then retains the local
incident and outbox for operator inspection without recursively reporting itself.
A crash in a claimed/pre-POST window can conservatively suppress a GitHub comment;
the CLI report remains durable. External exactly-once publication is not promised.

## Alternatives considered

- Reuse retry queue attempt as the budget: rejected because slot waits, tracker
  refreshes and successful continuation have different semantics.
- Reset on binding generation or error text: rejected because repeated reclaim,
  volatile strings and alternating failures could evade a finite total.
- Replay an unknown Send/repair/merge or re-post after a timeout: rejected because
  missing acknowledgement is not proof that an effect did not happen.
- Put reporting/actions in Dashboard or duplicate task/PR state in a recovery
  workflow: rejected to preserve native authority and observation boundaries.
- Add recovery actions that have no fenced native primitive: rejected. The selector
  accepts capabilities; it does not manufacture mutation permission.

## Consequences

Operators have a durable local list/detail report even when GitHub is unavailable.
Host authorization clears the reviewed policy epoch. For an unknown worker launch,
explicit exact-incident authorization attests that the old executor is stopped and
CAS-removes only its reviewed retry token before clearing policy. The live authority
reconciles its cached owner only after proving that native removal; a successor is
never released. Decision and Delivery blocks retain their native verification APIs. Single-node filesystem coordination remains the deployment boundary.
Embedders that construct an authority without the CLI must supply the new policy
port and durable storage to obtain these host recovery/reporting guarantees.

Automated validation covers policy escalation, bounded native retry delays,
concurrent processes/reporters, SIGKILL, receipt loss, stale callbacks, safe evidence
and authorization. New live GitHub/browser fault acceptance is separate from fixture
results and is not claimed by this implementation. See the operator instructions in
[bounded recovery](../../../docs/bounded-recovery.md).
