# Decision Plane protocol v1

Provider-neutral extension for GitHub #94 / NEST-99, exported from `@symphony/domain`.
This defines pure data validation and transitions, independently of Symphony SPEC §7.
Production callers, durable storage, atomic claims, timers, adapters and delivery gates
are not implemented by this protocol. Architecture rationale: [Agent Note](../notes/accepted/architecture/2026-10-08-decision-contracts.md).

## Identity and revisions

`DecisionSession.root` is a stable work-item reference `{ provider, key }`.
For GitHub it is `{ provider: "github", key: "owner/repo#94" }`; owner/repo
are lowercase and issue numbers are positive safe integers. `githubDecisionRoot`
canonicalizes casing; parsers reject noncanonical persisted data. Session ID is
`github:owner/repo#94`, independent of PR and executor identities. Other work-item
providers use a lowercase namespace and nonempty opaque key; they own key stability.
One root can have multiple PRs, replacement PRs, coding sessions and executors.

Tasks have `kind: plan | review`, positive `revision`, stable `sessionId` and a
canonical `id`. Plan ID is `<encoded-session>:plan:<revision>`; review adds
`:<encoded-repository>:<prNumber>:<headSha>`. Encoding is `encodeURIComponent`.
Review target includes canonical repository, positive PR number and the **full
40-character lowercase hexadecimal GitHub HEAD SHA**. A separate review revision
allows another review of the same SHA. Plan revisions are monotonically increasing
per session; review revisions increase per session/PR. Allocation, deduplication
and conflict resolution belong to the future store, not these identity helpers.
A failed/cancelled task is retried by allocating a new revision, never by reviving it.

## Task lifecycle

| Operation | Allowed source states | Destination | Preconditions |
|---|---|---|---|
| claim | pending | claimed | fresh token, next claim generation, expiry > now |
| start | claimed | running | matching live lease |
| complete | running | completed | matching live lease and validated result |
| fail | claimed, running | failed | matching live lease |
| release expired | claimed, running | pending | now >= expiry |
| cancel | pending, claimed, running | cancelled | explicit controller action |
| supersede | all except superseded | superseded | explicit controller action |

All other transitions, including self transitions, are rejected. Cancellation and
supersession revoke the lease immediately. `superseded` is absorbing. Completion
and failure clear the lease, retaining `claimGeneration` and `lastClaimToken`.
Expiry releases keep the task identity/revision but require a different token and
strictly next generation. Lease identity is owner/token/generation/expiry; this
fences old claims even if a token is reused after intervening generations.

`DecisionLease` is a minimal owner, opaque token, positive generation and UTC expiry
contract. At expiry equality the lease is already expired. Helpers take explicit
`now`, do not read clocks and do not mutate inputs. Timestamps cannot move backwards.
No heartbeat or expiry scheduler exists here. The future store must compare current
state, generation/token and lease expiry **atomically** with result insertion and
transition to completed. Passing a pure helper does not prove concurrency safety.

## Results and approval

`DecisionResult` is a discriminated Plan/Review envelope containing version,
task/session IDs, revision and `createdAtMs`. Plan content includes plan text,
acceptance criteria, risks and clarifications; verdict is `ready`,
`needs_clarification` or `needs_human`. Review includes the exact target and typed
blocker/suggestion findings (message and nullable location); verdict is `approve`,
`changes_requested` or `needs_human`. All verdicts are successful task completion;
execution failure is the separate `failed` lifecycle state.

`parseDecisionResult` validates the envelope itself; `validateDecisionResultForTask`
additionally checks kind, IDs, revision, exact target and creation ordering.
`completeDecisionTask` also rejects future-dated results, invalid state, stale claims
and expired leases. The store persists result and completed task together. Results
are independent immutable historical facts; cancelling/superseding does not delete
those records. Repeated submissions/idempotency remain a store responsibility.

