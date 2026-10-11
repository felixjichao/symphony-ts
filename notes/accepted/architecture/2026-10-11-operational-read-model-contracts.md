# Agent Note: Operational Read Model contracts and `@symphony/operations` boundary

Status: accepted

## Problem

GitHub #108 / NEST-112 needs a stable, read-only Operational Read Model so CLI, JSON API,
TUI, Dashboard and alerts can answer "what is happening and why" from one projection layer
instead of each consumer reading GitHub / the orchestrator / the Decision Store directly.
Before any source reader, projector, anomaly detector or query service is written, the
type-level boundary between authoritative sources and operational consumers has to be fixed
(GitHub #109 / NEST-113).

Existing contracts are insufficient or wrong for this layer: `packages/observability`
projects only the in-process orchestrator runtime (`ObservabilityRuntimeView` →
`ObservabilitySnapshot`), `@symphony/decision` persists store records with lease tokens,
receipts and contexts that must never reach a projector, and the tracker's `Issue.id` is a
tracker-scoped dispatch identity, not a cross-repository work key.

## Decision

Add the provider-neutral facts and projection contracts to the single authority on shared
types, `@symphony/domain` (`operations-facts.ts`, `operations-projection.ts`, aggregated by
`operations.ts`), and add a thin public facade package `@symphony/operations` that depends on
`@symphony/domain` only. The split follows the repository's rule that domain owns shared
contracts while behavior lives in its owning package: readers and projectors land in
`@symphony/operations` later, and no source package may import it back.

`WorkKey` aliases the existing canonical `DecisionWorkItemRef` (GitHub values
`{ provider: "github", key: "owner/repo#N" }`) so there is one definition of work identity;
repository / issue-number validation is reused, never re-derived. Normalized facts for
GitHub, runtime, Decision and executor are independent readonly DTOs that explicitly select
the fields an observer needs — no `PrRecord`, store record, lease token, browser DOM or
executor handle is re-exported. Every fact bundle carries `FactProvenance` (source kind,
instance, observation time), and freshness is a four-way discriminant
(`fresh` / `stale` / `unavailable` / `unknown`): a successful read that finds no PR or no
session is `null`, while a failed read is `unavailable`, so "absent" and "not observed"
stay distinguishable. `WorkPhase` / `WaitingReason` / `AttentionState` / `SystemHealth`
are documented derived-only display concepts with no setter or transition, kept orthogonal
(phase and attention), and review projections retain `currentHeadSha`, task target and
result target separately so an approval against a stale SHA is never presented as approval
of the current HEAD. This slice defines contracts and identity/shape helpers only; it adds
no HTTP, Dashboard, history store, query service or mutation command.

## Alternatives considered

- Extend `@symphony/observability` with the operational model: rejected because that package
  owns §13 runtime logging / snapshot for a single in-process authority, and mixing
  cross-source business projection into it would blur the Observation Plane's read-only
  boundary and its dependency set (a new reader/projector import would leak into the
  logging package).
- Put the contracts in the new `@symphony/operations` package instead of `@symphony/domain`:
  rejected because it would create a second authority for shared types and break the
  repository rule that cross-package contracts live in `@symphony/domain`.
- Define a fresh `WorkKey` type independent of `DecisionWorkItemRef`: rejected because it
  would duplicate canonical GitHub root validation and allow the two identities to drift.
- Model freshness as a single object with nullable timestamps: rejected because it lets
  `unknown`, `stale` and `unavailable` collapse together — the exact confusion #108 forbids.
- Redraw the canonical package-dependency diagram for the new package: not done here,
  matching the existing precedent that the Decision extension and `apps/chatgpt-web` are
  also absent from that hand-authored diagram; redrawing the ranked graph is an unrelated
  layout change and stays out of a contracts slice.

## Consequences

Consumers get one import surface for operational facts and projections, and later
reader/projector issues build on frozen shapes. Strict readonly + discriminated unions make
invalid or impossible shapes fail typecheck, guarded by `@ts-expect-error` negative tests
and a boundary test that keeps `@symphony/operations` synchronous and domain-only. The
package boundary is now fixed: `operations → domain`, with source packages forbidden to
import `operations`. Freshness thresholds, phase priority, health/summary computation,
anomaly detection, live reading and every transport remain unimplemented and must not be
assumed by consumers. `@symphony/operations` currently re-exports contracts only; adding
behavior there must preserve the read-only, side-effect-free, consumer-independent
properties established by these shapes.
