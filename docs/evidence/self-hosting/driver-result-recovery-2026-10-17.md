# Driver result recognition: real #137 recovery evidence

On 2026-10-17 (Asia/Shanghai), userscript 0.1.3 completed the real SHA-bound
Review revision 3 for [PR #144](https://github.com/felixjichao/symphony-ts/pull/144),
HEAD `a19e0c784752a508f22193d4c2fc42e4dd3a796e`.

## Observed failure mechanism and successful recovery

The per-tab metadata captured from the live page shows the baseline/current count
condition is unsafe for this UI. The current DOM count reached 12 while generating,
then collapsed to 4. The persisted baseline was 5. The result-bearing last turn
passed canonical task validation even though 4 was not greater than 5.

| Elapsed time | Baseline | Current count | Stop button | Task result matches | Wait phase |
|---|---|---|---|---|---|
| 0 ms | 5 | 5 | absent | false | waiting / no_new_turn |
| 502 ms | 5 | 4 | present | false | waiting / no_new_turn |
| 73,484 ms | 5 | 12 | present | false | waiting / generating |
| 75,024 ms | 5 | 4 | present | false | waiting / no_new_turn |
| 80,562 ms | 5 | 4 | absent | true | waiting / stabilizing |
| 81,575 ms | 5 | 4 | absent | true | completed / ready |

The Driver then recorded result_submitting and result_accepted. Independent Bridge
store verification confirmed revision 3 status completed, verdict changes_requested,
and a result receipt accepted at `2026-10-16T18:09:15.843Z` (02:09:15.843 local).
The outstanding finding is the missing post-listen HTTP server error listener in
`packages/observability/src/operations-http.ts:43`.

This live run confirms the hypothesized DOM-count failure mechanism and successful
exact-task fallback. Historical revisions 1 and 2 lack contemporaneous diagnostics,
so their exact DOM sequence cannot be reconstructed. Their failure provenance is
retained; no old response was manually imported or converted into approval.

## Boundary and remaining acceptance

The operator explicitly authorized a fresh bounded round, backed up the old state,
and created revision 3 through the Bridge. The new host delivery deadline is
02:38:09 local, with at most 3 repairs and human merge. Worker/repair sandbox
policies remain unchanged. At 02:10 local the full host gate and current CI had passed; the host consumed
the completed Review and automatically entered repair attempt 1/3. A new HEAD,
re-review and final delivery remained pending. This evidence does not claim #137 is complete or PR #144 is ready to merge.

## Delivery completed up to human merge

Status checked at 2026-10-17 07:55 Asia/Shanghai: the host automatically completed
repair 1/3, validated and pushed HEAD
`45a4a614f928d5824c40549df6eb1058c4cac3ea`. The new SHA's
[CI gate](https://github.com/felixjichao/symphony-ts/actions/runs/38945656673/job/117123989438)
succeeded at 02:15:55 local. Review revision 4 completed with verdict approve and
no findings, bound to that exact current SHA; its Bridge acceptance timestamp is
`2026-10-16T18:17:10.429Z`. The delivery log reports green and ready to land and
explicitly skips merge because optInLand is not true. The helper successfully
removed symphony-self-hosted; issue #137 currently has no labels, so the host will
not dispatch it again. PR #144 and issue #137 remain open for human landing.

The coding → host gate → PR/CI → independent changes_requested → sandbox repair
→ host validation/push → SHA-bound approve → ready-for-human-merge path has now
run successfully. This does not claim that PR #144 is merged or that the separate
local Driver/profile changes have been committed and merged.
