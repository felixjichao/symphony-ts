# NEST-119 macOS acceptance

GitHub issue [#115](https://github.com/felixjichao/symphony-ts/issues/115) mirrors NEST-119. The macOS gate was rerun against the NEST-119 test-fixture follow-up on 2026-10-12.

## Host

- macOS 26.6.2 (build 25G83), Darwin 25.6.0, arm64
- Node.js v24.15.0, npm 12.2.0, Vitest 2.1.9, zsh
- `TMPDIR=/private/tmp`; the default `/var/folders` path resolves to `/private/var/folders` on this host, which otherwise makes `pwd` path assertions compare aliases.
- Tests ran with host process visibility. The restricted sandbox cannot query process groups with `pgrep`, so its process-cleanup failures are not acceptance evidence.

## Results

Target code commit: `4d985a1` (`test(workspace): stabilize macOS process fixtures`), based on `10e8149` (merged NEST-119 PR #119).

| Command | Result |
|---|---|
| `TMPDIR=/private/tmp npm test -w @symphony/workspace -- --maxWorkers=1 --minWorkers=1` | Pass: 7 test files, 168 tests |
| `TMPDIR=/private/tmp npm run gate` | Pass: typecheck/build, all workspace tests, lint, and docs check |

The fixtures retain their behavior assertions: hook timeout cases still use the explicit 250ms deadline; the fake Git supervisor still times out and verifies process exit; the fork/reparent case confirms the leaf reached its ready marker, was terminated, and did not write its delayed marker; the close-takeover probe keeps its 1500ms confirmation delay scoped to that test, above its 1000ms timeout.
