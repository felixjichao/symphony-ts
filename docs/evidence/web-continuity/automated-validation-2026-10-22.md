# PR #156 automated validation — 2026-10-22

Scope: uncommitted Decision/Web follow-up changes on `feat/nest-132-web-continuity`, based on `b005b399ce87fd640569d14c05441af19913553b`. SPEC §4 Decision extension, §13 adjacency, §17/§18 validation. Self-host tooling and unrelated orchestrator dispatch changes were removed before validation.

## Results

- `npm test -w @symphony/chatgpt-web`: 29 files, 193 tests passed.
- `npm test -w @symphony/decision`: 11 files, 111 tests passed.
- `npm run typecheck`: passed, including production bundle generation.
- `TMPDIR=/private/tmp npm run gate` outside the execution sandbox: exit 0; 11 workspaces, 2,019 tests passed, one existing opt-in test skipped; lint and documentation checks passed.
- `git diff --check`: passed.

The first sandboxed gate failed: `ps` was denied with `operation not permitted`, preventing real process-group cleanup confirmation; macOS `/var` versus `/private/var` temporary-directory aliases also broke cwd equality assertions. The bootstrap race test reproduced the failure independently. The complete host run with a canonical temporary directory passed the same suites without source changes. No tests or safety checks were disabled.

Decision's canonical Vite build regenerates `scripts/cleanup-polluted-tasks.mjs`; its matching generated diff remains part of this change.

## Acceptance boundary

Automated coverage includes active heartbeat 401/403 interruption, authoritative lease expiry recovery, conversation drift fencing, admission checks before heartbeat/result acceptance, receipt idempotency after target changes, no replay after tab identity loss, and task-bound response recognition under DOM windowing.

This run did not perform real ChatGPT/Tampermonkey fault injection, verify the installed userscript version, create a new commit or push. Historical failures in [PR #156](https://github.com/felixjichao/symphony-ts/pull/156#issuecomment-6315625918) remain pending fresh real-browser acceptance. This evidence alone does not close #148 or make #156 ready to merge.
