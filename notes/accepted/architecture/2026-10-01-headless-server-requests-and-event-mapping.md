# Agent Note: Headless Server Requests 处理与 Runtime Event 映射 (M4.4)
Status: accepted

## Problem

在 M4.3（#39）交付 live session 基础生命周期后，Codex app-server 的双向交互协议处理（server→client requests）与 SPEC §10.4 / §10.5 / §10.6 / §17.5 规定的 headless 运行时事件映射仍未就绪。根据 SPEC 规定，Symphony 运行在无人工交互的 headless 模式下，需要满足以下核心设计与契约约束：

1. **审批请求（Approval Server Requests）处理**：
   - Codex app-server 会在命令执行或文件修改时发出审批请求，包含 v2 协议（`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`）与 legacy 协议（`execCommandApproval`、`applyPatchApproval`）。
   - 在配置 `approvalPolicy === "never"` 下，自动回包同意（v2: `{ decision: "accept" }`；legacy: `{ decision: "approved" }`），发射 `approval_auto_approved` 运行时事件，turn 顺利执行完成。
   - 在非 `"never"` 策略下（如 `"on-request"`、object 粒度策略、null 或缺省），回包拒绝（v2: `{ decision: "decline" }`；legacy: `{ decision: "abort" }`），发射 `turn_ended_with_error` 事件，并使 turn 以类型化错误 `AgentError("approval_required")` 稳定失败且不挂起，标记 session 致命错误。
   - 权限请求 `item/permissions/requestApproval` 即便在 `never` 策略下也不得自动批准，必须回包错误并以 `approval_required` 失败。
2. **人工输入与 MCP 交互请求**：
   - 收到 `item/tool/requestUserInput` 时返回 JSON-RPC 错误（code -32000）；收到 `mcpServer/elicitation/request` 时返回 `{ action: "cancel", content: null, _meta: null }`。
   - 发射 `turn_input_required` 事件，turn 立即以 `AgentError("turn_input_required")` 稳定失败，不得无界挂起。
3. **动态工具调用（Unsupported Tool Calls）**：
   - 当收到未注册或动态工具调用 `item/tool/call` 时，回包结构化失败 `{ success: false, contentItems: [{ type: "inputText", text: "Unsupported tool" }] }`。
   - 发射 `unsupported_tool_call` 事件，且**不得**中断当前 turn 或标记 session 失败；turn 可正常完成，且后续 turn 仍可在同一 session 上继续执行。
4. **遥测数据提取（Telemetry Extraction）**：
   - `thread/tokenUsage/updated`：仅提取 `total` 字段快照（`inputTokens`, `outputTokens`, `totalTokens`），忽略 `last`，不累加、不填零。只接受非负有限整数，非法数据触发 `malformed` 事件并安全跳过。发射附带 `usage` 对象的 `notification` 事件。
   - `account/rateLimits/updated`：提取 account 级限流快照，作为 opaque 对象保存在 `notification` 事件的 `rateLimits` 字段中，不强加 turn 身份。
5. **协议时序与收敛健壮性**：
   - 早到 completion（`turn/completed` 早于 `turn/start` 响应）：有界暂存并在取得 turn 身份后先发 `session_started` 再结算完成事件。
   - 异 thread / 异 turn 的 completion：作为 `other_message` 事件记录，不影响当前 turn 结算。
   - 等待 `turn/start` 响应期间收到 fatal request（如 `user-input`）：立即通过 Promise rejection 失败并向外冒泡，不发生 unhandled rejection 或挂起。
   - 监听器（listener）回调异常严格隔离，不破坏 transport 与 session 执行。

## Decision

在 `packages/agent/src/transport.ts` 与 `packages/agent/src/app-server-session.ts` 落地 Headless Server Requests 处理与 Runtime Event 映射：

1. **Transport 双向面增强**：
   - `TransportListener` 增加 `onOtherMessage` 与 `onActivity` 回调。
   - 消除 numeric 与 string request ID 碰撞（`pendingKey` 改用 `'n:' + id` 与 `'s:' + id` 前缀区分）。
   - 保持严格协议/诊断隔离，listener 异常隔离不向外部冒泡。
2. **`AppServerSession` 路由与事件发射**：
   - 集中路由 `handleServerRequest`：针对 v2/legacy approval、user-input、mcp-elicitation、permissions、tool-call 等方法分别进行响应。
   - 映射规范定义的全部 12 种 `AgentEvent`（`session_started`, `turn_started`, `turn_completed`, `turn_failed`, `turn_cancelled`, `turn_ended_with_error`, `turn_input_required`, `approval_auto_approved`, `unsupported_tool_call`, `notification`, `malformed`, `other_message`）。
   - 保持对外公共契约不暴露任何 raw Codex JSON，保持对 domain / config / workspace 的严格依赖约束。
3. **Turn 控制与早到时序解耦**：
   - `startTurn()` 直接返回 Promise 并异步发起 `turn/start` 请求，确保早于 `turn/start` 响应到达的 fatal request 能够立即触发 promise rejection，防止 Node.js unhandled rejection 与调用方挂起。
   - 通过 `activeTurn.settled` 与有界暂存队列（最大 4 条）处理 early completed 时序，保证 `session_started` 始终在终态事件之前发射。

## Alternatives considered

- **自动批准所有 server request**：考虑过是否直接全部回包 accept。但这会严重违背安全性与 headless 语义（例如 permissions 或未知危险操作），且 SPEC §10.5 明确要求非 `never` 策略及 user-input 必须立即以可判别错误失败。
- **让 `item/tool/call` 也导致 turn 失败**：Codex 架构允许模型在动态工具调用失败后根据返回的错误提示自行尝试备选方案或给出结论。回包 `{ success: false }` 符合模型交互协议，且保持 session 与 turn 正常可用。
- **在 `app-server-session` 内部累加 tokenUsage**：SPEC §10.5 明确指定 `total` 为绝对快照值。各 turn 和通知可能重复或异步，如果 Symphony 本地做累加会导致数值严重失真。因此严格保持快照语义。

## Consequences

正面：
- SPEC §10.4 / §10.5 / §10.6 / §17.5 涉及的 headless server request 裁决、遥测提取与全部 12 种 runtime events 映射全部落地并通过 23 个专用验收用例（总计 92 个用例全部通过）。
- `approvalPolicy === "never"` 与非 `never` 分支、人工输入即时失败、动态工具调用优雅降级与 early completion 缓冲完全收敛。
- 零新增外部依赖，严格遵守 contracts 守卫。

负面与后续承诺：
- prompt 组装（SPEC §12）、continuation 执行与 `agent.max_turns` 强制留待 M4.5。
- 跨包集成与 orchestrator 调度留待 M4.6 / M5。
