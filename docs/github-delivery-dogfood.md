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
| `happy` | Host + real Codex implement `subtract()`, PR, green CI, opt-in squash merge | single PR merged, issue closed, checks green |
| `repair` | Same, but the seeded CI-only lint fault makes the first head fail; real Codex `ci:fix` repairs it | a failing run is observed before a green run, then merged |
| `reuse` | Host is stopped once a PR exists, then restarted | exactly one PR for the issue, resumed from GitHub facts |
| `foreign` | A non-Symphony PR exists; the real delivery land entry is invoked | foreign PR stays open, no merge, issue open |
| `conflict` | An owned PR is forced into a real conflict; land is invoked | PR stays unmerged, issue open |

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
