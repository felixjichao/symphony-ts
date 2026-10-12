# NEST-104 real planning → delivery integration

On 2026-10-11 an explicitly authorized isolated run completed the real pre-execution planning → delivery chain for Issue #99 / NEST-104:

GitHub-published `ready` plan → host dispatch gate → real Codex implementation → real GitHub CI → same-session exact-HEAD Decision Review `approve` → production delivery skill automatic squash merge → issue closure → restart-time terminal workspace cleanup.

This was a recovered run with operator intervention (below), not an uninterrupted harness pass. No operator implemented the feature or merged the target PR; those effects used real Codex and the production delivery CLI.

## Versions and provenance

- Product runtime: `symphony-ts` PR [#107](https://github.com/felixjichao/symphony-ts/pull/107) head `4c991876bb7dc6ac2aab1817d5008c09a9e165f1`; docs-only follow-up `ab7da2f0168a343ea3da821f9f32afc11ab20300`; merged as `a9d114c4e82e0a9e77291808f430b30f080144d8`.
- Target: [`symphony-delivery-dogfood#20`](https://github.com/felixjichao/symphony-delivery-dogfood/issues/20) → [`PR #21`](https://github.com/felixjichao/symphony-delivery-dogfood/pull/21).
- Browser: existing installed ChatGPT Web driver; its bundle SHA was **not** verified, so it is not claimed as #107-self-contained evidence.
- **Provenance split.** Files in this directory are captured from public GitHub (plan comment, handoff, PR/CI/issue read-backs) or from the operator's report. The internal Decision store receipts (Plan/Review task records, result receipts, binding generation) and the raw host/delivery process logs live in the operator's run environment and are **not** captured here; see [Pending operator exports](#pending-operator-exports).

## Read-back facts (GitHub-verifiable)

| Stage | Exact commit / result | Evidence |
| --- | --- | --- |
| Persistent plan published | `ready`, revision 1, fingerprint `200f14c1fff88254e71136ed852142012b3526ef043205fb3145e4c6f33510f4` | [plan comment](plan-comment.md) |
| Delivery halt | `manual_intervention_required`, `.git/index.lock: Operation not permitted` | [handoff report](delivery-handoff.md) |
| Target PR | head `e24c7585e4f98f379d9e8739bdbd6aba7ff8b749`, merge `2525eb4412f24601226a1efbd539f8a697b14980` | [PR read-back](pr-21.json) |
| Target CI | `success` on `e24c758` | [CI read-back](ci-run.json), [run](https://github.com/felixjichao/symphony-delivery-dogfood/actions/runs/38134414338) |
| Issue closure | closed `2026-10-11T11:09:09Z` | [issue read-back](issue-20.json) |
| Product PR merge | merged `2026-10-11T11:26:42Z` | [PR #107](https://github.com/felixjichao/symphony-ts/pull/107) |

## Chain evidence source

The internal-chain steps (same Issue-rooted `DecisionSession` Plan rev1 / Review rev2, ChatGPT conversation `6acb6a38-a5fc-83ea-9a4f-8580f0e510fc` generation 1, Review context carrying the published plan, production merge, and restart-time cleanup) come from the operator's re-validation report: [symphony-ts PR #107 comment](https://github.com/felixjichao/symphony-ts/pull/107#issuecomment-6108399283), captured verbatim as [operator-report.md](operator-report.md). The reviewer independently cross-checked the GitHub facts above and recomputed the plan fingerprint against the real issue title/body.

## Operator interventions (retained)

1. The original `--resume` correctly preserved an expired deadline and stopped with `ci_wait_timeout` after commit/push/PR creation; the operator saved state and opened a fresh bounded 900s attempt reusing the same PR/session/plan — not an extension of the original persisted budget.
2. An archived state file was accidentally committed inside the workspace; it was moved outside and its removal committed through the production delivery entry. The final diff was verified to contain only implementation and tests.
3. The stale HEAD `5645f80…` Review returned `changes_requested`; that task was superseded, so the Bridge did not accept the stale result, and the Driver stopped with `Cannot fail superseded task`, requiring a manual **Start**. A new revision-2 Review on the new HEAD was independently approved before merge.
4. The Web Driver used the existing installed bundle; its SHA was not verified.

## Validation and limits

- Target: 9/9 tests and lint pass; CI green on the exact reviewed HEAD `e24c758`.
- Product Linux gate green at `4c99187` (`1510 passed / 2 skipped`); the later `ab7da2f` delta is docs-only.
- The operator's macOS local `npm run gate` retains unrelated `agent` / `workspace` timeout-cleanup failures; not claimed green cross-platform.
- Not exercised in a real environment: `needs_clarification` / `needs_human` branches, lost-conversation binding rollover, and the full requirements-changed replan flow (the observed `requirements_changed` was a read-only probe).
- This proves the recovered controlled-fault real integration chain; it does not authorize any further product repository merge.

## Pending operator exports

For fully independent verification of the internal chain, the operator can export sanitized receipts from the run store/process logs and attach them here. At minimum:

- Plan/Review task records and submitted result receipts (the `approve` bound to `e24c758`), with lease/claim tokens removed.
- Session binding generation and the Review context referencing the published plan.
- Production delivery log lines (`Review approved … Proceeding to land`) and the restart workspace-cleanup log line.

Suggested shape: reuse the redaction applied to the [NEST-103 evidence](../nest103/README.md) (strip lease/claim credentials and auth strings; keep result payloads unchanged).
