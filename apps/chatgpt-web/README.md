# @symphony/chatgpt-web

ChatGPT Web Decision Executor Adapter & Tampermonkey Decision Driver for Symphony Decision Plane.

## Overview

`@symphony/chatgpt-web` implements the first concrete `DecisionExecutorAdapter` for Symphony. It drives a ChatGPT Web browser session via a Tampermonkey userscript connected to the localhost Web Agent Bridge (`symphony decision bridge`).

This enables automated Plan and Review execution directly within ChatGPT Web while maintaining strict lease fencing, generation tracking, and fail-closed result verification.

## Architecture

- **`ChatGptWebAdapter`** (`src/adapter.ts`): Implements `DecisionExecutorAdapter` (`@symphony/decision/adapter`). Manages conversation handles, constructs task prompts (Plan / Review / Handoff), injects text into the ChatGPT composer, awaits streaming completion, and extracts `symphony-result` JSON payloads.
- **`DecisionTabDriver`** (`src/driver.ts`): Implements `DecisionTaskController` (`@symphony/decision/adapter`). Runs inside the ChatGPT Web tab, polls and claims tasks from the local bridge, maintains active leases with regular heartbeats, coordinates CAS rebinds, and manages recovery checkpoints.
- **DOM Probes** (`src/probes.ts`): Centralized DOM selectors for composer input, send/stop buttons, streaming indicators, turn extraction, and URL conversation ID parsing with defensive fallbacks across ChatGPT UI revisions.
- **Transports** (`src/transport.ts`):
  - `GmBridgeTransport`: Uses `GM_xmlhttpRequest` for cross-origin loopback requests bypassing browser CORS limitations.
  - `FetchBridgeTransport`: Standard `fetch` transport for environments where native CORS is permitted.
- **Checkpoint Recovery** (`src/checkpoint.ts`): Durable checkpoint persistence using `GM_setValue` / `sessionStorage` ensuring safe resumption across tab reloads and navigation.
- **Userscript Entrypoint** (`src/userscript-entry.ts`): Injects an interactive HUD control overlay onto ChatGPT Web (`https://chatgpt.com/*`), mounts the driver, and handles start/stop lifecycle.

## Building the Userscript

To compile the TypeScript source and generate the standalone Tampermonkey userscript bundle:

```bash
npm run build -w @symphony/chatgpt-web
```

The compiled bundle is output to:
```
apps/chatgpt-web/dist/symphony-decision-driver.user.js
```

The bundle includes the complete Tampermonkey metadata block (`// ==UserScript==`) specifying matching rules for `https://chatgpt.com/*` and granting `GM_xmlhttpRequest`, `GM_setValue`, and `GM_getValue`.

## Trust Boundary & Security

- **Authenticated Browser Context**: Runs entirely inside the operator's authenticated browser session. No ChatGPT login credentials or cookies are transferred to Symphony Core.
- **Loopback Bridge Boundary**: Communicates with `symphony decision bridge` exclusively via `127.0.0.1` protected by bearer token authentication and origin validation (`--allowed-origins https://chatgpt.com`).
- **Fail-Closed Result Verification**: Extracted results must be enclosed in ````symphony-result` blocks and strictly adhere to task revision and commit HEAD SHA identity. Stale or mismatched outputs are rejected.
