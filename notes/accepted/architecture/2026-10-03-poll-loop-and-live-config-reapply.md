# Agent Note: Poll loop、startup 编排与 live config re-apply 契约

Status: accepted

## Problem

M5.5（NEST-78 / #54）要在 `@symphony/orchestrator` 落地长运行 poll loop、startup / tick 顺序、per-tick 失败降级、live config re-apply 与 orchestrator stop lifecycle（SPEC §8.1、§14.2 / §14.3 / §14.4、§16.1 / §16.2、§6.2 / §6.3）。M5.1–M5.4 已交付纯调度内核、dispatch / worker lifecycle、retry queue 与 reconciliation，但没有"谁按节奏驱动 tick、如何组织 startup、reload 如何生效、如何关停"的编排层。需要定下五类跨切面问题：

1. **tick 节奏与重入**：`setInterval` 在异步 fetch 上会产生 tick 重叠；SPEC §16.1 又要求首次 tick 立即执行。需要一种既"立即启动"又"慢 tick 不重叠"的 timer 结构。
2. **startup 顺序与 fail-fast**：§16.1 明确 `validate_dispatch_config → startup_terminal_workspace_cleanup → schedule_tick(0)`；§6.3 要求启动校验失败 fail startup，而 §8.6 要求 terminal fetch 失败只警告、继续启动。两者失败面不同。
3. **per-tick 失败降级**：§14.2 要求 validation 失败跳过 dispatch、candidate fetch 失败跳过本 tick、reconciliation refresh 失败保留 worker，且 reconciliation 仍先执行。需要"所有出口只安排一个下一次 tick"的结构。
4. **live config re-apply 的生效点**：§6.2 要求 reload 作用于 future dispatch / retry / reconciliation，且普通 concurrency 下调不终止运行中 worker。既有 authority 把 `policy` 固定在构造时、continuation decider 也捕获该对象；retry cap / stall 已是 getter。需要一个原子 apply 入口与一致的读取口径。
5. **stop 的竞态**：取消 poll timer、取消 retry timer、停止 worker 都必须幂等，且"已 pop entry、仍在 `fetchIssuesByIds` 的 retry"也必须失效——ownership token 是回校验的关键。

## Decision

1. **单 timer 链 + 可注入一次性 scheduler**。`OrchestratorLoop` 不使用 `setInterval`：每次 tick **在 `finally` 中恰好安排一次**下一次 timer，延迟取**当前 effective** `polling.interval_ms`（即 `state.pollIntervalMs`）。首次 tick 以零延迟安排（§16.1）。慢 tick 在途时不排下一次，因此天然不重叠。scheduler 端口 `PollScheduler`（与 `RetryScheduler` 同形）可注入，默认复用 `createRetryScheduler()` 的分段 `setTimeout`。**约定：已挂出的 poll timer 不因 reload 立即改期，新的 interval 在 tick 结束时生效**——不额外产生 tick。

2. **startup 三步，失败面分开，能力缺失 fail-fast**。`start()` 先 `preflight()`：失败记录 `startup_validation_failed` 诊断并抛 `OrchestratorStartupError`，不 cleanup、不排 timer、不进入调度（§6.3）。成功后先 `applyEffectiveSchedulingConfig(初始 effective)`（保证 sweep 用 policy.terminalStates），再 `runStartupTerminalCleanup()`：若返回 `unavailable`（未注入 `cleanupWorkspace` 端口或 tracker 缺 `fetchIssuesByStates`），正式 loop 入口**拒绝进入调度**并抛 `OrchestratorStartupError`（诊断 `startup_cleanup_unavailable`）——保证"必做 startup sweep"不会被静默跳过；而**实际** terminal fetch 失败（`fetchFailed`）或单项 `refused` / `failed` / 异常仍是 best-effort 诊断后继续启动（§8.6）。最后排零延迟首 tick。startup 阶段的 Promise 由 loop 持有，`stop()` 会等待它，因此 stop 不会早于 startup 收尾返回。

3. **tick 严格按 §16.2 排序，降级统一从 `finally` 收口**。`reconcile running → preflight → apply effective → fetch active candidates → sort → dispatch while global slot`。reconciliation 先于一切且异常隔离（refresh 失败已由 authority 内部保留 worker）。validation 失败或 fetch 失败都只记诊断并 `return`，`finally` 仍安排唯一一次下一次 tick，服务保持存活。

4. **authority 提供唯一 effective 写入入口，读取全部走 getter**。`OrchestratorAuthority.applyEffectiveSchedulingConfig({ pollIntervalMs, maxConcurrentAgents, policy })` 原子更新两个"当前生效"标量与 policy；`policy` 字段改为可变，dispatch / retry / reconciliation / startup sweep 直接读现值，continuation decider 经 `policy: () => this.policy` getter 读取（`createTrackerRefreshContinuationDecider` 的 `policy` 同时接受静态对象与 getter，保留旧接线）。retry cap / stall timeout 不进 apply——它们继续由构造时注入的 getter 从同一 effective store 读取。并发下调只改 `state.maxConcurrentAgents`，**不主动 stop** 已运行 worker。

