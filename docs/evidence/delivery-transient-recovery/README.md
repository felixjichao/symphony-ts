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

## Live acceptance boundary

**Pending:** the original isolated `felixjichao/symphony-delivery-dogfood` conflict → repair → push → actual new-SHA CI → independent exact-HEAD Review → merge → Issue closed → host cleanup run. The existing `conflict` dogfood scenario remains a `merge_rejected` safety test; it is not repair-success evidence. No local controlled fixture is called a live GitHub/Review pass.

This change does not authorize production execution, changes to the running host or adding `symphony-ready`. No production recovery or state reset was performed. Full live closeout remains required before marking #192 fully accepted.
