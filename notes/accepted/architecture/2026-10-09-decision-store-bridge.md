# Agent Note: Durable Decision store and localhost Web Agent Bridge
Status: accepted

## Problem

In the Decision Plane protocol (GitHub #94 / NEST-99), Decision tasks, sessions, and leases were defined as pure in-memory data structures and transitions in `@symphony/domain`. However, external executors (such as Web Agents running in a browser via userscripts or background extensions) need:
1. Durable persistence of task and session state across process restarts.
2. Cross-process exclusive access guarantees preventing split-brain writes.
3. A safe HTTP bridge surface enabling localhost clients to poll pending tasks, acquire and heartbeat leases, submit idempotent results or errors, and manage session bindings.
4. Robust local security: loopback binding only (`127.0.0.1`), DNS rebinding prevention via strict `Host` header checks, optional bearer token authorization, restrictive CORS (denying arbitrary web origins), and request size limits.

## Decision

We introduce `@symphony/decision` and the CLI command `symphony decision bridge`:
1. **Durable Store Architecture**:
   - Single-writer process exclusivity via advisory filesystem lock (`store.lock`) recording owner PID and timestamp, with stale-lock detection and reclaim when the holding PID is no longer alive.
   - Atomic persistence using atomic file rename (`snapshot.json.tmp` -> `snapshot.json`) followed by directory fsync.
   - Fail-closed corruption handling: malformed or corrupt snapshots halt startup rather than silently dropping or resetting state.
   - Transactional in-memory queue that serializes all mutation operations, keeping an in-memory index for low-latency queries while guaranteeing durability.
   - Deterministic JSON comparison (`canonicalJsonEqual`) ensuring idempotent result submissions are recognized even if payload keys are permutated.
2. **Decision Service**:
   - Manages session lifecycle (`active`, `broken-binding`, `completed`) and compare-and-swap executor rebinding.
   - Revisions are automatically tracked: creating a task for an existing kind automatically supersedes earlier non-terminal tasks of that kind.
   - Leases use monotonic token generation, UTC expiry validation, and heartbeat extension.
3. **Localhost Web Agent Bridge**:
   - Built on native Node `http` (zero external dependencies).
   - Strict loopback listening (`127.0.0.1` by default).
   - DNS rebinding defense: strictly verifies incoming `Host` header against allowed hostnames (`127.0.0.1`, `localhost`, and bound host:port).
   - Bearer authentication support via constant-time comparison.
   - Restricted CORS: preflight and requests with non-loopback origins are rejected.
   - 1MB body size limit with graceful 413 draining to avoid socket resets.
   - Standard REST endpoints: `GET /v1/tasks/next`, `POST /v1/tasks/:id/claim`, `POST /v1/tasks/:id/start`, `POST /v1/tasks/:id/heartbeat`, `POST /v1/tasks/:id/result`, `POST /v1/tasks/:id/fail`, `GET /v1/sessions/:id`, `PUT /v1/sessions/:id/binding`, `POST /v1/sessions/:id/rebind`, control endpoints `POST /v1/tasks`, `POST /v1/sessions`, cancel, supersede, complete, reopen.
4. **CLI Integration**:
   - `symphony decision bridge --store <dir> [--port <port>] [--host <host>] [--token <token>] [--cors-origin <origin>] [--default-lease-ttl <ms>]` integrated into `@symphony/cli`.

## Alternatives considered

- **SQLite vs. Single-file JSON snapshot**:
  - *SQLite* offers transactional writes, fine-grained queries, and concurrent multi-reader/writer capabilities.
  - *Why JSON snapshot was chosen*: Decision plane tasks and sessions are work-item scoped and bounded in volume for a single workspace/node. A versioned JSON snapshot requires zero native C/C++ or binary dependencies (e.g., `better-sqlite3` or `sqlite3` which complicate cross-platform compilation and packaging), makes state immediately human-readable and debuggable in plain text, and allows straightforward backup and atomic swap. Cross-process safety is cleanly achieved via `store.lock`. If multi-process concurrent writers or tens of thousands of tasks become necessary in the future, a SQLite backend can be implemented behind the `DurableDecisionStore` contract.
- **WebSocket vs. HTTP REST polling**:
  - *WebSocket* provides bi-directional streaming and immediate push notifications.
  - *Why HTTP REST was chosen*: Web agents (e.g., userscripts in Tampermonkey or extension content scripts) operate primarily via standard `fetch()` or `GM_xmlhttpRequest`. A REST API with explicit `claim`, `heartbeat`, and `result` aligns directly with lease-based polling semantics, handles network interruptions gracefully, and simplifies stateless client implementation and testing.
- **Express / Fastify vs. Native Node `node:http`**:
  - *Why native `node:http` was chosen*: Consistent with repo principles (zero unnecessary dependencies, strict containment, minimal attack surface). Native HTTP handles the small REST surface cleanly without third-party supply-chain exposure.

## Consequences

- `@symphony/decision` provides a complete, durable, provider-neutral task store and Web Agent Bridge.
- Core Symphony §7 orchestration remains unaffected and decoupled.
- Web agents and operators have a standard, secure local interface for task execution.
- Store corruption fails closed, requiring operator attention if disk data is invalid.
