# Read-only status acceptance (#140 / NEST-127)

Production composition is `apps/cli/src/status.ts`, used by `createHost` and the built executable. No demo service or prepared OperationalSnapshot is used by the new acceptance suite. External facts/time are controlled; readers, operations projectors/query, HTTP, same-origin hosting and built browser code are real.

| Scenario / assertion | Durable evidence |
| --- | --- |
| Healthy active work | `status.test.ts` healthy: coding, healthy, wire equals independently invoked operations query with fixed facts/time |
| Waiting for CI / review | ci/review: supplied waiting reason survives HTTP and built DOM |
| Human / clarification | needs_human/needs_clarification: independent Decision verdicts preserve waiting and attention |
| Modeled degraded anomaly | conflict: canonical anomaly, degraded health, scoped evidence |
| Stale | stale runtime retains original timestamp, distinct stale freshness end to end |
| Unavailable with partial projection | partial: first GitHub source fails safely, second work and other sources remain visible |
| Exact HEAD mismatch | task-target, old approval and task/result-target variants; three complete SHAs independently visible |
| Cross-source contradiction | terminal: completed phase retained alongside execution_on_terminal_work |
| Completed | completed scoped work remains in list and detail |
| Concurrent WorkKeys | two repos, same issue number and task ID; navigation/direct/refresh/back retain full identity and scoped anomalies |
| Inventory empty / unconfigured | empty-inventory fresh empty vs unknown-inventory unknown; no inferred heartbeat |
| Transport interruption / recovery | Chromium stops/restarts actual production listeners on same port; last success retained then replaced |
| Domain pass-through / no browser conclusions | wire equals real operations query; DOM matches phase/attention/waiting/freshness; existing frozen inconsistent projections and AST/type/graph/module guards remain |
| Status failure has no authority effect | host.test.ts disabled/missing-assets/rejected-source/enabled: same real worker failure, first retry reservation and clean stop, no host.failure |
| Decision read-only / exact-HEAD safety | real temporary shared store and authenticated Bridge read equality, persisted bytes unchanged, expired lease retained, no token/context/receipt, current-HEAD approval remains refused before/after observation and store close |
| Credential origin / reload | `status-credentials.test.ts`: real host + public GitHub profile + production HTTP; GHES/alternate API bases/other providers start no subprocess; public default/trailing-slash origin works; reload blocks unsupported sources, recovers with the new public token and preserves the old validated token for an in-flight read |
| Bounded I/O / teardown | real stalled Bridge body abort; bounded GitHub runner commands; status stop fences admission and drains disconnected reads; bind/asset rollback |
| Architecture / read-only HTTP | status-boundaries negative fixtures, existing package/browser dependency guards and bundle scan; POST/PUT/DELETE/PATCH/HEAD 405, unknown API 404 |
| Packaged executable | Chromium launches actual built CLI with an isolated HTTPS tracker, different cwd and empty scope, checks production assets, then signals clean stop |

[Gate results](validation.json) record the implementation commit, full command, workspace results and the earlier default-concurrency failures. No failing test, timeout or skip policy was relaxed.

`browser.json` records the browser version, static asset SHA-256, scenario results and GET-only network result. It distinguishes controlled production composition scenarios from the actual executable packaging smoke. The source commit identifies the checkout at invocation; the candidate marker explicitly identifies uncommitted candidate runs. The final implementation commit and validation are recorded in the PR. This is automated/local acceptance, **not authenticated public GitHub/Decision live acceptance**. No external workflow was modified, no real ChatGPT session was required, and no #159 live evidence is borrowed. An optional external read-only smoke remains unrun; #140 allows automated or durable evidence for representative faults.

## Reproduce

```sh
npm ci
npm run build -w @symphony/cli
npm test -w @symphony/cli -- src/status.test.ts src/status-boundaries.test.ts src/status-credentials.test.ts src/host.test.ts
npm test -w @symphony/dashboard
npm test -w @symphony/operations
npm test -w @symphony/observability
npm test -w @symphony/decision
npm run gate
# Use an already installed Playwright module and matching Chromium; no browser download:
SYMPHONY_BROWSER_MODULE=/absolute/path/playwright/index.mjs \
SYMPHONY_CHROMIUM=/absolute/path/chrome \
node --import tsx apps/cli/scripts/status-smoke.mjs
```

The smoke is foreground, closes all child processes/listeners/browser contexts, and prints JSON. The real executable uses an isolated fixture tracker and no scoped external work. Controlled clocks and source faults use the same production composition entry, not a binary with hidden test environment flags. DOM tests are not substituted for Chromium. Root gate remains the required repository delivery check.

## Scope and limits

Observation scope is explicit; empty scope does not mean global idleness. Only default verified GitHub delivery naming is supported; custom metadata is not scanned or guessed. Unconfigured inventory remains unknown. Bridge configured with planning disabled is still readable through its observation client; an inactive local store is unavailable rather than opened again. Cross-source observations are not atomic. The browser uses bounded polling, not streaming. History, analytics, journaling and operator actions remain deferred. Parent #136 closure remains an owner decision after independent review.
