# Isolated live profile (opt-in)

Current result: **not run**. This environment has no supplied authenticated browser,
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
