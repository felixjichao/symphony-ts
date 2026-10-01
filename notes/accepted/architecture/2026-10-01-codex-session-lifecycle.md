# Agent Note: Codex app-server live session 生命周期与 turn 协议适配
Status: accepted

## Problem

M4.2（#38）交付了 Codex 业务无关的 transport kernel 与 launch 边界，但 coding agent live session 的业务生命周期尚未建立。根据 SPEC §10.2 / §10.3 / §10.6 与 §17.5，需要在 transport 之上实现 pinned `rust-v0.159.2` schema（commit `ff6aec96`）的最小 session lifecycle。实现面临以下核心设计与约束：

1. **协议握手与时序核实**：pinned Codex 协议规定了 `initialize` request → `initialized` notification → `thread/start` request → `turn/start` request 的启动顺序。经核实上游 `codex-rs/core/src/turn_processor.rs::turn_start_inner` 实现，Codex 在 `turn/start` 接收成功后**立即**返回 `{ turn: { id, status: "inProgress", ... } }`，而 turn 执行完成通过 `turn/completed` notification 异步回报。这意味着默认 5s 的 `readTimeoutMs` 对 `turn/start` 请求本身完全够用，不需要在 transport 层增加 per-request timeout 覆盖。
2. **Turn 结束判定与旧假设纠偏**：部分旧参考实现或直觉假设存在 `turn/failed` 或 `turn/cancelled` 专用 notification method。而在 pinned schema 中，并没有这些 method；终止语义统一由 `turn/completed` notification 的 payload 决定（`turn.status ∈ "completed" | "interrupted" | "failed" | "inProgress"`）。必须根据 payload 中的实际 `turn.status` 进行判定，绝不能仅看 method 名。
3. **Turn stream silence timeout 与有效输出判定**：SPEC §10.6 与 §5.3.6 定义了 `turn_timeout_ms`（默认 1 小时）。这属于 silence timeout，即在 turn 执行期间，任何**有效 app-server 输出**（notification、server request、response 结算）都会重置该计时器。而诊断流 stderr 与 malformed 畸形输出不是有效的协议输出，不得重置该计时器。
4. **超时与进程生命周期解耦**：当 `turn_timeout` 发生时，session 仅结算并拒绝当前 turn Promise，**不主动 kill 子进程**（与 transport 的 `response_timeout` 哲学一致，进程收敛交由上层调用方的 `stop()` 统一管理）。
5. **身份与路径约束**：`thread/start` 返回的 `thread.sessionId` 是 Codex 内部标识，与 Symphony SPEC §4.2 的 `session_id` 无关，不得混用；Symphony session ID 严格由 `composeSessionId(threadId, turnId)` 合成。`thread/start` 与 `turn/start` 的 `cwd` 必须统一使用 per-issue workspace 的绝对路径。
6. **结构守卫约束**：运行期源码不得出现 `codex` import 路径，不得复制 pinned schema 禁用 token（`AskForApproval`、`SandboxPolicy`、`SandboxMode` 等），配置 policy 必须以 pass-through 形式透明映射。

## Decision

在 `packages/agent/src/app-server-session.ts` 落地 Codex app-server live session 适配层，作为包内唯一的协议适配器：

1. **Session 契约与启动序列**：
   - 导出 `AppServerSession` 接口与 `startAppServerSession(options)` 工厂函数。
   - `startAppServerSession` 严格按 `launchTransport()` → `initialize` request（`clientInfo: { name: "symphony-ts", title: null, version: "0.1.0" }`, `capabilities: { experimentalApi: false, requestAttestation: false }`）→ `initialized` notification（无 params）→ `thread/start` request（`cwd` 为 workspace 绝对路径，`approvalPolicy` / `sandbox` 在非 null 时 pass-through 写入）→ 校验提取 `thread.id` 并返回 session 实例。
   - 启动过程任意步骤失败均立即先调用 `transport.stop()` 再抛出类型化错误，杜绝孤儿子进程残留。
2. **`startTurn` 与单活跃 turn 不变量**：
   - 组装 `turn/start` params：`{ threadId, input: [{ type: "text", text, text_elements: [] }], cwd, approvalPolicy?, sandboxPolicy? }`。
   - 保持**单活跃 turn 不变量**：同一 session 在前一个 turn 尚未结算时再次调用 `startTurn`，立即拒绝为 `protocol_error`；session stop 后调用 `startTurn` 拒绝为 `port_exit`。
   - 支持同一 live thread 上连续执行多个 turn（thread ID 保持不变，turn ID 与 session ID 随每个 turn 生成）。
