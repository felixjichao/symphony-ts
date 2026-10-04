# Agent Note: GitHub Delivery MVP.3 Primitives and Auto-merge Capability
Status: accepted

## Problem

Coding agents working in issue-dedicated workspaces require GitHub delivery primitives (SPEC §11.5 / MVP.3) to create, inspect, and land Pull Requests without relying on unstructured or arbitrary git operations:
1. **PR Ownership and Association**: Automated systems must not hijack or claim arbitrary open PRs. Re-entrant attempts must distinguish between self-owned Symphony PRs and foreign pull requests.
2. **CI Check Evaluation Boundary**: When deciding whether to merge, the orchestrator and agents must inspect checks bound to the specific head commit SHA. In environments without configured branch protection rules or required checks, relying solely on required checks could result in either false blockers or premature merges of untested commits.
3. **Safe Auto-merge Execution**: Automatic squash merging must be strictly opt-in, verify that the PR is open, non-draft, and mergeable, guarantee server-side head matching (`--match-head-commit`), and confirm the final merged state by re-reading facts after execution.
4. **Credential and Process Isolation**: GitHub tokens and credentials must never leak into command-line arguments, process titles, console output, logs, or diagnostic links. Subprocesses must have timeouts and clean process-group termination.

## Decision

We implement the GitHub delivery execution capability across `@symphony/domain`, `@symphony/tracker`, and `@symphony/cli`:

1. **Domain Contract (`@symphony/domain`)**:
   - `DeliveryContext`: Explicit delivery parameters (`repo`, `issueNumber`, `workspaceKey`, `headBranch`, `baseBranch`).
   - `PrOwnershipMarker`: Machine-readable comment marker (`<!-- symphony-delivery-marker: {...} -->`) embedded in PR descriptions alongside closing issue references (`Fixes owner/repo#N`).
   - `validatePrOwnership`: Validates repository, issue number, workspace key, head branch, base branch, and closing association.
   - `evaluateChecksAutoMergePolicy`: Pure CI evaluation policy confirming user decision:
     - When required checks exist: all required checks must strictly succeed, and all observed current checks must also strictly succeed.
     - When no required checks exist: at least one current check must exist, and all current checks must strictly succeed.
     - Zero checks, pending, failing, skipped, neutral, cancelled, or unknown checks strictly refuse auto-merge.

2. **Delivery Service and gh Transport (`@symphony/tracker`)**:
   - `GitHubDeliveryService`:
     - `ensurePr`: Idempotently creates a new PR with marker and closing reference when zero candidates exist; reuses an existing matching PR if ownership and association validate; safely refuses foreign PRs, ambiguous candidates, or closed-unmerged PRs.
     - `readPr`: Inspects PR state, mergeability, draft status, and validates ownership markers.
     - `readChecks`: Binds check evaluation to the head commit SHA, extracts required checks and check runs / status contexts, and evaluates CI auto-merge policy.
     - `diagnoseFailedChecks`: Formats safe, human-readable diagnostics for pending or failing checks with sanitized links.
     - `landPr`: Requires explicit opt-in (`--opt-in`), verifies open and mergeable status, executes squash merge with `--match-head-commit <sha>`, and verifies final `state === "MERGED"` by re-reading the PR.
     - `verifyMerged`: Verifies whether a PR is in the final merged state and retrieves merge commit details.
   - Subprocess safety (`DefaultGhRunner`):
     - Executes `gh` via argv spawn (no shell interpolation).
     - Credential sanitization (`sanitizeCredentials`): strips PATs (`ghp_*`, `github_pat_*`), OAuth tokens, Authorization headers, and URLs with embedded user credentials.
     - Handles `gh pr checks` exit code 8 (pending checks) without treating it as CLI failure.
     - Subprocess timeout enforcement with process-group `SIGKILL`.

3. **CLI Host Integration (`@symphony/cli`)**:
   - Subcommands `symphony pr <action>` and `symphony delivery <action>`:
     - Actions: `ensure`, `read`, `checks`, `diagnostics`, `land`, `verify`.
     - Supports `--json` flag for machine-readable JSON output and standard text formatting.
     - Structured error exits with sanitized diagnostics.

## Alternatives considered

- **Alternative 1: Relying purely on branch name or PR title to claim existing PRs**:
  Rejected because external contributors or other automations might open PRs with similar titles or branch prefixes. Using structured machine-readable Symphony markers combined with issue closing keywords prevents unauthorized takeover of foreign pull requests.

- **Alternative 2: Permitting auto-merge when zero CI checks exist (empty set assumption)**:
  Rejected because merging before any CI check runs or in unconfigured repositories risks merging broken code. Requiring at least one strictly successful check when branch protection is absent provides a safe fallback without requiring pre-configured branch protection rules.

- **Alternative 3: Treating `gh pr merge` exit code 0 as sufficient proof of merge completion**:
  Rejected because exit codes from API wrappers can indicate accepted or queued requests rather than completed merges. The implementation mandates re-reading the PR from GitHub to verify `state === "MERGED"` and obtain the verified merge commit SHA.

- **Alternative 4: Putting delivery tools directly into `@symphony/orchestrator`**:
  Rejected because delivery operations represent provider-specific external tools (SPEC §11.5). Orchestrator must focus on coordination and scheduling; placing delivery in `@symphony/tracker` and exposing it via `@symphony/cli` preserves clean dependency boundaries.

## Consequences

- Automated agents and workflows have deterministic primitives to manage pull requests, CI verification, and squash merges.
- Full credential privacy: tokens and credentials are sanitized from outputs, errors, and URLs.
- Conformance matrix updated with §11.5 / §17.3 delivery capability.
