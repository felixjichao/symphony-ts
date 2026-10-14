# Agent Note: Navigating Checkpoint Convergence and Temporary Route Isolation
Status: accepted

## Problem
During real-browser dogfooding of ChatGPT Web automation (`apps/chatgpt-web`, SPEC §17):
1. **Navigating Checkpoint Infinite Loop & Lack of Cross-Page Convergence**:
   When an active binding points to a conversation that was deleted or no longer exists, ChatGPT Web redirects back to the homepage `/`. In browser automation, cross-page navigations unload the document and destroy in-memory timers (such as `Date.now() - startWaitRoute` inside `adapter.resumeSession`). When the tab reconstituted at `/`, `resumeCheckpointIfAvailable` observed that the current URL did not match `targetUri` and unconditionally called `location.assign(targetUri)` again, creating an infinite navigation loop.
2. **Bootstrap Route Drift False Alarm due to Temporary Routes**:
   In modern ChatGPT Web (Edge + Tampermonkey), starting a new conversation from root `/` transitions first through a client-side temporary route (e.g. `/c/local-chatgpt`) before the backend assigns the canonical conversation UUID (e.g. `/c/<UUID>`). `recordCreatedConversationRef` immediately latched onto `local-chatgpt` as the durable conversation reference; when the subsequent formal UUID appeared, the attempt was falsely aborted as an unrecoverable route drift (`human_required`), preventing automated bootstrap and rollover.
3. **Scenario A Dead Route Divergence to Root and Navigation Budget Reset**:
   When resuming an existing session with an invalid/deleted conversation reference in ChatGPT Web, the SPA redirects back to homepage `/`. In `adapter.resumeSession`, waiting for composer previously either adopted the root composer or timed out as `execution_failed / retryable: true`, failing the task at generation 1 rather than triggering broken-binding rebind rollover (generation 1 → 2). Concurrently, `resumeCheckpointIfAvailable` prematurely demoted navigating checkpoints to `claimed` upon initial URL match, and step transitions reset attempt counters, disrupting the cross-page retry budget and heartbeat lease renewal state.
