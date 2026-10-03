# Agent Note: CLI host composition root and executable contract
Status: accepted

## Problem

SPEC §17.7 and §18.1 require an executable CLI entrypoint and composition root that wires the verified public packages (`@symphony/config`, `@symphony/tracker`, `@symphony/workspace`, `@symphony/agent`, `@symphony/orchestrator`, `@symphony/observability`) into a runnable service host. Prior to M6.3, `apps/cli` only contained M6.2 logging composition helpers, lacked an executable `bin` contract in `package.json`, and monorepo TypeScript was configured with `"noEmit": true` without build artifacts.

## Decision

1. **Host internal structure & `createHost()`**:
   - `apps/cli` provides pure CLI argument parsing (`parseCliArgs`) and workflow path resolution (`resolveWorkflowPath`) with priority given to positional path, falling back to `./WORKFLOW.md` in the current working directory.
   - `createHost(options)` serves as the composition root. It accepts optional dependency overrides (`workflowPath`, `cwd`, `env`, `logger`, `trackerProfiles`, `scheduler`, `retryScheduler`, `now`, `monotonicNow`) and assembles the full pipeline:
     `argv → resolveWorkflowPath → TrackerAdapterRegistry (built-in github profile) → loadEffectiveWorkflow → registerTrackerLogSecrets → observeTracker → WorkspaceManager → OrchestratorAuthority → OrchestratorLoop → SymphonyHost`.
   - `SymphonyHost` exposes `start()`, `stop()`, and read-only references to `effective`, `state`, `authority`, `loop`, and `logger`. The core host library contains no `process.exit()`, enabling deterministic integration testing within test processes.

2. **Packaging and `bin` contract**:
   - `vite` is declared explicitly in `apps/cli/package.json` devDependencies (pinned to `^5.4.21`, matching the monorepo lockfile).
   - `apps/cli` build script runs `tsc -p tsconfig.json && vite build`, using SSR mode to bundle `src/bin.ts` into a standalone Node ESM executable at `dist/bin/symphony.js` with shebang `#!/usr/bin/env node` and executable file mode `0o755`.
   - `package.json` specifies `"bin": { "symphony": "./dist/bin/symphony.js" }`.
   - `dist/` is gitignored.

3. **Thin executable entrypoint (`src/bin.ts`) & process lifecycle**:
   - `src/bin.ts` handles `--help` (exit 0) and `--version` (exit 0).
   - Startup preflight/config failures print an operator-visible message to stderr and terminate with exit code 1.
   - Minimal signal handling (`SIGINT`, `SIGTERM`) invokes `host.stop()` gracefully and exits with code 0.
   - Test suites automatically ensure the build bundle exists on demand when invoked independently.

## Alternatives considered

- **`tsc` direct emit**: Rejected because `tsconfig.base.json` path mappings only apply to TypeScript type resolution; standard Node runtime cannot resolve `@symphony/*` package aliases without bundler or package exports mapping.
- **`vite-node` dynamic launcher script**: Rejected for production CLI contract because it requires runtime devDependencies.
- **Node 22 `--experimental-strip-types`**: Rejected because root `package.json` requires `"node": ">=20"`, and native type stripping does not resolve monorepo path aliases.

## Consequences

- `apps/cli` is no longer a scaffold. `npm test -w @symphony/cli` executes full unit, integration, and child process suites.
- Production CLI executable `dist/bin/symphony.js` runs directly in Node >= 20 without third-party loaders.
- Real child processes verify explicit/default workflow loading, clean exit code 1 on missing/malformed configuration, and graceful signal shutdown.
- Workflow live reload and single `EffectiveRuntime` authority belong to M6.4 (NEST-84).
- Comprehensive signal race and terminal exit-code matrix belong to M6.5 (NEST-85).
