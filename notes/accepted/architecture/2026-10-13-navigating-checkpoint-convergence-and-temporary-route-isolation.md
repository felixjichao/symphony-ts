# Agent Note: Navigating Checkpoint Convergence and Temporary Route Isolation
Status: accepted

## Problem
During real-browser dogfooding of ChatGPT Web automation (`apps/chatgpt-web`, SPEC §17):
1. **Navigating Checkpoint Infinite Loop & Lack of Cross-Page Convergence**:
   When an active binding points to a conversation that was deleted or no longer exists, ChatGPT Web redirects back to the homepage `/`. In browser automation, cross-page navigations unload the document and destroy in-memory timers (such as `Date.now() - startWaitRoute` inside `adapter.resumeSession`). When the tab reconstituted at `/`, `resumeCheckpointIfAvailable` observed that the current URL did not match `targetUri` and unconditionally called `location.assign(targetUri)` again, creating an infinite navigation loop.
2. **Bootstrap Route Drift False Alarm due to Temporary Routes**:
   In modern ChatGPT Web (Edge + Tampermonkey), starting a new conversation from root `/` transitions first through a client-side temporary route (e.g. `/c/local-chatgpt`) before the backend assigns the canonical conversation UUID (e.g. `/c/<UUID>`). `recordCreatedConversationRef` immediately latched onto `local-chatgpt` as the durable conversation reference; when the subsequent formal UUID appeared, the attempt was falsely aborted as an unrecoverable route drift (`human_required`), preventing automated bootstrap and rollover.

## Decision
1. **Navigating Checkpoint Failure Convergence & Unrecoverable Rebind**:
   - Extended `DriverCheckpoint` with `navigationAttempts` (counter), `navigationStartedAtMs`, and `navigationDeadlineMs`.
   - Driver accepts `navigationTimeoutMs` (default 180s) and `maxNavigationAttempts` (default 3).
   - In `resumeCheckpointIfAvailable` (`cp.step === "navigating"`):
     - If the target conversation is detected as not found (`detectConversationNotFound(doc)`), it converges immediately without waiting for retry budget exhaustion.
     - If not at the target URI, it evaluates whether attempts exceeded `maxNavigationAttempts` or the deadline expired (`isBudgetExhausted`).
     - When unrecoverable, it executes `rebindUnrecoverableSession()`: breaks binding, creates a fresh session via `adapter.createSession()`, rebinds on the bridge with incremented `bindingGeneration` (N -> N+1), deletes the checkpoint, and returns `{ status: "superseded" }`.
     - Otherwise, it increments `navigationAttempts`, updates the checkpoint, calls `win.location.assign(targetUri)`, and checks `nowAtTarget` (returning `null` for real asynchronous navigation, or advancing to execution for synchronous test environments).
2. **Client Temporary Route Isolation**:
   - Added `isTemporaryConversationRoute(convId)` in `probes.ts` recognizing `local-chatgpt`, `local-*`, `temporary`, and `temp-*`.
   - Added `extractFormalConversationIdFromUrl` and updated `isConversationAssociatedWithBootstrap` to ignore temporary routes.
   - In `adapter.ts`: `recordCreatedConversationRef` ignores temporary routes only prior to latching the formal conversation reference. Once latched, any route departure (whether to a temporary route or a different conversation UUID) triggers immutable association protection with non-retryable `human_required`.
   - If bootstrap streaming completes without obtaining an authoritative formal conversation reference (e.g. tab remains on a temporary route), it fails closed with non-retryable `human_required` (`retryable: false`), preventing duplicate bootstrap prompt submissions.
3. **Browser-Safe Decision Error Export**:
   - Exported `DecisionConflictError` from `@symphony/decision/adapter` so `apps/chatgpt-web` maintains zero Node built-in dependencies in browser bundles.

## Alternatives considered
1. **Relying solely on `adapter.resumeSession` in-memory timeout**:
   Rejected because cross-page full navigations (`location.assign` / HTTP redirects) destroy in-memory wait timers. A timer inside `resumeSession` cannot converge across multiple document reconstitutions.
2. **Accepting temporary routes like `local-chatgpt` as the session's permanent `externalSessionRef`**:
   Rejected because `local-chatgpt` is a client-local route that cannot be resumed in a new tab or subsequent browser session, violating durable decision recovery across tabs.
3. **Failing closed immediately on the first redirect to homepage `/`**:
   Rejected because SPA client routing and network transitions may momentarily bounce to root before resolving. A bounded retry budget (default 3 attempts / 180s) ensures convergence without prematurely aborting transient routing jitter.

## Consequences
- Navigating checkpoints converge deterministically across document reconstitutions, automatically rolling over unrecoverable bindings (N -> N+1) without human intervention or infinite navigation loops.
- Real ChatGPT Web workflows navigating `/ → /c/local-chatgpt → /c/<UUID>` succeed smoothly without false route drift aborts.
- `apps/chatgpt-web` userscript bundle size remains compact (~87 kB) with zero Node built-in dependencies.
