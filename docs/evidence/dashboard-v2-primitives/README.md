# Dashboard V2 primitive evidence (#170)

[Controlled showcase](showcase.html) is generated from the actual DOM constructors and shared stylesheet, not a hand-maintained visual substitute. It includes every attention value, four freshness states, four explicit display states, separate PR/task/result SHA identities, surfaces, dense table/list and labeled native controls. It contains supplied test values only.

Regenerate from the repository root:

```sh
npx tsx apps/dashboard/examples/primitives.ts
```

Repair validation (2026-10-26, SPEC §13 adjacent): Dashboard 10 test files / 161 tests passed, including supplied taskTarget with a missing task, a different nested target and a missing taskTarget. Root typecheck (including production build), scoped ESLint and docs:check passed. No guard or acceptance assertion was relaxed.

The initial sandbox Chromium launch failed before rendering with macOS `bootstrap_check_in ... Permission denied (1100)`. The unchanged documented smoke subsequently **passed** using the installed Playwright module and Chromium headless shell outside the execution sandbox. No browser was installed and the pinned host was not modified.

Retained browser acceptance:

- [JSON scenario, asset, source and screenshot SHA-256 ledger](browser/acceptance.json), including browser version and GET-only requests.
- [Primitive desktop screenshot](browser/primitives-desktop.png) at 1280px and [primitive narrow screenshot](browser/primitives-narrow.png) at 390px; both visually inspected.
- Shell desktop/narrow and detail screenshots are retained in the same `browser/` directory. The smoke also passed native Tab focus/computed outline, full SHA accessible name, routing/history, diagnostic focus across polling, isolation and transport disconnect/recovery checks.

Reproduce after regenerating the showcase and building Dashboard:

```sh
SYMPHONY_BROWSER_MODULE=/absolute/path/to/playwright/index.mjs \
SYMPHONY_CHROMIUM=/absolute/path/to/chrome-headless-shell \
SYMPHONY_BROWSER_EVIDENCE=docs/evidence/dashboard-v2-primitives/browser \
npx tsx apps/dashboard/examples/smoke.ts
```

This run validates the repaired working tree, identified by source and production-asset hashes in the JSON ledger. No commit was created. The delivery runner owns final commit identity, full gate, CI and independent exact-HEAD review; bind those receipts to this retained evidence before landing. This is local built-browser acceptance, not production live verification.