`isDecisionReviewApproved(task, result, currentTargetWithSessionId)` fails closed
unless the task is completed, the result exactly matches it, the verdict is approve,
and session/repository/PR/HEAD match the current target. A SHA-A approval cannot
authorize SHA-B even before reconciliation supersedes A. A HEAD update requires
superseding the old task and creating a new revision for B. A → B → A does not
resurrect superseded A; it needs a fresh task/result. This predicate only establishes
the review condition. CI, ownership, permissions and the final HEAD reread before
merge remain delivery responsibilities. No current delivery call site is wired to it.

## Session lifecycle and executor binding

| Operation | Allowed source | Destination |
|---|---|---|
| rebind with next generation | active, broken-binding | active |
| break binding (requires a binding) | active | broken-binding |
| complete (no executable tasks) | active, broken-binding | completed |
| explicit reopen | completed | active |

Active sessions may have no executor binding. `ExecutorBinding` has only an opaque
adapter name, external session reference, nullable opaque resume URI, version and
positive generation. Core neither parses routes nor depends on conversation content.
These references must not contain credentials. First binding has generation 1;
rebind must increment by exactly 1. Losing the binding clears it while retaining
`bindingGeneration`; rebind cannot reset the counter. Rebinding does not invalidate
review facts or erase planning history. Completed sessions must be explicitly
reopened before rebinding, retaining their root and historical decisions.

Session completion requires the complete current task set for that session, with
only terminal tasks and no task newer than `now`. The caller/store must read that set
and commit completion atomically, preventing concurrent insertion of executable
tasks. A pure array argument cannot prove it is the complete set. The store must
also restrict task dispatch to active sessions. Broken binding is a continuity fault,
not a source of plan/review verdicts; conversation continuity never authorizes work.

## Serialization and compatibility

Independent session, task, result and binding records carry `schemaVersion: 1`.
Persist plain JSON via `JSON.stringify`; load with `JSON.parse` then the respective
`parseDecision*` / `parseExecutorBinding` function. Parsers accept unknown values,
throw `TypeError` on malformed records and never coerce values or silently drop
fields. Nested root/target/lease/content/finding objects have strict field whitelists.
Result arrays must be dense ordinary arrays with only length and enumerable data indices: custom properties, symbol keys,
serialization hooks, accessors and custom prototypes are rejected. Elements are
validated by index without invoking a supplied iterator.
All properties are required; unavailable binding, lease, resume URI and finding
location use explicit `null`, collections use arrays. No explicit undefined,
functions, class instances, nonfinite/fractional numbers or unknown enums are valid.
Times are nonnegative safe integers in UTC epoch milliseconds within the Date range.
Types are readonly value objects; helpers return new records, without deep-freezing.

The closed v1 field sets are exactly the public interfaces in
`packages/domain/src/decision.ts`; no provider payload map or credentials field
exists. Breaking changes (including adding fields to this strict format) require a
new schema version and explicit migration before readers accept it. Unknown versions
are rejected. Migration execution and durable recovery belong to subsequent work.

## Durable Store and Web Agent Bridge (NEST-100 / #95)

The `@symphony/decision` package implements durable storage, task coordination service, and localhost HTTP bridge for Web Agents and local controllers. Architectural rationale: [Agent Note](../notes/accepted/architecture/2026-10-09-decision-store-bridge.md).

### Storage and Process Concurrency

- **Store file**: All sessions, tasks, and results are persisted in a versioned JSON store file (`store.json`).
- **Atomic persistence**: Writes write to `store.json.tmp`, flush to disk, and atomically rename over `store.json`, followed by directory fsync. Real I/O errors (e.g. `EIO`) propagate and poison the store, failing subsequent writes.
- **Fail closed on corruption**: Startup verifies data integrity across all tables, referential relations, revision indexes, and receipts; malformed or unparseable files fail closed with `CorruptedStoreError` without silent reset.
- **Single-writer process lock**: An advisory `store.lock` records owner PID and acquisition timestamp. Stale locks from terminated processes are safely recovered using an atomic `store.reclaim.lock` mutex to prevent reclamation races.

