# 实现状态

本文件是本项目**开发进度与能力的唯一总览**：当前 posture、已完成能力、deferred / optional、下一阶段与历史里程碑。

- 面向使用者的安装 / 配置 / 运行指引见根 [README.md](../README.md)；
- SPEC 逐项 capability / validation 的权威矩阵仍是 [conformance.md](conformance.md)；
- 稳定架构、组件职责与依赖方向见 [architecture.md](architecture.md)。

## 当前 posture

- GitHub delivery：本地验证新增 `--validation-timeout`（默认 600 秒），覆盖首次及 CI/Review 修复后验证；独立于 CI 等待预算；超时配置随 continuation 持久化，host 重启恢复保持原值，旧记录使用默认值。

- 开发主线：`main`。当前最新里程碑提交为 `29840f9`（PR #133，Operational Read Model / Observation Plane query service 与集成验收收口）；GitHub Delivery MVP 的 dogfood 里程碑提交为 `e6f8e25`（PR #88）。
- **M0–M6 Core 已完成**：orchestrator authority 独占调度状态，默认 CI 覆盖 Core Conformance。
- **GitHub Delivery MVP 已完成并经真实验收**：从 issue 到自动合入并关闭 issue 的闭环可用。
- **Decision Plane extension（GitHub #93）已完成并经真实验收**：planning、SHA-bound review、repair/re-review、durable state、ChatGPT Web 执行与异常恢复均已通过真实环境验收；该扩展不改变 SPEC Core conformance，也不改变既有 GitHub Delivery 语义。
- **Operational Read Model extension（GitHub #108）已完成**：provider-neutral facts、只读 source readers、确定性 projectors、跨源 anomaly / explanation 与统一 in-process query service 已合入；只读 HTTP transport 由 #137 提供；Dashboard shell / Overview / Work list 由 #138 提供；Work Detail / evidence / anomaly / freshness diagnostics 由 #139 提供；只读生产装配与自动化/本地浏览器验收由 #140 完成；PR #165 已通过独立审查并合入 `main`（merge commit `8f7675e`，main CI run #344 通过），父任务 #136 的验收条件已满足；history / analytics / operator mutation 继续 deferred。
- **Execution Continuity extension（GitHub #145 / NEST-129）启动**：NEST-130 / GitHub #146 已完成 provider-neutral 契约、所有权防御（fencing）与故障分类共享语言（`packages/domain/src/execution-continuity.ts`）；NEST-138 增加工作级 stage/owner/progress 派生、host tick 扫描、Decision 过期租约原子回收及受互斥保护的 Delivery handoff 补偿；NEST-132 已补齐 Decision/Web continuity；NEST-133 增加跨重启 native handoff、retry 预约与不确定 executor 的持久化阻塞，等待独立审查；NEST-134 增加有限恢复策略、持久化 incident 和 CLI/GitHub 报告，等待独立审查。
- **M7 §15 hardening 未开始**。
- 尚无正式 npm 发布；安装形态为源码 checkout + `npm run build`。
- 不宣称整个 SPEC 或所有 provider 场景完成——见 [deferred / optional](#deferred--optional)。

## Decision Plane extension


本扩展是 §4（domain contracts）旁的 provider-neutral extension（GitHub #93 / NEST-98），不是上游 Symphony SPEC Core requirement，不改变 SPEC Core conformance，也不改变既有 GitHub Delivery 语义；逐项能力与证据矩阵见 [conformance.md](conformance.md#decision-plane-extension-evidence-nest-99--94-nest-100--95-nest-101--96-nest-102--97-nest-103--98--nest-104--99)。

- GitHub #94–#99（NEST-99–NEST-104）全部完成并已合入 `main`：`100c570`（#94 / NEST-99 契约）、`a0a6ecf`（#95 / NEST-100 存储与 Bridge）、`3760812`（#96 / NEST-101 adapter 抽象）、`73f055c`（#97 / NEST-102 ChatGPT Web adapter）、`314d05c`（#98 / NEST-103 review gate）、`a9d114c`（#99 / NEST-104 planning workflow）。
- NEST-99 / GitHub #94: provider-neutral v1 contracts, strict runtime validation and pure task/session/lease/binding transitions in `@symphony/domain`. Exact HEAD approval and supersession have unit evidence; [protocol](decision-protocol.md) defines persistence boundaries.
- NEST-100 / GitHub #95: durable task/session snapshot store, single-writer process lock (`store.lock`), lease coordination, and localhost Web Agent Bridge HTTP server in `@symphony/decision` and `symphony decision bridge` in `@symphony/cli`.
- NEST-101 / GitHub #96: executor adapter abstraction (`DecisionExecutorAdapter`), context strategies (`connector` vs `materialized`), machine-readable result extraction (````symphony-result` fenced JSON blocks with fail-closed last-block parsing), browser-safe entrypoint `@symphony/decision/adapter`, and deterministic `FakeDecisionExecutorAdapter`.
- NEST-102 / GitHub #97: ChatGPT Web concrete executor adapter (`ChatGptWebAdapter`), Tampermonkey tab driver (`DecisionTabDriver`), multi-turn Plan → Review SHA-A → Review SHA-B execution, broken-binding rollover (N → N+1) with durable handoff in `apps/chatgpt-web`, provider-neutral context API (`PUT/GET /v1/tasks/:id/context`), session mutual exclusion, and lease-fenced binding updates in `@symphony/decision`.
- NEST-103 / GitHub #98: SHA-bound independent review gate before auto-merge in `@symphony/domain` (`DeliveryReviewGate`), `@symphony/decision` (`DecisionReviewGate`), `@symphony/tracker` (`landPr` review verification), `@symphony/agent` (`runDeliverySkill` Phase 6 review gate loop, polling, HEAD invalidation, findings repair), and `@symphony/cli` (`symphony delivery-skill run` and `symphony pr land` review gate options).
- NEST-103 real integration follow-up (2026-10-10): isolated dogfood #18 / PR #19 completed SHA-A CI → real changes_requested → real Codex repair SHA-B → SHA-B CI/approve → automatic merge and restart-observed workspace cleanup. The run required host-side sandbox recovery, JSON redaction and repair deadline fixes, and manual Driver Start. [Evidence](evidence/nest103/README.md) retains interventions and root gate failures; product PR review/merge remains pending.
- NEST-105 real-account smoke (2026-10-10, Edge/Tampermonkey): authenticated GM loopback transport, claim, automatic bootstrap/Plan submission and conversation binding verified. Real `felixjichao/symphony-delivery-dogfood#15` Plan revisions 2 and 3 completed with accepted `ready` result receipts. Revision 3 was reloaded while the stop button was visible and recovered after manual **Start Driver**; user message count stayed at four before/after reload and completion, proving no duplicate submission. Full navigating checkpoint recovery also passed with manual Start after page replacement. Local fixes wait for send-button readiness, support current Chinese labels/markdown/code surfaces, and ignore intermediate prose completion candidates (60 Web tests pass). Context must be delivered before starting the driver; implementation/review delivery was subsequently covered by the NEST-103 / NEST-104 dogfood runs and the GitHub #120 real-environment acceptance below.
- NEST-104 / GitHub #99: Issue-rooted pre-execution planning workflow in the Decision Plane. Reuses same `DecisionSession` and ChatGPT Web conversation binding, enforces fail-closed eligibility gate (`DecisionPlanningGate`, `verifyPlanEligibility`), durable sync via `<!-- symphony-plan-marker ... -->` comment markers with full GitHub verification and crash recovery, host authority dispatch hook (`canDispatch`), agent prompt injection (`{{ plan.plan }}`), delivery skill context propagation and review gate requirement verification, and `symphony plan` CLI commands (`start`, `clarify`, `replan`, `retry`, `status`, `sync`).
  - Verified by service/store integration tests (`packages/decision/src/planning-workflow.test.ts`) and production-entry tests: dispatch gate wiring (`apps/cli/src/host.test.ts`), publish verification and bridge-cache freshness (`apps/cli/src/planning-cli.test.ts`, `packages/decision/src/planning-gate.test.ts`), and fail-closed negative cases (stale bridge cache, answered-clarification fingerprint, unreadable Issue requirements, inconsistent published comment, omitted review requirements). The bridge sync lookups now query the authoritative state before every dispatch instead of caching.
  - Live dogfood (2026-10-11): real issue [`symphony-delivery-dogfood#20`](https://github.com/felixjichao/symphony-delivery-dogfood/issues/20) → merged [`PR #21`](https://github.com/felixjichao/symphony-delivery-dogfood/pull/21). Verified end to end: `PlanTask` rev1 → `plan sync --publish` → host gate dispatch → real Codex implementation → GitHub CI (`e24c7585e4f98f379d9e8739bdbd6aba7ff8b749`, conclusion `success`) → same-session exact-HEAD Review approve (rev2) → production delivery skill auto squash-merge (merge commit `2525eb4412f24601226a1efbd539f8a697b14980`) → issue closed → restart-time terminal workspace cleanup. Plan and Review share the Issue-rooted `DecisionSession` and ChatGPT conversation `6acb6a38-a5fc-83ea-9a4f-8580f0e510fc` (generation 1); the Review context carried the published plan. Read-back facts, provenance and pending store/log exports: [evidence](evidence/nest104/README.md).
  - Documented human interventions in that run: a stale-budget resume stopped and a fresh bounded attempt was opened; an accidentally committed archive file was removed through the production delivery entry; a superseded Review caused a Driver `Cannot fail superseded task` stop requiring manual restart, and the stale result was not accepted — only the new HEAD's independent approve allowed the merge.
  - NEST-118 code fix (2026-10-11): the supersede race no longer stops the driver. `DecisionTabDriver` resolves a `409` result/failure rejection by re-reading the authoritative task status and, when the task is `superseded`/`cancelled`, drops the checkpoint and continues polling with a terminal `superseded` outcome (new `TaskExecutionSupersededOutcome`); the userscript stops only on 401/403 auth errors. Contract unchanged: the bridge still rejects stale submissions and nothing is recorded for the raced execution. Covered by new driver tests (V1); the real-environment re-verification in a browser + bridge + delivery run passed under GitHub #120 on 2026-10-12 (dogfood PR #25), where the superseded result was rejected and the driver continued to the latest task without a manual Start.
  - GitHub #120 real-environment acceptance (operator environment, real Edge + Tampermonkey + ChatGPT Web, 2026-10-12 ~ 2026-10-14) closed the previously unexercised branches:
    - `needs_clarification` (dogfood #22) and `needs_human` recovery (#23): a real `needs_clarification` / `needs_human` PlanTask blocked dispatch; after clarification / human decision the next revision returned `ready` and was published with plan status Eligible.
    - requirements-changed replan (dogfood #24): changed Issue requirements invalidated the old plan fingerprint and made it undispatchable; a new PlanTask revision was published and the following ReviewTask used it.
    - superseded ReviewTask recovery (dogfood PR #25): the superseded task's stale result was not accepted by the bridge and the driver continued to the latest task without a manual Start; the new HEAD received `approve`.
    - lost/unavailable conversation binding rollover (see the final acceptance below).
  - Rollover final acceptance (2026-10-14, PR #128, `main` = `afb29ab`): an inaccessible conversation was detected automatically; the binding advanced generation 1 → 2; the stale claim/lease was fenced; the original task was reclaimed under claim generation 2, completed and submitted its result receipt — with no manual re-Start, refresh or other intervention.
  - Earlier failed / partial attempts are retained as provenance only: PR #125 / #126 left the task at `execution_failed` with the binding still on generation 1, PR #127 restored access-denied / conversation-not-found detection and execution-time route verification, and PR #128 added signal snapshotting so a stale denial UI from the old conversation can no longer fail the new session's bootstrap. PR #107 is merged into `main` (`a9d114c`).
  - NEST-119 (2026-10-12) triaged the macOS local `npm run gate` failures on the `agent` / `workspace` timeout-cleanup suites and fixed the Linux-verifiable causes: the agent `before_run` / `after_run` fixture now separates their timeout budgets (fixture/timing, not a missing runner lifecycle step); the workspace bootstrap process-lifecycle tests build the CLI from current source instead of a broken bare-node fallback and assert typed errors. After review proved the snapshot-freeze cleanup racy (a descendant can `fork + exit` between the snapshot and its signal and reparent outside any observed subtree), the process model was changed per the adjudicated A-revised plan: each git operation runs in an **independent process group** (`detached`), termination uses `kill(-pgid)` (atomic for every member still in the group, including forked-then-reparented descendants), and ownership is held at creation time — direct calls hold the `ChildProcess`/PGID handle in-process; inside workspace hooks a per-hook `GitOperationSupervisor` (Unix socket IPC) serializes creation + registration before granting start permission, retains registration after requester exit, and the outer hook timeout stops accepting, terminates the held git groups and the hook group, and confirms within a unified bound (unconfirmed cleanup is reported as an explicit diagnostic, never claimed as success; communication failure refuses startup instead of silently degrading). The root `close` never settles the promise, and the typed `git_command_timeout` is surfaced only after a bounded exit-confirmation window (never success). A second review round fixed two remaining gaps: a root's natural `close` no longer releases ownership of a group with runnable members (scan-confirm on close; non-empty/unconfirmed groups stay registered and are cleaned by requester disconnect, `terminateAll` or `dispose` with a PID/PGID-reuse guard; the direct path confirms emptiness before success and fails typed otherwise), and non-Linux group queries treat pgrep exit 1 (no match) as a successful empty result. A third review round unified the close/timeout settle ownership in the direct path: taking over cleanup on close stops the pending timeout timer and re-checks `timedOut` after every await, so a triggered timeout is never overwritten by a late success; the timeout teardown reuses the close event instead of re-registering a listener that can never fire. Linux package suites and `npm run gate` are green. **macOS host acceptance completed on 2026-10-12** at PR #121 code commit `e16cbaa`: agent 208/208, workspace 168/168, and full `npm run gate` passed (one skipped test in `@symphony/chatgpt-web`). Durable command logs and the three timeout cases' PID/PPID/PGID/state, signal, stderr, and exit evidence are in [acceptance evidence](evidence/nest119/README.md).
  - NEST-121 / GitHub #122 (2026-10-12): Hardened binding rollover recovery and stale-task fencing for the Decision Plane. `executeTaskWithAdapter` in coordinator wraps `resumeSession` to recover broken bindings when `err.suggestedAction === "rebind"`; store transitions active uncompleted claims to `pending` upon rebind and fences stale leases against new `bindingGeneration` (returning HTTP 409 Conflict for outdated start/heartbeat/submit calls); and `apps/chatgpt-web` persists driver run state in `sessionStorage` (`symphony_driver_enabled`) across tab reloads/navigation, clearing only on operator stop or 401/403. Bootstrap checkpoint recovery (`bootstrap_submitting` / `bootstrap_waiting`) additionally requires the attempt's own recorded created conversation: the first conversation route the send produces is persisted as `targetConvId` while the reply streams, only while the attempt is live (a cancelled attempt never completes the reference from a post-cancellation route), that reference is immutable for the attempt (a later route is a deviation, never a re-definition), and it is re-verified when the wait is cancelled and after the reply is read before any binding. A matching bootstrap prompt is not attempt-unique and is never accepted as evidence. Without that recorded reference, on route deviation, recovery fails closed as non-retryable `human_required` instead of reading a reply, binding, or re-sending; recovery failures also keep their Decision-protocol classification (typed `human_required` / `binding_broken` stay non-retryable with their suggested action, only ordinary wait/network errors remain retryable `execution_failed`). Real-browser acceptance of the rollover scenarios was completed under GitHub #120 on 2026-10-14 (see the rollover final acceptance above).
  - NEST-120 / GitHub #122 follow-up (2026-10-13): Resolved navigating checkpoint infinite loop and bootstrap temporary route isolation for ChatGPT Web browser automation (SPEC §17). `DriverCheckpoint` persists `navigationAttempts` (retry counter), `navigationStartedAtMs`, and `navigationDeadlineMs` across document reconstitutions; `resumeCheckpointIfAvailable` checks target not-found UI (`detectConversationNotFound`) and navigation attempt limits (`maxNavigationAttempts`, default 3) to converge unrecoverable sessions into an automated rebind (`rebindUnrecoverableSession`, rolling over generation N → N+1) rather than looping indefinitely. `ChatGptWebAdapter.createSession` and `probes.ts` distinguish client temporary routes (`/c/local-chatgpt`, `local-*`, `temporary`, `temp-*`) from canonical backend UUIDs (`extractFormalConversationIdFromUrl`), capturing only formal conversation references while strictly preserving immutable association and fail-closed protections. `@symphony/decision/adapter` exports `DecisionConflictError` directly to maintain zero Node built-in dependencies for browser-safe userscript bundles (~87 kB). Covered by comprehensive unit tests (`test/probes.test.ts`) and regression suite (`test/review-round13.test.ts`).
- Closeout (2026-10-14, NEST-122 / GitHub #129): every Decision Plane path above — main line, clarification / human handoff, replan, supersede recovery and conversation rollover — now has both fixture/service/entry evidence and real-environment acceptance, so this extension has no remaining functional child work. It stays a provider-neutral extension beside §4 and does not alter upstream Symphony SPEC Core conformance.
- NEST-128 (2026-10-16): 决策环境隔离与交付交接竞态排查。修复测试/门禁对宿主外部 Decision 环境变量（`DECISION_BRIDGE_URL`, `DECISION_BRIDGE_TOKEN`, `DECISION_STORE_DIR`, `SYMPHONY_PLANNING_ENABLED`）的意外继承与污染，建立 Vitest 自动环境隔离（`apps/cli/src/test-setup.ts`），实施 CLI/Host 选项冲突早 fail-fast 与显式 store 优先规则；修复交付中断（`haltDispatch`）中标签移除触发调度器协调导致工作进程被提前终止的竞态，调整为在发起任何远端操作前先持久化已暂停状态、实际预算与交接意图，并提供具有远端评论幂等去重能力的补偿入口（`symphony delivery-skill recover-handoff`）；交付针对 fixture `#99` 泄漏计划任务的定向清理工具（`scripts/cleanup-polluted-tasks.mjs`），严格隔离且不影响 `#137` 等其他会话。

## Operational Read Model extension

- NEST-113 / GitHub #109: provider-neutral readonly facts and projection contracts for the Operational Read Model in `@symphony/domain` (`operations*.ts`) — WorkKey identity, GitHub/runtime/Decision/executor facts with provenance, fresh/stale/unavailable/unknown freshness, `WorkProjection`, `OperationalSnapshot`, derived-only phase/waiting/attention/health, and exact-HEAD review projection — surfaced through the new `@symphony/operations` facade package (domain-only dependency).
- NEST-114 / GitHub #110: four read-only source readers and one-shot partial collection, explicit source freshness, atomic PR HEAD/observed-CI read, committed Decision observation with expired leases/historical targets, and injected executor inventory (unconfigured by default; no inferred heartbeat).
- NEST-115 / GitHub #111: pure, deterministic work and system projectors in `@symphony/operations` — derived-only `WorkPhase`, `WaitingReason`, `AttentionState`, `SystemHealth`, review approval safety with exact HEAD verification, partial facts handling, and snapshot cross-counts. [Projector note](../notes/accepted/architecture/2026-10-14-deterministic-work-and-system-projectors.md); evidence in [conformance](conformance.md#deterministic-work-and-system-projectors-nest-115--111).
- NEST-116 / GitHub #112: cross-source anomaly detection and projection explanations in `@symphony/operations` — 8 canonical domain anomalies across GitHub, runtime, Decision Plane, and executor facts, structured `ProjectionEvidence` breadcrumbs with roles, deterministic multi-work aggregation and tie-breaking, attention state degradation, and snapshot/system health degradation with stale/unavailable safety guards. [Anomaly note](../notes/accepted/architecture/2026-10-15-cross-source-anomaly-detection-and-projection-explanations.md); evidence in [conformance](conformance.md#cross-source-anomaly-detection-and-projection-explanations-nest-116--112).
- NEST-117 / GitHub #113: in-process Operational Query Service and integration acceptance in `@symphony/operations` — public query surface (`getOperationalSnapshot`, `listWork`, `getWork`, `listExecutors`), single-round bounded assembly, partial failure tolerance, WorkKey scope boundaries, deterministic ordering, and multi-work isolation without background polling or persistent caching. Closes parent epic GitHub #108. [Query service note](../notes/accepted/architecture/2026-10-15-operational-query-service-and-integration-acceptance.md); evidence in [conformance](conformance.md#operational-query-service-and-integration-acceptance-nest-117--113).

## Execution Continuity and Recovery extension

- NEST-130 / GitHub #146: provider-neutral execution continuity, ownership fencing, and failure contracts in `@symphony/domain` (`src/execution-continuity.ts`) — continuity scopes (`work` / `task` / `attempt` / `binding`), continuity states with first-class non-terminal `blocked`, recovery actions (`none` / `dispatch` / `resume` / `retry` / `rebind` / `reclaim` / `compensate` / `await_external` / `require_human`), expected next actions with typed internal/external/human authority, multi-dimensional ownership fencing with capability credential sanitization, liveness and forward progress tracking, failure taxonomy (`transient` / `recoverable` / `blocked_external` / `superseded` / `invariant_violation`), pure subsystem error mapping for Decision, Delivery, Web Driver, and Orchestrator with explicit unmapped diagnostic gap handling, and canonical stage descriptors. [Continuity note](../notes/accepted/architecture/2026-10-17-execution-continuity-contracts.md); evidence in [conformance](conformance.md#execution-continuity-and-recovery-contracts-nest-130--146).

## 已完成能力

### M0–M6 Core

- M0 / M0.5 / M0.6：monorepo、strict TS、测试与文档门禁，并与官方 SPEC 重新对齐边界；
- M1：Domain 契约、`WORKFLOW.md` loader、typed config / 默认值 / env / path resolution；
- M2：provider 无关 tracker read kernel + registry，built-in `github` profile；
- M3：workspace 确定性 provisioning、路径 containment、lifecycle hooks；
- M4：Agent Runner + Codex app-server 客户端（transport / session / continuation）；
- M5：orchestrator 状态机、polling / scheduling / reconciliation、retry / backoff；
- M6：structured logging、只读 snapshot、CLI host 装配与进程生命周期。

逐项文件、用例名与可复跑命令见 [conformance.md](conformance.md)。

### GitHub Delivery MVP（#78 / NEST-89）

在 Core 之上，把「issue → Codex → PR → CI → auto merge → close → cleanup」串成可复制的闭环：

- **workspace bootstrap**（#79 / PR #84，NEST-90）：克隆目标仓库、创建 / 复用确定性 `symphony/<workspaceKey>` issue 分支，重入安全同步且不覆盖未提交修改；
- **Codex delivery + land skill**（#80，NEST-91）：inspect → validate → commit → push → PR → CI → 有界修复 → land；
- **GitHub delivery primitives**（#81，NEST-92）：PR `ensure` / `read` / `checks` / `diagnostics` / `land` / `verify`，严格所有权与 fail-closed check 策略；
- **闭环参考 profile**（#82，NEST-93）：[`examples/github-delivery/WORKFLOW.md`](../examples/github-delivery/WORKFLOW.md)；
- **真实端到端 dogfood**（#83 / PR #88，NEST-94）：opt-in 的真实 GitHub + 真实 Codex 闭环与安全拒绝证据，运行细节见 [github-delivery-dogfood.md](github-delivery-dogfood.md)。

真实 dogfood 摘要（2026-10-05 / 2026-10-06，隔离目标仓库）：

- happy delivery：PR #12，绿 CI，自动合并并关闭 issue；
- CI 修复闭环：PR #14，真实失败 CI → Codex 修复 → 绿 → 自动合并 → issue 关闭 → workspace 清理；
- 有界重启复用：PR #17，重启前后同一 PR / 分支 / head SHA，持久化绝对 deadline 未变；
- 安全拒绝：foreign / conflict 分别返回结构化 `ownership_refusal` / `merge_rejected`，PR 保持未合并。

默认 `npm run gate` 始终 credential-free：dogfood 入口需要显式 opt-in，缺凭据显式 skip，不计为 passed。

## Operational Snapshot HTTP transport（#137）

`@symphony/observability` 提供显式启动、默认 loopback 的 `GET /api/operations/snapshot`，直接序列化 `@symphony/operations` 查询结果。四类 freshness、partial failure、WorkKey 隔离、exact-HEAD review、anomaly/evidence 均经真实 HTTP 测试验证；无 workflow mutation、缓存或后台轮询。Dashboard 见 #138–#139；生产装配与验收见下方 #140 closeout。父任务 #136 的验收条件已由 #140 closeout 与独立审查满足，关闭由 owner 执行。

## deferred / optional

以下能力**未实现或明确保持 optional**，不计入当前已完成范围：

- 状态面的 history/analytics/journaling/streaming/operator actions 继续 deferred；
- provider-native agent tools（SPEC §11.5）；
- 通用 durable scheduler DB / workflow engine；原生 handoff 和 retry 预约恢复已由下文 #149 覆盖；
- SSH worker（Appendix A）；
- 最终 provider-native credential / tool boundary：当前 GitHub Delivery 使用 host 的 `git` + `gh`，是显式、临时的 MVP trust boundary。

> 区分两件事：**GitHub Delivery MVP 的 `git` + `gh` 闭环已经真实验收**（#83 / PR #88）；上面 deferred 的是**未来更严格的 provider-native credential / tool boundary**，不是「本仓库尚未验证真实集成」。

## 下一阶段

- M7 §15 安全 / 运维 hardening；
- 上述 deferred / optional 能力的取舍与排期。

## 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 / M0.5 | 工程基建：monorepo、strict TS、`npm run gate`、AGENTS / docs / notes | ✅ 已完成 |
| M0.6 | 对齐官方 SPEC：固定 baseline、按 §3 重建 workspace 边界、删除协议栈 scaffold、CI + doc gate | ✅ 已完成 |
| M1 | Domain + Workflow + Config（§4、§5、§6，验收 §17.1） | ✅ 已完成 |
| M2 | Issue Tracker Adapter：read kernel / registry + built-in `github` profile（§11，验收 §17.3） | ✅ 已完成 |
| M3 | Workspace Manager：确定性 provisioning、containment、lifecycle hooks（§9，验收 §17.2） | ✅ 已完成 |
| M4 | Agent Runner：prompt 组装、子进程控制、Codex app-server session（§10、§12） | ✅ 已完成 |
| M5 | Orchestrator：状态机、polling / scheduling / reconciliation、retry（§7、§8、§14、§16） | ✅ 已完成 |
| M6 | Observability + Status Surface + CLI 装配与进程生命周期（§13、§17.7、§18.1） | ✅ 已完成 |
| GitHub Delivery MVP | issue → Codex → PR → CI → auto merge → close → cleanup 闭环（#78–#83） | ✅ 已完成 |
| Operational Read Model | provider-neutral facts/readers/projectors/anomalies/in-process query service（#108–#113） | ✅ 已完成 |
| M7 | 安全 / 运维 hardening（§15）、可选 SSH worker 扩展（Appendix A） | ⏳ 未开始 |

> 逐 SPEC capability 状态仍以 [conformance.md](conformance.md) 为准；本表只记录里程碑级进度，是本项目唯一的里程碑进度表。

## 文档职责

- 使用者安装 / 配置 / 运行：根 [README.md](../README.md)；
- 开发进度、deferred 与 next work：本文件；
- SPEC capability / validation： [conformance.md](conformance.md)；
- 稳定架构与边界： [architecture.md](architecture.md)；
- 开发环境与工程命令： [development.md](development.md)；
- 测试策略与可复跑入口： [testing.md](testing.md)；
- Agent / 贡献者规则： [AGENTS.md](../AGENTS.md)。

## NEST-138 work-level liveness

Active supported GitHub work is scanned even with zero running workers. Native-source observations distinguish blocked, legitimate external wait, scheduled retry, unknown lease progress, stranded and contradictory ownership. Pre-action re-observation and native authority fencing prevent stale/concurrent reclaim. Codex stall uses meaningful lifecycle/usage progress, not arbitrary event traffic. File-backed Delivery entry points share an exclusive mutation lock; crash locks are not automatically stolen. Diagnostics are available via `host.workContinuity.observations`. The Decision bridge only exposes fenced reclaim; it no longer makes context-free startup/timer recovery decisions. Certified pre-entry lock failures allow later compensation, while post-entry uncertainty remains suppressed. Merged runtime/plan conflicts are diagnosed without mutation. Launch admission now reads native sources for each poll/retry attempt and rechecks keyed tracker facts after remote I/O; inventory failures suppress dispatch, observation failures retain retry reservations through backoff, and remote PR/CI reads work without a local workspace.

Uncertain recovery calls/readbacks now suppress repeat delegation across scans until native completion/invalidation evidence; unresolved work requires manual verification and cannot admit coding. Exact-target review selection retains cross-PR active conflicts, and merged PRs explicitly wait for tracker synchronization. Unsupported native browser/repair/merge recovery is reported without command replay. The #149 native durable handoff/retry implementation and #148 Decision/Web implementation are described below; NEST-134 / #150 adds the bounded policy and incidents described below, merged in PR #158. See [design and limitations](../notes/accepted/architecture/2026-10-20-work-level-continuity.md).

## NEST-132 Decision/Web continuity

Implementation adds durable execution progress/deadline, shared reclaim/rebind budget, explicit nonterminal blocked facts and fenced operator unblock to Decision; the host consumes these facts and distinguishes stalled valid leases, blocked work and browser-page waits. Browser enabled/Stop survives reopen; navigation/Send is authorized before mutation, and receipt-first recovery remains fenced. See [decision](../notes/proposed/architecture/2026-10-21-decision-web-continuity.md). Automated fixtures cover authority, driver, startup and host paths. Real Edge/Tampermonkey reload, Bridge auth/network faults, no-replay blocking, actual Review HEAD changes and native-host automatic reclaim have scoped 2026-10-22 evidence below; full browser-process bounded blocking is now accepted through #162/PR #163 below. Actual login/deleted-conversation UI variants remain unexercised/deferred.


PR #156 follow-up fixes active heartbeat auth reporting, authoritative lease recovery,
and bound-conversation checks around recovered extraction. Heartbeat and first
result acceptance now revalidate external target admission; accepted receipts remain
readable after target changes. Automated no-replay coverage includes tab identity
loss after Send. Scoped real-browser and final-gate evidence is recorded below;
untested historical categories are not marked passed.

Historical 2026-10-22 evidence below retains its original build/scope limits; current acceptance is summarized under NEST-135 and #162 below.

2026-10-22 real-browser follow-up: Edge/Tampermonkey partial fault acceptance passed reload, active heartbeat 401, result 403, pre/post acceptance network loss, bounded no-replay tab-loss handling, two-tab single claim/result, route-drift blocking, supersede continuation and persistent Stop. Ten isolated Plan tasks produced eight result receipts, all claim generation 1. Lost-tab blocking used explicit fenced reclaim, not automatic host coordination. The later same-day final-gate run verifies actual Review HEAD change and native-host reclaim. ChatGPT auth/deleted-conversation recovery and browser-process restart remain pending; #148/#156 overall acceptance is not complete. See [evidence and limits](evidence/web-continuity/live-acceptance-2026-10-22.md#current-build-real-browser-fault-run).

2026-10-22 final gates: both requested blockers passed. Native host polling with real GitHub sources automatically reclaimed a pre-Send lost claim; a new page completed generation 2 and stale generation 1 was rejected. The same host automatically blocked uncertain post-Send loss without replay. Actual dogfood PR #25 HEAD A → B during Review caused production GitHub admission to reject A and block the old task; an explicitly superseding Review completed with an exact-B approve receipt without manual Start. The test branch was restored to original A, all workers/listeners were stopped. See [final-gate evidence and remaining scope](evidence/web-continuity/final-gates-2026-10-22.md).

2026-10-22 closeout: inaccessible-conversation recovery additionally passed with automatic binding/claim generation 1 → 2 and a matching receipt. Standards review found one diagnostics-restoration metadata boundary defect, now fixed and re-reviewed; Spec review found no confirmed defect. PR #156 implementation closeout is complete within this bounded review scope. #148 remains open; remaining auth UI, permanent deletion/rebind exhaustion, full browser restart and heartbeat-403 live coverage stays tracked with existing #151. See [closeout evidence and build provenance](evidence/web-continuity/closeout-2026-10-22.md).

PR #156 review follow-up: the DOM-windowing liveness mismatch is fixed by sharing a task-scoped response observer between the adapter waiter and Driver heartbeat. Prompt-submission recovery recognizes strict exact-task results as Send evidence. Fake-clock Driver→Decision authority regressions cover growth beyond ten minutes and reject stale/non-response changes; real HTTP recovery proves no repeated Send. Userscript build advances to 0.1.5. Fresh live-browser coverage of this change remains unperformed; #148/#151 stay open.

Review-fix validation: full gate passed (2,042 tests, one existing opt-in skip; Web 216). See [review-fix evidence](evidence/web-continuity/review-5611917646-fix-2026-10-22.md).

Later 2026-10-22, after the operator updated Userscript 0.1.5, scoped real-browser acceptance passed native response-growth reporting, active reload without repeated Send, and accepted-result acknowledgement loss resolved by receipt readback. Two Plan receipts retained claim/binding generation 1. Build metadata duplication is fixed: Vitest shutdown no longer prepends to the built file. Full gate remains green (2,042 passed, one opt-in skip). [Evidence and limits](evidence/web-continuity/live015-acceptance-2026-10-22.md) distinguish this run from the untriggered ten-minute DOM-windowing and Send/checkpoint crash-gap cases; #148/#151 stay open.

### NEST-133 / #149 durable handoffs

Implementation protects coordinator invocation, CI→Review, Review-result→Delivery,
paused compensation, landing acknowledgement and retry→worker boundaries. Native
host startup restores reservations/intent discovery; uncertain launch/repair/child
outcomes are durable blocks. Local validation covers real child-process SIGKILL and
restart, native host ticks and both landing paths. Independent review and implementation completed in merged PR #157 (`a42f1b55dff42ffc02feb57d31f053bc2b153dcf`). Native crash-window evidence is accepted for the supported contract; exhaustive live provider combinations are not claimed. See the
[implementation note](../notes/proposed/architecture/2026-10-22-durable-recovery-invocations.md).

### NEST-134 / #150 bounded recovery and incidents

Implementation adds independent finite failure budgets, normalized SHA-256 fingerprints,
capability-aware strategy selection, stable recovery epochs and durable host policy
blocks. Native Decision/Web limits and fresh-admission/fencing remain authoritative.
The CLI exposes incident list/detail and exact-ID policy authorization; its dedicated
GitHub outbox verifies marker receipts and bounds reporting attempts without replaying
unknown POSTs. Operations/Dashboard remain read-only.

Automated policy, native retry, real filesystem/SIGKILL, cross-process exhaustion,
concurrent reporter, ACK-loss and stale-target tests are included. Scoped host restart and native worker exhaustion now have [real process evidence](evidence/execution-continuity/core-acceptance-2026-10-23.md); external report ACK/UI variants remain unexercised/deferred. Independent review approved PR #158,
squash-merged as `627daa2164f2a8cdbad67b05d860300ecb822db2`.
See [operator behavior](bounded-recovery.md) and the
[decision note](../notes/proposed/architecture/2026-10-22-bounded-recovery-incidents.md).

NEST-134 review follow-up fixes three blockers: automatic unblock now requires an
explicit modeled ownership condition; versioned native accounting separates legacy
migration from new capacity/continuation waits; native needs-human/manual reasons
produce durable deduplicated incidents without blocking Delivery report compensation.
Focused real-authority/file-store and production-host regressions are included;
independent re-review approved these fixes in PR #158. The finite policy and incident invariant are accepted through native fault injection plus scoped process evidence; this does not claim exhaustive external-provider/UI acceptance.

### NEST-135 / #151 fault acceptance

The [29-scenario ledger](evidence/execution-continuity/README.md) now aligns #159
(merged evidence), #162 (closed follow-up) and #163 (merged repair). Supported
bounded-convergence acceptance is satisfied by native production-equivalent fault
injection plus scoped real process/browser evidence. [Current closeout assessment](evidence/execution-continuity/closeout-2026-10-23.md)
records the maintainer's approved coverage profile and remaining non-exhaustive live
variants. W03 is **bounded convergence accepted**: complete host + installed Driver
0.1.6 reaches visible Waiting → Blocked without duplicate effects; seamless browser
session/response resume remains unaccepted/deferred. After this documentation
closeout passes gate/review and merges, #151 is ready to close, followed by final
maintainer acceptance/closure of parent #145. This documentation change does not
close either issue or expand runtime scope.

## Dashboard shell — NEST-125 / GitHub #138

`apps/dashboard` adds a replaceable TypeScript DOM consumer of #137: Overview, attention-first Work list, full WorkKey routes, distinct source freshness, explicit current/stale HEAD approval and observational polling errors. Schema v1 summary adds optional `degradedWork` / `anomalyCount`; new projectors always output them, using final canonical anomalies. The independent Node-only same-origin demo uses real query/HTTP and controlled readers, visibly marked 演示数据. Production CLI/source/lifecycle composition is recorded under #140 below; external live acceptance is not claimed; Work Detail is described below. This delivery does not depend on NEST-135 / merged #159 or change its continuity acceptance status.

## Work Detail — NEST-126 / GitHub #139

Adds WorkKey-addressable structured detail, derived/fact separation, four-state source diagnostics, source/role projection evidence, first-class anomalies and independently visible PR/task/result targets. Work-scoped selections reject foreign nested evidence; global diagnostics remain separate. Shape/type/AST/capability/fingerprint guards and local controlled-reader query/HTTP/proxy/DOM tests cover the diagnostic surface. The explicit Chromium smoke validates the built demo, navigation, keyboard diagnostics and disconnect/recovery. Schema v1/domain/HTTP contracts and production CLI are unchanged. Production scope/lifecycle acceptance is recorded under #140 below; the parent #136 acceptance is complete through merged PR #165, with closure remaining an owner action. merged #159 is independent.

### #162 bounded-convergence follow-up (2026-10-23)

SPEC §4 adjacent / §7 / §8 / §10 / §12 / §14 / §17 / §18: [new evidence](evidence/execution-continuity/bounded-browser-acceptance-2026-10-23.md)
uses complete production host + authenticated Bridge, real GitHub reads, isolated
Decision records and the installed Driver. A lost native-created test window's
`waiting_response` execution blocked 27.296 seconds after lease expiry, preserving
claim/binding generation 1 with receipt 404 and zero result POSTs. This initial bounded observation is retained with its original scope; the later
installed Driver 0.1.6 run below accepts W03 conservative convergence. It does not
establish seamless restoration. #162 is closed through PR #163; #151/#145 await
the documentation closeout and final maintainer acceptance. The [subsequent agent-tab quit comparison](evidence/execution-continuity/agent-browser-acceptance-2026-10-23.md)
completed: old PID absence/new PID verified; the same browser tab restored at home
with a newly created `symphony_tab_id` and empty diagnostics. Host block arrived
23.019 seconds after lease expiry, with local CLI-visible incident, receipt 404,
zero result POSTs and 409 for replacement claim/old heartbeat. Both variants now
show bounded blocking, while seamless resume remains unaccepted; the earlier
native-window comparison differs in window topology, and old GM checkpoint
persistence was not directly inspected.
CLI host-tick regression covers expiry, no replacement claim and durable block/incident
retention after host/Bridge reconstruction and store reopen. Decision's exported
`HeartbeatTaskRequest` now includes progress from the domain execution contract,
matching the already-supported service/HTTP payload; typed Bridge regression verifies
real progress and unchanged repeated progress. No recovery-policy change was required.


### #162 recovery visibility repair — Driver 0.1.6 (2026-10-23)

SPEC §13 adjacent / §10 / §12 / §17 / §18: [repair evidence](evidence/execution-continuity/recovery-hud-fix-2026-10-23.md).
A restored page without a local checkpoint now reads native continuity facts when
`/next` has no claimable task, displaying Waiting for an outstanding owner or Blocked
with native task/reason/instruction. This is read-only observation: no lost identity
is reconstructed and no lease is adopted, reclaimed or unblocked by the page.
The HUD displays the build version from the same source as userscript metadata.
Regression uses a real HTTP Bridge/store seam for waiting/block
facts, terminal clearing and no mutation, plus late-response-after-Stop fencing.
Transparent browser-session resume remains outside the proven boundary.
Operator-confirmed 0.1.6 and its HUD version were verified during actual generation
and complete Edge quit/reopen (old PID 32189 absent, new PID 16774). The restored
home page displayed Waiting then Blocked automatically; host block followed expiry
by 22.913 seconds, with generation 1, receipt 404, zero Driver POSTs after quit,
and stale heartbeat/replacement claim 409. Gate passed: 2312 tests, one opt-in skip.

Current #162 disposition: **closed**, with PR #163 merged as
`7e10c91d5693ef63f438490cbfd1886105b22225`. Bounded, operator-visible convergence
is accepted; seamless browser-session resume, alternative browser/session policies,
crash/SIGKILL and remaining live UI/provider combinations are deferred variants,
not silently passed experiments. The measured 22.913 seconds is one run's result,
not a universal wall-clock SLA. See the [closeout assessment](evidence/execution-continuity/closeout-2026-10-23.md).

## Read-only operational status closeout (#140)

The read-only operational status surface is complete and accepted: independent review approved PR #165, which merged to `main` as `8f7675ed09f59919f438a3b6e657471eb6b883ba` on 2026-10-24 with main CI run #344 green. It includes opt-in production CLI composition, explicit WorkKey scope, shared local/Bridge Decision observation, bounded source reads, built static hosting and observational shutdown. Automated production-path acceptance covers the representative states and fault boundaries; the [ledger](evidence/status-surface/README.md) distinguishes controlled Chromium scenarios from actual executable packaging and authenticated external live checks (unrun). Operations remains the sole presentation semantic source. Parent #136's exit condition is satisfied; closing it remains the owner's action. History/timeline, analytics, event journaling, persistent operational cache, streaming and operator actions remain deferred. NEST-135/#159 acceptance is tracked independently by its continuity closeout.

## Dashboard V2 Operator Console — GitHub #169
Implementation adds the framework-free four-destination shell (Overview / Work / Executors / System), with Work Detail owned by Work and legacy WorkKey hash links retained. V1 content and supplied semantics remain unchanged; executor inventory and global diagnostics have dedicated destinations. Keyboard heading focus, refresh restoration and narrow navigation/table layout are covered by Dashboard tests and the extended Chromium smoke harness. Initial host gate and CI passed; independent Review requested browser evidence. Host browser acceptance on 2026-10-26 passed all 23 scenarios after two smoke-only asynchronous waits were corrected. [Retained evidence](evidence/dashboard-v2-shell/README.md) includes desktop/390px screenshots, JSON and asset hashes. The evidence follow-up still requires its current-HEAD CI and independent re-review before landing; no downstream V2 child is marked ready.

### #170 — Dashboard V2 presentation primitives

Implemented horizontal DOM-native primitives, console tokens, Work-table reuse, explicit four-state freshness and display states, independently accessible full SHA identities, native controls and a generated static showcase. No page redesign or new read-model fields. Sandbox validation covers Dashboard tests/build and root typecheck; full gate, CI, exact-HEAD independent review and delivery evidence remain operator-host steps after this coding session. Rendered browser acceptance is tracked in [the primitive evidence ledger](evidence/dashboard-v2-primitives/README.md).

### Dashboard V2 Overview — #171

Attention-first presentation implemented on #169/#170: supplied needs-human/failed → degraded/anomaly association → waiting → remaining current work; compact supplied counts, system health, source posture, executor ownership and global/work anomaly visibility. Stable WorkKey navigation and last-successful snapshot retention remain intact. No Read Model extension or frontend projector added. Sandbox validation and controlled artifacts are recorded in [Overview evidence](evidence/dashboard-v2-overview/README.md). Full host gate, CI, exact-HEAD review and Delivery remain pending operator after_run; no production acceptance is claimed here.
