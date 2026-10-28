# Work Detail Why acceptance (#174 / SPEC §13 adjacent)

## Reviewed exact HEAD

On 2026-10-28 the original `apps/dashboard/examples/detail-visual.ts` was run against **`3f69e85b0220ac3fb2648d162133a597b3d88bd1`**, before any tracked workspace changes. Root typecheck rebuilt the Dashboard from that clean tracked tree. Edge 156.0.4314.50 passed the six supplied scenarios at 1280×900 and 390×844, including stale approval/independent HEAD targets, partial sources and visible evidence provenance. The [exact-HEAD report](exact-head/browser.json) retains the command, empty tracked-change list, original harness hash, built-asset hashes and all 12 screenshot hashes.

| Original scenario | Desktop | 390px |
|---|---|---|
| Planning ready | [Image](exact-head/planning-ready-desktop.png) | [Image](exact-head/planning-ready-narrow.png) |
| Active coding | [Image](exact-head/active-coding-desktop.png) | [Image](exact-head/active-coding-narrow.png) |
| Waiting / stale review | [Image](exact-head/waiting-stale-review-desktop.png) | [Image](exact-head/waiting-stale-review-narrow.png) |
| Partial / missing | [Image](exact-head/partial-missing-desktop.png) | [Image](exact-head/partial-missing-narrow.png) |
| Terminal | [Image](exact-head/terminal-desktop.png) | [Image](exact-head/terminal-narrow.png) |
| Needs human | [Image](exact-head/needs-human-desktop.png) | [Image](exact-head/needs-human-narrow.png) |

## Expanded diagnostic acceptance

The repair adds the reproducible package command `npm run browser:detail -w @symphony/dashboard` and pinned Playwright dependency. The [follow-up report](repair/browser.json) records the baseline HEAD **and tracked repair changes**, rather than claiming these changes are already committed. Its built JS/CSS hashes match the exact-HEAD report above: the product rendering code is unchanged. The [captured inputs](repair/fixtures.json) distinguish controlled read-model outputs from explicitly supplied synthetic diagnostic fixtures. Read-model scenarios are generated once before the browser run and then held stable; other fixture timestamps are fixed.

Edge 156.0.4314.50 passed 17 scenarios at both widths (34 detail screenshots), plus two interaction/global screenshots. Assertions check visible diagnostic text and independent full SHAs, page overflow, absence of foreign evidence even inside closed raw disclosures, keyboard Enter activation, and focus/open-state retention after an actual 15-second HTTP polling replacement. System separately displays the global anomaly. No page errors were observed. Raw evidence is collapsed in the common-path screenshots.

| Diagnostic scenario | Desktop | 390px |
|---|---|---|
| Matching-head review | [Image](repair/read-model-review-desktop.png) | [Image](repair/read-model-review-narrow.png) |
| Stale task target | [Image](repair/read-model-target-mismatch-desktop.png) | [Image](repair/read-model-target-mismatch-narrow.png) |
| Independent task/result mismatch | [Image](repair/read-model-result-mismatch-desktop.png) | [Image](repair/read-model-result-mismatch-narrow.png) |
| Stale approval diagnostic | [Image](repair/stale-approval-desktop.png) | [Image](repair/stale-approval-narrow.png) |
| Partial Decision source | [Image](repair/read-model-partial-desktop.png) | [Image](repair/read-model-partial-narrow.png) |
| Conflicting active review tasks | [Image](repair/read-model-conflict-desktop.png) | [Image](repair/read-model-conflict-narrow.png) |
| Active execution on terminal Work | [Image](repair/read-model-terminal-desktop.png) | [Image](repair/read-model-terminal-narrow.png) |
| GitHub unavailable / runtime unknown | [Image](repair/github-failure-desktop.png) | [Image](repair/github-failure-narrow.png) |
| Runtime unavailable / GitHub stale | [Image](repair/runtime-failure-desktop.png) | [Image](repair/runtime-failure-narrow.png) |
| Decision unavailable / stale + unknown peers | [Image](repair/decision-failure-desktop.png) | [Image](repair/decision-failure-narrow.png) |
| Decision session/task contradiction, all four roles, adversarial same-key/different-provider isolation | [Image](repair/contradiction-isolation-desktop.png) | [Image](repair/contradiction-isolation-narrow.png) |

The original six scenarios also run through the expanded command; their captures and hashes are listed in the follow-up report. [Keyboard raw evidence after refresh](repair/keyboard-refresh.png) and [separately labelled global diagnostics in System](repair/global-system.png) retain the interaction results. Screenshots are presentation evidence from controlled inputs, not live GitHub/Decision/runtime observations.

## Reproduction and retention

From the repository root:

```sh
npm ci
npm run typecheck
npm exec -w @symphony/dashboard -- playwright install --with-deps chromium
npm run browser:detail -w @symphony/dashboard
```

To use an installed browser, set `SYMPHONY_CHROMIUM` to its executable and omit the browser installation. Set `SYMPHONY_BROWSER_EVIDENCE` to an absolute output directory; the default is `.symphony/evidence/work-detail-why` relative to the Dashboard workspace. Browser launch used a disposable profile with loopback fixture pages only; no production state or pinned host was modified.

CI keeps the canonical gate unchanged. After it passes, an independent browser job checks out `pull_request.head.sha` (or the push SHA), builds, runs the package command, and uploads `work-detail-why-<exact checkout SHA>` for 30 days. The artifact contains fixtures, screenshots and `browser.json`, including failed reports/partial captures on assertion failure. A browser failure fails that job. The retained local evidence does not claim the future repair commit has passed CI or independent review.

Validation: Dashboard 12 test files / 198 tests passed; root typecheck, scoped ESLint and docs:check passed. Production Symphony CI → exact-HEAD Review → Delivery remains owned by the delivery runner; this ledger closes the missing browser/visual evidence only.
