# Execution-continuity acceptance ledger

Scope: NEST-135 / GitHub #151, parent #145; SPEC §4 adjacent, §7/§8/§14/§17/§18.
Initial test baseline: `main@627daa2164f2a8cdbad67b05d860300ecb822db2` (PR #158 squash).
Closeout baseline: `main@7e10c91d5693ef63f438490cbfd1886105b22225` (PR #163 merge).

**W03 bounded convergence is accepted**: installed Driver 0.1.6 and the complete
host move a restored page from Waiting to Blocked, without replay, after browser
quit/reopen. Seamless browser-session resume remains unaccepted/deferred. #162 is
closed through merged PR #163. The [closeout assessment](closeout-2026-10-23.md)
reconciles #159 → #162 → #163 evidence with the maintainer's approved support boundary.
After this documentation closeout passes gate, review and merge, #151 is ready for
closure and parent #145 for final acceptance/closure; neither is closed by this ledger.

Credential-free production-equivalent tests and scoped live evidence remain distinct.
Unexercised live combinations below are explicitly deferred, never relabeled live passed.

The matrix contains **29 scenario IDs**. [Current assessment JSON](closeout-results-2026-10-23.json) records the accepted support boundary; the dated original results retain their historical run identities.

## Scenario matrix

Suite names below are source basenames (`src/<name>.test.ts` for CLI, Decision,
orchestrator and agent). “Web full suite” means `npm test -w @symphony/chatgpt-web`.
Each automated result must be read with the exact run identity in [run record](run-2026-10-22.md).
Automated passed identifies suite evidence for the stated invariant, not exhaustive
production-composition or live acceptance of every interruption variant.
Current live evidence is limited to the explicitly recorded variants; it does not imply exhaustive acceptance of a row. Each row has scoped automated evidence for the supported invariant. Additional live combinations are non-exhaustive/deferred under the [accepted coverage profile](closeout-2026-10-23.md#coverage-and-deferred-variants).

| ID | Required interruption | Native entry / suites | Injection / observation | Required convergence | Automated result | Current live result |
|---|---|---|---|---|---|---|
| H01 | Kill after intent, before effect | CLI durable-delivery | review_intent / merge_intent | same Review receipt; one merge | passed (see run record) | not run live; additional live variants deferred |
| H02 | Kill after effect, before ACK | CLI durable-delivery | review_effect / merge_effect | remote readback; no repeated effect | passed (see run record) | not run live; additional live variants deferred |
| H03 | Kill after ACK, before cleanup | CLI durable-delivery | review_ack / merge_ack | native continuation completes | passed (see run record) | not run live; additional live variants deferred |
| H04 | Restart pending compensation | CLI durable-delivery, landing-recovery | report ACK loss / target drift | marker dedupe or stale refusal | passed (see run record) | not run live; additional live variants deferred |
| H05 | Duplicate startup | CLI work-continuity, durable-retry | host startup / UTC due restoration | one Review; no coding replay | passed (see run record) | blocked-host restart/deduplicated incident passed ([core run](core-acceptance-2026-10-23.md)); other live variants deferred |
| H06 | Concurrent recovery | CLI durable-delivery, recovery-ledger | independent lock / reporter claims | exclusive commit; successor nonce retained | passed (see run record) | not run live; additional live variants deferred |
| W01 | Claimed Web executor disappears | CLI work-continuity; Decision continuity | expired claim / lost execution | pre-Send reclaim; uncertain Send blocks | passed (see run record) | not run live; additional live variants deferred |
| W02 | Reload during navigation/execution | [Exact Web tests](#web-test-index-w02-w05-w08) | checkpoint / receipt reconstruction | fenced resume or explicit block | passed (see run record) | reload during generation passed ([2026-10-23](run-2026-10-23.md)); other live variants deferred |
| W03 | Driver/service restart with checkpoint | [Exact Web tests and boundary](#web-test-index-w02-w05-w08); Decision continuity | store reopen / rebuilt driver | safe resume or explicit bounded block; no repeated Send | passed (see run record) | **bounded convergence accepted** ([Driver 0.1.6](recovery-hud-fix-2026-10-23.md), [native readback](recovery-hud-result-2026-10-23.json)); host restart passed ([core run](core-acceptance-2026-10-23.md)); seamless resume deferred |
| W04 | Bridge timeout after accepted result | [Exact receipt tests](#web-test-index-w02-w05-w08) | accepted receipt after admission changes | receipt-first completion | passed (see run record) | accepted-result ACK loss passed with real ChatGPT ([2026-10-23](run-2026-10-23.md)) |
| W05 | Bridge unavailable before acceptance | [Exact transport tests](#web-test-index-w02-w05-w08) | transport unavailable / result retry | bounded retry or block | passed (see run record) | not run live; additional live variants deferred |
| W06 | Stale lease returns after reclaim | Decision continuity | expired generation / stale reclaim | stale mutation rejected | passed (see run record) | not run live; additional live variants deferred |
| W07 | Stale binding after rebind | Decision continuity | idempotent rebind | old binding progress rejected | passed (see run record) | not run live; additional live variants deferred |
| W08 | Supersede during recovery | [Exact supersede test](#web-test-index-w02-w05-w08); Decision continuity | admission barrier / supersede | revalidate current task | passed (see run record) | not run live; additional live variants deferred |
| W09 | PR HEAD changes | CLI durable-delivery, decision-web-admission; Decision continuity | HEAD drift during downtime/admission | old target cannot approve/merge | passed (see run record) | not run live; additional live variants deferred |
| W10 | Auth/human path | CLI work-continuity, review-regressions; Decision continuity | native block / host reconstruction | blocked; queryable deduplicated incident | passed (see run record) | API-injected auth block survives full host restart ([core run](core-acceptance-2026-10-23.md)); actual login/human UI deferred |
| L01 | Worker stops progress | orchestrator workflow-integration | stall with real subprocess | old process exits before retry | passed (see run record) | not run live; additional live variants deferred |
| L02 | Child ignores normal exit | agent transport | SIGTERM refusal | SIGKILL; PID disappearance | passed (see run record) | not run live; additional live variants deferred |
| L03 | Tracker outage during reconcile | CLI work-continuity, review-regressions | source failure / recovery | owner and block retained; fresh re-observation | passed (see run record) | not run live; additional live variants deferred |
| L04 | Restart loses retry timer | CLI durable-retry | SIGKILL / new monotonic clock | restore UTC due and fresh admission | passed (see run record) | not run live; additional live variants deferred |
| P01 | Repeated failure escalates | orchestrator recovery-policy | capability/strategy budget | finite supported strategies only | passed (see run record) | not run live; additional live variants deferred |
| P02 | Budget exhaustion | CLI recovery-ledger, recovery-review-regressions | independent processes / native worker failures | durable recovery_exhausted; no timer | passed (see run record) | native worker budget + full host restart passed ([core run](core-acceptance-2026-10-23.md)); Web live strategies deferred |
| P03 | One incident per epoch/fingerprint | CLI recovery-ledger, host-recovery | ACK loss / concurrent reporters | one incident; ambiguous POST never blindly resent | passed (see run record) | not run live; additional live variants deferred |
| P04 | Authoritative target/generation changes | CLI host-recovery; Decision continuity | new HEAD/task vs binding only | new scope only for semantic target; old callbacks fenced | passed (see run record) | not run live; additional live variants deferred |
| P05 | Blocked condition changes | CLI host-recovery, recovery-review-regressions | modeled ownership / explicit authorization | only modeled ownership conflict auto-clears | passed (see run record) | not run live; additional live variants deferred |
| R01 | Non-ownership invariant retention | CLI recovery-review-regressions | invalid_workspace_cwd / legacy incident | ordinary observation cannot clear epoch | passed (see run record) | not run live; additional live variants deferred |
| R02 | Continuation/capacity budget isolation | CLI recovery-review-regressions | six waits; restart; first failed worker | zero wait charge; first failure counts once | passed (see run record) | not run live; additional live variants deferred |
| R03 | Native Review/Delivery human block | CLI review-regressions, recovery-review-regressions | real needs-human / manual pause | queryable incident; compensation cannot bypass pause | passed (see run record) | not run live; additional live variants deferred |
| A01 | Observation Plane remains read-only | operations full suite | boundaries / source readers | no retry/resume/merge authority | passed (see run record) | not run live; additional live variants deferred |

## Web test index (W02-W05, W08)

Names below are exact `it` titles, not paraphrased acceptance claims. Paths are
relative to the repository root. These tests ran in the original 216-test Web
suite; a later focused rerun is recorded in the [review follow-up](run-2026-10-22.md#review-follow-up).

| IDs | File | Exact test name | Evidence boundary |
|---|---|---|---|
| W02 | [driver.test.ts](../../../apps/chatgpt-web/test/driver.test.ts) | `recovers waiting_response checkpoint by waiting for existing response without resending prompt (R3)` | Reconstructed checkpoint/driver, fixture adapter; no real browser reload |
| W02 | [fixture-e2e.test.ts](../../../apps/chatgpt-web/test/fixture-e2e.test.ts) | `recovers from navigating checkpoint across tab destruction and new tab reconstitution with real bridge (E2E)` | Real HTTP Bridge, fixture DOM/tab; no browser process restart |
| W03 | [userscript-entry.test.ts](../../../apps/chatgpt-web/test/userscript-entry.test.ts) | `auto-starts across reconstruction, consumes checkpoint, and completes work against controlled bridge` | Reconstructed userscript controller, real Bridge/store, fixture DOM; not a service-process restart |
| W03 | [continuity.test.ts](../../../packages/decision/src/continuity.test.ts) | `recovery budget survives reclaim and store reopen, then converges to blocked` | Same store object closed/reopened; not a Decision/Bridge process restart |
| W04 | [review-continuity-regressions.test.ts](../../../apps/chatgpt-web/test/review-continuity-regressions.test.ts) | `a receipt that already accepted the candidate completes without another submission` | Native accepted result plus injected transport; receipt-first no-resubmit proof |
| W04 | [continuity.test.ts](../../../packages/decision/src/continuity.test.ts) | `returns an already accepted result receipt after admission changes` | Native service receipt idempotency, not a real provider timeout |
| W05 | [driver.test.ts](../../../apps/chatgpt-web/test/driver.test.ts) | `preserves candidateResult in checkpoint and does not call /fail on network transport error (S3)` | Injected transport failure; candidate retained |
| W05 | [review-continuity-regressions.test.ts](../../../apps/chatgpt-web/test/review-continuity-regressions.test.ts) | `stops re-submitting at the budget, verifies the receipt first and blocks with the candidate retained` | Finite transport budget and native block; no real network outage |
| W08 | [driver.test.ts](../../../apps/chatgpt-web/test/driver.test.ts) | `resolves supersede race on checkpoint resume candidate result submission (V1)` | Injected race, stale continuation rejected; not live UI evidence |

The CLI host reconstruction test also retains the same DecisionService/store. It
proves host recreation and durable ledger/query wiring, not Decision, Bridge or
browser process restart. Subsequent full-process host evidence and the unaccepted browser
resume attempt are recorded below; neither is implied by this reconstruction test.

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

## 2026-10-23 follow-up

[Merge and environment verification](run-2026-10-23.md) records a real isolated Bridge SIGKILL/restart and exact durable HTTP readback. The operator-confirmed current Driver also passed real ChatGPT generation/reload and accepted-result ACK-loss variants. This earlier run did not cover full host/browser restart. Later core and #162 records below supply those scoped boundaries; additional provider/UI variants remain deferred.

## Core follow-up on 2026-10-23

[Complete host restart and native budget exhaustion](core-acceptance-2026-10-23.md) use real GitHub reads, isolated production createHost/Bridge processes and genuine fail-fast worker exits. The auth block and incident survive SIGKILL; an exhausted retry budget remains blocked after another full host restart. The later #162/PR #163 evidence below accepts browser-process bounded blocking; additional provider/UI variants remain deferred.

## Initial full browser quit/reopen attempt (historical)

[W03 browser-process acceptance](browser-process-acceptance-2026-10-23.md) was executed with operator permission. Old process absence and a new PID were verified through native UI. Automatic resume was not established: restored home tab, empty diagnostics, original task still waiting_response and receipt 404. This initial attempt did not prove safe resume and remains unaccepted for seamless resume. The later complete-host and Driver 0.1.6 runs below supersede its closeout posture by proving bounded visible blocking; the original readback is retained unchanged.

## #162 bounded-convergence follow-up — 2026-10-23

[Complete-host browser follow-up](bounded-browser-acceptance-2026-10-23.md) observes a
native-created test window losing its executor after clean quit/reopen, then a durable
human-required block 27.296 seconds after the last lease expired, with no result POST.
This was the initial bounded-convergence observation; the agent-tab comparison and
Driver 0.1.6 installed-version run below complete the accepted conservative path.
Seamless session restoration remains unaccepted/deferred. The matching automatic check is
`apps/cli/src/work-continuity.test.ts` → `W03: full host and authenticated Bridge block a lost waiting_response owner at lease expiry without replay`.


## #162 agent-tab quit/reopen comparison — 2026-10-23

[Agent-managed tab follow-up](agent-browser-acceptance-2026-10-23.md) completes the
previously interrupted process-boundary experiment: old PID 8768 absent, new PID
32189, same browser tab restored at home with Running / diagnostics []. Native
DevTools readback shows `symphony_tab_id` created after reopen. The complete host
blocked the missing executor 23.019 seconds after lease expiry; receipt 404, zero
result POSTs, and replacement claim / old heartbeat rejected with 409. Native-window
and agent-tab variants now both have bounded-block observations; seamless resume
remains unaccepted and storage durability has not been disproved.


## #162 recovery visibility repair — Driver 0.1.6

[Repair and current-install verification](recovery-hud-fix-2026-10-23.md) fixes the
restored page's misleading Running state. Waiting/Blocked are observed from native
Bridge facts, with no ownership adoption or replay. Seamless resume is not implied.

The final installed-version run measured 22.913 seconds from lease expiry to native
block, with Waiting → Blocked visible on the restored page, claim/binding generation
1, receipt 404, zero Driver POSTs after quit and HTTP 409 for old heartbeat/replacement
claim. This is the accepted W03 outcome. Earlier empty-diagnostics evidence is a
preserved pre-fix observation, not the current #162 status. See the
[closeout assessment](closeout-2026-10-23.md) for proof, timing limits and deferred variants.
