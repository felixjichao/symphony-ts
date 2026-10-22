# Execution-continuity acceptance ledger

Scope: NEST-135 / GitHub #151, parent #145; SPEC §4 adjacent, §7/§8/§14/§17/§18.
Baseline: `main@627daa2164f2a8cdbad67b05d860300ecb822db2` (PR #158 squash).
This ledger separates credential-free production-equivalent tests from live acceptance.
A passing fixture does not close a live gap. Parent #145 is **not ready to close**.

## Scenario matrix

Suite names below are source basenames (`src/<name>.test.ts` for CLI, Decision,
orchestrator and agent). “Web full suite” means `npm test -w @symphony/chatgpt-web`.
Each automated result must be read with the exact run identity in [run record](run-2026-10-22.md).
Automated passed identifies suite evidence for the stated invariant, not exhaustive
production-composition or live acceptance of every interruption variant.
This inventory is not a claim that any row has current live evidence.

| ID | Required interruption | Native entry / suites | Injection / observation | Required convergence | Automated result | Current live result |
|---|---|---|---|---|---|---|
| H01 | Kill after intent, before effect | CLI durable-delivery | review_intent / merge_intent | same Review receipt; one merge | passed (see run record) | not run |
| H02 | Kill after effect, before ACK | CLI durable-delivery | review_effect / merge_effect | remote readback; no repeated effect | passed (see run record) | not run |
| H03 | Kill after ACK, before cleanup | CLI durable-delivery | review_ack / merge_ack | native continuation completes | passed (see run record) | not run |
| H04 | Restart pending compensation | CLI durable-delivery, landing-recovery | report ACK loss / target drift | marker dedupe or stale refusal | passed (see run record) | not run |
| H05 | Duplicate startup | CLI work-continuity, durable-retry | host startup / UTC due restoration | one Review; no coding replay | passed (see run record) | not run |
| H06 | Concurrent recovery | CLI durable-delivery, recovery-ledger | independent lock / reporter claims | exclusive commit; successor nonce retained | passed (see run record) | not run |
| W01 | Claimed Web executor disappears | CLI work-continuity; Decision continuity | expired claim / lost execution | pre-Send reclaim; uncertain Send blocks | passed (see run record) | not run |
| W02 | Reload during navigation/execution | Web full suite | checkpoint / receipt reconstruction | fenced resume or explicit block | passed (see run record) | not run |
| W03 | Driver/service restart with checkpoint | Web full suite; Decision continuity | store reopen / rebuilt driver | no repeated Send | passed (see run record) | not run |
| W04 | Bridge timeout after accepted result | Decision continuity; Web full suite | accepted receipt after admission changes | receipt-first completion | passed (see run record) | not run |
| W05 | Bridge unavailable before acceptance | Web full suite | transport unavailable / result retry | bounded retry or block | passed (see run record) | not run |
| W06 | Stale lease returns after reclaim | Decision continuity | expired generation / stale reclaim | stale mutation rejected | passed (see run record) | not run |
| W07 | Stale binding after rebind | Decision continuity | idempotent rebind | old binding progress rejected | passed (see run record) | not run |
| W08 | Supersede during recovery | Decision continuity; Web full suite | admission barrier / supersede | revalidate current task | passed (see run record) | not run |
| W09 | PR HEAD changes | CLI durable-delivery, decision-web-admission; Decision continuity | HEAD drift during downtime/admission | old target cannot approve/merge | passed (see run record) | not run |
| W10 | Auth/human path | CLI work-continuity, review-regressions; Decision continuity | native block / host reconstruction | blocked; queryable deduplicated incident | passed (see run record) | not run |
| L01 | Worker stops progress | orchestrator workflow-integration | stall with real subprocess | old process exits before retry | passed (see run record) | not run |
| L02 | Child ignores normal exit | agent transport | SIGTERM refusal | SIGKILL; PID disappearance | passed (see run record) | not run |
| L03 | Tracker outage during reconcile | CLI work-continuity, review-regressions | source failure / recovery | owner and block retained; fresh re-observation | passed (see run record) | not run |
| L04 | Restart loses retry timer | CLI durable-retry | SIGKILL / new monotonic clock | restore UTC due and fresh admission | passed (see run record) | not run |
| P01 | Repeated failure escalates | orchestrator recovery-policy | capability/strategy budget | finite supported strategies only | passed (see run record) | not run |
| P02 | Budget exhaustion | CLI recovery-ledger, recovery-review-regressions | independent processes / native worker failures | durable recovery_exhausted; no timer | passed (see run record) | not run |
| P03 | One incident per epoch/fingerprint | CLI recovery-ledger, host-recovery | ACK loss / concurrent reporters | one incident; ambiguous POST never blindly resent | passed (see run record) | not run |
| P04 | Authoritative target/generation changes | CLI host-recovery; Decision continuity | new HEAD/task vs binding only | new scope only for semantic target; old callbacks fenced | passed (see run record) | not run |
| P05 | Blocked condition changes | CLI host-recovery, recovery-review-regressions | modeled ownership / explicit authorization | only modeled ownership conflict auto-clears | passed (see run record) | not run |
| R01 | Non-ownership invariant retention | CLI recovery-review-regressions | invalid_workspace_cwd / legacy incident | ordinary observation cannot clear epoch | passed (see run record) | not run |
| R02 | Continuation/capacity budget isolation | CLI recovery-review-regressions | six waits; restart; first failed worker | zero wait charge; first failure counts once | passed (see run record) | not run |
| R03 | Native Review/Delivery human block | CLI review-regressions, recovery-review-regressions | real needs-human / manual pause | queryable incident; compensation cannot bypass pause | passed (see run record) | not run |
| A01 | Observation Plane remains read-only | operations full suite | boundaries / source readers | no retry/resume/merge authority | passed (see run record) | not run |

## Cross-cutting assertions

H01–H06/L04 require fresh native files and remote facts, idempotency and stale-token
refusal. W06–W09 require stale leases/bindings/HEAD to fail closed. L03 requires no
ownership change on unavailable facts. W10/P02/P05 distinguish blocked from queued
retry and terminal failure. R02 covers legitimate waiting; A01 preserves read-only
operations. Unknown Send, launch, repair and merge effects must have explicit blocked
reasons rather than command replay. Reporter failure leaves a locally queryable incident.

## Reproduction commands

From the repository root after `npm ci`:

```sh
npm test -w @symphony/cli -- src/durable-delivery.test.ts src/durable-retry.test.ts src/recovery-storage.test.ts src/landing-recovery.test.ts src/work-continuity.test.ts src/host-recovery.test.ts src/recovery-ledger.test.ts src/recovery-review-regressions.test.ts src/review-regressions.test.ts src/decision-web-admission.test.ts
npm test -w @symphony/decision -- src/continuity.test.ts
npm test -w @symphony/chatgpt-web
npm test -w @symphony/orchestrator -- src/workflow-integration.test.ts src/recovery-policy.test.ts src/work-continuity.test.ts
npm test -w @symphony/agent -- src/transport.test.ts
npm test -w @symphony/operations
npm run typecheck
npm run gate
```

Default gate uses no external credentials. Live checks are a separate, explicit
operator-run profile in [live procedure](live-procedure.md); no skipped live tests
are added to gate as substitutes for acceptance.

## Evidence per execution

Copy [template](template.json) for each live scenario. Record safe owner/generation,
WorkKey, task/revision/HEAD/epoch, precise fault barrier, native before/after readback,
expected deadline and measured convergence, rejected stale operation and unchanged
current state, incident/outbox marker, artifact hashes, target cleanup and limitations.
Do not commit lease tokens, auth stores, raw conversations or account sidebars.

## Historical evidence

[Web final gates](../web-continuity/final-gates-2026-10-22.md) and
[userscript 0.1.5 acceptance](../web-continuity/live015-acceptance-2026-10-22.md)
remain scoped historical evidence. Their build restrictions remain in force; neither
is a live pass of the current host + driver + userscript composition.
