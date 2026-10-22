# Agent Note: Active Web response recovery fencing
Status: accepted

## Problem

PR #156 browser acceptance reported lost active responses after authentication
failure, conversation changes and review HEAD changes. Local regressions reproduce
swallowed heartbeat authorization errors, checkpoint deletion despite a renewed
native lease, and extraction from an unrelated route. These are Decision extensions
adjacent to SPEC §4 / §13.

## Decision

Report heartbeat 401/403 through the existing userscript authorization recovery
path immediately, abort the active wait and retain its checkpoint. An interrupted
wait cannot record a terminal failure just because the Bridge becomes reachable
again. Read the authoritative lease before deciding whether a local waiting
checkpoint expired. An actually expired sent attempt retains local evidence and
requires inspection; it cannot submit with expired credentials or replay Send.

Check the exact bound conversation and page health before and after recovered
response extraction. Route drift or a missing conversation records a native
nonterminal human block instead of rebinding and replaying an uncertain prompt.

Use the existing host-provided execution admission port on every heartbeat and
before first result acceptance. Revalidate native task/claim/binding facts in the
transaction after admission I/O. Existing accepted receipts remain idempotently
readable after an external HEAD change. This does not make remote GitHub observation
and the local store transaction atomic; delivery still validates the exact HEAD.

## Alternatives considered

- Trust local expiry: a lost renewal response can make it older than native authority.
- Rebind/replay a sent task on another route: cannot prove the first prompt had no effect.
- Check HEAD only before Send: HEAD can change while the model responds.
- Reject receipt replay after HEAD changes: loses confirmation of prior acceptance.

## Consequences

Admission now performs read-only external observation during active waits and first
result submission. Missing authority fails closed. Lost tab identity remains a
native human block after uncertain Send, with no credential adoption or generation
2 prompt. Automated regressions supplement the historical browser failures; fresh
ChatGPT/Tampermonkey fault acceptance remains pending.
