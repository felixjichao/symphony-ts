# Core continuity acceptance — 2026-10-23

NEST-135 / #151; parent #145. SPEC §4 adjacent, §7/§8/§14/§17/§18.
Source: `ad5b08e7790563f8de2d0bf0f4eb660518ca6b21` (runtime unchanged from the earlier full gate).

## Complete host process restart: passed for a native authentication block

A fresh isolated OS process assembled production `createHost`, its real poll and
workflow watcher, GitHub adapter, GitHub work observation, authenticated HTTP Bridge,
durable Decision store and recovery files. The real adapter was scoped to existing
open dogfood Issue `felixjichao/symphony-delivery-dogfood#24`; no tracker records were
fabricated or changed. Coding admission was disabled for this scenario. Remote incident
reporting returned unavailable through its injected port, preventing remote comments.

Through native HTTP, create/claim/start a local Plan and block it with `auth_required`,
recoveryCount 1. Wait until the real host records a single incident. Query it with
the built CLI `recovery list`, then SIGKILL the entire host/Bridge process PID 36566.
Restart exactly the same bundle/configuration/storage in PID 36893. Fresh real GitHub
reads reconstruct the same blocked work. The full native task/execution readback and
CLI incident list compare exactly equal. Built CLI `recovery show` returns that exact
incident. All observed worker/retry counts remain zero; no lock or recovery files were
deleted. This crosses the full host OS-process boundary, unlike earlier in-process
host reconstruction or Bridge-only restart evidence.

[Result](host-restart-2026-10-23.json), [CLI incident](host-auth-incident-2026-10-23.json),
[lifecycle](host-blocked-lifecycle-2026-10-23.txt),
[observations](host-blocked-observations-2026-10-23.txt),
[real tracker reads](host-blocked-tracker-2026-10-23.txt),
[host events](host-blocked-events-2026-10-23.txt),
[workflow](host-blocked-workflow-2026-10-23.txt).

The authentication block is intentionally injected through the API. This does not
establish real login/human UI detection, a growing browser response surviving a host
restart, or successful coding/delivery execution.

## Native worker budget exhaustion and restart: passed

A separate fresh store/workspace runs the same production host composition with
planning disabled. Actual native worker processes use the harmless command `false`,
which exits immediately and causes genuine app-server startup/port_exit failures.
The real GitHub issue is only read. Policy: max_attempts 1, max_strategy_attempts 1,
retry backoff cap 1000 ms, poll interval 2000 ms; remote reporting remains unavailable.

The host starts the initial worker and exactly one retry (PIDs 37334 / 37380), then
records one `recovery_exhausted` incident with attempts 1 and actions [retry]. No
failure state was manufactured in a file or directly injected into the policy engine.
SIGKILL PID 37159 and restart the full host as PID 37770. The exact incident and budget
survive, and both built recovery CLI list/show agree. During five blocked observations
from the restarted host, spanning about 59 seconds from startup to the last sample,
running and retry counts stay zero and total worker starts remain two. Restart does
not reset the budget or start another worker.

[Result](host-exhaustion-2026-10-23.json),
[CLI incident](host-exhaustion-incident-2026-10-23.json),
[lifecycle](host-exhausted-lifecycle-2026-10-23.txt),
[observations](host-exhausted-observations-2026-10-23.txt),
[real tracker reads](host-exhausted-tracker-2026-10-23.txt),
[host events](host-exhausted-events-2026-10-23.txt),
[workflow](host-exhausted-workflow-2026-10-23.txt).

This exercises the native coding retry strategy and its budget, not successful Codex
execution or every Web rebind/exhaustion strategy. External report publication/ACK
ambiguity is still unaccepted.

## Reproduction, provenance and validation

[Harness source](host-harness-2026-10-23.txt) and
[manifest](host-manifest-2026-10-23.json) record the build/run commands and source/bundle
hashes. Save the source as host.ts and use a fresh directory per mode. Supply a secure
Bridge credential file and an authenticated gh identity; never commit their contents.
The workflow paths must point to the selected fresh directory. Scope remains dogfood
#24; check it is open before rerunning. No production workspace is reused.

The harness passed TypeScript strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes
checking against repository sources. Runtime/package source is unchanged; the earlier
complete gate (2307 passed, 1 opt-in skip) remains applicable. Final evidence edits
must pass docs-check and diff-check; no credential-dependent test was added to default gate.

All four host PIDs and both worker PIDs were verified absent (ESRCH) after cleanup.
Ports 4040/4041 have no listeners. Private stores/lease capabilities remain only in
`/private/tmp/symphony-pr159-core-20261023`. Published files contain no Bridge/GitHub
credential values; tracker logs retain operation/count, not issue bodies. No GitHub
branch, issue, PR, comment or protection was written.

## Still pending

Full browser-process exit/restart needs an isolated authenticated browser, or explicit
permission to interrupt all current Edge tabs. The operator has been asked to choose;
no browser process has been stopped. Real auth/human/deleted-conversation UI, Web
rebind exhaustion and external reporting ACK ambiguity remain outside these runs.
Parent #145 is not declared complete.
