# Agent Note: SHA-bound Independent Review Gate before Auto-Merge
Status: accepted

## Problem

In the GitHub Delivery loop (NEST-89 / #78, NEST-91 / #80, NEST-92 / #81), pull requests were automatically squash-merged once automated CI status checks became green and the PR was mergeable. However, automated test checks alone do not evaluate architectural coherence, code semantics, regression risk, or adherence to project requirements.

To prevent unreviewed code from entering the main branch while retaining autonomous end-to-end delivery:
1. An independent review gate must verify code changes before any auto-merge occurs.
2. The review decision must be strictly bound to the pull request's current commit (`headSha`). Any new push or commit immediately invalidates any prior review approval.
3. Delivery must fail-closed: if the review gate is unavailable, missing, unconfigured, returns `changes_requested`, yields `needs_human`, or experiences communication errors, auto-merge must refuse without fallback to CI-only merging.
4. When `changes_requested` is returned with actionable findings, the delivery skill should feed the findings into the existing bounded repair loop (`--repair-cmd`), commit and push the fix, invalidate the prior review task, and restart CI inspection and review verification.
5. All domain contracts must remain provider-neutral, with zero coupling to specific browser, DOM, or LLM vendors in core packages (`@symphony/domain`, `@symphony/tracker`, `@symphony/agent`).

## Decision

We introduce an end-to-end, SHA-bound independent review gate across `@symphony/domain`, `@symphony/decision`, `@symphony/tracker`, `@symphony/agent`, and `@symphony/cli`:

1. **Provider-Neutral Domain Interface (`@symphony/domain`)**:
   - `DeliveryReviewGate`: defines `ensureReviewTask(sessionId, target)` ensuring a review task exists with atomic context (PR metadata, diff, CI status, checks), `getReviewStatus(taskId)` for polling review execution, and `verifyReviewApproval(target)` for atomic pre-merge verification.
   - `DeliveryReviewTarget`: `{ repository: string; prNumber: number; headSha: string }`.
   - `DeliveryReviewApprovalResult`: `{ approved: boolean; reason: string; taskId?: string; headSha?: string; verdict?: "approve" | "changes_requested" | "needs_human" }`.
   - Strict SHA binding: `verifyReviewApproval` approves ONLY when an approved review exists where `reviewResult.headSha === target.headSha`.

2. **Decision Plane Integration (`@symphony/decision`)**:
   - `DecisionReviewGate`: concrete implementation of `DeliveryReviewGate` that works either in-process with `DecisionService` or remotely over HTTP with `DecisionBridgeClient`.
   - Ensures an atomic materialized context bundle (`kind: "review"`, `strategy: "materialized"`) is attached when creating a review task.
   - Converts `DecisionTaskResult` verdicts into `DeliveryReviewApprovalResult`, ensuring exact SHA match and reporting clear reasons when a verdict is not `approve` or SHA has drifted.

3. **Tracker Pre-Merge Enforcement (`@symphony/tracker`)**:
   - `DeliveryService.landPr` enforces `options.reviewGate`. If `reviewGate` is omitted, auto-merge fails closed (`auto_merge_rejected: Review gate is required for auto-merge`).
   - Before executing squash-merge, `landPr` calls `reviewGate.verifyReviewApproval({ repository, prNumber, headSha })`. Any non-approved status halts merge immediately (`review_rejected`).

4. **Agent Delivery Skill Loop (`@symphony/agent`)**:
   - Phase 6 in `runDeliverySkill` executes the Review Gate cycle:
     - Fetches PR metadata, diff, and checks to materialize the review context.
     - Calls `ensureReviewTask` with the current PR `headSha`.
     - Polls `getReviewStatus` every `pollIntervalMs` until completed or timeout.
     - On each poll, re-reads the GitHub PR `headRefOid`. If the PR HEAD moves while review is in-progress, the runner supersedes the stale review task, breaks out of polling, and restarts CI check polling for the new SHA.
     - If verdict is `approve`: verifies approval and proceeds to Phase 7.
     - If verdict is `changes_requested`: passes structured findings as prompt / environment (`SYMPHONY_REVIEW_FINDINGS`) to `repairFn` / `repairCommand`, validates, commits, pushes new SHA, supersedes prior review task, and loops back to CI inspection.
     - If verdict is `needs_human`: halts dispatch immediately (`review_needs_human`) and generates operator handoff.
   - Phase 7 (Land PR) re-verifies review approval before final squash merge.

5. **CLI Wiring (`@symphony/cli`)**:
   - Added `--bridge-url`, `--bridge-token`, and `--session-id` options to both `symphony delivery-skill run` and `symphony pr land`.
   - Wires `DecisionReviewGate` to the delivery runner and service, failing closed if `--opt-in` is specified without review gate options or bridge connection.

## Alternatives considered

- **CI-only auto-merge with post-merge asynchronous review**:
   - *Alternative*: Allow PRs to merge directly upon passing CI checks, and trigger an automated code review comment or follow-up issue post-merge.
   - *Why rejected*: Post-merge review permits flawed or dangerous code to enter the trunk branch, potentially breaking main or requiring emergency reverts. The core requirement of this gate is pre-merge prevention with strict fail-closed guarantees.
- **Git commit hook or GitHub branch protection rules alone**:
   - *Alternative*: Rely entirely on GitHub's native branch protection "require approvals" setting and external GitHub App reviews.
   - *Why rejected*: Symphony operates in autonomous environments where external review agents may run on local decision bridges (such as Web Agents or local LLM review workers). A native domain contract in Symphony enables unified policy enforcement, local dogfooding without GitHub organization enterprise tiers, and deterministic SHA tracking across both local and remote execution models.
- **Implicit re-use of approved review when HEAD moves (e.g. trivial whitespace changes)**:
   - *Alternative*: Allow previous review approvals to persist across HEAD changes if diff similarity is above a threshold.
   - *Why rejected*: Diff heuristics can fail to catch subtle semantic breaks or regressions introduced during rebase/merge. The exact SHA match invariant (`approved ReviewResult.headSha === current PR HEAD SHA`) provides absolute certainty and avoids TOCTOU race conditions.

## Consequences

- Pull requests can no longer be automatically merged without an explicit approval for the exact commit HEAD SHA.
- Any manual or automated push immediately invalidates prior approvals and safely restarts the verification pipeline.
- The delivery skill automatically handles actionable review feedback via the repair loop.
- Core packages remain provider-neutral with zero ChatGPT or DOM dependencies.
