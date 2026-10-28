# Real acceptance — delivery passed, terminal cleanup failed

**Overall Real Integration profile: FAILED / incomplete.** Native Delivery recovered the injected faults, automatically merged [dogfood PR #30](https://github.com/felixjichao/symphony-delivery-dogfood/pull/30), and closed [Issue #29](https://github.com/felixjichao/symphony-delivery-dogfood/issues/29). The same host refused terminal workspace cleanup. The retained directory was not manually deleted. Product #192 remains open/Draft pending that final criterion.

## Provenance and execution boundary

2026-10-28, Asia/Shanghai. Event files use UTC. [Build record](build.json) pins source base `b1fc8325a2b9e87768adfff7323890d80b3ff336`, the [production source patch](product-source.patch), its SHA-256 and the actual CLI bundle hash. This run includes the host-owned staging fix beyond `b1fc832`; it must not be attributed to unmodified `b1fc832`. Codex version: `0.165.0-alpha.1.2`.

The [captured harness](harness-source.mjs.txt) launches the built native host and authenticated native Decision Bridge on isolated loopback ports. A real Codex app-server implements the change. An operator-owned `after_run` hook invokes the native Delivery CLI outside the coding sandbox. The default conflict executor remains `codex exec --sandbox workspace-write -`; the trusted host validates/stages resolved files. No sandbox or approval policy was weakened.

Plan and both Reviews use separate real `codex exec --sandbox read-only` processes. Reviewers inspect separate immutable checkouts at the exact task SHA. Their actual structured verdicts are submitted through native claim/start/result APIs; verdicts are not fixtures. [Plan receipt](plan-1-receipt.json), [first Review receipt](review-1-receipt.json), [second Review receipt](review-2-receipt.json) and [final task/results](review-results-final.json) retain the native identities. This is independent Codex Review evidence, **not ChatGPT browser/Userscript UI acceptance**.

## Actual chain and faults

| UTC | Observed event |
|---|---|
| 07:51:36 | Native host PID 19694 starts, isolated store/root and run-only tracker label |
| 07:53:44 | Ignored runtime probe exists in the actual issue workspace |
| 07:56:34 | Harness advances real main to `21207bef5b29290176bb6f32e768dc79f8c551f1`, changing the same source object line and adding a base test |
| 07:57:07 | First native Review status GET returns injected HTTP 503; original task/revision continues |
| 07:58:07 | Independent Review 1 approves original HEAD `9f9e8db67db04e2878ecbef2c58bff5f59ad3cea` |
| 07:58:22 | Exactly one native conflict executor starts |
| 07:59:01 | Real repair push succeeds; wrapper returns a transport error, then first authoritative ref read times out |
| 07:59:08 | First subsequent PR projection returns the old HEAD; later reads confirm the repair SHA |
| 08:00:24 | Independent Review 2 approves repair HEAD `c37fcf7ea8fa6b342187e1d013a30314ef863369` |
| 08:00:35 | Native Delivery reports PR merged, Issue closed; coding worker completes |
| 08:00:37 | Host continuation observes terminal work, but native cleanup logs `cleanup_refused` |
| 08:05:00 | Operator gracefully stops the completed test host/Bridge after collecting the failure; no restart during the injected-fault window |

[Conflict readback](conflict-before-repair.json) is real `OPEN/CONFLICTING`; its stale PR base projection differs from the authoritative pinned base. [Repair commit](repair-commit.json) proves two parents and no runtime source delta. The repair retains both feature/base implementations and tests.

Real CI succeeded on [original HEAD / run 40653327605](https://github.com/felixjichao/symphony-delivery-dogfood/actions/runs/40653327605) and [repair HEAD / run 40653594797](https://github.com/felixjichao/symphony-delivery-dogfood/actions/runs/40653594797). [Final PR facts](pr-final.json) bind the merge to squash commit `09222d9744542a708e52ac81e0532a6403d6a7b7`.

[Invariant summary](invariant-summary.json) checks all 20 sampled Delivery states: unpaused, one unchanged absolute deadline, one repair operation, repair budget 1, one repair executor, one repair push, zero ready-label removals and zero handoff comment writes. [Command trace](commands.ndjson), [injection receipts](injection-receipts.json), [state sequence](delivery-states.ndjson) and [native CLI log](delivery-cli.log) identify exact fault boundaries. Only read responses and the return value of an already successful push were changed. No write was repeated to make the scenario pass.

Live scope covers T1–T4 and initial/conflict runtime isolation. Separate CI/Review repair-path runtime combinations, forced missing-new-CI negative controls, exhaustion/auth/foreign-identity cases remain local controlled evidence; they are not silently promoted to live coverage.

## Cleanup blocker

[Acceptance readback](acceptance-readback.json) records merged PR, closed Issue, observed landing receipt, zero pause, one spent repair, workspace still present and surviving root sentinel. The final Delivery continuation has exact-target `result_observed/approve` and `landing.observed`; Delivery locks are gone. The [host log](host.log) records cleanup refusal, not cleanup success.

Source investigation points to the existing terminal continuation path in `packages/orchestrator/src/authority.ts`: it calls `cleanupTerminalWorkspace` while its durable retry reservation is still present; `removeWorkspaceFor` refuses deletion on that reservation, then the caller releases it. Readback subsequently shows an empty durable reservation list. This ordering is a source-based diagnosis, not a completed cleanup repair. No orchestrator guard was bypassed or changed in this PR.

The driver was deliberately stopped after the refusal. Its original generic cancellation guard printed `Live acceptance deadline exhausted`; [stop classification](stop-reason.json) distinguishes operator cancellation from native Delivery or harness deadline exhaustion. No budget/deadline/state was reset.

## Original safety refusal retained

The existing [PR #7](https://github.com/felixjichao/symphony-delivery-dogfood/pull/7) was checked with the actual native `pr land --expected-head <observed SHA> --opt-in` and a real empty authenticated Bridge. It returned exit 1, `merge_rejected`, and `PR #7 has merge conflicts with main`. [Result](safety-pr7-land-result.json), [before](safety-pr7-before.json) and [after](safety-pr7-after.json) prove unchanged OPEN/CONFLICTING HEAD. An earlier UNKNOWN read is retained separately and was not counted as passing.
