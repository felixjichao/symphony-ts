# @symphony/decision

## Purpose

Provider-neutral durable task store and localhost-only Web Agent Bridge for Decision Plane tasks and sessions (GitHub #95 / NEST-100).

Exposes local persistence and an HTTP surface so external executors (such as a browser userscript or local adapter) can claim Decision tasks, submit results, send heartbeats, and rebind sessions across browser and process restarts without direct access to repository files.

## Configuration

```ts
import { DurableDecisionStore, DecisionService, DecisionBridge } from "@symphony/decision";

// Store and Service configuration
const store = new DurableDecisionStore({
  storeDir: "./data/decision-store",
  defaultClaimTtlMs: 120_000,
});

const service = new DecisionService(store, {
  defaultClaimTtlMs: 120_000,
});

// Bridge HTTP server configuration
const bridge = new DecisionBridge(service, {
  host: "127.0.0.1",
  port: 4040,
  authToken: process.env.DECISION_BRIDGE_TOKEN,
  allowedOrigins: ["http://localhost:3000"],
});

const { host, port } = await bridge.start();
// ...
await bridge.stop();
```

## Extension points

- **Durable Store (`DurableDecisionStore`)**: Single-writer versioned JSON snapshot persistence (`store.json`). Uses transactional write serialization, validation before write, atomic temporary file rename, and fsync. Fails closed on unknown schema versions, malformed JSON, or broken record references.
- **Single-Writer Lock (`StoreLock`)**: Cross-process exclusive lock file (`store.lock`). Rejects concurrent writer processes, recovers from stale locks left by terminated processes (ESRCH), and verifies ownership before removal.
- **Service Layer (`DecisionService`)**: Implements session lifecycle, binding generation and compare-and-swap (CAS) rebind, task revision sequencing, deterministic `next` candidate selection, atomic lease acquisition, live heartbeat renewal, and key-order independent result/failure submission with idempotency receipts.
- **HTTP Bridge (`DecisionBridge`)**: Loopback-only (`127.0.0.1`) HTTP service exposing REST endpoints for executors and control operators. Enforces host header validation (DNS rebinding protection), bearer token authentication, request body size limits (1MB), and standard CORS policies.
- **HTTP Client (`DecisionBridgeClient`)**: Typed client for interacting with the Decision Bridge from tests, CLI commands, or external adapters.

### HTTP Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/tasks/next` | Returns next claimable task and session (204 if none) |
| `POST` | `/v1/tasks/:id/claim` | Atomically acquires lease token and increments claim generation |
| `POST` | `/v1/tasks/:id/start` | Enters `running` state with live lease credentials |
| `POST` | `/v1/tasks/:id/heartbeat` | Renews lease expiry with live lease credentials |
| `POST` | `/v1/tasks/:id/result` | Atomically completes task and records validated result receipt |
| `POST` | `/v1/tasks/:id/fail` | Fails task and records structured failure receipt |
| `GET` | `/v1/tasks/:id` | Returns persisted task details |
| `GET` | `/v1/sessions/:id` | Returns persisted session and opaque binding metadata |
| `PUT` | `/v1/sessions/:id/binding` | Installs initial binding (generation 1) with idempotent retry |
| `POST` | `/v1/sessions/:id/rebind` | Atomically CAS-replaces binding and increments generation |
| `POST` | `/v1/sessions/:id/break-binding` | Disconnects binding, marking status as `broken-binding` |
| `POST` | `/v1/sessions/:id/complete` | Validates all tasks terminal and marks session completed |
| `POST` | `/v1/sessions/:id/reopen` | Reopens completed session back to `active` |
| `POST` | `/v1/tasks` | Control endpoint to create plan or review tasks |
| `POST` | `/v1/tasks/:id/cancel` | Explicitly cancels unfinished task |
| `POST` | `/v1/tasks/:id/supersede` | Explicitly supersedes task |

## Known limitations

- Restricted strictly to loopback (`127.0.0.1`). Not exposed to the local network (LAN) or public interfaces.
- Single writer per store directory: concurrent instances on the same directory fail startup with `DecisionStoreLockError`.
- Whole JSON snapshot format: designed for local single-node workflows without external database dependencies. High-throughput multi-writer scenarios require migrating to a relational database (see [Agent Note](../../notes/accepted/architecture/2026-10-09-decision-store-bridge.md)).
- Does not implement DOM automation, browser scripts, or orchestrator state machine wiring.
