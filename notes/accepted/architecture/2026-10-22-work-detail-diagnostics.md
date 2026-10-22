# Agent Note: Work Detail diagnostics
Status: accepted

## Problem

NEST-126 / #139 (§13 adjacent) needs to explain a selected work projection without rebuilding projector rules, weakening exact-HEAD safety or leaking another work's diagnostics.

## Decision

Reuse the existing encoded `[provider,key]` hash. A structured DOM detail opens alongside the list and its raw HEAD foldout. Render supplied conclusions, independently labeled targets, source freshness, source/role evidence and anomaly objects. Projected taskTarget is explicitly distinguished from the real task because it may be a result fallback. Result verdict is a fact, not a current approval badge. No domain, schema v1 or HTTP changes are needed.

Use full WorkKey equality for selection. Optional foreign evidence is suppressed with a presentation ownership warning, not a synthesized anomaly. Unkeyed global sources/anomalies are separately labeled; they are not inferred to belong to a work. Source status/observed/attempt/reason and evidence provenance remain supplied values. Missing evidence is not evidence of safe progress. Unknown anomaly codes render generically. User navigation focuses the detail heading; polling restores focus and expanded diagnostics.

Validation checks consumed diagnostic wire shapes without semantic consistency checks or normalization. Extend the restricted presentation guard to registered renderers/calls, pin individually reviewed renderers and identity/grouping helpers, and protect diagnostic semantic construction/writes/returns with the type checker. Capability checks still scan every module. Negative fixtures cover diagnostic-derived waiting/attention/freshness/approval and fetch aliases. DOM, real local query/HTTP/proxy composition and a separate built-product Chromium smoke provide complementary evidence.

## Alternatives considered

- Separate endpoint/DTO: unnecessary; existing snapshot evidence is sufficient and avoids transport changes.
- Browser projector or inferred approval: would create another semantic authority and undermine exact-HEAD safety.
- Raw JSON alone: useful for inspection but does not make conclusions, provenance and stale evidence distinct.
- Framework migration: adds unrelated scope; existing DOM lifecycle and token remain compatible.

## Consequences

The UI explains current snapshot evidence, not a full rule trace or historical event stream. Closed helper/renderer changes require fingerprint and negative-fixture review. Guards constrain this presentation surface, not arbitrary JavaScript. No production source/scope/lifecycle or live acceptance is claimed; #140 owns that work. The implementation is independent of Draft #159.
