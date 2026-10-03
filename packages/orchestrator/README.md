# @symphony/orchestrator

## Purpose

SPEC **§7 Orchestration State Machine**、**§8 Polling, Scheduling, and Reconciliation**、**§14 Failure Model and Recovery Strategy** 的 owner 包，对应 §3 的 Orchestrator：轮询节奏、claim 集合、并发上限、dispatch 排序、retry / backoff、reconciliation，以及"单一权威 orchestrator runtime state"的维护。**修改 retry policy 的唯一落点在本包。**

M5.1 已落地**纯调度内核**（无副作用）：`createOrchestratorRuntimeState()` 初始化单一权威 runtime state；`DispatchPolicy` + eligibility 纯函数负责 active / terminal state、required-label matching、`issue_routable`、dispatch eligibility、claim / running gating、global / per-state 并发 slot；`sortForDispatch()` 实现 §8.2 stable sort；`backoff.ts` 提供 continuation / failure retry 的纯数学延迟。该内核不 fetch tracker、不 spawn worker、不调用 workspace cleanup、不解释 agent / Codex 协议。

M5.2 已落地 **dispatch + worker lifecycle**：`OrchestratorAuthority` 是单一写入者，`dispatchIssue()` 在 `claimed` + `running` 双检查后于无 `await` 的提交段原子写入 `running` + `claimed`、清除同 issue retry entry 与 timer；`WorkerControl` 提供幂等的 `stop(reason)` 与 attempt `AbortSignal`，并等待 runner 真正收尾；`runAgentAttempt()` 的正常 / 异常结果都经统一 `completeAttempt()` 归约为终态 `RunAttempt.status`（`outcome.ts`，主动 stop reason 优先于底层 `port_exit`）；`applyAgentEvent()` 只消费稳定 `AgentEvent`，以 **thread 身份为隔离边界**（异 thread 的无关 / 迟到遥测丢弃）、**thread owner 与 turn 身份都只由可靠生命周期事件确认**（`other_message` / `malformed` 等诊断事件即使先到也不得抢占尚未确认的 owner；`notification` 等携带的 turn id 不改写身份），身份未齐时把 usage / PID / last event 暂存在 per-attempt 遥测里（usage 到达即按**所属 thread 各自的基线**入账，取得完整身份后回填 `LiveSession`；候选切换 / owner 确认都保留每个 thread 已计入的额度，A→B→A 交错绝对快照不重复入账）；`createTrackerRefreshContinuationDecider()` 注入同线程 continuation 判定与 tracker refresh。`@symphony/agent` 增加最小 `signal` / `onPhase` 契约以支持取消，取消覆盖 launch 前 / 握手中 / turn / continuation / 收尾。

M5.3 已落地 **retry 队列 / timer 所有权 / backoff 决策**（SPEC §8.4、§14.2、§16.6、§17.4）：`OrchestratorAuthority` 在 worker 终态归约后按 `retryKind` 建立完整 `RetryEntry`——normal exit 固定 `attempt = 1` / `1000` ms / `error = null`，abnormal exit `attempt = (RunAttempt.attempt ?? 0) + 1`、`delay = min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`（每次新建从当前 effective cap 读取）；`scheduleRetry()` 取消 / 替换同 issue 旧 timer，claim 保留为 `RetryQueued`。timer 端口（`RetryScheduler`，默认 `setTimeout` 实现）与单调时钟均可注入；每次排队分配独立 ownership token，**timer 回调只提交带 issueId + token 的到期事件**，stale / canceled / 被替换的迟到回调被 token 隔离，绝不重复派发。retry timer 到期完整执行 §16.6 `on_retry_timer`：pop entry → `fetch_issues_by_ids` refresh → fetch 失败（保留 claim，`retry refresh failed` 重排）/ missing（释放 claim）/ terminal（经注入的 `cleanupWorkspace` 安全清理 + 释放）/ inactive·unroutable（释放、不 cleanup）/ slot 不足（`no available orchestrator slots` 重排）/ active+routable（用 entry.attempt 重新 dispatch）。重派经 authority 内部提交路径消费自己的 claim，普通候选 dispatch 不豁免 claim。terminal cleanup 的 `refused` / `failed` / 异常只经 `onDiagnostic` 暴露且释放 claim，本包不做删除 fallback；cleanup 是异步删除，因此 authority 用 `cleanupInFlight` 把同 issue 的 cleanup 与后续 refresh / launch **串行化**——删除在途时新 retry 必须先等待并重新校验 ownership，避免新 worker 写入随后被删的 workspace。默认 `createRetryScheduler()` 对超过 Node `setTimeout` 上限（`RETRY_MAX_TIMER_DELAY_MS = 2^31 - 1`）的合法 backoff 采用**分段 timer**，保持规定延迟而非被压成 1 ms。真实链路（`runAgentAttempt` → app-server fixture subprocess → outcome → fake timer → refresh → 新 worker）用两次 attempt 的不同 PID / `cwd === workspace.path` / 退出存活检查与 workspace marker 内容保留，验证新 subprocess session 与 workspace 复用。

## Configuration

轮询间隔、并发上限、backoff 参数等由 `@symphony/config` 产出的 typed config 提供（含 per-state 并发覆盖）；本包不自行解析 `WORKFLOW.md`。只有"当前生效"的 `pollIntervalMs` 与 `maxConcurrentAgents` 驻留在 runtime state 上；active / terminal states、required labels、per-state 并发上限、`max_retry_backoff_ms` 等由每 tick 的 effective config 以 `DispatchPolicy` / 纯函数参数传入，因此 reload 后自然采用新值。

## Extension points

- 调度 / claim / reconciliation 策略：在本包内实现，参考算法对齐 SPEC §16；
- 对 tracker / workspace / agent 的调用一律经各自公共 API；本包是唯一允许同时依赖它们的 coordination 层；
- 新增 `packages/orchestrator` 实现时同步更新 [docs/conformance.md](../../docs/conformance.md) 的 §7 / §8 / §14 行。

## Known limitations

- reconciliation / stall 检测 / terminal cleanup 的**调度接线**（M5.4）、poll loop / config re-apply（M5.5）与跨包端到端 conformance（M5.6）随后续 M5 子任务落地（SPEC §7 / §8 / §14、§17.4）。M5.3 已提供它们需要的 retry entry / timer 所有权、`scheduleRetry()`、`cancelScheduledRetry()`、`getWorker().stop()` 与 `suppressRetry` / `retryKind` outcome；
- retry `dueAtMs` 用单调时钟、`delay` 用注入 scheduler；测试注入手动 scheduler，不依赖真实 sleep；
- terminal retry refresh 的 workspace 清理只经注入的 `cleanupWorkspace` 端口（生产接 `WorkspaceManager.removeWorkspace`），`refused` / `failed` / 异常只记诊断并释放 claim，本包不做删除 fallback；
- worker 停止的上界由 agent 层自身的 `shutdownTimeoutMs` 与 workspace hook effective timeout 提供，本包不额外引入硬超时（避免"超时宣布退出却让 runner 继续运行"）；
- `applyAgentEvent` 只从可靠生命周期事件推进 turn 身份 / 计数，并按 thread 隔离异 thread / 异 turn 诊断事件；身份未齐时的 usage / last event 暂存在 per-attempt 遥测（`AgentTelemetryState`）中，usage 仍立即入账，因此"先到 usage、后到身份"或"身份始终未齐并最终启动失败"都不会漏账；
- runtime state 是 in-memory only（§14.3）：不提供 durable scheduler DB 或跨重启恢复，retry timer 不跨进程重启保留。
