# Dashboard V2 primitive evidence (#170)

[Controlled showcase](showcase.html) is generated from the actual DOM constructors and shared stylesheet, not a hand-maintained visual substitute. It includes every attention value, four freshness states, four explicit display states, separate PR/task/result SHA identities, surfaces, dense table/list and labeled native controls. It contains supplied test values only.

Regenerate from the repository root:

```sh
npx tsx apps/dashboard/examples/primitives.ts
```

Sandbox result (2026-10-26): Dashboard 10 test files / 158 tests passed, including primitive rendering, focus, SHA accessibility, negative derivation and production-bundle/capability checks. Root typecheck builds the production bundle. Scoped ESLint and docs:check are also run before handoff.

Real Chromium smoke was attempted using an existing Playwright module and Chromium binary. Launch failed before page rendering: `bootstrap_check_in ... Permission denied (1100)` in `mach_port_rendezvous_mac.cc`. No successful browser acceptance or screenshots are claimed. The standalone HTML is inspectable evidence of generated DOM only.

The operator host should regenerate the showcase, build Dashboard, then run the documented `apps/dashboard/examples/smoke.ts` with its installed browser/module and `SYMPHONY_BROWSER_EVIDENCE` set to a retained evidence directory. The extended smoke checks native Tab focus plus computed focus outline, badge matrix count and full SHA accessible name; it captures `primitives-desktop.png` and `primitives-narrow.png` alongside existing shell/detail screenshots and prints a JSON scenario/asset-hash ledger. Retain those artifacts with CI and independent exact-HEAD review in the host delivery trail. These are host validation steps, not completed sandbox evidence.
