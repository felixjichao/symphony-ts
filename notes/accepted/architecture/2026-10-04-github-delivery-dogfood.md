# Agent Note: GitHub Delivery Real-Integration Dogfood Harness

Status: accepted

## Problem

SPEC §17.8 Real Integration Profile had no runnable, reproducible entry point. The
M0–M6 Core suites and the GitHub delivery MVP fixtures (NEST-90–93) prove behavior
against local fixtures and subprocesses, but nothing drove the full closed loop
against **real** GitHub and **real** Codex: real issue polling, real workspace
bootstrap, a real Codex app-server editing code, real branches/commits/push, a real
pull request, real GitHub Actions, a real repair cycle, a real opt-in squash merge,
and a real terminal reconciliation with workspace cleanup. Acceptance for #83 is
evidence from those real runs, not more fixtures.

Two constraints shape the solution: the default `npm run gate` must remain
credential-free, and the dogfood must never touch a production repository or
fabricate a pass when credentials are absent.

## Decision

Add an opt-in, standalone harness plus an isolated synthetic target template; the
harness drives existing real entry points but never performs delivery itself.

1. **`symphony dogfood github` subcommand** (`apps/cli/src/dogfood/`). It supports
   five scenarios (`happy`, `repair`, `reuse`, `foreign`, `conflict`). It performs
   environment preflight, prepares issues/branches/PRs, starts the real Symphony
   host (or the real `pr`/`delivery-skill` CLI for the safety scenarios), injects
   controlled faults, polls GitHub for the expected terminal facts, stops the host
   gracefully, classifies the outcome and writes a sanitized evidence manifest.
2. **Pure, gate-covered contracts** (`contracts.ts`): argument parsing, the opt-in
   gate, target safety (the product repository and any unauthorized target are
   rejected), one-to-one acceptance classification, and evidence redaction reuse.
   The whole entry point takes injected dependencies, so
   `contracts.test.ts` plus `github-dogfood.test.ts` run credential-free inside
   the default gate and reproduce the false-positive paths (e.g. a `pr land`
   transport error must fail, not pass as a safety refusal).
3. **Skip, don't fake.** Without `--yes` or a credential the harness prints
   `SKIPPED: <reason>` and exits 0; an enabled run that hits a real failure exits
   non-zero and records the failure. It never substitutes a fixture or a manual
   merge for a real result.
4. **Isolated target template** (`examples/github-delivery-dogfood/`): a minimal
   synthetic project, a CI workflow with a CI-only lint gate, and a `ci:fix` entry
   that runs a bounded real `codex exec` session. The `repair` scenario injects a
   deterministic `console.log` lint fault into the target before dispatch.
5. **Out-of-workspace evidence**: `dogfood-artifacts/<runId>/manifest.json` plus
   issue/PR/check/Actions-run/merge/host-log artifacts, all passed through
   `sanitizeCredentials`, stored outside any workspace Symphony cleans up.
6. **Fail-closed safety semantics.** `foreign`/`conflict` pass only when the real
   `pr land` entry returns the specific structured refusal code from the real
   `GitHubDeliveryService` contract (`ownership_refusal`; and `merge_rejected`
   together with an independently verified `CONFLICTING` fact, since
   `merge_rejected` is also used for draft/UNKNOWN). A transport error or any
   other outcome fails the scenario even if the PR stays unmerged.
   `happy`/`repair`/`reuse` additionally require observed terminal workspace
   cleanup (directory removed, root sentinel preserved, `workspace_cleanup`
   `completed` logged for the exact issue); `happy`/`repair` also require a
   recorded Actions run whose head SHA equals the delivered PR head with a
   success conclusion. `reuse` compares the PR number and branch before/after the
   restart and requires the persisted absolute CI-wait deadline to be unchanged,
   proving resume rather than a budget reset. One resolved credential is pinned
   into the environment of every GitHub operation (harness `gh` and host); a
   conflicting token is a hard error, and only a genuinely missing credential
   skips (a missing `gh` binary or an unexpected `gh auth token` failure is a
   non-zero tool failure). The `reuse` restart hold reads the current branch
   protection, converts the GET body into a valid PUT payload (boolean wrappers,
   login/slug mappings, preserved app bindings, null semantics, and explicit
   `app_id: -1` for any-source checks instead of auto-selection), verifies
   conversion fidelity before mutating, and exactly restores it with a read-back
   check (requiring Administration write);
   `SIGINT`/`SIGTERM` request cancellation that stops the host/Codex process
   group and lets the scenario's own `finally` finish (restore + log capture)
   before returning 130/143, and failed runs retain their workspace, persisted
   delivery state and sanitized logs for recovery.

## Alternatives considered

- **Fold the dogfood into the default gate or CI.** Rejected: it would require
  real GitHub and Codex credentials in CI, breaking the credential-free Core CI
  boundary (acceptance #7) and making the gate flaky and network-dependent.
- **Let the harness perform the delivery steps (commit/push/PR/merge) directly.**
  Rejected: that would test the harness, not the product. The closure must go
  through the existing real host and delivery-skill entry points.
- **Reuse a production repository as the target.** Rejected: real mutation
  (branches, PRs, merge, issue close) against production is unsafe and the
  acceptance requires an isolated repository. The harness hard-rejects the product
  repository and any target other than the authorized isolated one.
- **Seed the CI failure by weakening CI or deleting tests during repair.**
  Rejected: the repair must be a real code fix. The repair scenario injects a
  deterministic CI-only lint fault (a `console.log` in `src/` caught only by the
  CI lint gate the local gate skips), so the repair path exercises real Codex
  fixing real code, not hiding a failure.
- **Treat any unmerged PR as proof that a safety guard worked.** Rejected: a
  transport error, permission failure or timeout also leaves the PR unmerged.
  The safety scenarios must observe the specific structured refusal code returned
  by the real `pr land` entry; anything else fails.
- **Hold the restart window by replacing branch protection wholesale.** Rejected:
  a blind PUT/DELETE destroys existing required checks, reviews and admin
  settings. The harness instead reads the current protection, merges in one
  additional required check, and restores the exact prior settings (or deletes
  when none existed), with the mutation and restore inside the same `finally`.

## Consequences

- The §17.8 Real Integration Profile now has a runnable, documented entry point
  (`docs/github-delivery-dogfood.md`) that stays out of the default gate.
- Real-run evidence is reproducible on another machine given `gh` and Codex
  credentials; absent credentials produce an explicit SKIP, never a false pass.
- The product code delta stays small: the `dogfood` subcommand and the target
  template. No orchestrator state, no second state machine, no provider-native
  tools refactor.
- Operators must supply an authorized isolated target; the harness will refuse to
  run otherwise. Removing `symphony-ready` (or deleting `.symphony/delivery-state.json`
  to start a new budget round) remains an explicit operator action.

- Real validation on 2026-10-06 found that GitHub rejected a protection PUT with
  both legacy `contexts` and source-aware `checks`. Conversion now emits only
  `checks`, mapping legacy contexts to explicit any-app sources. A real PUT and
  restoration validated this choice before the restart scenario was retried.
- Runtime delivery-state files are excluded from initial and repair source
  status/staging. The target template also ignores `.symphony/`; real Git tests
  protect against persisting runtime budgets in source commits.
