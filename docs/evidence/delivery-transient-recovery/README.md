# Delivery transient recovery — #192

Scope: Symphony baseline `be10a1b79df723d6d7612b5651c8522704dafb2e`, SPEC §8/§14, §9 adjacent and §17/§18. Implementation started at `c758162`; remote main `3b5eb8ff0b33c5a8c0fb81301017c10fbf638bb5` was fetched and compared: intervening changes affect Dashboard, not Delivery.

## Local controlled acceptance

Actual temporary Git worktrees, bare origins and runtime files are used. GitHub/CI facts, independent Review verdicts and time are injected at external boundaries. The CLI suite invokes `runDeliverySkillCli`, native file authority and `FileDeliveryStateStorage`.

| Scenario | Evidence and external outcome |
|---|---|
| T1 | `merge-conflict-repair.test.ts`: first Review read ETIMEDOUT, same task/revision completes and lands; no pause/label removal. CLI initial delivery injects the same fault and completes. |
| T2 | First PR projection after one real push still reports old HEAD; later projection matches, new-SHA CI/Review and fenced merge complete. |
| T3 | Real conflict resolution with ignored `.symphony/runtime.json` present: two-parent merge commit preserves both implementations and no runtime source delta. |
| T4 | Actual push succeeds but returns connection-reset error; first PR read also fails. Later facts confirm effect, exactly one push and one repair executor, then completion. |
| T5 | `delivery-review-regressions.test.ts` covers ordinary/CI commits with tracked/untracked, staged/unstaged, ignored/nonignored runtime and nested cwd. CLI initial/CI/Review paths preserve pre-staged runtime index and commit only source. CLI conflict path uses a real bare origin, merge and single push; a transport-error return, failed first authoritative ref read and old PR projection converge through new-SHA CI/Review to completion. Merge refuses pre-staged runtime without consuming repair budget; inherited tracked runtime stays unchanged in the merge tree while local runtime updates remain on disk. |
| T6 | Old SHA CI/Review approved; repaired SHA initially has no CI. New Review cannot begin until new CI appears; only matching new approval can merge. |
| T7 | Three consecutive Review failures persist across stage yields, preserving operation key and deadline. Post-push projection is bounded at three reads; total-deadline exhaustion retains spent repair. Exactly one logical handoff/label removal, no repeated push/executor. |
| T8 | Auth/corrupt errors, status/session identity mismatch, owner change, third projected/authoritative SHA fail closed. HEAD movement during a transient Review error supersedes the old task and uses a fresh operation key for current-SHA CI/Review. Existing target/HEAD/ownership/unknown-merge and no-replay tests retained. |

Red-before-green command: `npx vitest run packages/agent/src/delivery/merge-conflict-repair.test.ts -t '#192'`. Initial T1/T2/T3/T4 all failed with the reported premature handoff; the repaired cases reach completed delivery.

Reproduce the production CLI boundary: `npx vitest run apps/cli/src/delivery-transient-recovery.test.ts`.

## Verification — 2026-10-28

`TMPDIR=/private/tmp npm run gate` passed: strict typecheck/build, 2,564 tests passed and one existing opt-in compatibility test skipped, lint and documentation checks. The command ran with local process-inspection permission for the existing `ps`-based supervision tests. Earlier sandbox runs failed that permission check; the ordinary macOS temporary-directory alias also exposed existing `/var` versus `/private/var` cwd assertions. Canonical `/private/tmp` resolved those environment-only failures without changing workspace safety code.

## Real acceptance — 2026-10-28

**Historical partial / overall profile failed:** [dogfood #29 / PR #30 ledger](issue192-20261028075031/README.md) proves actual native host, real Codex coding/conflict executor, real GitHub CI on both SHAs, independent exact-HEAD Codex Reviews and automatic merge/Issue closure despite Review 503, successful-push transport error, first ref read timeout and old PR HEAD projection. One repair executor/push, unchanged deadline and no pause/handoff are recorded. Terminal host cleanup was refused; the retained workspace prevents a full Real Integration pass. This earlier run was not a full pass.

[The first failed attempt](issue192-20261028072718/README.md) is retained separately. It exposed Git metadata protection when Delivery ran inside the coding sandbox. The successful Delivery segment uses operator-owned `after_run`, with the executor limited to worktree resolution and the trusted host owning checked staging. The new regression first failed with `merge_conflict_unresolved_paths`, then passed after that staging boundary fix.

The historical conflict safety refusal was also re-run through actual native `pr land` and returned `merge_rejected`; its unchanged OPEN/CONFLICTING PR is distinct from repair success. Browser/Userscript UI, live exhaustion, auth and third-SHA negative injections are not claimed.

Only the explicitly authorized dogfood target was written. Production host/Bridge were not changed. No delivery state, repair budget or deadline was deleted or reset, and no manual workspace deletion substitutes for native cleanup.

[Historical process/port and credential-file audit](process-audit.json) confirms the owned hosts/coding PIDs are gone, both fault proxy ports are closed, private credential files are removed and both issue workspaces remain.

Post-live validation passed: 2,588 tests plus one existing opt-in skip, typecheck/build, lint and docs check, using a single Vitest worker. [Exact command/result](validation.json), [full gate log](validation-gate.log) and [earlier default-concurrency timing failures](parallel-validation-failures.txt) preserve the distinction. No safety check or assertion was weakened.

## Review follow-up: full native integration passed

[Fresh #31 / PR #32 acceptance](issue192-20261028122627/README.md) passed the complete conflict → repair → push → new-SHA CI/independent Review → merge → Issue closed → same-host automatic cleanup chain. Terminal retry settles only its own token-fenced durable record before cleanup, retaining claim/barrier and foreign-record refusal. CLI conflict coverage leaves an unmerged index for host staging. Full gate: 2590 passed / 1 existing opt-in skipped. Earlier failed evidence above remains unchanged.
