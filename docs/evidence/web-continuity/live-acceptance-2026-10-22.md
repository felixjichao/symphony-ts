# PR #156 real-browser acceptance preflight — 2026-10-22

Status: partial real-browser fault acceptance completed after operator installation confirmation; remaining scope is listed below.

## Observed environment

- Real Edge browser, logged-in ChatGPT, existing Tampermonkey Symphony HUD.
- A new HTTPS test page was used; the browser security policy rejected acquisition of a historical suspended-extension page, which was not bypassed.
- An isolated production DecisionBridge was bundled from current workspace source; a loopback-only authenticated fault proxy forwarded port 4040 to 4041. No production store was opened and no GitHub issue/PR was mutated.
- Existing temporary acceptance token was reused privately; no token was displayed or changed in browser settings.

## Preflight observations

1. Start Driver polled the empty isolated queue successfully: server trace recorded `GET /v1/tasks/next` with HTTP 204.
2. Stop Driver followed by a real browser reload retained Idle / Ready to connect, with Start Driver available.
3. No task was seeded, claimed or submitted during this preflight.

Full-page screenshot retained locally; omitted from public evidence to avoid unrelated account/sidebar content.

These observations apply to the installed script only. Its source identity was not independently established; HUD features and version number alone cannot prove installation of the current build.

## Required next step

Update the existing Tampermonkey script from `apps/chatgpt-web/dist/symphony-decision-driver.user.js`, then confirm completion. The current artifact SHA-256 is `c08b9ad494f101a2c4197c0666a33e21c76af8e74a309c5c49e5ffd251114154`.

The isolated harness, synthetic materialized Plan seed helper, fault controls and sanitized request trace are retained in `/private/tmp/symphony-pr156-live-20261022`. Active task reload/close/reopen, heartbeat authentication recovery, result request/ack loss, session drift, supersession, HEAD-change and competing-tab acceptance remain pending. No new passing claim is made for the historical failures of #156. Bridge/proxy listeners were stopped after preflight; Driver remains stopped, and the test page is retained for handoff.

## Current-build real-browser fault run

After the operator confirmed updating Tampermonkey from the current artifact, a fresh Edge page loaded the Driver. The dist SHA-256 was rechecked against the preflight manifest and was unchanged. Installation provenance is the operator confirmation; installed bytes/header were not independently extracted. The test used the real ChatGPT page and model, actual Tampermonkey Driver, production DecisionBridge/store code, and an authenticated loopback fault proxy. Synthetic materialized Plan tasks used fictitious `symphony-acceptance/pr156#148` / `#149` identities; they are not real GitHub issues. No delivery host ran and no GitHub writes occurred.

| Scenario | Result and readback |
|---|---|
| Reload during active response | Passed. The real Stop-generation button was present immediately before reload. Driver restarted automatically; task `#148:plan:1` produced a matching result receipt, claim/binding generation 1. Visible diagnostics contain one `prompt_submitting`; the original conversation initially contained one matching task prompt. |
| Active heartbeat 401 and restore | Passed. `#148:plan:3` entered waiting_response; actual heartbeat returned injected 401 at 06:06:38 UTC. HUD displayed Error. After proxy restoration, no Start was clicked; Driver returned to Running and accepted the saved/recovered result at the same claim generation. No failure receipt was recorded. |
| Active result submission 403 and restore | Passed for result submission, not heartbeat. `#148:plan:6` result POST returned 403. After restoration, without Start, its result was accepted at claim generation 1. The injection did not hit a heartbeat, so heartbeat-403 remains unverified live. |
| Network loss before acceptance | Passed. First `#148:plan:4` result request was disconnected before forwarding; receipt lookup returned 404. Driver resubmitted the persisted candidate and received an accepted result at generation 1. |
| Accepted result, lost response | Passed. `#148:plan:5` result was accepted by Bridge; proxy discarded its successful response. The next receipt GET returned 200. Trace contains one accepted result POST and no second result POST for this task. |
| Close/reopen active response | Passed for automatic page startup and safe no-replay convergence; not a full host-recovery test. Original page visibly streamed before close; a new tab opened the same conversation and started without Start. After the original lease expired, an explicit operator-side fenced native reclaim was invoked (no host coordinator was running). It wrote human_required without incrementing claim generation. Original task prompt count was one. Old heartbeat and a new claim were refused with 409; repeated reclaim returned false. No receipt was fabricated. |
| Two enabled tabs | Passed for single-claim/single-result behavior. Both tabs were Running against the same pending `#149:plan:1`; trace records one successful claim and one result POST, with one matching receipt and generation 1. No simultaneous claim-conflict request was observed, so this is not evidence for a forced same-instant race. |
| Active conversation drift | Passed for fail-closed blocking. During `#149:plan:2` generation the active page was navigated to the other known conversation. Native readback recorded human_required and no receipt; binding generation remained 1. This tests route mismatch, not actual deleted/inaccessible conversation recovery. |
| Superseded blocked recovery | Passed. Creating `#149:plan:3` superseded blocked revision 2. Without Start or manual page recovery, Driver navigated to the authoritative binding, sent revision 3 once, and accepted its matching result receipt. Revision 2 has no receipt. |
| Durable Stop | Passed. Driver was stopped after the run; refreshing the other tab retained Idle / Ready to connect. Both test pages were stopped before shutting down Bridge. |

Ten tasks were created (one extra ordinary task completed before a planned auth injection could be armed). Eight result receipts were accepted. Every task retained claim generation 1 and each session retained binding generation 1. Older successfully completed Plan revisions are marked superseded by subsequent revisions; their durable result receipts remain present. The remaining two tasks are the blocked lost-tab execution and the superseded drift execution, so their lack of result receipts is expected.

### Durable evidence

- [Sanitized final native readback](live-readback-2026-10-22.json)
- [Proxy request/status trace](live-requests-2026-10-22.ndjson), excluding authorization headers and request/response bodies
- [Initial visible Driver diagnostics](live-hud-first-rounds-2026-10-22.json)
- [Recovery visible Driver diagnostics](live-hud-recovery-2026-10-22.json)
- Full-page capture retained locally; public screenshot omitted to avoid unrelated account/sidebar content.

### Remaining acceptance and limits

This run does not exercise an actual GitHub PR HEAD change during an active review: all generated tasks were Plan tasks, and this isolated Bridge did not compose the production GitHub admission callback. Exact-HEAD review safety still requires a real review + GitHub admission run. Actual ChatGPT sign-out/auth UI, deleted/inaccessible conversation and bounded rebind exhaustion, browser-process restart, active-heartbeat 403, and automatic host-coordinator reclamation also remain unverified live. Explicit native reclaim is not evidence of automatic host recovery. No old failed acceptance is relabeled as passed outside the directly retested scenarios.

The run is therefore partial acceptance, not a basis to close #148 or mark #156 ready. No source fixes, commit, push or PR-state update were performed. The test stores remain isolated under /private/tmp for diagnosis; all loopback listeners were stopped, Driver enabled intent is false, and no real issue was dispatched.

## Subsequent final-gate run

The same-day [final-gate acceptance](final-gates-2026-10-22.md) now verifies actual GitHub HEAD changes during a real Review and automatic native-host reclaim/blocking with real GitHub source readers. The manual-reclaim and Plan-only limitations above describe this earlier run; they do not apply to that follow-up. Other untested categories remain unchanged.
