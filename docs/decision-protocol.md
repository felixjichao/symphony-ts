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

- **Snapshot file**: All sessions, tasks, and results are persisted in a versioned JSON snapshot file (`snapshot.json`).
- **Atomic persistence**: Writes write to `snapshot.json.tmp`, flush to disk, and atomically rename over `snapshot.json`, followed by directory fsync.
- **Fail closed on corruption**: Startup verifies data integrity; malformed or unparseable files fail closed without silent reset.
- **Single-writer process lock**: An advisory `store.lock` records owner PID and acquisition timestamp. Stale locks from terminated processes are safely recovered.

### Web Agent Bridge HTTP API

The bridge exposes a local HTTP interface (default `127.0.0.1:4040`) for Web Agents (Tampermonkey userscripts, browser extensions, or local tools):

- `GET /v1/tasks/next?kinds=plan,review` — Fetch the next pending executable task.
- `POST /v1/tasks/:id/claim` — Atomically claim lease with `{ owner, ttlMs }`.
- `POST /v1/tasks/:id/start` — Mark task running with `{ claimToken }`.
- `POST /v1/tasks/:id/heartbeat` — Extend lease expiration with `{ claimToken, ttlMs }`.
- `POST /v1/tasks/:id/result` — Submit idempotent decision result with `{ claimToken, result }`.
- `POST /v1/tasks/:id/fail` — Submit task failure with `{ claimToken, error }`.
- `GET /v1/sessions/:id` — Retrieve session status and binding.
- `PUT /v1/sessions/:id/binding` — Bind or update executor binding.
- `POST /v1/sessions/:id/rebind` — Rebind executor with compare-and-swap generation check.
- `POST /v1/tasks` — Create a new task (auto-supersedes earlier revisions of the same kind).
- `POST /v1/sessions` — Create or retrieve an issue session.

Security boundaries:
- Loopback-only binding (`127.0.0.1` by default).
- DNS rebinding prevention via strict `Host` header checks (`127.0.0.1`, `localhost`, bound host:port).
- Optional constant-time Bearer token authentication.
- Restricted CORS: requests from non-loopback origins are rejected.
- 1MB body limit with graceful socket draining to avoid connection reset.

## Validation evidence

`packages/domain/src/decision.test.ts` imports only the public package entry point.
It covers the complete task transition table, session transitions, all six verdicts,
identity mismatch, same-root multiple PRs, exact SHA approval and A → B → A,
expiry and claim fencing, binding generation/recovery, strict nested validation
and JSON round trips.

`packages/decision/src/*.test.ts` covers the lock recovery, atomic store persistence,
decision service lease coordination and automatic supersession, and the HTTP bridge
(DNS rebinding defense, CORS restrictions, bearer authentication, body limits, and REST routes).

CLI integration is verified in `apps/cli/src/decision-bridge-cli.test.ts` and `apps/cli/src/bin.test.ts`.

Run `npm test -w @symphony/domain`, `npm test -w @symphony/decision`, `npm test -w @symphony/cli`,
`npm run typecheck`, then `npm run gate`.
