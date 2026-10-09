# Agent Note: Decision executor adapter abstraction and context strategies
Status: accepted

## Problem

Following the Decision Plane domain protocol (GitHub #94 / NEST-99) and durable store/bridge (GitHub #95 / NEST-100), the next requirement is connecting Decision tasks to concrete execution engines (such as Web ChatGPT, browser-based LLM sessions, or external LLM APIs).

However:
1. **Separation of Concerns**: Core Symphony and `@symphony/domain` must not contain browser automation, DOM selectors, session cookies, or web chat protocol details.
2. **Context Delivery Differences**: Different execution environments require fundamentally different context strategies:
   - *Connector strategy*: Web-native agents with browser access already have access to GitHub web pages; they only need references (issue URL, repository, PR number, target commit SHA).
   - *Materialized strategy*: Direct API or self-contained models cannot browse the web independently; they need full materialized context (issue description, implementation plan, PR metadata, git diff, CI status, instructions, prior reviews).
3. **Unstructured Output Extraction**: Web chat agents produce mixed conversational text, markdown, and self-correction thoughts. We need a machine-readable, fail-closed result protocol that guarantees unambiguous extraction of `DecisionPlanResult` and `DecisionReviewResult`.
4. **Browser Runtime Safety**: Adapters running inside browser userscripts (e.g. Tampermonkey) or WebExtension content scripts cannot import Node built-in modules (`node:fs`, `node:path`, `node:http`, `node:crypto`).
5. **Lifecycle Diagnostics**: Failures such as CAPTCHA challenges, broken sessions, model refusals, or context size limits must be classified with structured diagnostic error codes.

## Decision

We introduce the executor adapter boundary and context strategy contracts across `@symphony/domain` and `@symphony/decision`:

1. **Adapter Interface (`DecisionExecutorAdapter`)**:
   - `inspectBinding(session, options)`: Inspects existing binding credentials for validity.
   - `createSession(session, options)`: Creates an external conversation/session and returns binding metadata (`adapter`, `externalSessionRef`, `resumeUri`).
   - `resumeSession(session, binding, options)`: Revalidates or recovers an existing session with live binding.
   - `executeTask(request, options)`: Executes a plan or review task with the bound executor and provided context strategy.
   - `normalizeResult(rawResult, task)`: Optional hook to normalize model output into a typed `DecisionResult`.

2. **Context Strategies (`DecisionContextBundle`)**:
   - **`connector` strategy** (`DecisionConnectorContext`): Minimal pointer bundle containing `workItem` (`{ provider, key }`), `repository`, `prNumber` (`number | null`), and `headSha` (`string | null`). Used when the executor navigates GitHub directly.
   - **`materialized` strategy** (`DecisionMaterializedContext`): Explicitly bundled markdown artifacts containing `workItem` (`{ provider, key }`), `repository`, `issue` (`{ repository, number, title, body }`), nullable `plan`, nullable `pullRequest`, nullable `diff`, nullable `ci`, nullable `repositoryInstructions`, `previousReviews`, and `unresolvedFindings`.
   - Context is packaged inside `DecisionExecutionRequest { task, session, context }`, keeping `DecisionTask` records lightweight and strictly versioned.
   - Strict work-item validation enforces that `context.workItem` matches `session.root`, GitHub repository/issue numbers match the session root, and review targets match the context repository.

3. **Machine-Readable Result Extraction**:
   - Fenced code block: ````symphony-result` containing valid JSON representing `DecisionPlanResult` or `DecisionReviewResult`.
   - **Strict Last-Block Rule**: If multiple `symphony-result` blocks appear in the output (e.g. model self-correction), only the LAST block is evaluated.
   - **Fail-Closed Semantics**: If the last block is missing, unclosed, contains malformed JSON, or fails schema validation, extraction immediately throws `DecisionAdapterError`. It NEVER falls back to earlier valid blocks.
   - **Identity Verification**: Extracted result must match `task.id`, `task.sessionId`, `task.revision`, and for reviews `task.target` (repository, PR number, and full 40-char head SHA). Specific error codes (`revision_mismatch`, `target_mismatch`, `task_mismatch`) are reported.

4. **Structured Error Diagnostics & Bounded Whitelisting (`DecisionAdapterErrorCode`)**:
   - `malformed_output`: Missing or invalid `symphony-result` JSON.
   - `task_mismatch`: Result taskId/sessionId does not match claimed task.
   - `revision_mismatch`: Result revision does not match task revision.
   - `target_mismatch`: Result target does not match task review target.
   - `binding_broken`: Executor session invalid, expired, or disconnected.
   - `execution_failed`: Underlying execution aborted or encountered unrecoverable runtime errors.
   - `human_required`: Executor encountered human intervention barrier (e.g. CAPTCHA, 2FA, login screen, account rate limits).
   - `unsupported_strategy`: Executor adapter does not support the requested context strategy.
   - `unsupported_task_kind`: Executor does not support plan or review tasks.
   - `cancelled`: Execution cancelled via abort signal.
   - **Safe Bounded Diagnostics**: Parser error messages and persisted `rawDetails` never embed raw fenced content or model transcripts; metadata is strictly filtered to bounded scalar fields (`errorName`, `contentLength`, `reason`, expected/actual identity pairs) preventing sensitive token leakage into durable failure receipts.

5. **Browser-Safe Distribution**:
   - Entry point `@symphony/decision/adapter` contains zero `node:*` built-in dependencies. Browser extensions or userscripts can import extractor, fake adapter, and types directly.

6. **Deterministic Verification Harness**:
   - `FakeDecisionExecutorAdapter` supports simulated execution, configurable results, custom handlers, and error injection for testing without network or browser dependencies.

## Alternatives considered

- **Persisting Context Bundles inside `DecisionTask` records**:
  - *Why rejected*: `DecisionTask` is an immutable, strictly validated domain record persisted in `store.json`. Persisting large git diffs, file trees, or prompt templates inside task records would significantly inflate storage, create serialization bottlenecks, and leak transient execution details into durable state. Ephemeral execution requests pass context directly to `executeTask`.
- **First-Valid-Block Extraction vs. Last-Block Extraction**:
  - *Why first-valid-block was rejected*: When LLMs reflect or self-correct in a single output stream, earlier blocks represent superseded drafts. Taking the first block would act on uncorrected decisions. Falling back from an invalid last block to an earlier block would risk acting on discarded reasoning. Failing closed on an invalid last block preserves safety.
- **Provider-Native Tool Calling vs. Markdown Fenced Blocks**:
  - *Why provider-native tool calling was rejected*: The primary external executor target is Web ChatGPT and web chat interfaces operated via browser automation or userscripts. These interfaces operate purely over markdown chat streams without access to OpenAI Function Calling APIs. The ````symphony-result` fenced code block is universally compatible across web chat, API models, and local models.

## Consequences

- Decision tasks can be executed against any adapter implementing `DecisionExecutorAdapter`.
- Web ChatGPT adapter development can proceed independently without altering Core domain or orchestration code.
- Both connector-based (web navigation) and materialized (bundled artifacts) workflows are cleanly supported.
- Browser-safe subpath `@symphony/decision/adapter` allows userscript builds without polyfill bloat.
