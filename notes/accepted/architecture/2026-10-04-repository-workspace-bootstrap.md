# Agent Note: Repository Workspace Bootstrap and Deterministic Issue Branch
Status: accepted

## Problem

Symphony creates clean workspace directories per issue (SPEC §9.1), but by default does not clone or populate repository code into the directory. When coding agents launch inside the workspace, they expect an executable clone of the target repository on an issue-specific branch (`symphony/<workspaceKey>`), with full git history and tracking.

Furthermore, orchestrator attempts are re-entrant. On subsequent attempts or continuations, the workspace already exists. If the local working tree has uncommitted modifications or local commits made by previous attempts, blindly resetting or pulling will destroy agent progress. Conversely, if the working tree is clean and has no local commits, it should fast-forward to the latest remote default branch without manual intervention.

Additionally, repository URLs may contain embedded credentials (e.g. personal access tokens `https://token@github.com/...`), which must never leak into command lines, console outputs, logs, or error messages. Subprocess execution must have bounded timeouts and terminate process groups cleanly.

## Decision

We implement repository bootstrap and issue branch synchronization in `@symphony/workspace`, exposed both as a TypeScript library API and as a CLI command in `@symphony/cli`:

1. **Core Library (`@symphony/workspace`)**:
   - `bootstrapRepository(options)`: Handles fresh clone and re-entrant synchronization in a target directory.
   - Dynamic default branch detection: Inspects `refs/remotes/origin/HEAD` or queries `git ls-remote --symref origin HEAD`, never hardcoding `main` or `master`.
   - Issue branch naming: Defaults to `symphony/${workspaceKey}` (where `workspaceKey` is derived from `options.workspaceKey` or `path.basename(targetDir)`).
   - Re-entrancy & synchronization rules:
     - Always fetch `origin` to refresh remote tracking refs.
     - Brand new branch created from latest remote default branch.
     - Clean tree + local HEAD ancestor of remote default branch: fast-forward to remote default branch.
     - Dirty working tree (uncommitted/untracked files) or branch with local commits: preserve working tree and branch HEAD untouched (no destructive merge or rebase).
     - Non-empty directory without `.git`: safe failure with `unrecognized_workspace_content`.
     - Repository origin URL mismatch: safe failure with `origin_url_mismatch`.
     - In-progress git operations (`MERGE_HEAD`, `REBASE_HEAD`, etc.): safe failure with `git_in_progress`.
   - Credential sanitization: `sanitizeRepoUrl` replaces embedded user/token credentials with `***`.
   - Local git identity: Configures `user.name` and `user.email` locally if not set globally.
   - Subprocess safety: All git commands run with `GIT_TERMINAL_PROMPT=0`, bounded execution timeouts, and process-group `SIGKILL` on timeout.

2. **CLI Subcommand (`@symphony/cli`)**:
   - Subcommands `repo-bootstrap`, `bootstrap-repo`, and `workspace bootstrap` run `runRepositoryBootstrapCli` directly without booting the orchestrator host daemon.
   - Accepts `--repo <url>`, `--target <path>`, `--branch <name>`, `--workspace-key <key>`, `--timeout-ms <ms>`, `--user-name <name>`, and `--user-email <email>`.

3. **Workspace Hook Integration**:
   - In `packages/workspace/src/hooks.ts`, `SYMPHONY_WORKSPACE_KEY` and `SYMPHONY_ISSUE_IDENTIFIER` are injected into child hook environments.
   - Users can invoke `symphony repo-bootstrap --repo <url>` directly in `after_create` or `before_run` hooks in `WORKFLOW.md`.

## Alternatives considered

- **Alternative 1: Hardcoding `main` as the default branch**:
  Rejected because many repositories use `master`, `trunk`, or custom default branches. Hardcoding breaks compatibility with existing projects. Dynamic resolution via remote HEAD accurately mirrors upstream repository settings.

- **Alternative 2: Blind `git pull --rebase` or `git reset --hard` on re-entrant runs**:
  Rejected because automated agent turns often leave uncommitted edits or intermediate commits across attempts. Destructive resets or automatic merges cause data loss or git conflict states that halt subsequent runs.

- **Alternative 3: Coupling repository clone directly into the Orchestrator loop**:
  Rejected because workspace population and synchronization are defined as optional extensions in SPEC §9 / §17.2. Keeping repository bootstrap in `@symphony/workspace` and invoking it via lifecycle hooks or CLI preserves modularity and avoids tight coupling between orchestrator scheduling and git operations.

## Consequences

- Workspaces can be bootstrapped into ready-to-run git checkouts with deterministic issue branches.
- Full re-entrancy safety: existing work and commits are protected against overwriting, while clean workspaces synchronize with default branch updates seamlessly.
- Zero credential leakage in logs, messages, and terminal outputs.
- Conformance matrix SPEC §9 and §17.2 conditional entries for workspace population and synchronization are satisfied.
