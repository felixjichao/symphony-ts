# Agent Note: OperationalSnapshot read-only HTTP transport
Status: accepted

## Problem

GitHub #137 (§13.7, parent #136) requires browser access to the completed #108 in-process query contract without moving authority, source reads or projection semantics into HTTP. Observability owns status surfaces, but operations previously had an observability test dependency, which would create a workspace cycle.

## Decision

Add `observability → operations` as a production dependency. Remove the reverse test dependency by constructing equivalent domain runtime snapshot fixtures in operations reader tests. Source packages tracker/decision/orchestrator/agent remain prohibited from importing operations. Keep the synchronous runtime projector independently domain-only.

Expose only `GET /api/operations/snapshot` through `startOperationsHttpServer(injectedQueryService, options)`. Call getOperationalSnapshot once per request and serialize the complete result directly. Degraded source status remains successful snapshot data. Query/serialization failures return a sanitized 500 error, unsupported methods 405 with Allow: GET, unknown paths 404. No authority ports or workflow callbacks enter the transport.

Startup is explicit, defaults to 127.0.0.1 and an ephemeral port, and returns the Node HTTP server for owner-managed shutdown. No CORS or command authentication is introduced; exposure is trusted local operator use. Production host lifecycle composition remains #140; browser Dashboard work remains #138–#139.

## Alternatives considered

- Put HTTP in operations: rejected because it mixes the established pure query boundary with network capabilities and contradicts the designated status-surface owner.
- Copy projections or expose source-specific resources: rejected because full snapshot pass-through already preserves freshness, WorkKey identity, exact review targets and evidence without a second semantic layer.
- Keep the reverse devDependency: rejected because workspace dependency cycles complicate package boundaries and builds; domain fixtures retain source-reader integration coverage while observability retains projector tests.

## Consequences

Operations remains domain-only in production; observability becomes its explicitly allowed downstream consumer. HTTP failures are observational only. Loopback does not establish future remote authentication policy; broader exposure requires a separate design. No persistent cache, background collection, retry, history, SSE/WebSocket or write endpoint is added. Real loopback tests cover direct JSON equivalence and the actual query-service partial-failure boundary, with separate static guards for transport and legacy projector.
