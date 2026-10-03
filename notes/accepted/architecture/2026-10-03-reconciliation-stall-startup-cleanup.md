# Agent Note: Reconciliation、stall 与 startup cleanup 契约

Status: accepted

## Problem

M5.4（NEST-77 / #53）要在 `@symphony/orchestrator` 落地 active-run reconciliation、stall detection、terminal cleanup 与 startup terminal workspace sweep（SPEC §7.3 / §7.4、§8.5 / §8.6、§14.2 / §14.3、§16.3、§17.4）。需要定下四类跨切面问题：

1. **时钟口径**：SPEC §8.5 Part A 的 `elapsed_ms` 以 `last_codex_timestamp`（存在 agent event 时）或 `started_at` 为基准；而 `lastCodexTimestamp` 是 UTC 墙上时钟、`RunningEntry.startedAtMs` 是单调时钟。两者不可相减。身份未齐时 `entry.session` 可能尚未物化，若只读 `entry.session` 会漏掉握手期事件，把活跃 worker 误判为 stall。
2. **异步 refresh 与 worker 自然退出的竞态**：`fetch_issues_by_ids` 是网络 await，期间 worker 可能自然退出（已建立 retry）、也可能被更新 attempt 接管；迟到刷新结果不得作用于新生命周期，且不得产生 duplicate retry。
3. **stop + cleanup 的次序与互斥**：terminal 的"先停 worker、再删 workspace"必须确定，且删除是异步的——ownership token 只能保护内存状态，无法撤销已发生的目录删除；terminal 从请求 stop 起就需要屏障，否则新 worker 可能在 stop 返回与 cleanup 登记之间抢入。
4. **cleanup 归属与 startup sweep 的失败面**：原 M5.3 的 `cleanupWorkspace` 依附 `RetryOptions`，导致不启用 retry 时 terminal cleanup 不存在；startup sweep 还要求 fetch 失败不阻止启动、单项 refused / failed 不阻断其余项、且不得绕过 workspace 包的 containment。

## Decision

1. **纯判定抽到 `src/reconciliation.ts`**。`decideReconciliationAction(issue, policy)` 只表达三个分支（terminal → `stop_and_cleanup`；active ∧ routable → `refresh_snapshot`；其余 → `stop`）；stall 判定为纯函数，authority 只负责副作用与状态写入。

2. **stall 使用同一 UTC 时钟域**：`max(nowUtc - (session.lastCodexTimestamp ?? telemetry.pendingLastTimestamp ?? attempt.startedAt), 0)`，负差值按 0；`stallTimeoutMs <= 0` 或非有限值整体禁用；仅 `elapsed > timeout` 触发（等于不触发）。身份未齐的暂存 `pendingLastTimestamp` 也推进活动时间，因此握手期事件不会漏算。单调时钟继续只用于运行时长与 retry `dueAtMs`，不改共享 domain 契约。

3. **reconcile 顺序 = 先 stall 后 refresh**（SPEC §16.3）。Part A 不调用 tracker，因此后续 fetch 失败不撤销已执行的 stall 判定。Part B **在 Part A 完成后、按当前仍在 running 的集合取剩余**（stall 收尾 / 其他 await 期间自然退出或被替换的 worker 不参与本次 fetch，也不进入请求集），**剩余为空时直接返回、零 tracker 请求**；fetch 前捕获每个 issue 的 attempt token，批量 `fetchIssuesByIds(runningIds)`，只处理本次请求的 ID；active+routable 更新 snapshot、terminal stop + cleanup、其余 stop 不 cleanup。只有真正参与本次 fetch 的生命周期才参与后续退出竞态处理。

4. **迟到结果同时按 reconciliation epoch 与 lifecycle generation 丢弃**：
   - **reconciliation epoch**：每次 `reconcileRunningIssues()` 在同步捕获 running 集合时为每个 issue 分配递增 epoch，覆盖更早调用在该 issue 上的写入权。异步 refresh 返回后只有仍持有最新 epoch 的调用才允许更新 snapshot / stop / cleanup——重叠调用**不串行阻塞**，而是按**发起顺序**决胜，较晚发起的调用结果永不被较早调用的迟到结果回退（无论两者 fetch 完成顺序如何），迟到 inactive / terminal 也不会错误停止已恢复 active 的 issue。
   - **lifecycle generation**：每次 `commitDispatch()`（首跑或 retry / continuation 重派）递增该 issue 的代数并跨 worker 退出 / retry 排队保留。refresh 结果返回后若代数已变，说明该 issue 已被更新的生命周期接管，整条丢弃。
   - **因此**：仅凭"`active` 中无该 issue"**不足以**判断当前 retry 属于捕获的旧 attempt——旧 attempt 退出后其 continuation retry 可能已派发新 worker，新 worker 再次退出会留下**新生命周期**的 retry（attempt 更大）。generation 校验保证这种情况整条丢弃，不会误取消后来者的 retry / claim。只有 epoch 与 generation 都不变、且原 attempt 已自然退出、判定为 stop 时，才取消该旧生命周期的 retry 并释放 claim（terminal 仍清理 workspace）；判定为 active 更新时交给自然退出的 retry 流程。

5. **cleanup 端口提升为 authority 顶层能力**：`OrchestratorAuthorityOptions.cleanupWorkspace` 优先，缺省回退 `RetryOptions.cleanupWorkspace`（保留 M5.3 接线兼容）；诊断同理（`onCleanupDiagnostic` → `retry.onDiagnostic`）。因此 reconciliation / startup sweep 的 cleanup 不再依赖是否启用 retry。

