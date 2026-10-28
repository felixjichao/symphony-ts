# Agent Note: Work Explorer selection boundary
Status: accepted

## Problem
The §13 adjacent Dashboard needs discovery across current Work projections without duplicating lifecycle or source interpretation, while polling and Work Detail navigation must retain selection state.

## Decision
#172 keeps a single persistent presentation panel with native search and filters over supplied WorkKey, display identity, phase, attention and each source's freshness status. Every WorkKey provides provider scope; repository-shaped WorkKeys additionally provide repository scope. Ordering uses the existing attention rank and full WorkKey. The reviewed module is fingerprinted by the browser guard and projection writes remain type-checked. Filtering never changes projections or hides partial sources unless the operator selects a filter.

## Alternatives considered
A browser-side aggregate freshness or inferred repository from PR facts would provide more compact controls but introduce new semantics or rely on incomplete source facts. Server-side search and a workflow board add state and mutation outside the current read-only scope.

## Consequences
Filter state survives polling and in-page navigation; it is intentionally local and resets on reload. Repository scope is available only where the WorkKey represents it. New selection logic requires review and guard fingerprint updates.
