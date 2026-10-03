# Agent Note: CLI process lifecycle and M6 Core evidence
Status: accepted

## Problem

M6.4 createHost initialized the workflow watcher timer before shell signals existed. bin used immediate process.exit, concealing timer/worker leaks and allowing duplicate signals during cleanup to bypass resource shutdown. M6.5 (SPEC §17.6 / §17.7 / §18.1, NEST-85) must preserve EffectiveRuntime single authority and the existing orchestration/agent shutdown chain.

## Decision

Use args for argv/path, host for process-independent resources, lifecycle.runCli for signal/fatal subscription and final numeric result, and bin only for process.exitCode. Initialize watcher with autoStart false; explicit startMonitoring precedes loop.start after signals are installed. Default config callers still auto-monitor. A small injected watcher scheduler supports measurable timer/late-callback evidence without another config cache. Initial controller.store.accept still validates tracker/command and every dispatch preflight still forces a fresh read.

Stop synchronously closes controller acceptance and watcher, invokes loop.stop before waiting, awaits startup/tick/authority workers/cleanup, emits final lifecycle outcome and closes logger. One shared host stop promise and one shell shutdown promise deduplicate all triggers. Failures retain precedence over signals; other cleanup steps continue after watcher failure. Handlers remain until settlement and only owned listeners are removed. Host has a separate failure promise for unexpected monitoring defects; typed reload errors stay recoverable. Shell uncaughtException/unhandledRejection fallbacks initiate the same cleanup, return 1 and never continue service.

Process evidence rebuilds the actual executable each run and uses loopback HTTPS with a committed test-only certificate/key and explicit child CA trust. Readiness is request/session/marker based. Reuse the existing app-server fixture, extending only an ignore-SIGTERM switch to exercise its existing transport deadline. after_run records PID disappearance/cwd; the parent independently re-reads its result and rechecks PID. A bundled resource-fault harness invokes the same runner but is labeled supplemental exit-code evidence.

## Alternatives considered

- Keeping immediate exit or unref timers would hide leaked resources; natural event-loop exit plus counted watcher/poll/retry ports gives complementary evidence.
- Installing process handlers in core host would couple in-process consumers to global shell policy and make handler ownership ambiguous. Shell owns only its listeners.
- Waiting for startup before invoking stop opens a dispatch window and can deadlock. Existing loop.stop already synchronously seals authority and waits its startup/tick promises.
- A second scheduler, effective-config cache, or CLI force-kill timeout would duplicate established authorities and transport policy. Reuse existing contracts instead.
- HTTP fixture/production HTTPS relaxation or public GitHub access would either weaken production validation or introduce nondeterministic external dependencies. Local HTTPS and explicit test CA preserve the executable's real validation path.
- Treating logs, invalid reload, tracker/agent faults or best-effort hooks as host fatal would change recovery semantics. An independent fatal channel and shell fallback keep the distinction explicit.

## Consequences

Constructing a host now obtains ready resources without monitoring; callers wanting live reload must start it. Existing host-reload regression cases that only constructed a host now explicitly start with controlled poll schedulers; no parallel production assembly is introduced. Stop is terminal; restarting requires a fresh host. A stuck external startup request remains governed by its existing external boundary, not a new CLI timeout.

M6 Core implementation/test evidence is ready, but completion requires M6.1–M6.5 merged, corresponding tests and main CI success. PR gate alone is insufficient. HTTP §13.7, tools §11.5, durable recovery and SSH remain outside this change; local fixtures do not establish §17.8 Real Integration. Evidence and commands are maintained in [conformance](../../../docs/conformance.md#m65-core-证据索引).
