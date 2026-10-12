# NEST-119 macOS acceptance

GitHub issue [#115](https://github.com/felixjichao/symphony-ts/issues/115) mirrors NEST-119. This evidence is from the PR #121 branch at code commit `e16cbaabf8502554300c3c9154555dc079a2442c`, based on merged PR #119 (`10e8149`).

## Host and run conditions

- macOS 26.6.2 (build 25G83), Darwin 25.6.0, arm64; Node.js v24.15.0; npm 12.2.0; Vitest 2.1.9; zsh.
- `TMPDIR=/private/tmp` avoids this host's `/var/folders` → `/private/var/folders` canonical-path mismatch in `pwd` assertions.
- The final gate ran without process tracing. Its host load averages were `3.71, 4.82, 4.67` before and `5.66, 5.36, 4.90` after, on a 10-core host.

## Uninstrumented results

| Command | Result | Log |
|---|---|---|
| `TMPDIR=/private/tmp npm test -w @symphony/agent -- --maxWorkers=1 --minWorkers=1 --reporter=verbose` | 10 files, 208 passed | [agent single-worker log](logs/agent-single-worker.log) |
| `TMPDIR=/private/tmp npm test -w @symphony/workspace -- --maxWorkers=1 --minWorkers=1 --reporter=verbose` | 7 files, 168 passed | [workspace single-worker log](logs/workspace-single-worker.log) |
| `TMPDIR=/private/tmp npm run gate` | Passed: typecheck/build, all workspace tests, lint, docs check | [full gate log](logs/npm-run-gate.log) |

The gate's `@symphony/chatgpt-web` suite reported 187 passed and 1 skipped. `docs:check` reported 83 Markdown files and 329 valid relative links.

## Three timeout cases

Each filtered case passed on the same commit and also passed uninstrumented as part of the package suites and full gate. For the detailed runs, a temporary Node preload recorded `spawn`, `process.kill`, child close signal, and stderr; `ps -axo pid,ppid,pgid,state,etime,command` sampled the process tree every 25ms. The preload did not modify repository source. Raw test output is attached: [agent before_run timeout](logs/agent-before-run-timeout.log), [outer hook timeout](logs/workspace-hook-timeout.log), [direct bootstrap timeout](logs/workspace-direct-timeout.log). The event and process snapshots are [JSONL events](logs/macos-target-process-events.jsonl) and [process-state timeline](logs/macos-target-process-samples.log).

- Agent `before_run`: hook process `57090` (`ppid=57059`, `pgid=57090`) and child `57117` (`ppid=57090`, same PGID) were observed in running/sleeping states. The runner sent `SIGKILL` to `-57090`; close reported `signal=SIGKILL`, empty stderr, and both PIDs disappeared from `ps`. The test confirmed `hook_timeout`, no agent startup marker, and a completed `after_run` marker.
- Outer hook / managed Git: hook process `58193` (`ppid=57743`, `pgid=58193`); Git `58579` (`ppid=57743`, `pgid=58579`); upload-pack shell `58580` (`ppid=58579`, `pgid=58579`). The supervisor sent `SIGKILL` to `-58579`, then to the hook group; Git close reported `SIGKILL` and empty stderr. All three PIDs disappeared from `ps` by `08:35:40.175Z`.
- Direct bootstrap: Git `59455` (`ppid=58871`, `pgid=59455`) and upload-pack shell `59456` (`ppid=59455`, `pgid=59455`) were observed. The runner sent `SIGKILL` to `-59455`; Git close reported `SIGKILL` and empty stderr. Both PIDs disappeared from `ps` by `08:35:51.933Z`.

## Fixture follow-up

The first full-gate capture under process sampling exposed another timing coupling: a test intentionally timed out `after_run` at 250ms, then reused that same budget for `before_remove`'s `echo`/`exit 5` assertion. The fixture now gives `before_remove` the normal 3000ms budget while retaining the 250ms `after_run` timeout assertion. The uninstrumented full gate above passed with this change.
