# Agent Note: Orchestrator dispatch 与 worker lifecycle 契约

Status: accepted

## Problem

M5.2（NEST-75 / #51）要在 `@symphony/orchestrator` 建立 dispatch 写路径、worker control abstraction、`RunAttempt` / `RunningEntry` 生命周期，以及 `AgentEvent → runtime state` 的稳定映射。约束：

- orchestrator 是 scheduling state 的唯一写入者，所有 worker outcome / agent event 必须串行化为显式 transition；
- orchestrator 不得接触 Codex `ChildProcess`、不得解析 raw Codex JSON；
- agent runner 不得拥有 scheduler / retry policy；
- SPEC §7.4 要求 worker launch 前 MUST 检查 `claimed` + `running`；dispatch 成功后进入 running + claimed；
- SPEC §7.3 worker 正常 / 异常退出都必须回到 orchestrator authority 做核算与后续决策；
- 后续 M5.3（retry 队列）、M5.4（reconciliation / stall / cleanup）、M5.5（poll loop）需要一套可复用的控制与结果契约。

需要定下：worker 控制面的形状、dispatch 提交的原子性边界、取消如何穿透到 agent、outcome 与 claim 的交接方式、以及 telemetry 的记账口径。

## Decision

1. **单一 authority 类 `OrchestratorAuthority`**。`dispatchIssue(issue, { attempt? })` 先做 `claimed` + `running` 双检查，再复用 M5.1 eligibility；随后同步构造 `RunAttempt` + `RunningEntry` + `WorkerControl`，并在**没有 `await` 的提交段**写入 `running` + `claimed`、删除同 issue `retry_attempts`、调用可注入的 `cancelRetry(issueId)` timer 接线点、注册 worker。dispatch 成功仅表示 worker task 已被接纳，不要求 Codex 握手完成。

2. **`WorkerControl` 是 orchestrator 拥有的 handle**：持有 attempt `AbortController`，`stop(reason)` 幂等（第一次 reason 生效，重复调用返回同一 Promise），并等待 runner 真正完成收尾后才 resolve；`markCompletion()` 让 authority 的 outcome 归约先于 `stop` resolve。停止上界由 agent 层自身的 `shutdownTimeoutMs` 与 workspace hook effective timeout 提供，不额外引入会"宣布退出却让 runner 继续跑"的硬超时。

3. **`AgentAttemptOptions` 增加最小 public API**：可选 `signal?: AbortSignal` 与 `onPhase?: (phase: RunAttemptStatus) => void`。取消覆盖 launch 前 / workspace·hook 后 / 握手中 / turn 等待 / continuation 等待 / finally；握手期取消会终止已 launch 的 transport，不遗留孤儿子进程。旧调用不传时行为不变。

4. **统一 outcome 入口**：runner 正常 resolve 与异常 reject 都经 `completeAttempt(issueId, token, outcome)` 归约一次。`outcome.ts` 以**主动 stop reason 优先于底层错误码**分类终态，区分 `port_exit`，映射到 §7.2 的 `succeeded` / `failed` / `timed_out` / `stalled` / `canceled_by_reconciliation`；shutdown 经 `suppressRetry` 表达"不安排 retry"，不新增 domain 状态。outcome 带 `suppressRetry` / `retryKind` 供 M5.3。

5. **claim 交接**：归约后先调用 `onOutcome`（M5.3 可在此为 issue 建立 `retryAttempts`），再在"没有 retry entry"时释放 claim。M5.2 默认释放；retry 保留由 M5.3 接管。

6. **attempt token 隔离**：每个 worker 有唯一 token；事件 / 阶段 / 结果回调都先校验 token 仍是该 issue 的当前 owner，旧 worker 的迟到消息不改状态。

7. **telemetry 记账**：只消费稳定 `AgentEvent`。缺席字段不覆盖；身份不完整不伪造 session；turn 按身份去重计数；token 按 thread 绝对快照的正差额入账，重复不重复计、回退保留已入账高水位；rate limits 原样保存不解释。

8. **continuation decider 注入**：`createTrackerRefreshContinuationDecider()` 在 orchestrator 内实现"每 turn 后 `fetchIssuesByIds` refresh → active+routable continue / 否则 stop"，agent 不 import tracker；refresh 失败 / 超时沿 `continuation_failed` / `continuation_timeout`；取消或 attempt 过期后迟到 refresh 不写状态。只决定 same-thread continue / stop，不读并发 slot 或 claim eligibility。

## Alternatives considered

- **在 orchestrator 里直接 spawn / 管理 Codex 子进程**：违反 SPEC §7 与依赖方向，且会把 wire 解析带进 coordination 层。否。
- **用 `Promise.race` 给 `stop()` 加超时后立即宣布退出**：会让 runner / child 在 orchestration 认为已停止后继续运行，破坏 M5.4 的 stall / reconciliation 语义。改为等待真实收尾，上界复用 agent 层既有 timeout。否。
- **把取消信号只包在 runner 外层 Promise 上**：握手期 child 由 `startAppServerSession` 内部持有，外层 race 无法及时停止它。因此在 `launchTransport` / `startAppServerSession` / `executeContinuationDecider` 内部贯通 signal。否。
- **新增 `attempt_cancelled` 错误码**：会扩大已冻结的 `AGENT_ERROR_CODES` 契约（现有测试断言恰好 14 个），而 orchestrator 已用自己记录的 stop reason 分类。复用 `turn_cancelled` 更小。否。
- **在 `LiveSession` 上新增 `lastTurnId` / `seenTurnIds` 做去重**：会改 domain 契约；turn 在 runner 内顺序 await，实际不会乱序，简单 `turnId !== session.turnId` 足够。否。
- **让 worker 直接修改 runtime state**：违反单一写入者。worker 只发带 token 的回调。否。

## Consequences

- orchestrator 只依赖稳定 `AgentEvent` / `AgentAttemptOptions` / `result`，不接触 `ChildProcess` 或 raw Codex JSON（由 `src/boundaries.test.ts` 结构测试守住）。
- M5.3 通过 `onOutcome` 与 `cancelRetry` 接线点接管 claim 保留与 timer 所有权，不需要改动 authority 的提交段；M5.4 通过 `getWorker().stop()` 复用取消能力。
- agent 公共面新增两个可选字段；`AGENT_ERROR_CODES` 保持不变。
- 后续承诺：`dispatchIssue` 的提交段必须保持"无 `await`"；不得把 retry / tracker policy 下沉到 agent；不得在 orchestrator 引入 Codex wire method literal 依赖。
