# Isolated live profile (opt-in)

Original 2026-10-22 result: **not run**. This environment has no supplied authenticated browser,
page/Bridge endpoint or approved isolated live target. GitHub bot credentials alone
are not evidence of a usable ChatGPT page. No product PR/Issue was fault-injected.

1. Choose disposable dogfood Issue/PR and independent workspace, Decision store,
   Bridge and browser profile. Record original PR HEAD and expected-current value
   before changing the branch. Never mutate the implementation PR for this test.
2. Checkout the exact delivered commit. Run `npm ci` and `npm run typecheck`; record
   `git rev-parse HEAD`, `git status --porcelain`, Node/npm versions and SHA-256 of
   `apps/cli/dist/bin/symphony.js` and installed userscript. Confirm installed script
   identity on the page; a repository build alone does not prove installation.
3. Use the native host startup/poll path and authenticated Bridge. For each matrix
   row, save a separate template record with redacted native readbacks. Set fault
   barriers on durable intent, accepted provider effect or ACK, never a fixed sleep.
4. W02/W03: reload during navigation/response; restart the driver service and then
   the entire browser process separately. Read native task/lease/binding/receipt and
   checkpoint. With no enabled page, require explicit browser-page wait. Reopen the
   page and verify receipt-first recovery or conservative unknown-Send blocking.
5. W04/W05/P03: lose the response after result acceptance or incident POST; restart
   and verify the authoritative receipt/remote marker before any second effect.
   Repeat with provider unavailable before acceptance. Capture effect counts and
   outbox attempts; ambiguous POST must not be blindly repeated.
6. W10/P02: exercise actual login/human-required UI, inaccessible/deleted conversation,
   heartbeat 403 and native rebind exhaustion. Record finite configured attempts,
   incident ID, CLI list/show readback and absence of a retry loop. Do not simulate
   login UI with a fixture and label it live passed.
7. W06–W09: retain only safe generation identifiers, reclaim/rebind/supersede or
   advance isolated PR HEAD, then attempt the old operation. Record rejection plus
   unchanged current state. Restore the branch with expected-current protection and
   read back the restored SHA; retain exact-HEAD merge opt-in.
8. Record lease expiry/progress threshold, poll period, retry due/backoff, process
   TERM→KILL bounds and reporter's three-attempt cap. Measure elapsed convergence
   against these bounds. External waits have an observable owner/condition, not a
   promise of business completion during an unlimited outage.
9. Stop the exact test child PIDs and isolated listeners, close test tabs, restore
   branch/labels and verify targets and temporary stores were cleaned or intentionally
   retained as redacted evidence. Never delete production `.symphony-host` to unblock.

Pending current-build live items: browser-process restart, driver/host restart with
installed artifact identity, real provider/report ACK ambiguity, authentication/human
UI, deleted conversation and native exhaustion. Historical tests narrow investigation;
they do not resolve these current-composition gaps. Parent #145 stays open.

## Environment required to resume

Review follow-up on 2026-10-22 did not establish a usable live environment. No
browser-control tool or authenticated page/Bridge address was supplied to this run.
A local headless DevTools MCP process is present, but its existence establishes
neither an accessible logged-in ChatGPT/Tampermonkey page nor current installation
identity. No unrelated browser/profile or account store was opened or modified.
Historical 4040/4041 loopback listeners were explicitly shut down in their evidence;
their addresses are not a reusable live environment contract.

The operator needs to supply or confirm:

- A dedicated logged-in ChatGPT browser profile/page, enabled Tampermonkey script,
  and a reachable browser-control connection (or an operator to perform the UI
  interventions). Confirm the installed artifact hash and ability to restart that
  isolated browser without affecting ordinary work.
- Bridge base URL reachable from that page and this host, isolated Decision/store
  and workspace paths, allowed origin, and a secure credential-file handoff. Do
  not paste tokens in issue comments or commit authentication stores.
- Disposable GitHub Issue/PR/repository and permitted fault operations. Historical
  `felixjichao/symphony-delivery-dogfood` #24/#25 are candidates only until their
  current ownership/availability is confirmed; do not assume old branch values.
- Isolated driver/host launch and stop handles, expected retry/lease/progress
  configuration, and permission to exercise auth/human/deleted-conversation and
  finite exhaustion cases on that test account/profile.

After these are available, repeat preflight at the latest PR head, execute each
applicable pending row with template readbacks, and request review only after new
live evidence exists. Keep PR #159 Draft and unmerged meanwhile. Its task-key link
can auto-complete NEST-135 on merge; changing closing text alone does not disable
that association. A partial merge would require explicit maintainer acceptance
and handling of automatic completion settings first.

## 2026-10-23 environment update

The earlier environment inventory above is historical. A controllable authenticated Edge page with the Driver HUD and configured Token is now available; an isolated current-source Bridge was successfully restarted after SIGKILL. [Current follow-up](run-2026-10-23.md) records the exact boundary. Tampermonkey editor access is blocked by browser security policy, so current installation must be confirmed by the operator. The operator subsequently confirmed installing the current artifact; real ChatGPT generation/reload and accepted-result ACK-loss variants passed. Installed bytes were not independently extracted. See the current follow-up for readbacks and remaining gaps.

## Core host follow-up

[Core acceptance](core-acceptance-2026-10-23.md) supplies complete createHost + Bridge process SIGKILL/restart with a native auth block, plus genuine worker retry budget exhaustion retained after another host restart. These use real GitHub reads and private stores, with remote reporting unavailable by design. Full browser-process restart and actual auth/human UI, Web strategy exhaustion and provider report ACK ambiguity are still pending.
