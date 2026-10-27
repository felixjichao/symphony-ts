# Agent Note: Bounded Delivery merge conflict repair
Status: accepted

## Problem
#186 extends GitHub Delivery / Execution Continuity (SPEC §8/§14, §9, §17/§18 adjacent). A confirmed owned PR conflict currently pauses before using the existing repair budget. Generic unmergeable failures must remain fail closed.

## Decision
Use a normal two-parent merge of the exact observed base SHA, never rebase or force push. A canonical optional `mergeConflictRepair` record carries cause `merge_conflict`, operation identity, attempt, PR identity, expected HEAD, pinned base, phase and receipts. Reserve the existing spentRepairs budget before mutation; retain the absolute deadline. The existing filesystem authority and subprocess uncertainty fence remain the sole executor authority. An interrupted executor is never replayed; only a persisted commit/push receipt with matching local/remote facts can be reconciled automatically. Dirty or pre-existing merge/rebase work is preserved and handed off. Git metadata inspection is a narrow read-only workspace API (`inspectGitOperationState`), supplied with Git’s per-worktree absolute metadata directory; agent does not own filesystem inspection or containment.

Only owned OPEN non-draft exact-HEAD CONFLICTING facts qualify, after CI and review evidence verification. Reconcile an old landing intent using authoritative OPEN/no-merge facts before repair; create new landing intent immediately before merge. Fetch and merge the pinned base, pass structured conflict context to the built-in same-workspace Codex repair executor, validate, verify exact parents, then push normally after fresh remote ownership/HEAD checks. Re-read base after repair and re-enter CI and independent exact-HEAD review on every new HEAD; a later conflict consumes another bounded attempt.

The shared delivery runner (used by both CLI and continuity host) launches `codex exec --sandbox workspace-write -` in the owned workspace through its authority-guarded `DeliveryGitGhRunner.exec`. The exec contract accepts explicit environment exclusions, forwarded through the authority guard. The production runner removes `GITHUB_TOKEN` / `GH_TOKEN` and the continuity host’s current profile secret names after merging overrides, while retaining Codex authentication and normal host Git/GitHub environments. A fixed shell pipeline supplies the prompt as stdin, with conflict JSON as evidence. This conflict-specific default does not depend on profile `--repair-cmd` (which remains the CI/review repair entry). Missing Codex or nonzero exit hands off without replay. The existing injectable `repairFn` remains available for controlled integrations. No additional budget, persisted configuration or host dispatch path is introduced.

## Alternatives considered
Reusing an arbitrary CI repair command does not guarantee coding-agent dispatch and may reference a nonexistent repository script. Keeping the coding-agent default in the shared runner prevents CLI and host recovery from diverging.

Rebase rewrites existing PR commits and requires force push, violating the delivery boundary. Treating all unmergeable failures as repairable conflates permission, ownership and uncertain merge outcomes. A separate repair budget or scheduler would duplicate existing coordination and allow unbounded retries. Replaying a checkpoint without proof of subprocess completion could create a second executor or push.

## Consequences
Old persisted states remain valid. Active repair remains visible without removing the ready label; terminal failures preserve local work and produce a specific handoff. Crash windows without durable receipts deliberately require operator reconciliation. Tracker merge rejection and host merge fences remain unchanged.