4. **Scenario A Real-Browser Access Denied Detection and Route Divergence**:
   In live Edge + Tampermonkey dogfood testing of Scenario A (PR #126 HEAD `68b04f73`), the target conversation route was reached, but ChatGPT Web displayed “你无权访问此对话” (access denied / permission error) and asynchronously redirected to homepage `/`. `detectConversationNotFound` failed to identify this permission refusal UI, and `adapter.resumeSession` returned upon observing the shell composer `#prompt-textarea` before the redirection finished. In `adapter.executeTask`, the task proceeded on homepage `/`, waiting ~180s for send-button readiness without verifying route continuity, eventually timing out as `execution_failed / retryable: true` at generation 1 without broken-binding rebind rollover.

## Decision
1. **Navigating Checkpoint Failure Convergence & Unrecoverable Rebind**:
   - Extended `DriverCheckpoint` with `navigationAttempts` (counter), `navigationStartedAtMs`, and `navigationDeadlineMs`.
   - Driver accepts `navigationTimeoutMs` (default 180s) and `maxNavigationAttempts` (default 3).
   - In `resumeCheckpointIfAvailable` (`cp.step === "navigating"`):
     - If the target conversation is detected as not found (`detectConversationNotFound(doc)`), it converges immediately without waiting for retry budget exhaustion.
     - If not at the target URI, it evaluates whether attempts exceeded `maxNavigationAttempts` or the deadline expired (`isBudgetExhausted`).
     - When unrecoverable, it executes `rebindUnrecoverableSession()`: breaks binding, creates a fresh session via `adapter.createSession()`, rebinds on the bridge with incremented `bindingGeneration` (N -> N+1), deletes the checkpoint, and returns `{ status: "superseded" }`.
     - Otherwise, it increments `navigationAttempts`, updates the checkpoint, calls `win.location.assign(targetUri)`, and checks `nowAtTarget` (returning `null` for real asynchronous navigation, or advancing to execution for synchronous test environments).
   - **Preserving Navigation Budget and Step Across Checkpoints**:
     - In `updateCheckpointStep`, track `isSameTarget` across step updates. When continuing navigation to the same target URI / conversation ID across step transitions, preserve accumulated `navigationAttempts`, `navigationStartedAtMs`, and `navigationDeadlineMs`, incrementing attempts if re-entering navigating rather than resetting them to 1.
     - In `resumeCheckpointIfAvailable` under `cp.step === "navigating"`, do not prematurely demote navigating checkpoints to `claimed` merely on URL match before route stability and composer readiness are confirmed by the adapter.
     - Preserve authoritative heartbeat `leaseExpiresAtMs` renewal in `checkpointStore` during checkpoint resumption, avoiding redundant overwrites from stale in-memory snapshots.
2. **Resume Route Departure and Timeout Rebind Classification**:
   - In `adapter.resumeSession`, classify route navigation timeout as `binding_broken / rebind` with `observedGeneration: binding.generation`.
   - In the composer-wait loop of `resumeSession`, detect route departure from `targetConvId` (e.g. redirected to root `/`), immediately throwing `binding_broken / rebind` rather than falsely adopting the root composer or timing out as `execution_failed / retry`.
3. **Client Temporary Route Isolation**:
   - Added `isTemporaryConversationRoute(convId)` in `probes.ts` recognizing `local-chatgpt`, `local-*`, `temporary`, and `temp-*`.
   - Added `extractFormalConversationIdFromUrl` and updated `isConversationAssociatedWithBootstrap` to ignore temporary routes.
   - In `adapter.ts`: `recordCreatedConversationRef` ignores temporary routes only prior to latching the formal conversation reference. Once latched, any route departure (whether to a temporary route, another conversation UUID, or a route without conversation ID such as homepage `/`) triggers immutable association protection with non-retryable `human_required`.
   - If bootstrap streaming completes without obtaining an authoritative formal conversation reference (e.g. tab remains on a temporary route), it fails closed with non-retryable `human_required` (`retryable: false`), preventing duplicate bootstrap prompt submissions.
4. **Browser-Safe Decision Error Export**:
   - Exported `DecisionConflictError` from `@symphony/decision/adapter` so `apps/chatgpt-web` maintains zero Node built-in dependencies in browser bundles.
5. **Authentic Access Denied Detection and Execution Route Continuity Verification**:
   - Extended `detectConversationNotFound` in `probes.ts` with `CONVERSATION_NOT_FOUND_PATTERNS` covering Chinese and English permission/not-found variations ("你无权访问此对话", "无权访问此对话", "无权访问", "找不到对话", "对话不存在", "无法加载对话", "You do not have access to this conversation", "Access denied", "404 - Not Found", etc.).
   - Authentic error UI (`[role='alert']`, `[role='dialog']`, `div[class*='modal']`, `div[class*='toast']`, `h1-h3`) outside message containers takes strict precedence over lingering shell composer elements (`#prompt-textarea`). Text extraction explicitly strips descendant chat message containers (`getTextExcludingMessages`), preventing in-chat quotes from triggering false positive not-found errors.
   - Added a route stabilization window in `adapter.resumeSession` to detect asynchronous redirect/error before confirming resume.
   - In `adapter.executeTask` pre-flight checks, preserved authentication priority by checking `detectAuthRequired` first before route departures, ensuring login obstacles surface as `human_required / human_intervention` rather than false broken bindings.
   - Added route continuity and health checks in `adapter.executeTask` pre-flight and polling loop in `waitForSendButton`: if route departs to root or conversation is not found before prompt submission, throws `binding_broken / rebind` with `promptSubmitted: false`.
   - In `coordinator.ts` (`executeTaskWithAdapter`), pre-submit rebind errors during `executeTask` (`promptSubmitted: false`) trigger automated CAS rebind and session rollover (generation N -> N+1) and task supersede under lease, while post-submission errors remain fail-closed to prevent duplicate prompt submission.

## Alternatives considered
1. **Relying solely on `adapter.resumeSession` in-memory timeout**:
   Rejected because cross-page full navigations (`location.assign` / HTTP redirects) destroy in-memory wait timers. A timer inside `resumeSession` cannot converge across multiple document reconstitutions.
2. **Accepting temporary routes like `local-chatgpt` as the session's permanent `externalSessionRef`**:
   Rejected because `local-chatgpt` is a client-local route that cannot be resumed in a new tab or subsequent browser session, violating durable decision recovery across tabs.
3. **Failing closed immediately on the first redirect to homepage `/`**:
   Rejected because SPA client routing and network transitions may momentarily bounce to root before resolving. A bounded retry budget (default 3 attempts / 180s) ensures convergence without prematurely aborting transient routing jitter.
4. **Retrying dead conversations as `execution_failed` at the same generation**:
   Rejected because a deleted or nonexistent conversation will never recover under the same external reference; re-attempting without rebind causes task exhaustion rather than establishing a fresh valid binding.
5. **Waiting for generic send-button timeout (180s) when route departs**:
   Rejected because once the SPA redirects to homepage `/` or presents permission denial, waiting 180s wastes execution time and conflates unrecoverable route divergence with transient send button latency. Failing fast with `binding_broken / rebind` preserves session authority and rollover semantics.

## Consequences
- Navigating checkpoints converge deterministically across document reconstitutions, automatically rolling over unrecoverable bindings (N -> N+1) without human intervention or infinite navigation loops.
- Scenario A dead conversation routes and access denied errors automatically trigger broken-binding rebind rollover from generation 1 to generation 2 without requiring manual break-binding or failing the task with retryable execution error.
- Real ChatGPT Web workflows navigating `/ → /c/local-chatgpt → /c/<UUID>` succeed smoothly without false route drift aborts.
- `apps/chatgpt-web` userscript bundle size remains compact (~90 kB) with zero Node built-in dependencies.
- Note: Scenario A recovery is verified through unit and regression fixtures in `test/scenario-a-resume.test.ts`; live browser dogfood acceptance on ChatGPT Web with operator login session remains pending under NEST-120.
