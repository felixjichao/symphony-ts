# Work Detail browser evidence (#173)

2026-10-28: built Dashboard demo, Edge 156.0.4314.50, `apps/dashboard/examples/smoke.ts`. The smoke passed WorkKey isolation, exact HEAD identities, keyboard navigation, 390px layout, source failure and transport recovery. Screenshots show the result-mismatch scenario at desktop and narrow widths.

- [Desktop](current-detail.png)
- [Narrow](narrow-current-detail.png)

Full host gate passed once with `TMPDIR=/private/tmp`. Subsequent automated delivery gate failed on an intermittent workspace timeout test; its handoff remains pending because the report exceeded GitHub comment size. CI and independent exact-HEAD review remain pending.