### Persistence Schema Envelope

The `store.json` file adheres to schemaVersion `1` and passes all integrity checks enforced by `validateStoreRecord`. The canonical envelope structure is:

```json
{
  "schemaVersion": 1,
  "transactionSequence": 2,
  "sessions": {
    "github:owner/repo#42": {
      "schemaVersion": 1,
      "id": "github:owner/repo#42",
      "root": {
        "provider": "github",
        "key": "owner/repo#42"
      },
      "status": "active",
      "binding": {
        "schemaVersion": 1,
        "adapter": "browser-agent",
        "externalSessionRef": "chat-002",
        "resumeUri": null,
        "generation": 2
      },
      "bindingGeneration": 2,
      "createdAtMs": 1700000000000,
      "updatedAtMs": 1700000001000
    }
  },
  "tasks": {
    "github%3Aowner%2Frepo%2342:plan:1": {
      "schemaVersion": 1,
      "id": "github%3Aowner%2Frepo%2342:plan:1",
      "sessionId": "github:owner/repo#42",
      "kind": "plan",
      "revision": 1,
      "status": "completed",
      "lease": null,
      "claimGeneration": 1,
      "lastClaimToken": "00000000-0000-0000-0000-000000000001",
      "createdAtMs": 1700000000000,
      "updatedAtMs": 1700000000500
    },
    "github%3Aowner%2Frepo%2342:review:1:owner%2Frepo:42:0123456789abcdef0123456789abcdef01234567": {
      "schemaVersion": 1,
      "id": "github%3Aowner%2Frepo%2342:review:1:owner%2Frepo:42:0123456789abcdef0123456789abcdef01234567",
      "sessionId": "github:owner/repo#42",
      "kind": "review",
      "revision": 1,
      "status": "pending",
      "target": {
        "repository": "owner/repo",
        "prNumber": 42,
        "headSha": "0123456789abcdef0123456789abcdef01234567"
      },
      "lease": null,
      "claimGeneration": 0,
      "lastClaimToken": null,
      "createdAtMs": 1700000000600,
      "updatedAtMs": 1700000000600
    }
  },
  "results": {
    "github%3Aowner%2Frepo%2342:plan:1": {
      "schemaVersion": 1,
      "kind": "plan",
      "taskId": "github%3Aowner%2Frepo%2342:plan:1",
      "sessionId": "github:owner/repo#42",
      "revision": 1,
      "verdict": "ready",
      "content": {
        "plan": "Step 1",
        "acceptanceCriteria": ["AC1"],
        "risks": [],
        "clarifications": []
      },
      "createdAtMs": 1700000000500
    }
  },
  "failures": {},
  "receipts": {
    "github%3Aowner%2Frepo%2342:plan:1": {
      "schemaVersion": 1,
      "taskId": "github%3Aowner%2Frepo%2342:plan:1",
      "type": "result",
      "claimGeneration": 1,
      "claimOwner": "worker-1",
      "claimToken": "00000000-0000-0000-0000-000000000001",
      "acceptedAtMs": 1700000000500,
      "payload": {
        "schemaVersion": 1,
        "kind": "plan",
        "taskId": "github%3Aowner%2Frepo%2342:plan:1",
        "sessionId": "github:owner/repo#42",
        "revision": 1,
        "verdict": "ready",
        "content": {
          "plan": "Step 1",
          "acceptanceCriteria": ["AC1"],
          "risks": [],
          "clarifications": []
        },
        "createdAtMs": 1700000000500
      }
    }
  },
  "revisions": {
    "plan:github:owner/repo#42": 1,
    "review:github:owner/repo#42:owner/repo:42": 1
  },
  "operationReceipts": {
    "op-plan-1": {
      "schemaVersion": 1,
      "operationKey": "op-plan-1",
      "kind": "create-plan-task",
      "sessionId": "github:owner/repo#42",
      "entityId": "github%3Aowner%2Frepo%2342:plan:1",
      "createdAtMs": 1700000000000
    },
    "op-rev-1": {
      "schemaVersion": 1,
      "operationKey": "op-rev-1",
      "kind": "create-review-task",
      "sessionId": "github:owner/repo#42",
      "target": {
        "repository": "owner/repo",
        "prNumber": 42,
        "headSha": "0123456789abcdef0123456789abcdef01234567"
      },
      "entityId": "github%3Aowner%2Frepo%2342:review:1:owner%2Frepo:42:0123456789abcdef0123456789abcdef01234567",
      "createdAtMs": 1700000000600
    },
    "op-rebind-1": {
      "schemaVersion": 1,
      "operationKey": "op-rebind-1",
      "kind": "rebind-session",
      "sessionId": "github:owner/repo#42",
      "bindingGeneration": 2,
      "expectedGeneration": 1,
      "adapter": "browser-agent",
      "externalSessionRef": "chat-002",
      "resumeUri": null,
      "resultingSession": {
        "schemaVersion": 1,
        "id": "github:owner/repo#42",
        "root": {
          "provider": "github",
          "key": "owner/repo#42"
        },
        "status": "active",
        "binding": {
          "schemaVersion": 1,
          "adapter": "browser-agent",
          "externalSessionRef": "chat-002",
          "resumeUri": null,
          "generation": 2
        },
        "bindingGeneration": 2,
        "createdAtMs": 1700000000000,
        "updatedAtMs": 1700000001000
      },
      "entityId": "github:owner/repo#42",
      "createdAtMs": 1700000001000
    }
  }
}
```

