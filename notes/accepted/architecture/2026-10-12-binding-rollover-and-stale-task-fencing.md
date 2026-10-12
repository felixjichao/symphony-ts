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

## Alternatives considered

- **Clear all tasks on rebind instead of releasing to pending**: Rejected because review tasks and plan tasks belong to the issue session's historical continuity. Setting them back to `pending` allows the newly bound generation to pick up the execution with handoff context without losing task identity or findings history.
- **Rely solely on task lease timeout (TTL) for fencing**: Rejected because lease TTL defaults to minutes, during which an old generation worker could write back stale results or race with the new generation worker. Explicit generation fencing rejects stale calls immediately (fail-closed).
- **Auto-restart driver unconditionally without `sessionStorage`**: Rejected because tabs not intended to act as Symphony drivers (or tabs where an operator intentionally clicked "Stop") must not execute tasks unexpectedly.

## Consequences

- Broken conversation sessions seamlessly roll over to a fresh conversation with durable handoff context without human restart.
- Stale workers from older binding generations are fenced immediately with HTTP 409 and cannot overwrite or corrupt state in newer generations.
- ChatGPT Web tab navigation or reload resumes autonomous execution smoothly.
