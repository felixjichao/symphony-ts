# Production external settlement acceptance — 2026-10-30

**#169, #173, #175 and #176 were settled as `external_completion`, cleaned through the native API, and verified after runtime restoration.** This is explicit operator maintenance, not recovered autonomous delivery or fabricated exact-HEAD approval. Parent #168 remains open.

## Reviewed and deployed identity

[PR #198](https://github.com/felixjichao/symphony-ts/pull/198) merged as `f1fb14f5ef4d8592d0ca79c077a4e1fd23409302`. Stable release `ae4fb1132f789b97e172d32315694adee5b31f9e` is a reviewed parent of that merge, at `/Volumes/Data/symphony-runtime/releases/ae4fb1132f789b97e172d32315694adee5b31f9e`; its source working tree is clean. CLI SHA-256: `b9642c7a5aa69fd7fb0654f8dd1f5d3c95905ad123d84361e660f0adc2821eda`. Supervisor and Bridge execute outside the issue workspace root, which stayed `/Volumes/Data/symphony-runtime/state/workspaces` throughout maintenance.

Full host gate: **2,649 passed / 1 existing opt-in skipped**, including 40 new targeted tests. [Independent review](../review-2026-10-30.md) resolved the public-export and root-migration findings; subsequent independent follow-up verified the built-executable fix. [Binary/source validation](../binary-validation.json) retains the reproduced exit-13 failure and the first CI clean-tree failure; neither gate was weakened.

[Exact-HEAD CI run #394](https://github.com/felixjichao/symphony-ts/actions/runs/40913738062) passed gate, detail-browser, operational-browser and production-status-browser; the [job receipt](ci-jobs.json) records each job. The clean release also passed a separate local Edge production-composition smoke: [report](release-status-smoke.json), 20 passed scenarios, empty working tree, zero pageErrors. That browser run used controlled fixtures and explicitly records `externalLive: not run`; it does not close the outstanding parent browser-matrix gaps.

## Native maintenance and read-back

Both visible Web Drivers connected to the production Bridge were stopped and rechecked before maintenance. An initial stop preflight refused a live short-lived `gh` read child; it performed no mutation. The next attempt waited for idle, sent SIGTERM to the verified host/Bridge wrappers, waited for wrappers and CLI children to exit, and verified release of the native Decision writer lock. Unrelated Codex processes were identified by parent/CWD and left untouched; no old workspace executor remained.

Private backup: `/Volumes/Data/symphony-runtime/state/backups/external-settlement-20261029T164914Z`. It retains the original runtime/shim/workflow, entire Decision store, host recovery metadata, raw Delivery JSON and four workspace archives including Git/source/diagnostics. Only reproducible `node_modules` and `.cache` were excluded. Backup permissions are private; raw tokens, native store, details and authorization files were not exported here. Archive hashes and sanitized receipt facts are in [settlement.json](settlement.json).

The fixed release was selected while offline, updating both runtime selection and the `bin/symphony` shim. Each work item then used a fresh native prepare → preview → apply request, sequentially so its Decision hash/sequence reflected preceding settlement. The operation rechecked actual public GitHub closed/merged identity, final HEAD, merge SHA, repository and branches. Missing ownership markers were explicitly authorized only for #173/#176; foreign markers were never overridden.

| Work | Completed remote target | Native result |
| --- | --- | --- |
| #169 | PR #178, HEAD `c0d38f54…`, merge `cb671b74…` | external receipt; existing final-HEAD approve retained |
| #173 | PR #191, HEAD `caa16c9c…`, merge `3b5eb8ff…` | external receipt; exact old handoff request retired |
| #175 | PR #195, HEAD `be7dc2f5…`, merge `53d6d1b0…` | external receipt; exact blocked retry retired |
| #176 | PR #196, HEAD `0f2affa8…`, merge `9fd0f6d4…` | external receipt; old claimed Review cancelled and exact handoff request retired |

Direct file read-back verified Decision sequence **648 → 652**, all four sessions completed, no executable target tasks, unchanged task identities and historical result/submission-receipt dictionaries, unchanged unrelated tasks/sessions, and byte-identical recovery ledger. Delivery JSON changed only by adding its external receipt; original flags, raw details, budget and deadline were compared against the backup. The published receipt summary includes numeric budget values and diagnostic digests, never raw details. Old `isPaused` / compensation flags remain historical facts in the retained original journal, rather than being rewritten as success.

Every apply was repeated with the identical request while offline: same receipt, byte-identical Decision snapshot. Native `createHost.cleanupWorkspace.removeWorkspaceForIssue` then removed all four workspaces. Repeating each apply after cleanup returned its receipt without rewriting Decision or recreating the workspace; complete journals remain outside the removed directories as admission fences.

Bridge was started before host. Authenticated terminal queries returned `settled: true` for all four work items. Process inspection confirmed Bridge wrapper/CLI **78607/78608** and host wrapper/CLI **78609/78613** execute the fixed release; the host holds its native root maintenance lock. Both Drivers were restored to enabled polling. A final committed-state read still showed sequence 652, zero executable Decision tasks, zero recovery requests, zero retries and the original ledger bytes. IDs/paths are time-bound local observations, not portable credentials.

Driver HUD evidence is cropped to omit chat bodies and sidebars: [stopped](driver-stopped.png), [second stopped](second-driver-stopped.png), [restored](driver-restored.png), [second restored](second-driver-restored.png).

## Retained exceptions

#173/#175/#176 still lack historical final-HEAD native Decision approval. No Review task/result/receipt was fabricated, no old approval target was changed, no budget or ledger was reset, and no coding/Review/merge/comment compensation was replayed by settlement. Public historical reviews or these local independent reviews do not replace missing pre-merge native receipts. Remaining #168 product/browser coverage and acceptance of historical self-hosting exceptions are separate closeout work.