#### Snapshot Integrity & Mutual Exclusion Facts

The store validator enforces fail-closed consistency across all records:

- **Canonical Task IDs**: Task IDs are generated deterministically using `decisionTaskId(...)`, which URL-encodes session IDs and review repository paths (e.g. `github%3Aowner%2Frepo%2342:plan:1`). Handcrafted IDs that deviate from domain encoding fail closed on startup.
- **Terminal Status Mutual Exclusivity**:
  - `completed` tasks MUST have a corresponding record in `results` and `receipts`, and MUST NOT have a record in `failures`.
  - `failed` tasks MUST have a corresponding record in `failures` and `receipts`, and MUST NOT have a record in `results`.
  - Non-terminal tasks (`pending`, `claimed`, `running`, `cancelled`) MUST NOT have any entries in `results` or `failures`.
- **Receipt Consistency**: Each `SubmissionReceipt` verifies that:
  - `receipt.taskId` matches the task ID key.
  - `receipt.claimGeneration === task.claimGeneration`.
  - `receipt.claimToken === task.lastClaimToken`.
  - `receipt.payload` canonically matches stored `results[taskId]` or `failures[taskId]`.
- **Operation Receipts**:
  - `create-plan-task`: Stores `entityId` referencing the created plan task (`task.kind === "plan"`), with no target.
  - `create-review-task`: Stores `entityId` and `target`, validating `task.kind === "review"` and canonical equality between `receipt.target` and `task.target`.
  - `rebind-session`: Stores `entityId`, `expectedGeneration`, `bindingGeneration`, `adapter`, `externalSessionRef`, `resumeUri`, and `resultingSession` (the historical session state generated by that rebind). When replaying an existing `operationKey`, full parameter identity is enforced; conflicting payloads return HTTP 409 Conflict without modifying session state.


### Web Agent Bridge HTTP API

The bridge exposes a local HTTP interface (default `127.0.0.1:4040`) for Web Agents (Tampermonkey userscripts, browser extensions, or local tools):

