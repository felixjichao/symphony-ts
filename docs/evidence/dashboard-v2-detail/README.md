# Work Detail browser evidence (#173)

2026-10-28: built Dashboard demo, Edge 156.0.4314.50, `apps/dashboard/examples/smoke.ts`. The smoke passed WorkKey isolation, exact HEAD identities, keyboard navigation, 390px layout, source failure and transport recovery. Screenshots show the result-mismatch scenario at desktop and narrow widths.

- [Desktop](current-detail.png)
- [Narrow](narrow-current-detail.png)

Full host gate passed once with `TMPDIR=/private/tmp`. Subsequent automated delivery gate failed on an intermittent workspace timeout test; its handoff remains pending because the report exceeded GitHub comment size. CI and independent exact-HEAD review remain pending.

## Representative current-state matrix

The following deterministic, synthetic `WorkProjection` snapshots exercise the built Dashboard through the demo HTTP transport. They are presentation evidence, not production observations. Each scenario is asserted before capture and shown at 1280px and 390px; the script also rejects page-level horizontal overflow. The stale-review fixture independently displays the current PR HEAD and the older task/result target.

| Scenario | Desktop | 390px |
|---|---|---|
| Planning ready | [Desktop](planning-ready-desktop.png) | [Narrow](planning-ready-narrow.png) |
| Active coding | [Desktop](active-coding-desktop.png) | [Narrow](active-coding-narrow.png) |
| Waiting / stale review | [Desktop](waiting-stale-review-desktop.png) | [Narrow](waiting-stale-review-narrow.png) |
| Partial source / missing data | [Desktop](partial-missing-desktop.png) | [Narrow](partial-missing-narrow.png) |
| Terminal | [Desktop](terminal-desktop.png) | [Narrow](terminal-narrow.png) |
| Needs human | [Desktop](needs-human-desktop.png) | [Narrow](needs-human-narrow.png) |

Run against installed Playwright and Chromium/Edge, without browser downloads:

```sh
npm run build -w @symphony/dashboard
SYMPHONY_BROWSER_MODULE=/absolute/path/to/playwright/index.mjs \
SYMPHONY_CHROMIUM=/absolute/path/to/chromium \
SYMPHONY_BROWSER_EVIDENCE=/absolute/path/to/output \
npx tsx apps/dashboard/examples/detail-visual.ts
```

2026-10-28: Edge 156.0.4314.50 passed all 12 screenshots and scenario assertions. The fixture fixes timestamps and reloads for each scenario; it does not exercise live source ingestion. The existing smoke remains the evidence for keyboard navigation, routing, transport recovery and WorkKey isolation.
