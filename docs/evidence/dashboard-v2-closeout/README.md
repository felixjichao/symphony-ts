# Dashboard V2 closeout evidence (#176, SPEC §13 adjacent)

Baseline: `53d6d1b01fe3c9e742af2cd26b90338545d9cea1`. The following GitHub records were read on 2026-10-29; issue closure and PR merge are established by GitHub, not proof of every self-hosting stage. The PR HEADs below are distinct from squash merge commits.

| Issue | Merged PR | PR HEAD | Merge commit | Recovery incident comments |
| --- | --- | --- | --- | --- |
| [#169](https://github.com/felixjichao/symphony-ts/issues/169) | [#178](https://github.com/felixjichao/symphony-ts/pull/178) | `c0d38f54f4ecb820e23e1ec71b87f9b5d7cebaa2` | `cb671b740b84802fc231bed88e8d67277ac9f48c` | 3 |
| [#170](https://github.com/felixjichao/symphony-ts/issues/170) | [#181](https://github.com/felixjichao/symphony-ts/pull/181) | `8620dfca6b615210ec8b8ae680aaf97a49382ec8` | `e1b109fe4dcc336c267360e5d2a803108e09f8c7` | 1 |
| [#171](https://github.com/felixjichao/symphony-ts/issues/171) | [#183](https://github.com/felixjichao/symphony-ts/pull/183) | `fc628b794b5b9f60a5666e60375c28a07a757525` | `c7581629c4bec7191e144efd415781971c4cef58` | 8 |
| [#172](https://github.com/felixjichao/symphony-ts/issues/172) | [#190](https://github.com/felixjichao/symphony-ts/pull/190) | `abd6c65d280fc9649ca27809aad6a0663f4340a2` | `6a870be2183100af2df3f75c536f55dc91156d98` | 2 |
| [#173](https://github.com/felixjichao/symphony-ts/issues/173) | [#191](https://github.com/felixjichao/symphony-ts/pull/191) | `caa16c9cafc79e182dfd4623fb1985e5e40963ff` | `3b5eb8ff0b33c5a8c0fb81301017c10fbf638bb5` | 4 |
| [#174](https://github.com/felixjichao/symphony-ts/issues/174) | [#194](https://github.com/felixjichao/symphony-ts/pull/194) | `a296d907bea1fcd7e3dc272a922b6d03c9b68237` | `2f7300bc201db3164121e07f7fe5f2c08d5a4162` | 4 |
| [#175](https://github.com/felixjichao/symphony-ts/issues/175) | [#195](https://github.com/felixjichao/symphony-ts/pull/195) | `be7dc2f5beec530f7ef770ce72522ed20be668b2` | `53d6d1b01fe3c9e742af2cd26b90338545d9cea1` | 5 |

GitHub PR status readback on 2026-10-29 shows the `gate` check succeeded on each listed final PR HEAD. [#195 CI](https://github.com/felixjichao/symphony-ts/actions/runs/40811218392) also shows successful `detail-browser` and `operational-browser` jobs. These checks do not establish Decision approval or stable-host identity.

Each linked issue has a Symphony plan marker for revision 1 with verdict `ready`. This establishes the published plan marker, not independent proof of execution. The incident counts count comments containing “recovery incident”, not unique incidents or manual interventions. Issue comments and PRs are the authoritative linked records. Isolated execution, validation, CI, exact-HEAD Decision review, repairs and host identity/rebuild boundaries have not yet been inventoried here; do not infer those stages from merge or issue closure. The current #176 execution has the separately scoped host and workspace evidence below; historical child host/isolation facts remain unverified. #176 itself has a recorded plan-recovery incident in its [issue](https://github.com/felixjichao/symphony-ts/issues/176); its delivery and parent #168 acceptance remain pending.

The #169 issue comments additionally record a delivery block classified `manual_intervention_required`, a `review_needs_human` block, and a recovery incident targeting ReviewTask revision 2 at PR #178 HEAD `c0d38f54f4ecb820e23e1ec71b87f9b5d7cebaa2`. These are incident reports, not proof that the review approved or that recovery completed. The #170–#173 comments also include unverified delivery outcomes; #171 and #173 include manual-intervention classifications. See the linked issue comments for the original receipts and their separate recovery epochs.

The [#174 incident records](https://github.com/felixjichao/symphony-ts/issues/174) include exhausted coding retries, an unverified delivery subprocess outcome, and a CI wait timeout requiring human intervention at PR #194 HEAD `a296d907bea1fcd7e3dc272a922b6d03c9b68237`. A subsequent recovery record also reports an unverified outcome at that HEAD. These records do not establish how the incidents were resolved or that the final review approved.

The [#175 incident records](https://github.com/felixjichao/symphony-ts/issues/175) report a plan recovery requiring human intervention, an unverified coding launch, unverified delivery subprocess outcomes, and an unverified handoff launch. Two latter records refer to the earlier PR #195 HEAD `95a8c2e93b2549a18b9024fdc005a4e26319222c`, not the final PR HEAD above. The records do not establish resolution or exact-HEAD approval.

Existing evidence: [shell](../dashboard-v2-shell/README.md), [primitives](../dashboard-v2-primitives/README.md), [Overview](../dashboard-v2-overview/README.md), [Work Detail](../dashboard-v2-detail/README.md), [Why](../work-detail-why/README.md), and [production status](../status-surface/README.md). These are scoped to their stated baselines; they are not a substitute for #176 production V2 browser acceptance. Screenshots are supplemental, not authoritative state.

## Production browser acceptance

On 2026-10-29 an operator host ran the production status smoke outside the coding sandbox using Microsoft Edge 156.0.4314.50. The [report](host-report.json) records 20 passed scenarios, 42 GET-only status requests, no page errors, the asset and harness hashes, and the dirty tree at baseline `53d6d1b01fe3c9e742af2cd26b90338545d9cea1`. It exercised controlled source facts and the built executable with empty scope; authenticated external sources were not tested. This is not exact-PR-HEAD CI evidence. Screenshots are supplemental to assertions:

| View | Desktop | 390px |
| --- | --- | --- |
| Overview | [image](overview-desktop.png) | [image](overview-narrow.png) |
| Work | [image](work-desktop.png) | [image](work-narrow.png) |
| Work Detail | [image](detail-desktop.png) | [image](detail-narrow.png) |
| Executors | [image](executors-desktop.png) | [image](executors-narrow.png) |
| System | [image](system-desktop.png) | [image](system-narrow.png) |

The coding sandbox could not launch its browser due to the missing pinned executable and macOS sandbox restrictions. Full gate, exact-HEAD CI/review and delivery remain host-owned. Historical stable-host and child execution receipts remain unverified; neither this browser run nor merged PRs establish them.

## #176 supervising host and workspace: operator observations

Observed on 2026-10-29 from the local operator host, not from a GitHub or Decision receipt. The durable host configuration recorded release commit `f15ae9f9c92afa9f09553b12ae5a1161e7d7aded` at `/Volumes/Data/symphony-runtime/releases/f15ae9f-local`; that checkout was clean at inspection. Its built `apps/cli/dist/bin/symphony.js` SHA-256 was `95b0e4e440c85237cbe050456733012f262532479fdfcbd7c428de12b2518980`. The build file timestamp was 2026-10-28 21:09:57 +0800.

Process inspection found host wrapper PID 34206 and its CLI child PID 34210, both started 2026-10-29 10:01:32 +0800, with the child executing that release binary and the workflow at `/Volumes/Data/symphony-runtime/state/WORKFLOW.md`. Bridge wrapper PID 34168 and CLI child PID 34169 were separately running the same release. The operator host-delivery script SHA-256 was `329d295942429c947eb67c1d2fbcbbf4df128f2034c753f8612d0ba90cbbc124`; workflow SHA-256 at inspection was `b3d7ee540dfb0abe5ad73349dd8c64565f27e0d041d6803518d3788431597400`. These local paths and process IDs are time-bound operator observations, not portable credentials or durable GitHub receipts.

The native Codex session metadata for `01a18720-7be2-7600-a4e3-25a274b705e7` records start `2026-10-29T10:06:55.507Z`, model `gpt-6.1-terra`, working directory `/Volumes/Data/symphony-runtime/state/workspaces/GH-176`, branch `symphony/GH-176`, and workspace baseline `53d6d1b01fe3c9e742af2cd26b90338545d9cea1`. `git rev-parse` independently identified that directory as its own top-level and `.git` as its Git common directory. The workspace is outside the supervising release directory; the recorded host binary and workspace are separate checkouts. This session wrote a delivery request; the host delivery log recorded its `run` at `2026-10-29T10:07:35.280Z` followed by `npm run gate`, then a validation failure and handoff. The operator subsequently submitted PR #196 manually, preserving the pending handoff compensation; this is not an autonomous Delivery completion or proof of historical child execution.

The `f15ae9f` release was built and selected on 2026-10-28 before #174 and #175 merged. The host and bridge were restarted at the above 2026-10-29 boundary, still using `f15ae9f`; they were not rebuilt after those merges. #176's separate workspace was based on #175 merge `53d6d1b`, so the closeout code consumed the merged Dashboard changes while the stable supervisor stayed pinned to its earlier build. This records the observed boundary without claiming that the supervisor itself included those Dashboard commits or that the earlier child runs had the same host.

## Exact-HEAD production browser CI

The `production-status-browser` CI job checks out the PR HEAD, verifies a clean working tree after build, and runs `apps/cli/scripts/status-smoke.mjs` through the production status composition. The SHA-labelled `production-status-closeout-<HEAD>` artifact retains `report.json` and the desktop/narrow screenshots for 30 days, including available partial evidence if the smoke fails. The report records the source commit and tree, harness and fixture SHA-256, built asset hashes, scenario outcomes and browser version. The committed dirty-tree host report above remains historical supplemental evidence; this job's result is established only by the actual CI run for the reviewed HEAD.

## 2026-10-30 native external reconciliation

[Production maintenance evidence](../external-delivery-settlement/production/README.md) records PR #198, fixed stable release `ae4fb11`, exact-HEAD CI, four explicit external completions (#169/#173/#175/#176), precise request/retry retirement, native workspace cleanup, duplicate replay and restored host/Bridge/Drivers. Decision sequence 648 → 652; historical results/receipts, diagnostics, budgets and recovery ledger were preserved. The old #176 claimed Review was cancelled, not completed with an invented verdict.

This closes the observed native-state mismatch through operator-authorized external settlement. #173/#175/#176 still have no historical final-HEAD native approval, the historical autonomous execution chain remains scoped to existing evidence, and remaining parent browser-matrix/exception acceptance is separate. #168 remains open.

## 2026-10-30 production browser matrix follow-up

[Clean-source acceptance](../dashboard-v2-production-matrix/README.md) adds failed source facts and source/executor field assertions through the production composition: 22 passed scenarios, 45 native viewport samples, full WorkKey navigation and four freshness states. It closes the previously identified controlled-source browser coverage gap; external-live validation and historical Review exception acceptance remain separate. Earlier reports and historical outcomes above are preserved. #168 remains open.