5. **stop 分两层且幂等，同步关闭先于任何等待**。`OrchestratorLoop.stop()` **同步**置 `stopping`、取消 poll timer，并立即调用 `authority.shutdown()`——其**同步前缀**（`beginShutdown()`）拒绝新 dispatch / retry、`retryOwners.clear()`（使在途 refresh 迟到结果失效）、取消并清空排队 retry timer、拒绝之后开启新的 workspace 删除，然后开始以 `{ kind: "shutdown" }` 停止全部 worker。loop 随后才等待 startup / 在途 tick，并等待 `shutdown()` 完成全部收尾：先 worker 生命周期，再 `waitForCleanups()` 等待**已开始**的 workspace 删除真正结束（startup sweep、reconciliation / retry terminal cleanup 共用一个全局在途登记）。这样即使某个 tick 卡在 candidate fetch，worker 也会立即停止、retry 也不会触发；调用方在 `stop()` resolve 后不会遭遇旧生命周期的迟到删除。重复调用共享同一 Promise，stop 后实例不再启动。

## Alternatives considered

- **`setInterval(intervalMs, tick)`**：异步 fetch 期间下一次 tick 仍会触发，造成重叠与重复 dispatch；也无法表达"首次立即"。改为单 timer 链（tick 结束再排下一次）。否。
- **tick 内用 `while` 自旋或递归 `setTimeout` 不 await**：慢 tick 下会堆积 timer handle，stop 时无法干净取消。改为只保留一个 `pollTimer` 并在 stop 时取消。否。
- **reload 后立即重排已挂出的 poll timer**：会产生额外 tick、并让"interval 生效点"依赖 reload 时序而非 tick 边界；SPEC 只要求作用 future。改为 tick 结束时取最新 interval。否。
- **启动 preflight 失败仍进入 loop、每 tick 重试**：违反 §6.3"startup validation fail → fail startup"。改为 fail-fast 且不留下 timer。否。
- **startup terminal fetch 失败也 fail startup**：违反 §8.6"log a warning and continue startup"。改为只诊断。否。
- **validation / fetch 失败时 `return` 而不排下一次 tick**：服务会静默停止轮询。改为 `finally` 统一排下一次。否。
- **把 retry cap / stall 也塞进 apply**：authority 已用 getter 读取，重复存储会产生两个真相来源。改为继续用 getter，loop 只负责让 preflight 更新同一 store。否。
- **reload 时重建整个 authority / 重建 running state**：会丢失 worker、claim 与 retry ownership，且普通并发下调不应终止 worker（§6.2）。改为原子 apply 到既有 authority。否。
- **stop 只遍历 `state.retryAttempts` 取消 timer**：已 pop entry、仍在 `fetchIssuesByIds` 的 refresh 不在队列里，其迟到结果可能重新 dispatch。改为先 `retryOwners.clear()` 使全部在途 ownership 失效。否。
- **stop 先 await 在途 tick、再调用 `shutdown()`**（首版实现）：等待期间 retry timer / ownership 与 workers 仍有效——若 tick 卡在 candidate fetch，retry timer 会在窗口内触发并启动第二个 attempt，worker 也迟迟不停；违反"stop 首先同步禁止 dispatch/retry、使 ownership 失效"（审查 blocker 1）。改为同步前缀先关闭调度并开始停 worker，再等待收尾。否。
- **startup 缺 cleanup 能力（未注入 `cleanupWorkspace` / tracker 缺 `fetchIssuesByStates`）仍继续启动**（首版实现）：会静默跳过必做 startup sweep。改为 `unavailable` fail-fast；仅实际 fetch / 单项失败 best-effort（审查 blocker 3）。否。
- **`shutdown()` 只等待 workers，不等已开始的 workspace 删除，且 stop 不等待 startup**（首版实现）：调用方以为已关停后仍可能遭遇旧生命周期迟到删除，或 startup fetch 返回后继续删除（审查 blocker 2）。改为跟踪全局在途 cleanup、stop 等待 startup，并拒绝 stopping 后开启新删除。否。
- **stop 不等待真实 runner / after_run 收尾**：会出现"宣布退出却仍在跑"的窗口。改为 await worker `completion`。否。

## Consequences

- M5.6 只需实现 `DispatchPreflightSource`（真实 workflow load + registry preflight）与 `CandidateIssueSource`（tracker adapter），把 `runAgentAttempt` / `WorkspaceManager` 注入 `OrchestratorAuthority`，即可组装真实长运行服务；loop 本身上下文无关、可确定性测试。
- 已发布公共面新增 `OrchestratorLoop` / `OrchestratorStartupError` 与 `DispatchPreflightSource` / `CandidateIssueSource` / `EffectiveSchedulingConfig` / `DispatchPreflightResult` / `LoopDiagnostic` / `PollScheduler`；`OrchestratorAuthority` 新增 `applyEffectiveSchedulingConfig` / `beginShutdown` / `shutdown` / `waitForCleanups` / `pollIntervalMs` / `hasAvailableGlobalSlot` / `isStopping`，`createTrackerRefreshContinuationDecider` 的 `policy` 放宽为对象或 getter（向后兼容）。
- 后续承诺：loop 不得引入 `setInterval`、不得跳过 reconciliation、不得在降级出口遗漏下一次 tick；authority 仍是唯一 state 写入者；关停必须使全部 retry ownership 失效后才停止 worker；任何新加的有效配置读取都必须走 getter / apply，不得缓存构造时快照。
- scheduler state 仍 in-memory only（§14.3）：stop 后不保留 timer、retry、running；跨重启恢复仍靠 startup sweep + 重新轮询。
