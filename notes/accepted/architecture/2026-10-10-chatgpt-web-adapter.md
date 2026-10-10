# Agent Note: ChatGPT Web executor adapter and Tampermonkey decision driver
Status: accepted

## Problem

Following the Decision Plane domain contracts (GitHub #94 / NEST-99), durable store/bridge (GitHub #95 / NEST-100), and executor adapter abstraction (GitHub #96 / NEST-101), the next requirement is a concrete executor adapter for ChatGPT Web (GitHub #97 / NEST-102).

Executing Decision tasks within ChatGPT Web presents several operational and architectural challenges:
1. **Browser Runtime Constraints**: ChatGPT Web runs within a browser context on `https://chatgpt.com`. Interacting with a localhost service (`http://127.0.0.1:4545`) is subject to cross-origin resource sharing (CORS) security restrictions.
2. **DOM Volatility & Streaming**: ChatGPT Web UI selectors and DOM structures evolve frequently. Assistant answers stream progressively via Server-Sent Events, necessitating robust stabilization detection before extracting results.
3. **Session Continuity & Rollover**: A single issue lifecycle spans multiple sequential tasks: Plan → Review SHA-A → Review SHA-B. The executor must maintain conversation continuity across reviews while supporting graceful broken-binding rollover (generation N → N+1) with durable context handoff if a conversation expires or becomes corrupted.
4. **Task Context Delivery**: Tasks require provider-neutral context (issue details, PR metadata, diffs, previous reviews). This context must be stored and fetched through the bridge without embedding browser-specific data into core Symphony contracts.
5. **Lease Safety & Mutual Exclusion**: In multi-tab or concurrent scenarios, only one active driver should execute tasks for a given session at a time, and binding updates must be fenced by the active task lease.

## Decision

We introduce `@symphony/chatgpt-web` and extend `@symphony/decision` with provider-neutral context storage and lease-fenced updates:

1. **Provider-Neutral Task Context Bridge**:
   - Extended `@symphony/decision` bridge and store with `PUT /v1/tasks/:id/context` and `GET /v1/tasks/:id/context`.
   - Stores `DecisionContextBundle` (`connector` or `materialized`) alongside task records, validated against task and session schemas.
   - The CLI bridge accepts `--allowed-origins` / `DECISION_BRIDGE_ALLOWED_ORIGINS` to configure allowed CORS origins for browser fetch clients.

2. **Session Mutual Exclusion & Lease-Fenced Bindings**:
   - `DecisionService.claimTask` enforces session mutual exclusion: if any other task in the session is currently claimed with an active, unexpired lease, subsequent task claims are rejected with `session_conflict` (409 Conflict).
   - `DecisionService.putBinding` and `rebindSession` accept optional lease credentials (`owner`, `token`, `generation`). If lease credentials are provided, binding updates verify lease validity, preventing stale or desynchronized drivers from mutating session bindings.
   - Sessions in `broken-binding` status can still claim tasks to allow the driver to trigger CAS rebind to generation N+1.

3. **`ChatGptWebAdapter` Implementation**:
   - Implements `DecisionExecutorAdapter` (`@symphony/decision/adapter`).
   - Centralizes prompt templates in `prompts.ts`:
     - Initial Plan prompt establishes reviewer guidelines, exact HEAD SHA review requirements, and ````symphony-result` JSON output contract.
     - Review prompt references previous work and enforces evaluation against the target head SHA.
     - Continuation headers maintain multi-turn context within the same conversation.
     - Handoff prompt summarizes prior plan and review findings when rolling over to a new conversation (N+1).
   - Implements DOM probes in `probes.ts` with selector fallback lists and streaming completion detection that verifies both the disappearance of the stop button and text stability.
   - Extracts machine-readable results via `extractResultFromAssistantTurn` using strict last-block fail-closed JSON parsing.

4. **`DecisionTabDriver` & Tampermonkey Bundle**:
   - Implements `DecisionTaskController` (`@symphony/decision/adapter`).
   - Polls and claims tasks via `BridgeTransport` (`GmBridgeTransport` using `GM_xmlhttpRequest` to bypass CORS, or `FetchBridgeTransport`).
   - Runs a periodic lease heartbeat timer during active task execution.
   - Persists execution checkpoints in `GM_setValue` / `sessionStorage` (`checkpoint.ts`) to enable seamless recovery across page reloads or navigations.
   - Bundles into a standalone userscript (`dist/symphony-decision-driver.user.js`) via Vite with a Tampermonkey metadata banner (`userscript-entry.ts`).
   - Injects a lightweight HUD overlay (`[Symphony Driver: Active]`) onto `https://chatgpt.com/*` with start/stop control.

5. **Multi-Turn and Rollover Verification**:
   - Full end-to-end integration fixture (`test/fixture-e2e.test.ts`) verifies the complete lifecycle: Plan → Review SHA-A → Review SHA-B on a single binding, followed by session invalidation and rebind rollover (N → N+1) with durable handoff context.

## Alternatives considered

- **Direct OpenAI API Executor**:
  - *Description*: Implement the executor via the OpenAI Platform API (`chat/completions` or `responses`) directly from Node.js instead of browser automation.
  - *Why rejected*: Users often have active ChatGPT Plus/Team/Enterprise subscriptions with custom GPTs or capabilities that do not share API billing. Furthermore, browser-based execution allows operators to inspect and interact with the live conversation in their browser window. The core Decision Plane protocol remains provider-neutral, allowing API-based adapters to be added later if desired.

- **Headless Browser Daemon (Playwright / Puppeteer)**:
  - *Description*: Run a headless Chromium instance managed by Symphony to log into and drive ChatGPT Web.
  - *Why rejected*: Headless automation frequently encounters Cloudflare bot-detection challenges, CAPTCHAs, and 2FA barriers. Managing user authentication credentials and session cookies inside Symphony processes also expands the security attack surface. A Userscript running inside the user's authentic, already-logged-in browser profile cleanly sidesteps bot-detection and avoids credential handling in Symphony.

- **Full Conversation History DOM Scraping**:
  - *Description*: Scrape the full conversation turn history from the DOM to reconstruct prior context.
  - *Why rejected*: ChatGPT Web DOM elements for past turns are dynamically virtualized and frequently change structure. Relying on DOM scraping across multiple turns is fragile. Instead, Symphony persists task context and review findings durably in `@symphony/decision`, allowing the adapter to format concise continuation and handoff prompts without depending on DOM history scraping.
