# Agent Note: Web heartbeat interruptions retain sent attempts
Status: accepted

## Problem

Issue #184 reproduces a heartbeat 409 aborting an active adapter wait, which the
coordinator converted to a generic failure and the Driver converted to a native
`human_required` block while deleting its checkpoint. This concerns SPEC §4
Decision extensions and §13 adjacent diagnostics. The historical initiating
failure remains unknown; a GitHub outage is not established by this reproduction.

## Decision

The coordinator propagates an aborted signal's reason before recording adapter
failures and checks cancellation before result submission. Driver heartbeats carry
typed interruption reasons; denial and Stop preserve the sent checkpoint. Recovery
heartbeat failures retain the checkpoint and return the technical error without
starting page actions or manufacturing a human verdict. Subsequent polling must
re-observe task, claim, binding, lease, current target and receipts through the
existing fenced paths; retaining evidence never grants permission to resend.

The existing boolean execution-admission port returns false for an observed
changed/closed target. The CLI throws a sanitized `DecisionStoreError` with code
`execution_observation_unavailable` and status 503 when GitHub cannot be observed
(nonzero exit, timeout, malformed payload or transport exception). The Bridge
preserves that category at recovery, heartbeat and result-admission boundaries.
Both categories deny Send/result acceptance. Active transient heartbeat failures
can continue observation only within the existing lease and progress budgets.

Bounded local Driver diagnostics persist stage, task/revision, interruption reason,
HTTP status, claim/binding generations and timestamp through the existing whitelist.
They retain neither credentials, raw errors nor response text.

## Alternatives considered

- Map every admission failure to false/409: loses the initiating failure category.
- Block every interruption as `human_required`: invents a product decision and
  prevents ordinary technical recovery.
- Delete or replay an uncertain sent attempt: loses evidence or duplicates Send.
- Extend leases despite unavailable GitHub authority: weakens current-target checks.

## Consequences

True human decisions, native recovery budgets, receipt matching and host merge
checks remain authoritative. Unavailable observations can consume bounded recovery
budgets; they do not reset them. These are deterministic isolated tests, not a
production intervention or new live-browser acceptance claim.
