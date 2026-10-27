# Overview evidence — #171 / SPEC §13 adjacent

Controlled supplied snapshots rendered through the actual `mount` / Overview constructors and shared CSS:

- [Healthy active](healthy.html), [intervention / degraded / waiting](attention.html).
- [Fresh empty scope](empty.html), [unavailable observation and transport failure retaining snapshot](observation-failure.html).

Regenerate: `npx tsx apps/dashboard/examples/overview.ts`. These standalone HTML artifacts are DOM output, not screenshots or production observations. Test fixtures intentionally permit inconsistent summaries; the page preserves supplied values.

Optional screenshots and native focus/overflow checks at 1280px and 390px:

```sh
SYMPHONY_BROWSER_MODULE=/absolute/path/to/playwright/index.mjs \
SYMPHONY_CHROMIUM=/absolute/path/to/chrome-headless-shell \
npx tsx apps/dashboard/examples/overview.ts
```

Built-product transport, navigation and refresh checks remain `apps/dashboard/examples/smoke.ts` (see Dashboard README). Sandbox attempt with installed Chromium 1243 failed at launch with macOS bootstrap permission denial / SIGABRT; no browser download, sandbox change, screenshot or successful browser acceptance is claimed. Host should retain screenshots alongside its CI / exact-HEAD review / Delivery receipts. Production Symphony self-hosting evidence belongs to the host after_run, not these controlled fixtures.

Sandbox validation: Dashboard 173 tests passed; root typecheck and Dashboard build passed. No full gate or delivery ran in the coding sandbox.
