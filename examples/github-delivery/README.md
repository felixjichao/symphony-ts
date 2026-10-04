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
state machine. See [docs/github-delivery-workflow.md](../../docs/github-delivery-workflow.md)
for the full start/run/stop lifecycle and the [CLI reference](../../apps/cli/README.md)
for every subcommand.

## Prerequisites

- Node.js >= 20 and a built `symphony` CLI on `PATH`
  (`npm ci && npm run typecheck`, then put `apps/cli/dist/bin` on `PATH`).
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

Everything else is a reasonable default. Adjust `polling.interval_ms`,
`agent.max_turns`, `agent.max_concurrent_agents`, and the `codex.*` values to
match the repository.

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

## Safety

- Only issues with `symphony-ready` are dispatched, and only the pull request
  that belongs to the current issue/workspace is auto-merged.
- Foreign or unmanaged pull requests are never merged; checks that are pending,
  failing, or unknown never merge.
- Never place credentials in committed files. In the MVP trust boundary the
  delivery skill uses host-provided `git` / `gh` credentials and redacts secrets
  from every output it prints.
