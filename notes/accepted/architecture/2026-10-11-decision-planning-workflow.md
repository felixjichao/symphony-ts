# Agent Note: Issue-Rooted Pre-Execution Planning Workflow in Decision Plane
Status: accepted

## Problem

Prior Decision Plane milestones (NEST-99 / #94 through NEST-103 / #98) established session binding, task leases, executor adapters, and SHA-bound post-implementation PR review gates. However, coding agents were dispatched directly without an agreed, verified implementation plan, risking wasted compute on misunderstood tasks, architectural deviations, or underspecified requirements.

To enable autonomous yet bounded implementation:
1. Issue eligibility for dispatch must require an accepted, current plan durably published to GitHub.
2. The Symphony Core scheduler must not implement a complex planning state machine; it consumes a simple allow/deny eligibility gate on dispatch.
3. GitHub remains the durable truth: planning state lives in the durable Decision Plane store, not solely in ChatGPT conversational memory.
4. Fail-closed verdicts: `needs_clarification`, `needs_human`, stale requirement fingerprints, or unpublished plans must strictly block dispatch.
5. Clarification cycles, plan revisions, implementation, and code review must reuse the same Issue-rooted `DecisionSession` and conversation binding.
6. When requirements change, previous approvals and reviews bound to old plans must be rejected even if the PR HEAD SHA has not changed.

## Decision

We introduce an Issue-rooted pre-execution planning workflow across the Decision Plane, Domain model, Config, Orchestrator, Agent, and CLI:

1. **Domain Contracts & Comment Protocol (`@symphony/domain`)**:
   - `PlanCommentMarker`: HTML comment marker protocol (`<!-- symphony:plan ... -->`) containing `{ taskId, revision, fingerprint }`.
   - Helper functions: `serializePlanCommentMarker`, `parsePlanCommentMarker`, `formatPlanCommentMarkdown`.
   - `PlanningEligibilityResult`: Discriminated union reporting `{ eligible: true, sessionId, verdict, fingerprint, publishedCommentId, plan }` or `{ eligible: false, sessionId, reason, verdict?, fingerprint? }`.
   - `DeliverySkillConfig.plan`: Propagates materialized plan to delivery skill and review context.

2. **Durable Store & Decision Service (`@symphony/decision`)**:
   - `DecisionPlanRecord`: Tracks planning lifecycle with schema version, `sessionId`, `taskId`, `revision`, `triggerKind` (`initial` | `requirements_changed` | `clarification` | `retry`), `requirements` (`title`, `body`, `clarifications`, `fingerprint`), `previousTaskId`, `status`, `result`, `publishedCommentId`, `publishedAtMs`.
   - `computeRequirementFingerprint`: Deterministic SHA-256 hash over canonical JSON `{ title, body, clarifications }`.
   - `DecisionService.createPlanTask`: Atomically creates `DecisionTask` and `DecisionPlanRecord`, superseding older active plan tasks for the session.
   - `DecisionService.verifyPlanEligibility`: Synchronously checks session existence, latest plan status (`completed`), verdict (`ready`), absence of unresolved clarifications, requirement fingerprint match, and published comment ID.
   - `DecisionService.createReviewTask`: Evaluates `context.plan`; if the plan taskId or revision changes, it refuses to reuse previous reviews or approvals and forces a new review revision.

3. **Planning Gate & Bridge Integration (`@symphony/decision`)**:
   - `DecisionPlanningGate`: Unified interface wrapping `DecisionService` (in-process) or `DecisionBridgeClient` (over HTTP). Exposes `ensurePlanTask`, `verifyPlanEligibility`, `markPlanPublished`, `getLatestPlan`, `formatPlanCommentMarkdown`, and `parsePlanCommentMarker`.
   - Decision Bridge HTTP endpoints: `POST /v1/plans/verify`, `POST /v1/plans/:taskId/publish`, `GET /v1/plans/:sessionId/latest`, and extended `POST /v1/tasks` for plan tasks.

4. **Orchestrator Dispatch Hook (`@symphony/orchestrator`)**:
   - Added `canDispatch?: ((issue: Issue, context: { readonly isRetry: boolean }) => boolean) | undefined` to `OrchestratorAuthorityOptions`.
   - Hooked into `dispatchIssue` and `on_retry_timer`: any issue lacking an accepted and published plan is held as `not_eligible` and does not claim or dispatch workers.

5. **Prompt Rendering & Agent Context Wiring (`@symphony/config`, `@symphony/agent`)**:
   - Injected `plan` into Liquid template rendering context with both snake_case and camelCase access (`plan.plan`, `plan.task_id`, `plan.revision`, `plan.acceptance_criteria`, `plan.risks`, `plan.clarifications`).
   - `AgentAttemptOptions` accepts `plan?: DecisionMaterializedPlan | null | undefined` and passes it to `renderPrompt`.
   - `runDeliverySkill` populates `reviewContext.plan` from `options.plan`.

6. **CLI Subcommand & Host Integration (`apps/cli`)**:
   - Added `symphony plan <start|clarify|replan|retry|status|sync>` subcommand.
   - Wires `canDispatch` and plan resolution into `createHost` and `WorkspaceLifecycleCoordinator`.
   - `delivery-skill-cli` queries planning gate when bridge is configured to inject the verified plan.

## Alternatives Considered

- **Embedding full planning workflow state machine in Symphony Core scheduler**:
  - *Alternative*: Manage planning tasks, clarifications, and approval transitions inside `OrchestratorLoop` and `OrchestratorAuthority`.
  - *Why rejected*: Symphony Core scheduler is designed as a minimal, robust execution worker dispatcher (SPEC §7/§8). Introducing LLM interactive conversational planning states into Core would bloat scheduling invariants and violate separation of concerns. Instead, Core consumes a synchronous `canDispatch` predicate, while planning lifecycle is managed by the Decision Plane.
- **Relying solely on ChatGPT conversation memory without GitHub sync**:
  - *Alternative*: Assume the ChatGPT web session retains the plan, and dispatch implementation without writing the plan back to GitHub.
  - *Why rejected*: ChatGPT conversation contexts can experience tab eviction, browser restart, or broken bindings. Without a durable copy on GitHub, human reviewers have no record of the agreed plan, and rollover recovery cannot reconstruct requirements.
- **Manual operator approval for every ready plan**:
  - *Alternative*: Require a human operator to run `symphony plan approve` even when the Planner returns `ready`.
  - *Why rejected*: Confirmed design decision with workspace owner: when Planner returns `ready` with empty clarifications, the plan is accepted automatically; once written to GitHub and matching current requirements, execution dispatch proceeds autonomously.

## Consequences

- Issues cannot be dispatched for implementation unless a plan with verdict `ready` has been created, verified, and durably written back to GitHub.
- If requirements in the issue change, the fingerprint mismatch immediately blocks further dispatch and review until replanning completes.
- The entire Issue lifecycle (planning, clarifications, implementation, and code review) shares the same `DecisionSession` and ChatGPT conversation binding.
- All 6 critical regression paths are verified:
  1. Issue → PlanTask → `ready` → durable plan → eligible for dispatch.
  2. `needs_clarification` → blocks dispatch → clarification loop in same session.
  3. `needs_human` → handoff, blocks dispatch.
  4. ChatGPT Web plan → later ReviewTask resumes same binding.
  5. Conversation binding lost → rollover reconstructs context from durable plan.
  6. Requirements change → new plan revision becomes current, review receives current plan.
