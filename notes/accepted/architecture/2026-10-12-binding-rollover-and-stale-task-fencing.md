# Agent Note: Binding rollover recovery and stale-task fencing
Status: accepted

## Problem

In real-world Decision Plane runs (e.g. dogfooding with ChatGPT Web and localhost bridge):
1. **Unrecovered `resumeSession` failure**: When an executor adapter (such as `ChatGptWebAdapter`) failed during `resumeSession` because an underlying conversation became broken or inaccessible (e.g. HTTP 404 conversation not found, or authentication expired), the coordinator treated it as a terminal task failure without triggering broken-binding recovery or rollover. The session remained bound to an invalid external conversation and subsequent tasks continued to fail or stall.
2. **Stale task lease execution across rebinds**: When a session binding was broken or rolled over to generation $N+1$, tasks that had been claimed under generation $N$ could still continue executing, heartbeating, or submitting results against the new generation. There was no lease fencing tied to the binding generation.
3. **Manual intervention on page reload**: In the ChatGPT Web browser userscript, refreshing the page or navigating caused the driver to stop in an "Idle" state requiring a manual operator click on "Start Driver", interrupting automated multi-turn execution.

## Decision

1. **Coordinator-level `resumeSession` broken-binding recovery**:
   - `executeTaskWithAdapter` wraps `adapter.resumeSession` in an error handler.
   - When `resumeSession` throws an error with `suggestedAction === "rebind"` (e.g. conversation deleted/404, or unrecoverable thread brokenness), the coordinator automatically triggers `adapter.breakBinding` / bridge rebind recovery, rebinds the session to generation $N+1$, and executes the task with handoff context rather than recording a permanent failure. Errors requiring fail-closed or human intervention continue to fail cleanly.
2. **Stale-task fencing on binding rollover**:
   - The decision store tracks claim binding generations (`claimBindingGenerations: Record<string, number>`).
   - When a session is rebound (`rebindSession`), all active non-completed claims for that session are immediately released back to `pending` via `releaseDecisionTaskForBindingInvalidation(task, now)` with cleared leases.
   - `startTask`, `heartbeatTask`, and `submitResult` / `submitFailure` enforce that the task claim's binding generation matches the session's current `bindingGeneration`. Stale generation workers receive HTTP `409 Conflict`.
   - In `executeTaskWithAdapter`, detecting that the session has rolled over returns `{ status: "superseded", session: currentSession, error: DecisionConflictError }` so the driver immediately drops obsolete checkpoints and polls for newly available work.
3. **Tab reload auto-restart**:
   - In `apps/chatgpt-web`, starting the driver persists `symphony_driver_enabled` in `sessionStorage`.
   - On page reload or navigation, if `sessionStorage.getItem("symphony_driver_enabled") === "true"`, the driver automatically starts without operator intervention.
   - Explicit operator stop or fatal authentication rejections (HTTP 401/403) clear `symphony_driver_enabled` from `sessionStorage`. Unstarted tabs remain Idle.
4. **Bootstrap recovery requires the attempt's recorded created conversation**:
   - Conversation creation is checkpointed in phases (`bootstrap_submitting`, `bootstrap_waiting`, `rebind_submitting`).
   - As soon as the send produces the conversation route, `createSession` records that conversation in the checkpoint (`targetConvId`), and any earlier reference is cleared when a new creation attempt starts.
   - The recorded reference is **immutable for the attempt**: the first conversation route reached after the send is what this attempt created. Every later route change (human navigation, redirect, restart) is a deviation, never a re-definition — a deviation fails the attempt closed instead of updating the reference.
   - The reference is **only ever recorded while the attempt is live**: once the wait is cancelled, a route observed afterwards never becomes the creation reference (it may be an unrelated conversation loaded as the tab goes away). An interrupted attempt without a recorded reference fails closed rather than completing the reference from the post-cancellation route.
   - The reference is verified when the wait is cancelled, on every route poll, and again after the reply is read, before any binding is written (creation and recovery alike).
   - Recovering a bootstrap checkpoint only proceeds while the tab shows **exactly that recorded conversation**. Page content is not attempt-unique — every Symphony-created conversation renders the same bootstrap prompt and reply — so text, an arbitrary `/c/<id>` URL, or a "looks sent" page is never accepted as association evidence.
   - Without a recorded reference, on any route deviation from it, or when the tab shows any other conversation, recovery fails closed with a non-retryable `human_required` failure for operator handoff (no reply is read, no binding is written, no prompt is re-sent).
5. **Recovery failures keep their Decision-protocol classification**:
   - Failures raised while recovering a checkpoint (health probes, association checks, adapter faults) are persisted with the same code, suggested action and retryability the coordinator applies to adapter errors: typed `human_required` / `human_intervention` remains a non-retryable human handoff and typed `binding_broken` (suggested action `rebind`) remains non-retryable instead of being flattened into a retryable `execution_failed`.
   - Ordinary wait, timeout or network errors keep the retryable `execution_failed` classification.

## Alternatives considered

- **Clear all tasks on rebind instead of releasing to pending**: Rejected because review tasks and plan tasks belong to the issue session's historical continuity. Setting them back to `pending` allows the newly bound generation to pick up the execution with handoff context without losing task identity or findings history.
- **Rely solely on task lease timeout (TTL) for fencing**: Rejected because lease TTL defaults to minutes, during which an old generation worker could write back stale results or race with the new generation worker. Explicit generation fencing rejects stale calls immediately (fail-closed).
- **Auto-restart driver unconditionally without `sessionStorage`**: Rejected because tabs not intended to act as Symphony drivers (or tabs where an operator intentionally clicked "Stop") must not execute tasks unexpectedly.
- **Association by URL shape or page text during bootstrap recovery**: Rejected because neither is attempt-unique: a restored or unrelated page also sits on a `/c/<id>` route, and every Symphony-created conversation renders the same bootstrap prompt and reply. Only the conversation recorded by this attempt (`targetConvId`) identifies it.
- **Re-recording the reference whenever the route changes**: Rejected because a later route is not evidence of creation: a redirect, a human navigation or a restarted tab would silently redefine the attempt to whatever conversation happens to be open, and the real created conversation would be abandoned. The reference is written once and any deviation fails the attempt closed.
- **Completing the reference from the route observed after cancellation**: Rejected because the tab may be leaving the page exactly when the attempt is cancelled, so the route visible then can belong to an unrelated conversation. The creation reference must be established while the attempt is live; otherwise the attempt fails closed without one.
- **Flattening recovery failures into a retryable `execution_failed`**: Rejected because upstream would then blindly retry a page that needs a human (authentication barrier) or a binding that needs a rebind, and the human-intervention handoff and rebind signal would be lost. Recovery keeps the typed code, suggested action and retryability.
- **Binding the loaded conversation and re-sending when association is unclear**: Rejected because binding an unrelated historical conversation silently abandons the real one and routes later tasks to the wrong context, while re-sending can duplicate external side effects; failing closed with an operator handoff is the safe alternative.

## Consequences

- Broken conversation sessions seamlessly roll over to a fresh conversation with durable handoff context without human restart.
- Bootstrap-phase recovery only continues from the conversation this attempt created; unconfirmable pages fail closed into an explicit operator handoff instead of binding unrelated history.
- Stale workers from older binding generations are fenced immediately with HTTP 409 and cannot overwrite or corrupt state in newer generations.
- ChatGPT Web tab navigation or reload resumes autonomous execution smoothly.