6. **per-issue 收尾屏障覆盖"请求 stop → 删除完成"**：`withCleanupBarrier(issueId, action)` 在 map 中登记最新未结束屏障，晚到的收尾串行排队在既有屏障之后（不覆盖、不提前解除互斥）；terminal 的屏障**先于 stop 建立**，次序固定为"屏障 → stop → outcome/after_run 完成 → removeWorkspace → 释放屏障"。`dispatchIssue` 与 retry refresh 继续通过 `cleanupInFlight` 等待。

7. **startup sweep 独立可调用、best-effort**：`runStartupTerminalCleanup()` 按 `policy.terminalStates` 经 tracker `fetchIssuesByStates` 拉取（不附加 required-label / dispatchable 筛选），逐 identifier 调用注入的 `removeWorkspace`；`removed` / `missing` 视为成功，`refused` / `failed` / 异常只记诊断并继续，绝不 `fs.rm` fallback、不复制 containment；fetch 失败诊断后返回、不阻止启动。首个 dispatch 前的调用顺序由 M5.5 编排。

## Alternatives considered

- **把 `pendingLastTimestamp` 排除、只用 `entry.session.lastCodexTimestamp ?? startedAt`**：握手期（session 未物化）的事件会被忽略，活跃 worker 可能被误判 stall。改为回退暂存时间戳。否。
- **用 `monotonicNow - entry.startedAtMs` 计算 stall**：两个时钟域不可减；且 SPEC §8.5 明确以 event 时间戳 / `started_at`（UTC）为基准。改为统一 UTC 域。否。
- **`elapsed >= timeout` 触发**：SPEC 写的是 `elapsed_ms > codex.stall_timeout_ms`，边界相等不应终止。改为严格大于。否。
- **reconcile 先 refresh 再 stall**：SPEC §16.3 明确先 `reconcile_stalled_runs`；且 tracker 失败不应影响 stall 判定。否。
- **只按 issueId 处理 refresh 结果，不捕获 attempt token**：新 attempt 已接管时旧结果会覆盖新生命周期（错误 stop / 错误快照）。改为 token 校验。否。
- **原 attempt 已自然退出就直接跳过、不取消其 retry**：terminal 情况下会留下对 terminal issue 的 continuation retry（延迟清理，甚至在不启用 retry 时泄漏 workspace）。改为 stop 分支取消旧生命周期 retry 并释放 claim。否。
- **仅凭"`active` 中无该 issue"判断 retry 归属**（首版实现的假设）：旧 attempt 的 continuation retry 可能已派发新 worker、新 worker 再退出并留下 attempt 更大的 retry，此时无 active 但 retry 属**新生命周期**，无条件取消会误伤（审查 blocker 1）。改为持久追踪 lifecycle generation 并回校验。否。
- **串行化或合并重叠的 reconciliation 调用（后到调用等待前一个完成）**：会让一个慢 fetch 阻塞后续 tick，且把"哪次调用更新"绑定到完成顺序而非发起顺序。改为按发起顺序的 reconciliation epoch 决胜：不阻塞，但被覆盖的调用其迟到结果一律丢弃（审查 blocker 2）。否。
- **Part B 直接复用 stall 之前捕获的 running 集合**：stall 收尾是异步 await，期间其他 worker 可能自然退出并建立自己的 retry；把它计入请求集既违反 SPEC §16.3"stall 后再读取 running IDs"，也会在 refresh 省略该 ID 时误取消其刚建立的 retry（审查 blocker 3）。改为 Part A 完成后按当前 active/running + token/generation/epoch 过滤请求集。否。
- **继续让 `cleanupWorkspace` 只挂在 `RetryOptions` 下**：不启用 retry 时 reconciliation / startup 无 cleanup 端口，terminal workspace 会累积。改为顶层能力 + 旧接线回退。否。
- **cleanup 前不建立屏障，只在 stop 返回后登记 cleanup promise**：stop 返回与登记之间新 dispatch 可能抢入并把文件写进随后被删的目录。改为屏障先于 stop 建立。否。
- **后到的收尾直接覆盖 `cleanupInFlight` 的 promise**：前一个收尾结束时可能误删 map 中后一个 promise，提前解除互斥。改为按"最新屏障 + 串行排队"实现。否。
- **startup sweep 复用 retry 的 refresh 逻辑或在内联代码里做 `fs.rm` fallback**：前者把 startup 绑死在 retry 控制面，后者绕过 workspace 包 containment（§9.5）。改为独立方法 + 注入端口 + 只记诊断。否。

## Consequences

- M5.5 poll loop 只需按 tick 调用 `reconcileRunningIssues()`、启动时调用 `runStartupTerminalCleanup()`，并提供 `stallTimeoutMs` getter 与 effective `DispatchPolicy`；cleanup 端口与 retry 解耦，重叠调用由 authority 按发起顺序自行决胜，调用方无需外部加锁。
- 已发布公共面新增 `reconcileRunningIssues` / `runStartupTerminalCleanup` / 顶层 `cleanupWorkspace` / `onCleanupDiagnostic` / `stallTimeoutMs`，以及 `reconciliation.ts` 的纯函数与类型；`RetryDiagnostic.kind` 扩展为含 `cleanup_fetch_failed` / `cleanup_unavailable` 且 `issueId` 可为 `null`（startup 级诊断无单一 issue）。内部新增 per-issue `reconcileEpoch` 与 `lifecycleGeneration`（不进入 domain 契约）。
- 后续承诺：authority 仍是唯一 state 写入者；本包不得内联 destructive 删除、不得引入真实 sleep、不得把 stall 判定与 refresh 顺序倒置；cleanup 必须始终经注入端口；任何异步 refresh 结果在写入前都必须回校验 reconciliation epoch 与 lifecycle generation。
- stall / reconciliation 仍是 in-memory only（§14.3）：进程重启后不恢复 worker 或 retry timer，靠 startup sweep + 重新轮询恢复。
