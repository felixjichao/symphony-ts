# GitHub delivery dogfood

Opt-in, real GitHub + real Codex end-to-end verification of the closed-loop
delivery profile (SPEC §17.8 Real Integration, NEST-94 / #83). Unlike the
fixture-based suites, this harness drives the **real** entry points — the
Symphony host, the real Codex app-server, real branches/PRs, real GitHub Actions
and a real auto-merge — against an isolated test repository.

The harness itself only prepares scenarios, launches those real entry points,
injects controlled faults, reads GitHub back and records sanitized evidence. It
never implements, repairs, commits, pushes or merges on the agent's behalf.

## Default gate stays credential-free

`symphony dogfood github` is **never** part of `npm run gate`. It requires
explicit opt-in and an explicitly authorized isolated target, and without a
credential it prints `SKIPPED: ...` instead of pretending to pass. The only part
of the harness covered by the default gate is its pure contract surface
(`apps/cli/src/dogfood/contracts.test.ts`): opt-in gating, target safety, outcome
classification and evidence redaction.

## Target repository

Use a dedicated, throwaway repository. The harness refuses the product
repository (`felixjichao/symphony-ts`) and any target that is not the explicitly
authorized isolated repository, so a production target cannot enter the loop by
accident. The authorized default is `felixjichao/symphony-delivery-dogfood`, and
the target template lives in
[examples/github-delivery-dogfood/](../examples/github-delivery-dogfood/README.md).

The target needs: a default branch, the `symphony-ready` label, a CI workflow
that produces checks on pull requests, a `gate` script and a `ci:fix` repair
entry that runs real Codex. The template supplies all of these.

## Running

```sh
# Build once so the `symphony` binary is available.
npm ci && npm run typecheck
export PATH="$PWD/apps/cli/dist/bin:$PATH"

# Real run against the authorized isolated target (mutations: branches/PRs/merge).
GITHUB_TOKEN="$(gh auth token)" \
  symphony dogfood github --target felixjichao/symphony-delivery-dogfood --scenario happy --yes
```

The npm wrapper is `npm run dogfood:github -- --target <owner/repo> --scenario <s> --yes`.

### Scenarios

| Scenario | What it drives | Pass condition |
|---|---|---|
| `happy` | Host + real Codex implement the run's task, PR, green CI, opt-in squash merge | single PR merged, issue closed, checks green, **and terminal workspace cleanup observed** |
| `repair` | Same, but an injected CI-only lint fault makes the first head fail; real Codex `ci:fix` repairs it | a failing run is observed before a green run, then merged + cleaned up |
| `reuse` | A bounded pre-merge hold is created, the host is stopped once a PR exists, then restarted after the hold is released | same PR number reused, persisted delivery state present, single PR, merged + cleaned up, no wait timed out |
| `foreign` | A non-Symphony PR exists; the real `pr land` entry is invoked | land returns the **`ownership_refusal`** code; foreign PR stays open, unmerged, issue open |
| `conflict` | An owned PR is forced into a real conflict; `pr land` is invoked | land returns the **`unmergeable`** code; PR stays unmerged, issue open |

The safety scenarios are only considered proven when the real `pr land` entry returns the specific structured refusal code. A transport error, timeout, authentication failure, or any other outcome — even if the PR happens to stay unmerged — fails the scenario; it is not accepted as a safety refusal.

### Harness safety properties

- **Single pinned credential.** The harness resolves one credential (`SYMPHONY_DOGFOOD_TOKEN`, else `GITHUB_TOKEN`/`GH_TOKEN`) and refuses to run when both env vars disagree. The raw value is read through a non-redacting path and is never logged; the same value is exported to the host so tracker, `gh`, `git` and Codex delivery share one identity. Without an explicit env token it falls back to the ambient `gh auth` login and prints a warning.
- **Every started host is stopped.** All host runs are tracked and shut down on success, failure and cancellation; a timeout or thrown error still stops the host before the run is recorded as failed.
- **Terminal cleanup is mandatory** for `happy`/`repair`/`reuse`: the issue workspace directory must be observed, then removed, the workspace-root sentinel must survive, and the host must log `workspace_cleanup` `completed` for that exact issue.
- **Unique per-run task.** Each run asks for a distinct synthetic export name, so re-running a scenario on the same repository still exercises a real change.

### Exit status

- `0` — scenario passed, or the run was explicitly skipped (no opt-in / no
  credential). A skip prints `SKIPPED: <reason>` and is never counted as a pass.
- `1` — the scenario failed, the target was rejected, or a real external step
  (auth, permissions, Actions, protocol) failed. The harness fails closed; it
  never substitutes a fixture or a manual merge for a real result.

## Evidence

Each run writes `dogfood-artifacts/<runId>/manifest.json` (schema: `runId`,
`scenario`, `target`, `startedAt`, `finishedAt`, `status`, `reason`, `facts`,
`artifacts`) plus the referenced read-back files: issue and PR JSON, check
rollups, GitHub Actions run conclusions and the raw Symphony host log. Evidence
is written **outside** any workspace Symphony cleans up, and every string is
passed through `sanitizeCredentials` before it hits disk, so tokens, bearer
headers and credential-bearing URLs never enter the artifacts.

## Reproducing on another machine

1. Node >= 20, `npm ci`, `npm run typecheck`; put `apps/cli/dist/bin` on `PATH`.
2. Authenticate `gh` for an account with write access to the isolated target, and
   a Codex login (`codex login status`) so `codex app-server` starts.
3. Create the target from the template and add the `symphony-ready` label.
4. Export `GITHUB_TOKEN` and run the command above. No other machine state is
   needed; the harness renders `WORKFLOW.md` from the template and records a
   self-contained evidence manifest per run.

## Relationship to the reference profile

This harness drives the same runtime as
[docs/github-delivery-workflow.md](github-delivery-workflow.md); it adds no
orchestrator state or second state machine. The only product-code addition is the
`dogfood` subcommand and the target template.
