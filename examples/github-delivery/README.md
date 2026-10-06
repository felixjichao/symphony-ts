# GitHub delivery reference profile

A copy-paste `WORKFLOW.md` that wires Symphony's scheduler together with the
delivery skill into the smallest closed loop on a real GitHub repository:

```text
open issue + `symphony-ready`
  → Symphony dispatch
  → per-issue workspace bootstrap (clone + `symphony/<workspaceKey>` branch)
  → Codex implement + validate
  → commit + push + create/reuse PR
  → CI inspect + bounded repair
  → squash merge (opt-in only)
  → `Fixes #N` closes the issue
  → Symphony terminal reconciliation + workspace cleanup
```

The runtime behavior lives in the existing packages; this profile only supplies
configuration and a prompt. It does **not** add orchestrator state or a second
state machine. Start from the [root README](../../README.md) for installation and
prerequisites; see [docs/github-delivery-workflow.md](../../docs/github-delivery-workflow.md)
for the full start/run/stop lifecycle and the [CLI reference](../../apps/cli/README.md)
for every subcommand.

## Prerequisites

- Node.js >= 20 and a built `symphony` CLI on `PATH`
  (`npm ci && npm run build`, then put the absolute `apps/cli/dist/bin` on `PATH`).
- `git` on `PATH` with credentials for the target repository.
- [`gh`](https://cli.github.com) authenticated for the same account, so the
  delivery skill can read checks and merge. Run `gh auth setup-git` once on the
  host so `git push` reuses those credentials.
- A `GITHUB_TOKEN` (repo scope) exported for the tracker, and Codex installed so
  `codex app-server` starts.

## Copy into a target repository

1. Copy `WORKFLOW.md` from this directory to the root of the target repository.
2. Copy `skills/github-delivery/` from the Symphony checkout into the target
   repository so the `after_create` hook can install it into the workspace
   (`skills/github-delivery/SKILL.md`).
3. Replace the repo-specific values, then commit both into the target repository.

### Values you must change

| Location | Placeholder | Replace with |
|---|---|---|
| `tracker.provider.repo` | `<owner/repo>` | the target repository, e.g. `acme/widget` |
| `tracker.provider.token` | `$GITHUB_TOKEN` | keep as-is, or point at your own env var |
| `hooks.after_create` | `https://github.com/<owner/repo>.git` | the target clone URL |
| prompt `--base` | `$SYMPHONY_DELIVERY_BASE` (default: the repo's default branch) | set only to override the discovered base branch |
| prompt `--validate` | `$SYMPHONY_DELIVERY_VALIDATE` (default `npm run gate`) | the repository's own validation command |
| prompt `--repair-cmd` | `$SYMPHONY_DELIVERY_REPAIR_CMD` (default `npm run ci:fix`) | a command that repairs the failure described in `SYMPHONY_CI_FAILURE_DIAGNOSTICS` |

Everything else is a reasonable default. The `--base`, `--validate`, and
`--repair-cmd` values can be overridden through the `SYMPHONY_DELIVERY_*`
environment variables shown above, so you usually do not need to edit the prompt.
`--repair-cmd` must exit non-zero when it could not repair; the delivery skill
never invents an empty repair and re-checks CI only after a new commit/SHA is
produced. Adjust `polling.interval_ms`, `agent.max_turns`,
`agent.max_concurrent_agents`, and the `codex.*` values to match the repository.

## Start / run / stop

```sh
# Start: load this profile and supervise the loop.
GITHUB_TOKEN=... symphony /path/to/WORKFLOW.md
```

- **Start** — an issue in the target repository that is `open` and carries the
  `symphony-ready` label is dispatched automatically.
- **Run** — the coding agent implements, validates, and calls
  `symphony delivery-skill run ... --opt-in` to reach a squash merge. CI failures
  are repaired within a bounded budget; no human merge is required.
- **Stop** — send `SIGINT` / `SIGTERM` to the host for a graceful shutdown. To
  pause a single issue without stopping the host, remove its `symphony-ready`
  label; the delivery skill does this itself when it hands a blocker back.
- **Recover** — after a handoff, fix the root cause and re-add `symphony-ready`.
  The delivery command detects the paused state and resumes. Note that resume
  keeps the already-spent repair count and wait deadline; a budget-exhausted
  handoff needs an operator to start a new budget round first. See
  [docs/github-delivery-workflow.md](../../docs/github-delivery-workflow.md#stop-and-exit-paths).

## Safety

- Only issues with `symphony-ready` are dispatched, and only the pull request
  that belongs to the current issue/workspace is auto-merged.
- Foreign or unmanaged pull requests are never merged; checks that are pending,
  failing, or unknown never merge.
- Never place credentials in committed files. In the MVP trust boundary the
  delivery skill uses host-provided `git` / `gh` credentials and redacts secrets
  from every output it prints.
