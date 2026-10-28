# First live attempt — failed before PR creation

[Issue #28](https://github.com/felixjichao/symphony-delivery-dogfood/issues/28) remains Open. This attempt is **not** a passing recovery or cleanup run.

The [build](build.json) used unchanged product commit `b1fc832`. Actual Codex generated the [ready Plan](plan-1-receipt.json), which the native CLI published. Before coding admission, two transparent-wrapper defects were corrected in place: a generated syntax error and forced Node exit truncating large JSON on pipes. [Correction record](setup-correction.json) and both captured harness versions preserve that preparation history. The same isolated host remained alive; no Delivery budget existed at that point.

Target main had accidentally tracked old Issue #13 runtime and lacked `.gitignore`. [Baseline hygiene](baseline-hygiene.json) removes that foreign file from the source index and adds `.symphony/` before the #28 workspace exists. This did not delete live runtime or reset any issue's native budget.

The worker subsequently implemented source/tests, validated them, then invoked Delivery inside the actual Codex workspace-write sandbox. Git refused `.git/index.lock` creation. Native Delivery paused with repair count 0; [last native state](delivery-last-state.json), [manifest](manifest.json) and [host log](host.log) preserve the failure. Source edits and native state remain in the isolated workspace; no PR/commit/push was manufactured on the agent's behalf.

The next attempt uses the operator-owned `after_run` entry and the trusted-host staging fix. Its [separate ledger](../issue192-20261028075031/README.md) records actual transient recovery, automatic merge/closure and the remaining host cleanup failure. Neither attempt changes or restarts the existing production host/Bridge.
