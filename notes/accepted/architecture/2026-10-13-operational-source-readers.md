# Agent Note: Operational source readers and one-shot collection
Status: accepted

## Problem

NEST-114 / GitHub #110 needs current facts for the Observation Plane adjacent to SPEC §13.
The source authorities already exist, but raw Decision records contain secrets, runtime
uses two clocks, and delivery PR reuse excludes closed PRs. Observation must preserve
historical review targets and successful absence without deriving operational meaning.

## Decision

`@symphony/operations` exports four reader factories and `collectOperationFacts`. Source
ports are injected; runtime uses one existing `SnapshotResult`, Decision uses the already
open `DecisionService.observeWork`, GitHub uses `GitHubDeliveryService.observeWork` bound
to a trusted delivery context, and executor uses an explicit inventory observation port.
Production dependencies remain domain-only; real source packages are test dependencies.
Shared result envelopes and compatible optional session/lease/generation/CI HEAD fields
belong to domain. Readers whitelist output, copy identities, and retain source time.

GitHub discovers PRs by complete paginated repository reads and existing ownership marker
validation, or validates an explicit PR number. Multiple matching PRs fail rather than
choose one. Terminal PRs are read by number without depending on a live head branch;
missing head repository is allowed only for terminal records with verified marker,
branch/base and non-fork identity. PR state, HEAD and observed CI come from one response.
CI describes observed checks, not required-check configuration or merge authorization.
Unknown conclusions fail the bundle. No mutating delivery primitive is called.

Decision's synchronous view reads one committed store state, keeps all tasks/results,
includes expired leases and claim binding generations, and omits tokens, contexts,
receipts and external executor session references. Unopened, closed or poisoned stores
cannot report successful absence. Executor status and heartbeat are never inferred from
Decision leases or Codex activity; an unconfigured inventory is unknown.

Freshness age bounds and clocks are explicit per source. Source bundle failures return
unavailable with safe reason codes; unconfigured sources are unknown and successful empty
collections are fresh/stale. No previous-value cache or poller is introduced. Collector
waits for all source reads to finish. Read budgets and cancellation/cleanup are owned by
the source port (the default gh runner already enforces subprocess timeouts).

## Alternatives considered

- Call `ensurePr` or `getNextTask` to discover state: rejected because these mutate sources.
- Expose cloned store records: rejected because cloning does not remove secrets.
- Add a fleet registry/heartbeat writer: rejected because no such authority exists today
  and adding one expands this read-only slice into executor coordination.
- Read PR and CI separately: rejected because a single response binds observed rollup
  to exact HEAD without a cross-query SHA race.

## Consequences

The host must supply trustworthy delivery identity, mapping and source ports; this slice
adds no host wiring or transport. Four reads are not an atomic cross-system snapshot.
A GitHub read failure invalidates only that source bundle. Runtime retains unlinked rows
when URL or trusted scope mapping cannot establish work identity. Projectors, anomaly
rules, query aggregation and health/phase derivation remain later slices. Tests exercise
real Decision files and observability snapshots, plus external gh/clock/failure fixtures.
