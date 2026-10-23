# @symphony/chatgpt-web

ChatGPT Web Decision Executor Adapter & Tampermonkey Decision Driver for Symphony Decision Plane.

## Overview

`@symphony/chatgpt-web` implements the first concrete `DecisionExecutorAdapter` for Symphony. It drives a ChatGPT Web browser session via a Tampermonkey userscript connected to the localhost Web Agent Bridge (`symphony decision bridge`).

This enables automated Plan and Review execution directly within ChatGPT Web while maintaining strict lease fencing, generation tracking, fail-closed result verification, and cross-tab isolated recovery.

## Architecture

- **`ChatGptWebAdapter`** (`src/adapter.ts`): Implements `DecisionExecutorAdapter` (`@symphony/decision/adapter`). Manages conversation handles, constructs task prompts (Plan / Review / Handoff), injects text into the ChatGPT composer, awaits streaming completion with turn baseline tracking, and extracts `symphony-result` JSON payloads with fail-closed last-block parsing.
- **`DecisionTabDriver`** (`src/driver.ts`): Implements `DecisionTaskController` (`@symphony/decision/adapter`). Runs inside the ChatGPT Web tab, polls and claims tasks from the local bridge, maintains active leases with regular heartbeats, coordinates CAS rebinds, and manages recovery checkpoints with stage tracking.
- **DOM Probes** (`src/probes.ts`): Centralized DOM selectors for composer input, send/stop buttons, streaming indicators, turn extraction, and URL conversation ID parsing with defensive fallbacks across ChatGPT UI revisions.
- **Transports** (`src/transport.ts`):
  - `GmBridgeTransport`: Uses `GM_xmlhttpRequest` for cross-origin loopback requests bypassing browser CORS limitations, including Bearer token authentication.
  - `FetchBridgeTransport`: Standard `fetch` transport for environments where native CORS is permitted.
- **Checkpoint Recovery** (`src/checkpoint.ts`): Durable checkpoint persistence using `GM_setValue` / `sessionStorage` ensuring safe resumption across tab reloads and navigation with per-tab scoped keys (`symphony_driver_checkpoint_v1_${tabId}`).
- **Userscript Entrypoint** (`src/userscript-entry.ts`): Injects an interactive HUD control overlay onto ChatGPT Web (`https://chatgpt.com/*`), mounts the driver, provides Bridge URL and Token configuration inputs, surfaces runtime errors, and handles start/stop lifecycle.

## Building the Userscript

To compile the TypeScript source and generate the standalone Tampermonkey userscript bundle:

```bash
npm run build -w @symphony/chatgpt-web
```

The compiled bundle is output to:
```text
apps/chatgpt-web/dist/symphony-decision-driver.user.js
```

The bundle includes the complete Tampermonkey metadata block (`// ==UserScript==`) specifying matching rules for `https://chatgpt.com/*` and granting `GM_xmlhttpRequest`, `GM_setValue`, and `GM_getValue`.

## Installation & Setup

1. **Install Tampermonkey**:
   Install the Tampermonkey browser extension in Chrome, Edge, or Firefox.
2. **Install the Userscript**:
   - In Tampermonkey dashboard, select "Utilities" → "Import from file" (or create a new script and paste `dist/symphony-decision-driver.user.js`).
   - Enable the script for `https://chatgpt.com/*`.
3. **Start the Bridge with Authentication & Store**:
   Start the localhost decision bridge with the required store directory and bearer token:
   ```bash
   symphony decision bridge \
     --store ./data/decision-store \
     --port 4040 \
     --token "secret-bridge-token" \
     --allowed-origins "https://chatgpt.com"
   ```
4. **Configure Token & Bridge URL in Userscript**:
   - Navigate to `https://chatgpt.com/`.
   - The "Symphony Decision Driver" HUD will appear in the bottom-right corner.
   - Enter `http://127.0.0.1:4040` into the Bridge URL input.
   - Click **Set Token** (or use Tampermonkey menu: *Tampermonkey Icon* → *Symphony: Set Bridge Bearer Token*) and enter `secret-bridge-token`.
   - The token is saved in isolated Tampermonkey storage (`GM_setValue`) and is **never** written to page DOM elements or inputs.
   - Click **Start Driver**. The status will switch to `● Running` and poll for tasks.

