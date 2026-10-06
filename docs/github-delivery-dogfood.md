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
| `happy` | Host + real Codex implement the run's task, PR, green CI, opt-in squash merge | single PR merged, issue closed, checks green with a recorded CI run tied to the delivered head SHA, **and terminal workspace cleanup observed** |
| `repair` | Same, but an injected CI-only lint fault makes the first head fail; real Codex `ci:fix` repairs it | a failing run is observed before a green run tied to the head SHA, then merged + cleaned up |
| `reuse` | A bounded pre-merge hold is created, the host is stopped once a PR exists, then restarted after the hold is released | same PR number **and branch** reused, persisted delivery state's absolute deadline preserved across restart, single PR, merged + cleaned up, no wait timed out |
| `foreign` | A non-Symphony PR exists; the real `pr land` entry is invoked | land returns the **`ownership_refusal`** code; foreign PR stays open, unmerged, issue open |
| `conflict` | An owned PR is forced into a real conflict; `pr land` is invoked | land returns the real **`merge_rejected`** code with a verified `CONFLICTING` mergeable state; PR stays unmerged, issue open |

The safety scenarios are only considered proven when the real `pr land` entry returns the specific structured refusal code. A transport error, timeout, authentication failure, or any other outcome — even if the PR happens to stay unmerged — fails the scenario; it is not accepted as a safety refusal.

### Harness safety properties

- **Single pinned credential.** The harness resolves one credential (`SYMPHONY_DOGFOOD_TOKEN`, else `GITHUB_TOKEN`/`GH_TOKEN`) and refuses to run when more than one distinct value is present. The raw value is read through a non-redacting path and never logged, and it is pinned as both `GH_TOKEN` and `GITHUB_TOKEN` in the environment used by **every** GitHub operation — harness `gh` calls (preflight, issue/PR setup, protection, land) and the host alike — so nothing falls back to another ambient identity. Without an explicit env token it falls back to the ambient `gh auth` login and prints a warning; a missing credential is the only case that skips.
- **Non-destructive restart hold.** For `reuse`, the harness reads the current branch protection and adds an unsatisfiable required check, converting the GET body into a valid PUT payload (boolean `enabled` wrappers, user/team/app objects mapped to login/slug, `required_status_checks` app bindings preserved, `null` kept null, and null/absent check sources restored as explicit `app_id: -1` "any app" rather than relying on GitHub's auto source selection). It then **restores the exact prior protection** (or deletes it when none existed) and reads it back to confirm; a conversion-fidelity check runs before any mutation. The mutation and its restore are inside the same `try/finally`, and the restore runs even when the PUT's own evidence write fails. This requires **Administration: write** on the target repository for the `reuse` scenario only.
- **Signals unwind the main chain.** `SIGINT`/`SIGTERM` request cancellation: they stop the detached host/Codex process group (`SIGINT` → `SIGKILL`) and wake the running wait, so the scenario's own `finally` completes (branch-protection restore, log capture) before the process returns `130`/`143`. Cancellation never calls `process.exit` from a side branch.
- **Every started host is stopped** on success, failure and cancellation.
- **Failed runs are retained.** A failed or cancelled run keeps the run working directory (workspace + persisted `.symphony/delivery-state.json`) and the sanitized host log so the flow can be resumed and the failure diagnosed; only a clean success removes the harness's run working directory (Symphony itself already cleans the issue workspace on the success path).
- **Terminal cleanup is mandatory** for `happy`/`repair`/`reuse`: the issue workspace directory must be observed, then removed, the workspace-root sentinel must survive, and the host must log `workspace_cleanup` `completed` for that exact issue. `happy`/`repair` additionally require a recorded GitHub Actions run whose `headSha` equals the merged PR head and whose conclusion is success, so the CI evidence is tied to the delivered commit.
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
   a Codex login (`codex login status`) so `codex app-server` starts. The
   `reuse` scenario additionally needs **Administration: write** on the target to
   set and restore the bounded restart hold. Prefer exporting a target-scoped
   `GITHUB_TOKEN` so the identity is explicit and pinned.
3. Create the target from the template and add the `symphony-ready` label.
4. Export `GITHUB_TOKEN` and run the command above. No other machine state is
   needed; the harness renders `WORKFLOW.md` from the template and records a
   self-contained evidence manifest per run.

## Relationship to the reference profile

This harness drives the same runtime as
[docs/github-delivery-workflow.md](github-delivery-workflow.md); it adds no
orchestrator state or second state machine. The only product-code addition is the
`dogfood` subcommand and the target template.

## Runtime state and real verification

Delivery status checks and staging exclude `.symphony/delivery-state.json` in
both initial delivery and CI repair. The target template also ignores
`.symphony/`; persisted budgets stay local to the workspace. Existing tracked
state is left untouched in the index, rather than deleting source files during
an automated delivery.

On 2026-10-06, the isolated target demonstrated real happy delivery in
[PR #12](https://github.com/felixjichao/symphony-delivery-dogfood/pull/12), with
[CI run 37406707232](https://github.com/felixjichao/symphony-delivery-dogfood/actions/runs/37406707232)
successful on the delivered head. The original harness read-back timed out;
a host restart then observed the closed issue and removed its workspace.
The failed harness manifest is retained alongside the recovery evidence.
[PR #14](https://github.com/felixjichao/symphony-delivery-dogfood/pull/14)
demonstrated an actual failing CI run followed by a real Codex repair, green CI,
automatic merge, issue closure, and terminal cleanup.

When Codex tool shells filter inherited credential variables, use a private
`GH_CONFIG_DIR` populated from the selected `gh-bot token`, and put the literal
configuration directory in the rendered workflow's delivery shell block.
Unset `GH_TOKEN` and `GITHUB_TOKEN` in that block so another ambient token cannot
override the selected configuration. Keep the configuration outside the evidence
and workspace roots, restrict its directory/file permissions to 700/600, and
remove it after the host stops. Never place the token itself in the workflow.
A bounded retry wrapper may retry read-only GitHub requests on transient TLS
errors; writes are not automatically replayed, and the delivery deadline remains
unchanged across a restart.

The restart hold PUT sends the source-aware `checks` form alone; sending both
legacy `contexts` and `checks` was rejected with HTTP 422 during real validation.
Legacy contexts are converted to explicit any-app checks (`app_id: -1`) before
apply/restore, preserving source semantics. A real checks-only PUT and DELETE
restore succeeded on the isolated target. See the
[GitHub branch-protection API](https://docs.github.com/en/rest/branches/branch-protection)
for the check-source contract.

The controlled restart used the same
[PR #17](https://github.com/felixjichao/symphony-delivery-dogfood/pull/17), branch,
head SHA, and persisted absolute deadline before/after restarting. Its
[CI run 37408085760](https://github.com/felixjichao/symphony-delivery-dogfood/actions/runs/37408085760)
passed, followed by automatic merge, issue closure and workspace cleanup; exactly
one linked PR was found. The original harness stopped when policy restoration
hit a TLS timeout. An operator read the actual policy, removed only the run-owned
hold, verified the original unprotected state, and restarted the same host.
The failed manifest and successful recovery evidence are both retained; this
result includes that operator recovery, rather than claiming an uninterrupted
harness pass. Foreign/conflict refusal evidence remains from the 2026-10-05
real runs (`ownership_refusal` / `merge_rejected`), with both PRs still open.
