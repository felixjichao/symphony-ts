# NEST-105 real browser smoke — 2026-10-10

Scope: Decision Plane extension alongside SPEC §4; real integration evidence under §17.8. Baseline: Symphony SPEC `be10a1b79df723d6d7612b5651c8522704dafb2e`, implementation base `73f055c6a2d07ddd45a120bd29915b94d5346663`.

## Environment and execution

- Operator explicitly opted in to a logged-in ChatGPT account, installed/updated the userscript in Edge with Tampermonkey, and authorized a local smoke token. Credentials are excluded from this record.
- CLI and userscript were built locally. A real `decision bridge` listened on `127.0.0.1:4040`, using an isolated `/private/tmp/symphony-nest105-store` durable store and allowed origin `https://chatgpt.com`.
- The operator selected the isolated [dogfood repository](https://github.com/felixjichao/symphony-delivery-dogfood). Tests used its real open [issue #15](https://github.com/felixjichao/symphony-delivery-dogfood/issues/15), with connector context. No code, PR, CI or merge was generated in that repository during this smoke.
- Prepared session, task and context using real HTTP endpoints before Start Driver. Observed HUD, GM loopback claim, automatic composer injection/send, bootstrap response, `/c/<id>` binding, Plan response extraction and authenticated result submission.

## Observations and fixes

1. Starting the driver before context delivery raced task claim and failed with `Context ... not found`. Manual instructions now deliver all context before Start.
2. Composer injection succeeded but synchronous send-button lookup ran before React rendered/enabled it. Added bounded, cancellable readiness polling and Chinese send labels.
3. Current assistant markup uses `data-markdown-text-style="assistant-message"`, and code surfaces use `data-markdown-copy="code-block"` with a language header and descendant `code`. Added these probes plus the Chinese stop label; invalid last result blocks remain rejected.
4. Real dogfood Plan revision 1 was reloaded during generation. Recovery treated stable intermediate prose as final and submitted a failure before the eventual valid response. Added a completion-candidate predicate requiring a result-bearing Plan/Review turn. Its regression failed before the fix and passed afterward.
5. Revision 2 without reload completed with `ready`. Revision 3 with the final userscript was reloaded while the real Chinese Stop button was visible. After manual Start, it resumed the existing response and completed with `ready`; user message count was four before refresh, after refresh and after completion. No prompt was resubmitted.
6. Full `location.assign` navigation from an old conversation to the new-chat root replaced the page and reinjected the userscript. Manual Start resumed the navigating checkpoint. Full navigation/reload initializes the HUD in Idle; automatic restart is not implemented.

## Durable evidence

[Sanitized live Bridge export](bridge-results.json) records real session binding, tasks and receipts. Lease/claim credentials have been removed; result payloads are unchanged.

| Revision | Execution | Durable outcome |
|---|---|---|
| 1 | Active generation reload before completion fix | `failed`, failure receipt |
| 2 | Real repository Plan, no reload | `completed`, result receipt, `ready` |
| 3 | Active generation reload after completion fix | `completed`, result receipt, `ready`; no duplicate user turn |

Conversation: `https://chatgpt.com/c/6aca5019-1904-83ea-af1d-d90d2ec2963d`. It requires the operator's account; the durable export is the reviewable evidence. Screenshots were retained locally, not committed because they include unrelated account sidebar information.

## Validation and limits

- Web suite: 60/60; root typecheck, lint and docs checks passed after the final code change.
- Root gate previously failed in unmodified agent/workspace/CLI subprocess hook tests. Final gate result is reported in the PR, without replacing failures with the narrower Web test result.
- This proves NEST-105 browser adapter smoke. It does **not** satisfy NEST-103 / GitHub #98's Codex → CI → SHA-bound Review → repair/re-review → merge dogfood acceptance requirement. No review approval, repair SHA, target PR CI or remote merge is claimed.