- `GET /v1/tasks/next` — Fetch the next pending executable task (204 if none).
- `POST /v1/tasks/:id/claim` — Atomically claim lease with `{ owner, ttlMs? }`.
- `POST /v1/tasks/:id/start` — Mark task running with `{ owner, token, generation }`.
- `POST /v1/tasks/:id/heartbeat` — Extend lease expiration with `{ owner, token, generation, ttlMs? }`.
- `POST /v1/tasks/:id/result` — Submit idempotent decision result with `{ owner, token, generation, result }`.
- `POST /v1/tasks/:id/fail` — Submit task failure with `{ owner, token, generation, error, details?, retryable? }`.
- `GET /v1/tasks/:id` — Retrieve task state.
- `GET /v1/tasks/:id/result` — Retrieve persisted decision result.
- `GET /v1/tasks/:id/receipt` — Retrieve immutable submission receipt.
- `POST /v1/tasks/:id/cancel` — Cancel task.
- `POST /v1/tasks/:id/supersede` — Supersede task.
- `POST /v1/tasks` — Create a new task with `{ sessionId, kind, operationKey, target? }` (auto-supersedes earlier revisions of the same kind).
- `GET /v1/sessions/:id` — Retrieve session status and binding.
- `POST /v1/sessions` — Create or retrieve an issue session with `{ root }`.
- `PUT /v1/sessions/:id/binding` — Bind or update executor binding with `{ adapter, externalSessionRef, resumeUri? }`.
- `POST /v1/sessions/:id/rebind` — Rebind executor with compare-and-swap generation check: `{ adapter, externalSessionRef, resumeUri?, expectedGeneration, operationKey? }`.

Security boundaries:
- Loopback-only binding (`127.0.0.1` by default).
- DNS rebinding prevention via strict `Host` header checks (`127.0.0.1`, `localhost`, `[::1]`).
- Constant-time Bearer token authentication via SHA-256 digest comparison (`crypto.timingSafeEqual`).
- Restrictive Origin enforcement: any request with an `Origin` header not explicitly listed in `allowedOrigins` is rejected with `403 Forbidden` before routing or execution (preventing unauthorized simple cross-origin requests and preflight requests).
- 1MB body limit with graceful socket draining to avoid connection reset.

## Executor adapter boundary and context strategies

The `@symphony/decision/adapter` entrypoint and `@symphony/domain/decision` subpath export the provider-neutral adapter layer and Decision Plane contracts for external model engines (such as Web ChatGPT, browser userscripts, or direct LLM APIs). Architectural rationale: [Agent Note](../notes/accepted/architecture/2026-10-09-decision-executor-adapter.md).

> [!NOTE]
> **Browser vs Server Runtime Entrypoints**:
> - **Browser runtimes** (userscripts, Tampermonkey, WebExtension content scripts): MUST import adapter execution primitives from `@symphony/decision/adapter` and domain contracts/types from `@symphony/domain/decision`. These subpaths contain zero Node built-in dependencies (`node:crypto`, `node:fs`, etc.) and produce clean browser bundles without polyfills.
> - **Server / Node.js runtimes** (CLI, orchestrator, localhost bridge): May import from the root `@symphony/domain` (which re-exports `@symphony/domain/decision` alongside Core workspace and config types) and `@symphony/decision`.

### DecisionExecutorAdapter interface

```ts
interface DecisionExecutorAdapter<THandle = unknown> {
  readonly name: string;
  readonly supportedTaskKinds: readonly ("plan" | "review")[];
  readonly supportedContextStrategies: readonly DecisionContextStrategyKind[];

  inspectBinding(
    session: DecisionSession,
    options?: { readonly signal?: AbortSignal | undefined }
  ): Promise<DecisionBindingInspectionResult<THandle>>;

  createSession(
    session: DecisionSession,
    options?: { readonly signal?: AbortSignal | undefined }
  ): Promise<DecisionSessionCreationResult<THandle>>;

  resumeSession(
    session: DecisionSession,
    binding: ExecutorBinding,
    options?: { readonly signal?: AbortSignal | undefined }
  ): Promise<DecisionSessionResumeResult<THandle>>;

  executeTask(
    request: DecisionExecutionRequest,
    options?: DecisionExecutionOptions
  ): Promise<DecisionExecutionOutcome>;

  normalizeResult?(
    rawResult: unknown,
    task: DecisionTask
  ): DecisionResult;
}
```

