# Agent Note: Dashboard presentation primitives
Status: accepted

## Problem
#170 / SPEC §13 adjacent needs reusable V2 presentation without moving operational derivation into browser helpers. The post-#169 shell is framework-free and already guards its presentation language.

## Decision
Keep DOM-native constructors in `apps/dashboard/src/primitives.ts`. Inputs are supplied attention/freshness, independent identifier strings, explicit display states and structural labels; outputs are DOM elements. No constructor returns a domain conclusion. SHA shortening preserves the complete identifier in both title and accessible name. WorkKey links preserve provider and key. Native labeled controls expose native events without owning filter semantics. Shared CSS tokens provide dense surfaces, hierarchy, non-color badges and focus/hover/selection cues. Work table dogfoods structures, identities and statuses; pages retain their existing behavior.

## Alternatives considered
A framework/component-library migration adds dependencies and changes the browser graph without improving this boundary. Accepting whole WorkProjection objects in generic primitives makes it easier to derive conclusions from facts. Both are rejected. A public showcase route would expand product navigation; a generated standalone HTML matrix instead exercises the same constructors outside the production graph.

## Consequences
Primitives are a registered, fingerprint-locked formatting module. AST checks additionally reject lower-level fact/conclusion identifiers in this module; type/projection-write and production capability guards still scan it. Any new helper shape must review the fingerprint and negative cases. These guards constrain the approved language, not arbitrary JavaScript equivalence. Callers remain responsible for supplied semantics and filter behavior. Static showcase HTML is regenerated from the constructors; real browser screenshots and keyboard outline checks run through the existing optional smoke. Host delivery retains full gate, CI and independent exact-HEAD review evidence; sandbox results do not claim these steps.
