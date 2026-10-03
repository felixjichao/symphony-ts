# Agent Note: Retry queue 与 timer ownership 契约

Status: accepted

## Problem

M5.3（NEST-76 / #52）要在 `@symphony/orchestrator` 落地 worker 退出后的 retry queue、timer 所有权、normal continuation retry 与 failure exponential backoff，以及 retry timer fired 后的完整 refresh / re-dispatch（SPEC §8.4、§14.2、§16.6、§17.4）。约束：

- orchestrator 是 scheduling state 的唯一写入者：retry entry、timer、claim 的变更都必须串行化为 authority 的显式 transition；
- SPEC §7.4 要求 launch 前检查 `claimed` + `running`，但 §16.6 的 retry 恰需在 claim 保留的情况下重新派发（`retry_dispatch_allowed(ignore_existing_claim=issue_id)`）——两条规则冲突，需要明确的 claim 消费路径；
- timer 是异步事件源：迟到 / 已取消 / 被替换的回调不得删除新 entry、不得启动重复 worker、不得绕过 ownership 改 state；
- 测试不得依赖真实 10 秒 / 5 分钟 sleep；timer / 时钟必须可注入；
- terminal retry refresh 的 workspace 清理必须走 workspace 包的安全边界，本包不得做 destructive fallback。

需要定下：retry 数据与 timer 归属、token 隔离口径、refresh 的异步 ownership 校验点、以及重派的 claim 语义。

## Decision

1. **authority 独占 retry 状态与 timer 所有权**。retry 逻辑作为 `OrchestratorAuthority` 的方法实现，`state.retryAttempts`、timer、`claimed` 的写入全部经 authority。新增 `RetryScheduler` / `RetryOptions` 端口（`src/retry.ts`）：timer、单调时钟（复用既有 `monotonicNow`）、`maxRetryBackoffMs` getter、terminal cleanup 端口、诊断出口都可注入；默认 scheduler 用 `setTimeout`。调度状态不进入 domain 契约，`RetryEntry.timerHandle` 仍是不透明句柄。

2. **入队口径**：`completeAttempt()` 归约后按 `retryKind` 建 entry。normal exit → `attempt = 1`、`1000` ms、`error = null`（continuation）；abnormal exit → `attempt = (RunAttempt.attempt ?? 0) + 1`、`failureRetryDelayMs(attempt, maxRetryBackoffMs())`、`error` 取终态 error。`suppressRetry`（reconciliation / terminal / shutdown）不入队。每次新建时读取**当前** effective cap，已有 timer 不因 cap 变化自动改期。retry 的 `attempt` 与同线程 `turnCount` 完全分离。

3. **替换与取消**：`scheduleRetry()` 先取消同 issue 旧 timer（SPEC §8.4 "cancel any existing retry timer"）再写新 entry 并保留 claim（`RetryQueued` 属 claimed）。`cancelScheduledRetry()` 使排队 timer 与在途 refresh token 同时失效，供 M5.4 shutdown / M5.5 reload 复用。

4. **ownership token 隔离**：每次排队分配独立 token 写入 authority 私有 `retryOwners`。timer 回调只提交 `handleRetryTimerFired(issueId, token)`，**入口与每个 await 之后**都校验 token；stale / canceled / 被替换的迟到回调、重复 firing 一律丢弃，绝不 duplicate dispatch。旧回调即使已进入事件队列也不能删除新 entry。

5. **refresh 期间保留 claim**：timer fired 先 pop entry（保留 claim 与 refresh ownership），再 `fetchIssuesByIds([issueId])` refresh。结果分支严格按请求 issueId：fetch 失败 → 保留 claim、`attempt + 1` failure backoff、error `retry refresh failed`；missing → 释放 claim（不 cleanup）；terminal → 安全 cleanup + 释放；inactive / unroutable / 缺必填字段 → 释放、不 dispatch、不 cleanup；active+routable 且 slot 不足 → 保留 claim、`attempt + 1`、error 精确为 `no available orchestrator slots`；active+routable 有 slot → 用 entry.attempt 重派。

6. **重派走专用内部提交路径**：新增 `isRetryDispatchAllowed(issue, state, policy, ownClaimIssueId)`（§16.6 `ignore_existing_claim`），只豁免该 issue 自己的 claim，仍拒绝 running / 其它 claim / terminal / inactive / unroutable；slot 由调用方单独检查以区分"不可派发"与 slot 不足。重派复用 `commitDispatch()` 的无 `await` 提交段，普通 `dispatchIssue()` 不豁免 claim，不公开通用 `ignoreClaim` 开关。同步构造失败按 failure 重排（§16.4 "failed to spawn agent"）。