## Manual Task Scheduling & Smoke Testing

To schedule a task on the localhost bridge manually for smoke testing or verification (from an empty store to an executable pending task), stop the driver first. Create the session, task and context below before clicking **Start Driver**. A running driver can claim a task before its context is delivered.

```bash
# 1. Create a Decision session for a work item
curl -s -X POST http://127.0.0.1:4040/v1/sessions \
  -H "Authorization: Bearer secret-bridge-token" \
  -H "Content-Type: application/json" \
  -d '{"root":{"provider":"github","key":"owner/repo#1"}}'
# Output: {"session":{"id":"github:owner/repo#1",...}}

# 2. Create a plan task for the session
curl -s -X POST http://127.0.0.1:4040/v1/tasks \
  -H "Authorization: Bearer secret-bridge-token" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"github:owner/repo#1","kind":"plan","operationKey":"op-smoke-1"}'
# Output: {"task":{"id":"github%3Aowner%2Frepo%231:plan:1",...}}

# Note: The canonical task ID contains URL-safe encoding (e.g. "github%3Aowner%2Frepo%231:plan:1").
# When passing the task ID in HTTP route path segments, encode it with encodeURIComponent
# (producing "github%253Aowner%252Frepo%25231%3Aplan%3A1") so the server decodes it back to the exact ID.

# 3. Deliver task context (required before task can be executed)
curl -s -X PUT http://127.0.0.1:4040/v1/tasks/github%253Aowner%252Frepo%25231%3Aplan%3A1/context \
  -H "Authorization: Bearer secret-bridge-token" \
  -H "Content-Type: application/json" \
  -d '{"context":{"strategy":"connector","workItem":{"provider":"github","key":"owner/repo#1"},"repository":"owner/repo","prNumber":null,"headSha":null}}'

# 4. Verify task is pending and ready to be claimed by the driver
curl -s -H "Authorization: Bearer secret-bridge-token" \
  http://127.0.0.1:4040/v1/tasks/next

# 5. Query task status and receipt after driver execution
curl -s -H "Authorization: Bearer secret-bridge-token" \
  http://127.0.0.1:4040/v1/tasks/github%253Aowner%252Frepo%25231%3Aplan%3A1

curl -s -H "Authorization: Bearer secret-bridge-token" \
  http://127.0.0.1:4040/v1/tasks/github%253Aowner%252Frepo%25231%3Aplan%3A1/receipt
```

## Execution & Smoke Walkthrough

