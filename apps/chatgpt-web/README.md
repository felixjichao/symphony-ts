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
3. **Start the Bridge with Authentication**:
   Start the localhost decision bridge with a designated bearer token:
   ```bash
   symphony decision bridge \
     --port 4040 \
     --auth-token "secret-bridge-token" \
     --allowed-origins "https://chatgpt.com"
   ```
4. **Configure Token & Bridge URL in HUD**:
   - Navigate to `https://chatgpt.com/`.
   - The "Symphony Decision Driver" HUD will appear in the bottom-right corner.
   - Enter `http://127.0.0.1:4040` into the Bridge URL input.
   - Enter `secret-bridge-token` into the Bearer Token input.
   - Click **Start Driver**. The status will switch to `● Running` and poll for tasks.
   - The token and bridge URL are automatically persisted via `GM_setValue`.

## Execution & Smoke Walkthrough

### 1. Plan Task Execution
- Symphony schedules a `plan` task on the bridge for a session (e.g. `github:owner/repo#1`).
- The userscript claims the task, verifies that no existing conversation is bound, navigates to a new chat, submits `BOOTSTRAP_PROMPT`, awaits response, records the new conversation reference (`/c/<id>`), and stores the binding.
- It then formats and submits the `plan` prompt, awaits completion of the new turn, extracts the structured ````symphony-result` payload (verifying `schemaVersion: 1`, `verdict: "ready"`, and content nesting), and submits the result to the bridge.

### 2. Review Task Execution & Session Continuity
- Symphony schedules a subsequent `review` task for the same session.
- The userscript inspects the session binding, verifies that the existing conversation is authoritative, navigates to that conversation URL (`/c/<id>`), and submits the continuation prompt with the current PR and expected HEAD SHA.
- It extracts the `review` result and submits it to the bridge.

### 3. Navigation & Checkpoint Recovery
- If the browser tab reloads or navigates during execution, `GmCheckpointStore` retains the active state scoped to the tab (`claimed`, `started`, `waiting_response`, or `result_extracted`).
- On restart, `resumeCheckpointIfAvailable()` validates tab identity, checks lease validity with `/heartbeat`, verifies receipt existence, and recovers idempotently without duplicate `/start` calls or prompt re-submission.

### 4. Broken Binding & Rollover
- If an existing conversation is deleted or returns 404, the session transitions to `broken-binding`.
- On next task claim, `inspectBinding()` detects `unusable` with `needsRebind: true`.
- The driver creates a new conversation, executes CAS rebind with `expectedGeneration`, delivers the `formatHandoffPrompt` carrying all prior issue and review facts, and continues execution seamlessly.

## Trust Boundary & Security

- **Authenticated Browser Context**: Runs entirely inside the operator's authenticated browser session. No ChatGPT login credentials or cookies are transferred to Symphony Core.
- **Loopback Bridge Boundary**: Communicates with `symphony decision bridge` exclusively via `127.0.0.1` protected by bearer token authentication and origin validation (`--allowed-origins https://chatgpt.com`).
- **Fail-Closed Result Verification**: Extracted results must be enclosed in ````symphony-result` blocks and strictly adhere to task revision and commit HEAD SHA identity. Stale or mismatched outputs are rejected.