7. **terminal cleanup 只经端口，并与同 issue 后续 launch 串行**：`cleanupWorkspace.removeWorkspace(identifier)` 与 `WorkspaceManager.removeWorkspace` 结构兼容；`refused` / `failed` / 异常经 `onDiagnostic` 暴露并释放该 retry claim，不启动 worker、不做删除 fallback。更重要的是：cleanup 是**异步删除**，ownership token 只能保护内存状态、无法撤销已经发生的目录删除，因此 authority 维护 `cleanupInFlight: Map<issueId, Promise<void>>`——cleanup 在途时，同 issue 的 retry refresh / 重派必须先 `await` 该 promise 且重新校验 token；普通 `dispatchIssue()` 也直接 `skipped`。这样"旧 cleanup 删目录"与"新 worker 用 workspace"不会交叠。

8. **默认 scheduler 用分段 timer**：Node `setTimeout` 对超过 `2^31 - 1` ms 的延迟会压成 `1` ms（`TimeoutOverflowWarning`），而配置解析接受任意正整数 `max_retry_backoff_ms`（如 `3_000_000_000`），failure backoff 因此可能超过该上限。默认 `createRetryScheduler()` 把延迟按 `RETRY_MAX_TIMER_DELAY_MS = 2_147_483_647` 拆成连续多段，`cancel` 同时取消当前段，从而保持规定的实际触发时间，而不是静默压缩 effective cap。

## Alternatives considered

- **把 retry 状态放到独立 `RetryQueue` 类并让它直接改 `state`**：会让"单一 authority"出现两个 state 写入者，异步 refresh 与 dispatch 交叉时难以论证原子性。改为 authority 独占，纯逻辑（延退 / eligibility）抽成函数。否。
- **timer 回调直接持调度状态并在回调内 pop + dispatch**：失败路径（fetch 失败、slot 不足、并发替换）会把 partial state 暴露给下一次 tick，且旧回调可删新 entry。改为回调只提交带 token 的到期事件，ownership 由 authority 校验。否。
- **回调入口校验一次 token 即可（不校验 await 之后）**：refresh 是网络 await，期间可能被新 retry 替换、被 cancel 或进入新 lifecycle；只在入口校验会让迟到结果覆盖新状态。改为等待前后都校验。否。
- **公开 `dispatchIssue(issue, { ignoreClaim: true })` 让 retry 复用普通路径**：等于对所有调用方敞开 claim 绕过，普通候选可抢 retry claim。改为私有专用入口 + 纯函数 `isRetryDispatchAllowed`。否。
- **timer fired 时先释放 claim 再 refresh，失败再重新 claim**：违反 §7.4（launch 前 claim 必须已持有），且释放瞬间普通 dispatch 可能抢占同一 issue。改为 refresh 全程保留 claim。否。
- **terminal cleanup refused / failed 时做 `fs.rm` fallback**：会把 destructive 动作带出 workspace 包的 containment 校验（§9.5）。改为只记诊断 + 释放 claim。否。
- **只在 cleanup 结束后检查 token（不串行化 launch）**：token 只能避免覆盖内存状态，无法撤销旧 cleanup 已经/正在进行的目录删除；新 worker 可能写入随后被删的 workspace（审查已复现）。改为 `cleanupInFlight` 让后续 refresh / launch 先等待删除结束。否。
- **把超过上限的 backoff clamp 到 `2^31 - 1`**：会静默改变 effective `max_retry_backoff_ms` 语义，使实际派发时间短于 `dueAtMs` 与公式。改为分段 timer 保持延迟。否。
- **把 `delay` 直接算成绝对 `dueAtMs` 交给 scheduler**：scheduler 需要的是相对延迟，且 `dueAtMs` 归 domain 记录（单调时钟）。由 authority 计算 `delayMs` 并记录 `dueAtMs = nowMs + delayMs`，scheduler 只负责按时回调。否。
- **引入第三方 timer / fake-timer 库**：增加依赖且与仓库"最小依赖"约定冲突；测试用注入的手动 `RetryScheduler` 即可确定性触发。否。

## Consequences

- M5.4 通过 `getWorker().stop()` + outcome 的 `retryKind` 复用 retry 入队；shutdown / reconciliation 经 `cancelScheduledRetry()` 使 timer 与在途 refresh 失效；M5.5 poll loop 只需提供当前 effective `maxRetryBackoffMs` getter 与 cleanup 端口。
- 后续承诺：retry dispatch 的提交段必须保持"无 `await`"；timer 回调不得直接改 state 或调 runner，只能提交带 token 的事件；不得在 orchestrator 内引入真实 sleep、增依赖或把 workspace 删除逻辑内联。
- 已发布公共面新增 `RetryScheduler` / `RetryOptions` / `RetryDiagnostic` / `isRetryDispatchAllowed` / `scheduleRetry` / `cancelScheduledRetry`；`RetryEntry` domain 契约不变。
- retry 是 in-memory only（§14.3）：进程重启后 timer 与队列不恢复。
