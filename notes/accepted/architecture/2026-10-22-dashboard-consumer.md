# Agent Note: Read-only Dashboard consumer
Status: accepted

## Problem

NEST-125 / #138 (§13 adjacent) needs a usable operator Overview and Work list without duplicating Operational Read Model meaning or production composition reserved for #140. Summary v1 previously lacked degraded and anomaly counts.

## Decision

Add `apps/dashboard` with TypeScript DOM components and Vite. Browser imports only operations public types; all semantic conclusions bind supplied fields. Operations outputs optional-in-v1 `degradedWork` (exact degraded attention) and `anomalyCount` (final canonical deduplicated anomalies). Older v1 snapshots remain acceptable and missing counts remain explicit.

Use exact same-origin proxying to #137, loopback only. Dev HMR reuses the owned loopback HTTP server; shutdown closes upgraded clients before HTTP. Listener/upgrade/failure/restart tests guard this resource boundary. A separate Node-only demo owns controlled read-only sources, real query, transport and static/Vite host lifecycle. It is always labeled 演示数据. Production CLI remains unchanged. Polling is bounded, cancellable and observational, preserving last success with clear failure indication.

Browser tsc consumes generated declaration output because the upstream public barrel reaches domain's Node crypto implementation. This preserves canonical public types while excluding Node ambient globals; declarations are ignored build artifacts. AST/type/graph/capability/negative/bundle tests and helper fingerprints enforce the closed presentation surface, backed by frozen inconsistent-projection tests. Capability references are granted only at the fixed fetch call, so namespace access, aliasing, destructuring and bind cannot create another request point. Source-dependent conditionals/truthiness, unapproved calls/returns and typed business-enum helper results are rejected, including local-variable flows. Full review identifiers remain keyboard-accessible without comparing SHA or deriving approval.

## Alternatives considered

- React/Vue: unnecessary for this small current-snapshot surface; DOM keeps dependencies small, at the cost of explicit focus/open-state/lifecycle handling.
- Shared `packages/dashboard`: no shared public API is needed; an app workspace is the replaceable leaf consumer.
- CORS or static hosting inside #137: adds exposure policy or mixes transport responsibilities. A separate exact proxy preserves the existing HTTP contract.
- Production CLI composition now: would expand #138 into #140; controlled sources give a real local chain without that expansion.
- Frontend anomaly counting or inferred degraded status: violates the semantic owner boundary. Minimal additive upstream counters preserve schema v1 compatibility.
- Browser tsc with Node globals: obscures capability boundaries; generated declarations retain type authority without runtime bundling or ambient Node access.

## Consequences

DOM updates restore keyboard focus/open review details. Helper changes need guard/negative-test review. Guards constrain this surface, not all possible JavaScript. Local Chromium evidence is separate from automated DOM/HTTP checks and production live acceptance. Work Detail/evidence/anomaly explanation remains #139, production source scope and lifecycle #140. NEST-135/#159 and continuity pending acceptance are independent.
