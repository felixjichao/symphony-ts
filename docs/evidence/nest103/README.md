# NEST-103 real delivery and Review integration

On 2026-10-10, an explicitly authorized isolated run completed real Codex → GitHub CI → ChatGPT Review `changes_requested` → real Codex repair → new HEAD CI → new HEAD Review `approve` → automatic squash merge → issue closure → host terminal workspace cleanup.

This was a recovered run with operator intervention, not an uninterrupted harness pass. No operator implemented the feature, repaired its code, committed, pushed or merged the target PR; those effects used real Codex and the production delivery CLI. The initial mutation defect was deliberately seeded through the first coding prompt to make the Review repair branch observable.

## Versions and environment

- Product baseline: PR #104 at `843e7ad45f4571d2b911ec598d082b6c43aefe9a`, combined locally with PR #105's `d4fb8db` browser fixes (initial combination `5e6df0b`).
- During the run, two real blockers required product fixes: JSON-safe URL redaction and repair subprocess timeout bounded by the existing persisted deadline. The successful runtime used those fixes, now committed as `5f50590` on the combined checkout and equivalently `5b4fba6` on the PR #104 follow-up branch. The original PR #104 HEAD alone is **not** claimed to pass this integration.
- macOS, Node `v24.15.0`, npm `12.2.0`, real logged-in Codex app-server/exec and authenticated GitHub account with access to the isolated target; real Edge/Tampermonkey and logged-in ChatGPT.
- Separate localhost Bridge on `127.0.0.1:4041`, separate durable store/session, session `github:felixjichao/symphony-delivery-dogfood#18`. Bridge, host and Driver stopped after export; temporary GitHub credential copy removed.
- [Recorded workflow](WORKFLOW.md) and [real Codex repair entry snapshot](repair.mjs.txt). Absolute paths describe this run; replace them and the redacted local token for reproduction. The repair entry consumes both `SYMPHONY_REVIEW_FINDINGS` and `SYMPHONY_CI_FAILURE_DIAGNOSTICS`; the repository's old `ci:fix` consumes only CI diagnostics.

## Read-back facts

Target [issue #18](https://github.com/felixjichao/symphony-delivery-dogfood/issues/18) and [PR #19](https://github.com/felixjichao/symphony-delivery-dogfood/pull/19).

| Stage | Exact commit / result | Evidence |
| --- | --- | --- |
| Initial real Codex implementation | `77e149bdcb07ed1ed56639f3472671ad3df54b3b` (SHA-A), intentionally input-mutating `values.sort(...)` and ordering-only tests | [initial Codex tool trace](initial-codex.json) |
| Initial CI | success on SHA-A, run `38063730606` | [CI A JSON](ci-head-a.json), [GitHub run](https://github.com/felixjichao/symphony-delivery-dogfood/actions/runs/38063730606) |
| Real Review revision 1 | `changes_requested`, two blocker findings: input mutation and missing non-mutation/reference tests | [Bridge tasks/results/receipts](bridge-results.json) |
| Real Codex repair | successful attempt 2/3 produces `ac7a3106405c5389ba4adb864af72b165349e974` (SHA-B), copying input and adding regression coverage | [successful Codex tool trace](successful-repair-codex.json), [delivery log](delivery-completed.log) |
| New HEAD authorization before re-review | SHA-B denied; SHA-A task subsequently superseded | [pre-review authorization](sha-b-before-review-approval.json), [Bridge export](bridge-results.json) |
| Repaired CI | success on SHA-B, run `38064474126` | [CI B JSON](ci-head-b.json), [GitHub run](https://github.com/felixjichao/symphony-delivery-dogfood/actions/runs/38064474126) |
| Real Review revision 2 | `approve` on exact SHA-B, no findings; final verification denies A and approves B | [Bridge export](bridge-results.json), [approval verification](approval-verification.json) |
| Automatic squash merge | `a8ec31e922955323954acf74c4ad7e030cb4afec`, merged `2026-10-10T15:40:38Z` | [PR read-back](pr.json), [delivery log](delivery-completed.log) |
| Issue closure / cleanup | issue closed `15:40:40Z`; host restart cleaned `GH-18` at `15:41:32.728Z`; root sentinel survived | [issue read-back](issue.json), [host log](host.log), [asserted facts](facts.json) |

## Actual failures and recovery

1. The real app-server coding pass wrote the seeded implementation and passed target gate/lint, but its delivery shell could not write `.git/index.lock` under the coding sandbox. Production delivery emitted a handoff and removed the ready label. The operator stopped that host and resumed the same production CLI from the host side; no sandbox protection was disabled. The same workspace/branch became PR #19.
2. SHA-A CI succeeded, but the shared URL redaction regex crossed JSON string boundaries between HTTPS and later `git@...`, making compact Pulls API JSON unparsable. [Failure log](delivery-api-failure.log), [red regression](sanitizer-red.log). The corrected regex preserves compact JSON and still redacts credential URLs. Resuming reused the same PR/SHA and created the real Review task.
3. Full navigation reinjected the userscript into Idle. The operator manually clicked Start once; bootstrap and the two Review submissions then ran through the Driver. Automatic restart is not claimed.
4. Review revision 1 completed with genuine findings. The first real `codex exec` repair generated a patch but exceeded the subprocess runner's default 60 seconds; production delivery failed closed. [Timeout log](delivery-repair-timeout.log), [preserved interrupted patch](interrupted-repair.patch), [red timeout regression](repair-timeout-red.log).
5. The fix passes the remaining persisted deadline to both CI and Review repair commands. The interrupted patch was preserved outside the workspace and stashed locally before retrying. A production `--resume` reused the same completed `changes_requested` task, preserved the absolute deadline and spent repair count, and performed successful attempt 2/3 with real Codex. It then committed/pushed SHA-B, superseded A, created Review revision 2, waited for exact-SHA approval and automatically merged.
6. The operator restarted the real host for terminal reconciliation after the host-side delivery completed. Cleanup was observed on that restart, not claimed to happen in an uninterrupted original host process.

## Validation and limits

- [Related regression tests](related-tests.log): 58/58; [typecheck](typecheck.log) and [lint](lint.log) passed. Tests include JSON parseability with mixed HTTPS/SSH URLs, credential redaction, CI repair timeout and command-mode Review findings → repair → new SHA → re-review, with timeout reduced to the exact remaining 230 seconds after 70 seconds already spent.
- [Full root gate](root-gate.log) exited 1 in existing short native hook/termination tests in agent/workspace. These failures are retained, not treated as a green full gate. Target GitHub CI is separately verified green on both exact delivered HEADs.
- This proves the recovered controlled-fault real integration chain and records its operator involvement. It does not approve or merge product PR #104/#105 or authorize any product repository merge.
- Exports remove lease/claim credentials and redact authentication strings. Result payloads remain unchanged. Only the two relevant Codex sessions' tool calls/outputs and assistant completion text are included; system/developer prompts, reasoning, unrelated sessions and account-sidebar screenshots are excluded. Screenshots remain local for the operator.