3. **`turn/completed` 状态判定与错误映射**：
   - `turn.status === "completed"` → resolve `TurnCompletedOutcome`（`{ turnId, sessionId: composeSessionId(threadId, turnId) }`）。
   - `turn.status === "failed"` → reject `AgentError("turn_failed")`，携带 `turn.error.message` 与上下文 details。
   - `turn.status === "interrupted"` → reject `AgentError("turn_cancelled")`，携带 `turn.error.message` 与上下文 details。
   - `turn.status === "inProgress"` 或未识别状态 → reject `AgentError("protocol_error")`（协议矛盾）。
   - 畸形 payload（缺少 turn / 非字符串 turn.id）→ reject `AgentError("protocol_error")`。
   - 不匹配当前 active turn 的迟到通知直接忽略，不影响当前 turn 等待。
4. **Silence Timer 机制**：
   - 启动 `turn/start` 时启动 `turnTimeoutMs` 定时器。每收到来自对端的有效 notification、server request 或 request response 结算时重置该计时器。
   - `onStderr` 诊断流与 `onProtocolIssue`（malformed/oversized）不重置计时器。
   - 超时触发 `AgentError("turn_timeout")`，清理定时器 handle，不主动终止进程。
5. **公共导出面**：
   - 在 `packages/agent/src/index.ts` 导出 `startAppServerSession`、`DEFAULT_TURN_TIMEOUT_MS`、`AppServerSession`、`AppServerSessionOptions`、`TurnCompletedOutcome` 以及 `WorkspacePathSafetyGate`。

## Alternatives considered

- **在 transport 层增加 per-request timeout 覆盖**：假设 `turn/start` 会被阻塞直到整个 turn 结束。查阅上游 `turn_processor.rs` 源码确证 `turn/start` 仅在启动提交后立即返回初始状态 `inProgress`，真正的耗时与完成完全走 `turn/completed` notification。因此 transport 层维持既有的 launch 级 `readTimeoutMs` 即可，无需破坏 transport 的简洁性。
- **沿用旧参考实现的 `turn/failed` / `turn/cancelled` 假想 method**：上游 pinned schema 中已无此类 method，所有结束状态统一封在 `turn/completed` 的 `turn.status` 中。如果只看 notification method 名称，会导致失败和中断 turn 被误判为成功，严重违背 SPEC §17.5。
- **Turn silence 超时直接 kill 进程**：虽然 kill 进程能强行收敛，但违背了分层隔离原则——client 负责协议会话的状态结算，进程维度的收敛与清理责任应归属于持有 session 生命周期的 runner（M4.5 的 finally 块负责调用 `session.stop()`）。保持与 transport `response_timeout` 相同的非主动 kill 策略使得错误恢复语义清晰统一。
- **将 `thread.sessionId` 用作 Symphony 的 `session_id`**：pinned Codex schema 的 `thread.sessionId` 是 Codex 内部生成的 UUID，而 Symphony SPEC §4.2 明确规定 `session_id` 必须是 `composeSessionId(thread_id, turn_id)`。混用会导致 tracker 与 orchestrator 的 session 关联错位。

## Consequences

正面：
- SPEC §10.2 / §10.3 / §10.6 与 §17.5 的 session startup、thread/turn/session identity 抽取、workspace cwd 绑定、基于 `turn.status` 的完成判定、silence timeout 及多 turn 复用全部落地并通过真实子进程 fixture 检验。
- 所有协议细节（方法名、payload 形状、状态枚举）严格封装在 `app-server-session.ts` 内，transport 保持纯净，对外公共契约保持稳定。
- `contracts.test.ts` 的结构守卫全面通过，未泄漏任何禁用 schema token 或非规范依赖。

负面与后续承诺：
- `ServerRequest` 的 approval / user-input policy 裁决与 `turn/*` → `AgentEvent` 事件流映射留待 M4.4。
- prompt 组装（SPEC §12）与 continuation 执行决策（`ContinuationDecider`）留待 M4.5。
- `turn_timeout` 时子进程仍在运行，依赖上层 runner 在 catch / finally 中调用 `stop()` 关闭进程。
