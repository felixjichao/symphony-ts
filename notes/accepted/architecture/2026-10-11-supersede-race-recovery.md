# Agent Note: Supersede race recovery between bridge and Decision Tab Driver
Status: accepted

## Problem

The real-environment continuation run (PR #107 / NEST-104 dogfood) exposed a recovery gap: when a PR HEAD moved from SHA-A to SHA-B while the driver was still executing the SHA-A ReviewTask, the bridge correctly superseded the old task and rejected the driver's late failure submission with `409 Cannot fail superseded task`. The userscript treated every driver error as fatal (`onError` stopped the polling loop), so a contract-correct supersede rejection required a manual "Start Driver" click before the SHA-B review task was picked up. The stale result was never accepted (correct), but recovery was manual instead of policy-driven.

Contract requirements in tension: superseded/cancelled tasks must never transition or accept results (`supersedeDecisionTask`, `submitResult` / `submitFailure` guards), yet the executor must keep serving the newest head without human restart.

## Decision

1. **Terminal superseded outcome**: `TaskExecutionOutcome` gains a `superseded` variant (`{ status: "superseded", session, error }`) representing "the task became non-actionable on the bridge while executing; nothing was recorded for this execution". The coordinator type is additive; the coordinator itself still rethrows controller authority conflicts (supervisor owns recovery policy).
2. **Driver resolves the race, not the bridge**: on a `409` from result/failure submission, `DecisionTabDriver` re-reads `GET /v1/tasks/:id`. If the authoritative status is `superseded` or `cancelled`, it drops the local checkpoint and returns the superseded outcome; any other status (e.g. lease expiry while still running) rethrows the original error. Status-based verification, not message parsing, decides.
3. **Userscript stops only on auth failures**: `onError` no longer stops the driver on every error. Only `BridgeHttpError` 401/403 are fatal (polling would loop on bad credentials); transient network errors and supersede races surface in the HUD while the loop keeps polling. Recovery policy stays with checkpoint + bridge lease/supersede semantics, not with the HUD glue.

## Alternatives considered

- **Handle the race inside the coordinator (`executeTaskWithAdapter`)**: catch the failure-submission conflict and return the superseded outcome there. Rejected: the coordinator is provider-neutral and its controller-authority errors are deliberately rethrown (see the stale-lease/CAS rethrow test); teaching it about bridge HTTP semantics would blur the boundary, and non-driver controllers (tests, future hosts) would silently change behavior.
- **Match on the `Cannot fail superseded task` message**: cheaper, but brittle against wording changes and cannot distinguish supersede from other 409 conflicts such as lease expiry. Rejected in favor of authoritative status re-read.

## Consequences

- A superseded ReviewTask no longer stops the driver; the newest-head task is claimed on a later poll cycle and manual restarts for this race are no longer needed. This is a code-level guarantee only — real-environment re-verification (browser + bridge + delivery linkage) remains an open NEST-118 acceptance item and must not be reported as proven.
- The stale result/failure is still never accepted by the bridge; the driver additionally discards its local checkpoint so the candidate cannot be re-submitted.
- Auth errors (401/403) remain operator-facing stops; any new fatal error class must be added explicitly to the userscript handler.
