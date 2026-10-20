# Agent Note: Work-level continuity reconciliation
Status: accepted

## Problem

Locally valid task, retry and Delivery records can leave active work without an executor. Running-worker reconciliation alone cannot discover these gaps. The approved NEST-138 plan targets baseline `4655820` independently of other implementations of GitHub #147.

## Decision

Keep observation contracts in domain (§4 adjacent) and a thin coordinator in orchestrator (§7/§8/§14). A scan unions active tracker identities with known runtime, Decision and managed Delivery references. Every identity still requires refreshed tracker facts. CLI composition reads native sources, never Operations projections. Stage derivation uses planning admission, pending/leased tasks, marker-validated PR HEAD/CI, completed current-HEAD review verdicts and paused handoff state. Managed GitHub repositories use the existing Delivery observer; unprovisioned work has no local Delivery stage yet.

The protocol is observe, derive, re-observe/version-check, delegate once, then re-observe. A failed post-action read is unverified; it never triggers immediate replay. Diagnoses remain derived memory, available through `host.workContinuity.observations`, with no capability lease token or new persisted lifecycle. Admission prevents the normal candidate loop from dispatching coding into a different stage or after observation failure. The existing authority remains the only dispatcher and retry scheduler.

Decision reclaims only an expired lease, transactionally checking task revision, claim generation, binding generation and exact observed expiry. Renewals and competing reclaims fence stale requests. Local service and authenticated bridge share this primitive. The bridge performs an initial sweep and a non-overlapping lifecycle-owned periodic sweep without reopening another store. Pending tasks still need an executor; a service name alone does not establish liveness. A valid lease with no business progress is unknown, not reclaimable.

Codex meaningful progress is a new stable lifecycle transition or increased absolute usage. Generic notifications, PID and duplicate usage do not reset stall. Existing timeout configuration, disable semantics and strict greater-than boundary remain. Last event time stays observational telemetry.

File-backed Delivery run, halt and compensation share an exclusive filesystem authority lock. Run/recover library entry points acquire the storage's exclusive capability as well. Automatic compensation re-reads identity/handoff version under that lock before invoking the existing recovery function. Lock age is never evidence that a mutation can be repeated; a leftover crash lock requires operator verification and removal. Completion of reporting does not unpause work. Native in-memory storage adapters remain responsible for their own concurrency when used outside the file-backed host.

## Alternatives considered

- Put recovery in Operations: rejected because read-model anomalies do not authorize mutations.
- Replay the last CLI command: rejected because task revision, HEAD, binding, admission and pause state may have changed.
- Rely on coordinator single-flight or atomic file rename: rejected because separate coordinators/processes can still race. Decision checks inside its transaction; Delivery locks the mutation authority across all supported entry points.
- Claim unknown Web progress is stale: rejected because heartbeat only establishes execution permission. Browser progress/deadline policy belongs to #148.

## Consequences

No new production dependency from orchestrator to Decision/Operations. Recovery is bounded to one authority delegation per work per scan; the scheduler consumes its own queued/due retry. Stop synchronously rejects new recovery and waits for in-flight work.

Unsafe or absent native primitives return `unsupported` with the responsible authority and stranded diagnosis. In particular the coordinator does not automatically start a browser, invent missing retry timers, run repair commands, or authorize merge. Coding proceeds through the ordinary dispatch path. Cross-restart intent/timer restoration (#149), browser recovery (#148), and durable incidents/multi-round policy (#150) remain outside this change. Delivery context conventions remain the existing `symphony/<identifier>` and `main`; nonstandard contexts fail closed through ownership validation. Real GitHub/Codex smoke is opt-in and is not implied by fixture validation.
