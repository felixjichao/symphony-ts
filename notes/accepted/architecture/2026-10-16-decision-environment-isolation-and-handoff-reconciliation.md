# Agent Note: Decision environment isolation and handoff reconciliation

Status: accepted

## Problem

In self-hosted and dogfood environments, test suites and delivery CLI runs were susceptible to cross-environment pollution and race conditions:

1. **Environment Contamination**: When parent shells or caller environments set `DECISION_BRIDGE_URL`, `DECISION_BRIDGE_TOKEN`, `DECISION_STORE_DIR`, or `SYMPHONY_PLANNING_ENABLED`, tests and commands inadvertently inherited remote bridge configuration. In `planning-cli.ts` and `host.ts`, `process.env.DECISION_BRIDGE_URL` was evaluated before local stores or fallback defaults, causing tests and gates to attempt remote calls to production bridge instances, leading to leaked planning tasks and polluted states (such as leaked plan tasks for `#99`). Furthermore, conflicting CLI options (e.g. specifying both `--store` and `--bridge-url`) did not fail fast before I/O.
2. **Delivery Handoff & Cancellation Race**: During delivery halts (budget exhaustion, manual intervention, or terminal blocker), `haltDispatch` previously removed the `symphony-ready` label on GitHub before writing local delivery state. When label removal immediately triggered Orchestrator reconciliation, the reconciler observed the unroutable issue and terminated the worker process before paused state, spent budget, and handoff report could be written to disk. Subsequent retries reset budgets or left issues in inconsistent states. Additionally, if the process was terminated mid-handoff, there was no safe recovery mechanism to finish posting the handoff comment and deduplicate remote reports without accidentally restarting coding or resetting spent budgets.

## Decision

1. **Decision Environment Isolation & Strict Configuration Precedence**:
   - **Vitest Environment Isolation**: Created `apps/cli/src/test-setup.ts` and configured `apps/cli/vite.config.ts` to automatically isolate Decision environment keys (`DECISION_BRIDGE_URL`, `DECISION_BRIDGE_TOKEN`, `DECISION_STORE_DIR`, `SYMPHONY_PLANNING_ENABLED`) during test execution.
   - **Fail-Fast on Option Conflict**: `parsePlanningArgs` in `planning-cli.ts` and `createHost` in `host.ts` enforce early validation; specifying both `--store` (or `decisionStoreDir`) and `--bridge-url` (or `decisionBridgeUrl`) throws an immediate error before any I/O.
   - **Explicit Store Precedence**: When an explicit store directory is provided, it takes strict precedence over inherited `DECISION_BRIDGE_URL` in the environment.
   - **Inverted Option Env Isolation**: `createHost` isolates provided `options.env` without falling back to ambient `process.env` for Decision keys.
2. **Durable Handoff-First Persistence & Reconciliation Resilience**:
   - **Write-Before-Remote in `haltDispatch`**: In `packages/agent/src/delivery/delivery-skill-runner.ts`, `haltDispatch` persists `isPaused: true`, `pauseReason`, actual `spentRepairs`, `spentWaitSeconds`, `pendingCompensation: true`, and full `handoff` intent to `.symphony/delivery-state.json` *before* attempting remote label removal or comment posting.
   - **Stepwise State Progression**: State updates at each step (`readyLabelRemoved: true`, `commentPosted: true`, `pendingCompensation: false`), ensuring that if worker execution is abruptly terminated by Orchestrator reconciliation after label removal, complete and accurate local facts remain persisted.
   - **Idempotent Recovery Entrypoint (`symphony delivery-skill recover-handoff`)**:
     - Safely inspects persisted state. If not paused, exits cleanly without mutating GitHub.
     - Completes unposted handoff comments while preserving actual spent budget and paused state.
     - **Remote Comment Deduplication**: Reads remote issue comments via `gh issue view --json comments` and skips re-posting if `## 🚨 Symphony Delivery Handoff Report` is already present.
     - Never resets budget, resumes coding, or adds back `symphony-ready`.
3. **Directional Cleanup Script (`scripts/cleanup-polluted-tasks.mjs`)**:
   - Targets leaked fixture plan tasks for `#99` (`github:felixjichao/symphony-ts#99`) in local store or remote bridge using `cancelTask`.
   - Defaults to safe dry-run mode (`--apply` required to execute).
   - Strict session boundary: Explicitly leaves `#137` and all other sessions untouched.

## Alternatives considered

- *Rely on process-exit handlers or finally blocks in haltDispatch*: Rejected. Orchestrator reconciliation terminates worker processes via OS signals (`SIGTERM` / `SIGKILL`) or subprocess termination, which can bypass asynchronous finally blocks or event loop ticks. Writing durable state before initiating remote mutations guarantees data safety.
- *Blindly re-post handoff comments on recovery without checking remote state*: Rejected. Network timeouts often succeed on GitHub's side despite returning an error or connection abort to the client. Querying issue comments and deduplicating based on report signature prevents spamming issues with duplicate handoff comments.
- *Global blanket purge script for all pending tasks in Decision Store*: Rejected. Indiscriminately cancelling tasks risks aborting legitimate active tasks belonging to `#137` or other concurrent work items. Targeted session filtering with dry-run default ensures surgical precision.
- *Rely on developer environment discipline without automated test isolation*: Rejected. Ambient environment variables from production sessions or shell rc files easily leak into test runs, causing nondeterministic test failures and remote side-effects. Automated vitest test setup guarantees reproducible hermetic isolation.

## Consequences

- Local test execution and full gate validation run hermetically without leaking requests to production Decision Bridge or using production stores.
- Delivery handoff is crash-proof against worker termination during Orchestrator reconciliation.
- Operators have a dedicated, idempotent compensation command (`recover-handoff`) and directional cleanup script (`cleanup-polluted-tasks.mjs`).