### Context strategies

Execution requests decouple task persistence from prompt assembly via `DecisionExecutionRequest`:
- **`connector` strategy** (`DecisionConnectorContext`): Minimal pointer bundle containing `workItem` (`{ provider, key }`), `repository`, `prNumber` (`number | null`), and `headSha` (`string | null`). Ideal for web-based agents that navigate GitHub directly via browser automation.
- **`materialized` strategy** (`DecisionMaterializedContext`): Explicit pre-bundled artifacts containing `workItem` (`{ provider, key }`), `repository`, `issue` (`{ repository, number, title, body }`), nullable `plan` (`DecisionMaterializedPlan | null`), nullable `pullRequest` (`DecisionMaterializedPullRequest | null`), nullable `diff` (`DecisionMaterializedDiff | null`), nullable `ci` (`DecisionMaterializedCi | null`), nullable `repositoryInstructions` (`string | null`), `previousReviews` (`readonly DecisionReviewResult[]`), and `unresolvedFindings` (`readonly DecisionReviewFinding[]`). Ideal for API or offline models without autonomous web navigation.

### Machine-readable result extraction

Models return structured results enclosed within fenced code blocks:
````markdown
```symphony-result
{
  "schemaVersion": 1,
  "taskId": "<task-id>",
  "sessionId": "<session-id>",
  "kind": "plan",
  "revision": 1,
  "verdict": "ready",
  "content": {
    "plan": "...",
    "acceptanceCriteria": ["..."],
    "risks": [],
    "clarifications": []
  },
  "createdAtMs": 1728480000000
}
```
````

Extraction rules:
1. **Last-block rule**: If multiple `symphony-result` blocks exist in the output (e.g. conversational self-correction), only the LAST block is extracted.
2. **Fail-closed semantics**: If the last block is missing, unclosed, contains malformed JSON, or fails schema validation, extraction throws `DecisionAdapterError`. It NEVER falls back to earlier valid blocks.
3. **Identity verification**: Result `taskId`, `sessionId`, `revision`, and review `target` must match the claimed task; mismatches throw `task_mismatch`, `revision_mismatch`, or `target_mismatch`.

### Error classification

`DecisionAdapterErrorCode`:
- `malformed_output`: Missing, invalid, or unclosed `symphony-result` JSON.
- `task_mismatch`: Result taskId or sessionId does not match claimed task.
- `revision_mismatch`: Result revision does not match task revision.
- `target_mismatch`: Review result target does not match task review target.
- `binding_broken`: Executor session expired, disconnected, or unrecoverable.
- `execution_failed`: Unhandled runtime execution exception.
- `human_required`: Interactive barrier encountered (CAPTCHA, 2FA, login, rate limit).
- `unsupported_strategy`: Requested context strategy not supported by adapter.
- `unsupported_task_kind`: Task kind not supported by adapter.
- `cancelled`: Execution aborted by caller.

## Validation evidence

`packages/domain/src/decision.test.ts` and `packages/domain/src/decision-context.test.ts` cover domain validation, context parsing, task/session transitions, all six verdicts, and identity guards.

`packages/decision/src/*.test.ts` covers the lock recovery, atomic store persistence, lease coordination, HTTP bridge, adapter result extraction, last-block fail-closed semantics, and `FakeDecisionExecutorAdapter` execution with CAS rebind.

CLI integration is verified in `apps/cli/src/decision-bridge-cli.test.ts` and `apps/cli/src/bin.test.ts`.

Run `npm test -w @symphony/domain`, `npm test -w @symphony/decision`, `npm test -w @symphony/cli`,
`npm run typecheck`, then `npm run gate`.
