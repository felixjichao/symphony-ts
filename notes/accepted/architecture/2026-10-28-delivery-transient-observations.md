# Agent Note: Bounded Delivery observations and source staging
Status: accepted

## Problem
#192 / Symphony baseline `be10a1b79df723d6d7612b5651c8522704dafb2e`, SPEC §8/§14 and §9 adjacent, §17/§18: ignored runtime directories make wildcard `git add` fail after partially staging source. A transient Review read or delayed post-push PR projection currently pauses delivery permanently.

## Decision
Keep coordination in the existing Delivery runner. Enumerate NUL-separated tracked and non-ignored files and stage literal root-relative source paths in checked batches. Ordinary commits retain `--only` to preserve runtime index entries. Merge commits retain both parents and refuse staged runtime before reservation and before commit; tracked unchanged runtime stays at its inherited tree version. The workspace-write executor only resolves working files; the trusted host checks conflict markers, validates, stages source and verifies the index has no unresolved entries. It never requires the coding sandbox to write protected Git metadata.

Review reads allow three consecutive supported transport/unavailability failures under the existing absolute deadline. Domain owns an optional validated `DeliveryContinuation.reviewReadFailures` counter, preserving it, task/revision and operation key across native stage yields. Unknown errors, authentication, corrupted store/results and changed identities fail closed. Successful observations reset the consecutive counter, never the total deadline or repair budget.

After a single conflict push, allow three read-only observations of the authoritative head ref plus owned PR projection, separated by the existing poll interval and fenced by the original deadline. Both must match the commit receipt before entering new-SHA CI/Review. Old facts wait; third SHA/identity/outcome changes refuse. A pushing receipt never authorizes replay. Tracker preserves failure diagnostics so transport errors can be distinguished from authorization failures.

## Alternatives considered
Adding another wildcard exclusion still fails in real Git with ignored `.symphony/`; ignoring exit code hides partial staging failures. Staging everything then resetting runtime can destroy pre-existing index state. Requiring the executor to stage first fails under actual Codex workspace-write Git metadata protection; weakening that sandbox is unnecessary when the host already owns checked staging. `commit --only` cannot replace a merge commit. Broad retry of all exceptions would mask auth/corruption. A generic recovery engine or repeated push would widen authority and introduce unknown duplicate effects.

## Consequences
No Core SPEC or scheduler change. Legacy continuations remain valid. Runtime staged during a merge still needs manual resolution. This bounds observation during continuous operation; it does not add executor/commit replay after a crash. Local controlled evidence and live acceptance remain distinct in the evidence ledger.
