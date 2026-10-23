# #162 complete-host bounded-convergence follow-up — 2026-10-23

SPEC §4 adjacent, §7/§8/§10/§12/§14/§17/§18; baseline in [upstream](../../upstream.md).
Source runtime: `937e9d6d9e74c90f736137d897efdca856444594`.

**Result: bounded-convergence observed for a lost native-created test window.**
The complete host blocked the sent task 27.296 seconds after its final lease expired.
Transparent browser-session resume remains unaccepted. #162 and parent #145 remain open.

## Composition and controls

Production `createHost` + authenticated production DecisionBridge/durable store,
loopback proxy 4040 → 4041, real GitHub adapter scoped to read only issue #162, and
installed Edge/Tampermonkey Driver. Coding dispatch was disabled. The host recovery
reporting runner refused external reporting; the local incident is the acceptance
surface. No GitHub issue, PR, comment, branch or label was changed. The synthetic
materialized Plan used only test text; it requested no tools or external changes.

Private working files are in `/private/tmp/symphony-162-20261023`. Tokens and raw
store/response text are excluded from published evidence. A previously configured
loopback token was used without changing browser credentials. Current installed bytes
were not independently extracted, so installation identity remains a limitation.

## Native-window run

The test used a native Edge New Window and address-bar navigation, rather than an
agent-created browser tab. The first task completed while a native Activity Monitor
tool call stalled for approximately 38 minutes; it is **excluded** from quit acceptance.
A second synthetic task, revision 2, reached actual response generation, with a visible
Stop-generation control and native `waiting_response` progress. Native menu **Quit
Microsoft Edge** was then used. A preceding keyboard shortcut did not prove exit.

Activity Monitor screenshots showed main PID 44752 before and 8768 afterward. The
native API subsequently showed a newly opened window; reopening was tool-assisted.
There was no direct sample of old-process absence in this run, so the changed PID
proves process replacement without claiming an independently observed stopped interval.
The original separate test window was not restored; no foreign checkpoint/lease was
copied or adopted. Checkpoint storage was not directly inspected, so its absence is
not asserted. No browser setting was changed.

[Native task/incident readback](bounded-browser-result-2026-10-23.json) and
[scoped HTTP trace](bounded-browser-http-2026-10-23.ndjson) retain the exact timestamps.
The last progress heartbeat was 15:49:12.447 Asia/Shanghai; lease expiry was
15:51:12.447, native block 15:51:39.743, and local incident 15:51:47.725.
The final successful heartbeat lease was 120 seconds. Host polling was configured at
2 seconds; actual scans included fresh GitHub I/O and therefore took longer than the
configured scheduling interval. A valid lease was retained until expiry. The native
block arrived 27.296 seconds after expiry; its local incident was persisted afterward.
The test continued beyond the progress deadline and still read back blocked.

The task retained native status `running`, but `execution.blocked.reason` was
`human_required`, with conversation/receipt inspection instructions. Host diagnosis was
`blocked` / `require_human`, with a durable incident, claim generation 1 and binding
generation 1. Thus native task status alone is insufficient to detect stranded work.
Receipt HTTP status was 404, result POST count was zero, and task start POST count
was one. These are the observed no-replay signals; they do not prove every possible
UI side effect. No successful-result receipt was manufactured for the blocked task.

## Agent-tab comparison and remaining boundary

A new agent-managed tab automatically started the Driver, navigated to the existing
binding and sent revision 3. It showed active generation. Browser-control commands
experienced a timeout, then native automation refused an action because the user
changed Edge. No second quit was established. The test Driver was explicitly stopped
and its agent tab closed; this attempt is **not** a passed process-restart comparison.
Creation of revision 3 superseded the earlier isolated revision only **after** revision
2's blocked readback and incident had been captured. The published revision-2 record
is that pre-comparison snapshot, not a claim about its later superseded state.

The root cause of transparent restore is still unisolated: session/window restore,
agent-managed tab lifetime and Driver tab identity/checkpoint lookup need separate
successful controls. This evidence establishes safe host convergence in one real
composition, not universal browser recovery or closure of #162/#145/#151. Crash/SIGKILL,
other session policies, unavailable GitHub observations and remote incident posting
are outside this live result.

## Automatic regression and interface fix

Run from the repository root:

```sh
npm test -w @symphony/cli -- src/work-continuity.test.ts
npm test -w @symphony/decision -- src/continuity.test.ts
npm run gate
```

The CLI regression uses actual host startup/ticks, authenticated HTTP Bridge and a
durable store, with fixture tracker/GitHub facts and controlled time. It checks no
block before expiry, block at expiry, no replacement claim or old heartbeat, unchanged
generations, no receipt, a local incident, and preservation after host/Bridge
reconstruction and store reopen past the progress deadline. It is not an OS process
restart or real browser test.

The first strict build of this regression exposed `TS2353`: exported
`HeartbeatTaskRequest` omitted `progress` although the service and HTTP route already
accepted it. The request now uses `Pick<DecisionExecution, "phase" | "responseLength">`
and the service consumes that same request type. The Decision regression sends a typed
request through the real Bridge and verifies that repeated progress does not refresh
the business deadline. This repairs the public TypeScript contract, not the browser
restore policy. No lease/adoption/replay semantics were relaxed.

## Cleanup

The agent comparison Driver was stopped through its HUD, its test tab closed, and
revision 3 cancelled through the isolated Bridge. The exact recorded harness PID
96285 received SIGTERM; the process exited and listeners 4040/4041 were empty on
readback. The native test window had already disappeared during quit. Activity
Monitor's test search filter was cleared. Synthetic conversation and private evidence
remain retained. No ordinary user conversation was edited or deleted.

## Validation result

[Validation record](bounded-browser-validation-2026-10-23.json):
`TMPDIR=/private/tmp npm run gate` exited 0 (2309 passed, 1 skipped),
including strict builds, all workspace tests, lint and docs-check. Process-supervision
tests required execution outside the restricted sandbox. Earlier failures from denied
process operations and `/var` versus `/private/var` hook cwd assertions were resolved
by the execution environment; no unrelated runtime/test logic was changed for them.

## Subsequent comparison

The interrupted agent-tab attempt above was later repeated successfully as an
experiment (not as seamless-resume acceptance). [Agent-tab follow-up](agent-browser-acceptance-2026-10-23.md)
records an absent old PID, explicit reopen/new PID, restored-home/empty diagnostics,
a new session identity, and host blocking 23.019 seconds after lease expiry. This
supersedes the lack of an executed agent quit comparison; other stated limits remain.
