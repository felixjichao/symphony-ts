# @symphony/dashboard

Read-only operator shell, Overview, Work list and Work Detail for §13 adjacent / GitHub #138–#139 (NEST-125–126). TypeScript DOM components + Vite; no framework or domain projector runs in the browser.

## Run

From the repository root:

```sh
npm ci
npm run build -w @symphony/dashboard
npm run demo -w @symphony/dashboard
# http://127.0.0.1:4173 — Ctrl-C closes all listeners
npm run dev -w @symphony/dashboard
# optional startup scenario (built mode)
npm run demo -w @symphony/dashboard -- --scenario=unavailable
```

Dev HMR upgrades share the same loopback HTTP listener; no default wildcard HMR port is opened. Stop closes HMR clients before the HTTP listeners. Dev lifecycle tests check every acquired listener, a real HMR upgrade, bind failure cleanup and restart.

Both modes continuously show **演示数据**. Scenarios: `populated`, `empty`, `stale`, `unknown`, `unavailable`, `review`, `target-mismatch`, `result-mismatch`, `partial`, `conflict`, `terminal`. Scope is only `github:demo/alpha#1` and `github:demo/beta#1` (empty excludes both). Controlled memory SourceReaders feed the real operations query/projector and real observability HTTP server; no production stores or scheduler are opened. Importing examples does not start listeners. Startup failures clean up acquired resources. Production source/scope/lifecycle wiring is provided by the opt-in CLI; see [production usage](../cli/README.md#local-production-status-surface).

Browser has one fixed `GET /api/operations/snapshot`, no-store and redirects refused. The demo static server proxies this exact path to an ephemeral loopback transport without reshaping JSON. Other API paths return 404; upstream method/error codes remain intact. No CORS is added. Default exposure is local only; snapshots can contain sensitive identifiers and paths.

## Display contract

Overview binds service health and summary directly. Missing optional `degradedWork` / `anomalyCount` displays “该版本未提供”; no counting in the frontend. Work list orders supplied attention (needs_human/failed → degraded → waiting → normal), then full WorkKey tuple. Hash routes open structured Work Detail and retain row identities, including same-number issues across repositories; invalid/out-of-scope identities have an explicit message.

Source fresh/stale/unknown/unavailable remain textually distinct. Review approval is never reduced to a generic approved badge. Expand “完整 HEAD / 审查标识” with keyboard Enter/Space to select/copy full PR/current HEAD, task target, task/result target, task IDs and revisions. This is an observation, not merge authorization. Work Detail separates supplied current conclusions, scan-first execution / PR / review identities, source freshness and WorkKey-scoped executors from Why evidence and work anomalies. It independently labels PR HEAD, projected currentHeadSha, projected taskTarget (which may fall back to a result), actual task target and result target. Full SHAs remain selectable text. Raw evidence is keyboard-expandable. Missing roles/evidence and no reported anomalies are explicit, never inferred as permission to proceed.

WorkKey selection uses both provider and key for evidence, anomalies, source statuses and executor association. Foreign embedded evidence is hidden with an ownership diagnostic; global source statuses and global anomalies stay clearly separate. Invalid/out-of-scope routes clear detail. User navigation focuses the heading; refresh preserves focus and expanded diagnostics without taking focus. Existing list HEAD JSON remains available. No schema/HTTP change is needed.

Polling waits 15 seconds after completion; requests time out at 10 seconds. Hide/unmount aborts and cancels; visible resumes; generations reject late responses. Refresh failures retain the last successful snapshot with a prominent error and separate received/generated timestamps. Source freshness stays as supplied. 404, 405, sanitized snapshot 500, gateway 502/504, network/timeout and invalid shape/version are distinct. Partial/all unavailable 200 remains snapshot data. No persistent cache, mutation controls, workflow callbacks or historical claims.

## Validation

```sh
npm test -w @symphony/dashboard
npm test -w @symphony/domain
npm test -w @symphony/operations
npm test -w @symphony/observability
npm run typecheck
npm run docs:check
npm run gate
```

Browser tsc uses generated ignored `.contracts` declarations, without Node ambient globals. Node examples/tests/config have a separate tsconfig. Tests cover eight required UI states, input immutability, inconsistent projection pass-through, WorkKey isolation, polling cancellation and real query/HTTP/proxy behavior. Guards traverse core manifests and TS imports including aliases/dynamic/relative imports, restrict browser capabilities/imports at reference/binding sites (including fetch aliases), reject source-dependent truthiness/conditional/helper flows and typed business-enum returns, reject projection construction using the type checker and AST, pin closed shape/format helpers, test negative derivations and inspect the production module graph. Helper changes require explicit guard/fingerprint and negative-test review. These guard a restricted presentation surface; they do not prove arbitrary JavaScript safe.

## Real browser smoke

Build first. The general smoke accepts an installed Playwright module and Chromium:

```sh
npm run build -w @symphony/dashboard
SYMPHONY_BROWSER_MODULE=/absolute/path/to/playwright/index.mjs \
SYMPHONY_CHROMIUM=/absolute/path/to/chromium \
npx tsx apps/dashboard/examples/smoke.ts
```

The foreground smoke serves current `dist`, opens Chromium, checks loaded demo status, direct WorkKey routes, back/forward, three independent full SHAs, keyboard raw evidence, work isolation, review/mismatch/partial/conflict/terminal scenarios, fixed GET network requests, actual upstream disconnect and recovery, then closes browser/listeners. It prints browser version and asset hashes. This is local consumer acceptance, not production live verification. Default gate runs DOM/HTTP tests, not Chromium.

## Operator Console navigation
Top-level destinations are `#overview` (default), `#work`, `#executors` and `#system`. Work Detail keeps the existing `#${encodeURIComponent(JSON.stringify([provider, key]))}` format and highlights Work. Invalid and out-of-scope identities show an explicit message. Overview links to Work; inventory WorkKeys also open detail. Native hash history supports back/forward and refresh without server route configuration.

The shell always retains the production/demo label and refresh status. Keyboard navigation focuses the page or detail heading; the first skip link reaches current content. Polling preserves surviving focus and diagnostic expansion. Navigation wraps on narrow screens; wide Work tables scroll within their own panel.

The Chromium smoke additionally checks all destinations, active navigation, heading focus, invalid identities and 390px overflow, and writes desktop/narrow screenshots to `.symphony/evidence/dashboard-169` (override with `SYMPHONY_BROWSER_EVIDENCE`). Retain its JSON output alongside screenshots in the host issue/PR trail. Production labels are also checked by the shell repository tests.

## Presentation primitives (#170)

`src/primitives.ts` provides DOM-native attention/freshness badges, explicit display states, WorkKey and independent SHA identities, surfaces, dense tables/lists and native labeled search/filter controls. Append returned elements using the existing DOM model. Controls expose native events; callers supply behavior. Pass already-derived enums, never infer attention, phase, freshness, health or approval applicability here. Full SHA values remain in accessible names and titles; PR, task and result targets stay separate.

Regenerate the controlled matrix with `npx tsx apps/dashboard/examples/primitives.ts` from the repository root. Open [the standalone showcase](../../docs/evidence/dashboard-v2-primitives/showcase.html) locally. The existing optional Chromium smoke also captures this matrix at desktop/390px and checks Tab focus outline and full SHA accessibility. Regenerate before running smoke; no runtime route or API is added.

Overview prioritizes supplied human/failed work, degraded or anomaly-associated work, waiting, then other current work. Active counts come from the supplied summary. Source posture remains visible with empty scope; the persistent transport notice separates last successful response time/errors from snapshot generation time. Compact anomalies link context to WorkKey through work entries; full evidence remains in Work Detail / System. See [Overview acceptance artifacts](../../docs/evidence/dashboard-v2-overview/README.md) for controlled scenarios and optional narrow/keyboard rendering.

Work Explorer (#172) searches display identity/title and filters provider/repository scope, phase, attention and each source's freshness. Controls retain their values during polling and navigation; reset clears them. Repository scope is available for repository-shaped WorkKeys. Zero matches and an empty snapshot are distinct. The optional Chromium smoke exercises keyboard search/reset and narrow table overflow.

## Work Detail Why browser acceptance (#174)

```sh
npm run typecheck
npm exec -w @symphony/dashboard -- playwright install --with-deps chromium
npm run browser:detail -w @symphony/dashboard
```

The package command builds the Dashboard and runs `examples/detail-visual.ts` against the built same-origin demo. It uses the pinned Playwright dev dependency; an installed browser can be selected with `SYMPHONY_CHROMIUM`. Output defaults to `.symphony/evidence/work-detail-why` (override with `SYMPHONY_BROWSER_EVIDENCE`). Assertions cover desktop/390px supplied diagnostics, independent review targets, source failures, evidence roles, full-WorkKey isolation, global diagnostics, keyboard disclosure and real polling focus/open retention. Screenshots, supplied fixtures and `browser.json` retain HEAD, tracked changes, browser version and SHA-256 hashes. A failed assertion fails the command and records a failed report.

CI runs this acceptance after the canonical gate and uploads evidence as `work-detail-why-<checkout SHA>` for 30 days, including partial evidence when browser assertions fail. Retained local evidence and its exact baseline are indexed in the [Why acceptance ledger](../../docs/evidence/work-detail-why/README.md). Controlled browser acceptance does not establish live provider or delivery acceptance.
