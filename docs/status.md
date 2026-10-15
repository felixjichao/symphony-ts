# 实现状态

本文件是本项目**开发进度与能力的唯一总览**：当前 posture、已完成能力、deferred / optional、下一阶段与历史里程碑。

- 面向使用者的安装 / 配置 / 运行指引见根 [README.md](../README.md)；
- SPEC 逐项 capability / validation 的权威矩阵仍是 [conformance.md](conformance.md)；
- 稳定架构、组件职责与依赖方向见 [architecture.md](architecture.md)。

## 当前 posture

- 开发主线：`main`。当前最新里程碑提交为 `afb29ab`（PR #128，Decision Plane extension 真实浏览器 rollover 验收收口）；GitHub Delivery MVP 的 dogfood 里程碑提交为 `e6f8e25`（PR #88）。
- **M0–M6 Core 已完成**：orchestrator authority 独占调度状态，默认 CI 覆盖 Core Conformance。
- **GitHub Delivery MVP 已完成并经真实验收**：从 issue 到自动合入并关闭 issue 的闭环可用。
- **Decision Plane extension（GitHub #93）已完成并经真实验收**：planning、SHA-bound review、repair/re-review、durable state、ChatGPT Web 执行与异常恢复均已通过真实环境验收；该扩展不改变 SPEC Core conformance，也不改变既有 GitHub Delivery 语义。
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

## Operational Read Model extension

- NEST-113 / GitHub #109: provider-neutral readonly facts and projection contracts for the Operational Read Model in `@symphony/domain` (`operations*.ts`) — WorkKey identity, GitHub/runtime/Decision/executor facts with provenance, fresh/stale/unavailable/unknown freshness, `WorkProjection`, `OperationalSnapshot`, derived-only phase/waiting/attention/health, and exact-HEAD review projection — surfaced through the new `@symphony/operations` facade package (domain-only dependency).
- NEST-114 / GitHub #110: four read-only source readers and one-shot partial collection, explicit source freshness, atomic PR HEAD/observed-CI read, committed Decision observation with expired leases/historical targets, and injected executor inventory (unconfigured by default; no inferred heartbeat).
- NEST-115 / GitHub #111: pure, deterministic work and system projectors in `@symphony/operations` — derived-only `WorkPhase`, `WaitingReason`, `AttentionState`, `SystemHealth`, review approval safety with exact HEAD verification, partial facts handling, and snapshot cross-counts. [Projector note](../notes/accepted/architecture/2026-10-14-deterministic-work-and-system-projectors.md); evidence in [conformance](conformance.md#deterministic-work-and-system-projectors-nest-115--111).
- NEST-116 / GitHub #112: cross-source anomaly detection and projection explanations in `@symphony/operations` — 8 canonical domain anomalies across GitHub, runtime, Decision Plane, and executor facts, structured `ProjectionEvidence` breadcrumbs with roles, deterministic multi-work aggregation and tie-breaking, attention state degradation, and snapshot/system health degradation with stale/unavailable safety guards. [Anomaly note](../notes/accepted/architecture/2026-10-15-cross-source-anomaly-detection-and-projection-explanations.md); evidence in [conformance](conformance.md#cross-source-anomaly-detection-and-projection-explanations-nest-116--112).
- NEST-117 / GitHub #113: in-process Operational Query Service and integration acceptance in `@symphony/operations` — public query surface (`getOperationalSnapshot`, `listWork`, `getWork`, `listExecutors`), single-round bounded assembly, partial failure tolerance, WorkKey scope boundaries, deterministic ordering, and multi-work isolation without background polling or persistent caching. Closes parent epic GitHub #108. [Query service note](../notes/accepted/architecture/2026-10-15-operational-query-service-and-integration-acceptance.md); evidence in [conformance](conformance.md#operational-query-service-and-integration-acceptance-nest-117--113).

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

## deferred / optional

以下能力**未实现或明确保持 optional**，不计入当前已完成范围：

- HTTP / dashboard status surface（SPEC §13.7）；
- provider-native agent tools（SPEC §11.5）；
- durable scheduler state / durable recovery；
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
