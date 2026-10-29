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

Each linked issue has a Symphony plan marker for revision 1 with verdict `ready`. This establishes the published plan marker, not independent proof of execution. The incident counts count comments containing “recovery incident”, not unique incidents or manual interventions. Issue comments and PRs are the authoritative linked records. Isolated execution, validation, CI, exact-HEAD Decision review, repairs and host identity/rebuild boundaries have not yet been inventoried here; do not infer those stages from merge or issue closure. In particular, stable supervising host and isolation remain unverified for this chain. #176 itself has a recorded plan-recovery incident in its [issue](https://github.com/felixjichao/symphony-ts/issues/176); its delivery and parent #168 acceptance remain pending.

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