### 1. Plan Task Execution
- Symphony schedules a `plan` task on the bridge for a session (e.g. `github:owner/repo#1`).
- The userscript claims the task, verifies that no existing conversation is bound, navigates to a new chat, submits `BOOTSTRAP_PROMPT`, awaits response, records the new conversation reference (`/c/<id>`), and stores the binding.
- It then formats and submits the `plan` prompt, awaits completion of the new turn, extracts the structured ````symphony-result` payload (verifying `schemaVersion: 1`, `verdict: "ready"`, and content nesting), and submits the result to the bridge.

### 2. Review Task Execution & Session Continuity
- Symphony schedules a subsequent `review` task for the same session.
- The userscript inspects the session binding, verifies that the existing conversation is authoritative, navigates to that conversation URL (`/c/<id>`), and submits the continuation prompt with the current PR and expected HEAD SHA.
- It extracts the `review` result and submits it to the bridge.

### 3. Checkpoint Lifecycle & Idempotent Recovery
- Active execution is checkpointed at discrete stages (`claimed`, `started`, `prompt_submitting`, `waiting_response`, `result_extracted`), isolated per tab via `tabId`.
- **Packet Loss & Receipt Recovery**: Before sending `/result`, the candidate result is persisted in the checkpoint. If network packet loss occurs during submission, `resumeCheckpointIfAvailable()` first checks task completion and queries authoritative `/receipt` on the bridge, replaying the completed result without requiring lease renewal.
- **In-flight Waiting & Navigation Auto-Recovery**: Starting the driver records active run state in `sessionStorage` (`symphony_driver_enabled`). Across full page navigation or reloads within the same tab, the userscript automatically resumes polling and checkpoint recovery without requiring manual operator clicks. Explicit operator Stop or fatal authentication errors (HTTP 401/403) clear this flag and keep the HUD in Idle. If the checkpoint is in `waiting_response`, recovery waits for the existing assistant response instead of re-submitting the prompt.
- **Typed Recovery Failures**: failures raised while recovering (health probes, association checks, adapter faults) are persisted with their Decision-protocol classification — a typed `human_required` / `human_intervention` stays a non-retryable human handoff, a typed `binding_broken` stays a rebind signal, and their `suggestedAction` is recorded in the failure details — while ordinary wait or network errors remain a retryable `execution_failed`.
- **Bootstrap Phase Recovery & Conversation Association**: conversation creation is checkpointed as `bootstrap_submitting` / `bootstrap_waiting` / `rebind_submitting`. As soon as the send produces the conversation route, the creation attempt records that conversation in the checkpoint (`targetConvId`), and that reference is immutable for the attempt: the first conversation route reached after the send is what this attempt created, while any later route (navigation, redirect, restart) is a deviation that never redefines it. The reference is only ever recorded while the attempt is live — a cancelled attempt never takes its creation reference from a route observed after the interruption, since that route may belong to an unrelated conversation. Creation and recovery verify the reference when the wait is cancelled, when the route drifts, and after the reply is read before any binding is written. Recovering a bootstrap checkpoint only proceeds while the tab shows **exactly that recorded conversation**: page content is not attempt-unique (every Symphony-created conversation renders the same bootstrap prompt and reply), so it is never accepted as association evidence. Without a recorded reference, on any route deviation, or when the tab shows another conversation, the attempt fails closed (`human_required`, non-retryable) for operator handoff instead of reading a reply, binding, or re-sending the bootstrap.
- **Heartbeat Expiry Sync**: Each successful lease heartbeat returns the extended `expiresAtMs`, which is written back to the checkpoint to prevent false local expiry during lengthy model reasoning.

### 4. Broken Binding & Rollover
- If an existing conversation is deleted or returns 404, the session transitions to `broken-binding`.
- On next task claim, `inspectBinding()` detects `unusable` with `needsRebind: true`.
- The driver creates a new conversation, executes CAS rebind with `expectedGeneration`, delivers the `formatHandoffPrompt` carrying all prior issue and review facts, and continues execution seamlessly.

## Trust Boundary & Security

- **Authenticated Browser Context**: Runs entirely inside the operator's authenticated browser session. No ChatGPT login credentials or cookies are transferred to Symphony Core.
- **Loopback Bridge Boundary**: Communicates with `symphony decision bridge` exclusively via `127.0.0.1` protected by bearer token authentication and origin validation (`--allowed-origins https://chatgpt.com`).
- **Credential DOM Isolation**: The bridge bearer token is stored exclusively in Tampermonkey's private storage (`GM_setValue`) and memory closure. It is never placed into any page DOM element, attribute, or property, preventing third-party page scripts from accessing bridge credentials.
- **Fail-Closed Result Verification**: Extracted results must be enclosed in ````symphony-result` blocks and strictly adhere to task revision and commit HEAD SHA identity. Stale or mismatched outputs are rejected.

## Automatic continuity and blocking

Start persists enabled intent per bridge URL in userscript storage. A configured ChatGPT page automatically starts after reload or browser reopen; Stop persists disabled intent, including for later pages. Concurrent tabs retain separate checkpoints and cannot take over a live lease. Losing tab identity does not authorize importing another tab's token or resending an uncertain prompt. No OS browser launch or automatic login is provided. Browser reopen auto-start does not guarantee restoration of the original conversation or tab identity. If the browser reconstructs a fresh document/session identity, its per-tab checkpoint lookup cannot adopt the previous identity's lease. With the complete host and available authoritative sources, expired sent execution is conservatively blocked for operator inspection. A standalone Bridge does not run that recovery policy. See [process-boundary evidence](../../docs/evidence/execution-continuity/agent-browser-acceptance-2026-10-23.md).

Navigation and Send await an authoritative lease/binding check. Progress requires an advanced execution stage or growth in the new assistant response, with a ten-minute deadline. Native reclaim/rebind budgets persist across claims and restarts; transport recovery is additionally capped at six checkpoint failures. Receipt lookup still resolves accepted-but-unacknowledged results before budget handling. Auth/human barriers, inaccessible-session exhaustion and ambiguous lost execution become durable blocked facts. Bridge 401/403 stops mutations but retains enabled intent and periodically checks authorization through read-only requests. Stop cancels that recovery.

Use the [Decision protocol](../../docs/decision-protocol.md#decisionweb-execution-facts) to inspect a blocked task and explicitly authorize recovery after checking the cause and possible prior effects. A browser with no runnable page is a host-visible browser-page wait, not a reason to silently restart coding. Fixture tests cover the native boundaries; real Tampermonkey/browser restart acceptance is separate.

### Response waiting deadline

Plan/Review and bootstrap response waits default to 15 minutes. The HUD's **Response timeout (minutes, 1–60)** is saved in Tampermonkey storage when Start is clicked and restored after reload; Stop/Start applies edits. This setting also applies when recovering an existing in-flight response. Navigation and composer waits retain their 3-minute default. Programmatic adapters accept `responseTimeoutMs`; an explicitly supplied legacy `timeoutMs` remains the fallback for compatibility. This does not extend the host delivery budget or revive failed tasks; the host's progress deadline can block execution first when no qualifying progress is observed. Rebuild and reinstall `dist/symphony-decision-driver.user.js` to update an installed driver.

### Response recognition and diagnostics

Userscript 0.1.6 shows the installed version in the HUD. When no local checkpoint or
claimable task exists, idle polls read the Bridge's read-only continuity facts.
When the Bridge has an `authToken` configured, these requests require Bridge Bearer
authentication; no task lease credentials are exposed or adopted. In the HUD,
unfinished owned tasks show **Waiting** with an explicit no-checkpoint instruction;
native execution blocks show **Blocked**, task ID, reason and inspection instruction.
Terminal history is ignored and the message clears when no unfinished work remains.
Polling remains enabled so fresh tasks can still be received; Stop stays available.
This status observation neither adopts another tab's lease nor triggers recovery.

The driver merges supported assistant message selectors and deduplicates nested nodes. Plan/Review can complete even when DOM windowing reduces the message count, but only the latest canonically validated result for the exact task/revision/target may bypass count growth. A result already present before a fresh send cannot qualify through that fallback. Bootstrap replies retain count/identity fencing. Streaming and stabilization checks remain required.

Expand **Driver diagnostics (last 50 events)** in the HUD to distinguish response waiting, result submission, accepted receipt, submission errors, and recorded task failures. Wait entries include baseline/current counts, the selected selectors, exact-task match, stop-button presence, elapsed time and the terminal blocker. These per-tab records survive refresh in Tampermonkey storage; only metadata is retained, with no Token, prompt/reply text or raw exceptions. Existing failed tasks are not automatically revived.

Heartbeat progress and response waiting share a task-scoped observer. After DOM windowing, a new eligible assistant node must show append growth while generating; static count changes, pre-send messages and route drift do not advance progress. A restored sent checkpoint similarly observes growth on its current response. Strict exact-task results also confirm Send during prompt-submission recovery, without another click. Response snapshots remain in memory; no response text is added to diagnostics or checkpoints.

The metadata declaration is emitted only when bundling. Running Vitest does not modify the built userscript; repeated builds retain a single declaration.
