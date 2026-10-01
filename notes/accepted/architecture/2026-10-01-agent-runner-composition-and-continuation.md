# Agent Note: Agent Runner 组合与 Continuation 执行契约 (M4.5)
Status: accepted

## Problem

在 M4.1–M4.4 陆续交付 Codex 协议基线、NDJSON transport 内核、Codex live session 生命周期以及 headless server request 处理之后，Symphony 仍缺少将 workspace、config prompt renderer 与 session client 组合在一起的单一 worker attempt 驱动原语（SPEC §10.7 / §12 / §16.5）。

根据 SPEC 与任务契约要求，该原语需要解决以下关键问题：
1. **Attempt 执行生命周期与错误优先级**：
   - 顺序：create/reuse workspace → before_run → prompt render → start Codex session → first turn → continuation turns → stop session → after_run best-effort。
   - `before_run` 失败或 prompt 渲染失败必须发生在 child launch 之前，直接阻断子进程启动。
   - `after_run` 必须在正常完成、startup failure、turn failure、timeout、decider failure 时均以 finally-style 执行，且其自身失败（退出非零或超时）绝不覆盖原始 attempt 结果。
   - attempt 结束后，workspace 目录与业务文件不主动删除（SPEC §10.7）。
2. **Continuation 机制与依赖反转**：
   - SPEC §10.2 / §10.3 规定多个 turn 必须在同一个 live thread 上继续执行，各 turn 的新 turn ID 由 app-server 返回。
   - Continuation turns 绝不能重新渲染或重发完整原始 prompt，需发送固定的简洁指导文本。
   - 契约隔离：`packages/agent` 严禁 import `@symphony/tracker` 或 `@symphony/orchestrator`。turn 完成后是否继续、如何 refresh 工单状态属于 M5 协调层职责，agent runner 仅通过依赖反转接口 `ContinuationDecider` 接收外部判定。
   - decider 等待必须有界（默认 30 秒），超时或决议非法必须可判别失败，迟到 resolve/reject 不得触发 unhandled rejection。
   - `agent.maxTurns` 作为硬上限控制 attempt 生命周期内的总 turn 数。
3. **错误分类与启动退出判定**：
   - 当 `codex.command` 可执行文件不存在或 shell 启动阶段非主动 exit 127 时，必须在握手阶段准确分类为 `codex_not_found`，保留底层 exit 信息为 cause。

## Decision

在 `packages/agent` 新增 `src/agent-runner.ts`，扩展 `src/continuation.ts` 与 `src/errors.ts`，提供稳定的 `runAgentAttempt()` 原语：

1. **Attempt 执行主干与收尾**：
   - 读取启动时的 `workspace` / `codex` / `agent.maxTurns` 配置，创建真实 `WorkspaceManager` 并调用 `createWorkspace`。若 create 失败，直接抛错，不执行 `after_run`。
   - 在覆盖后续流程的 `try/finally` 中，依次执行 `before_run`（调用时获取当前 `getConfig().hooks`）、严格 `renderPrompt()` 与 `startAppServerSession()`。
   - 收尾时在独立的 finally 块中先 await `session.stop()`，再执行 `runAfterRunHook()`。若已有主失败，任何收尾错误均不替换它；若正常完成但 stop 失败，映射为 `port_exit`。
2. **Continuation 循环与指导文本**：
   - 默认指导文本固定为：`Continue working on the same issue using the existing thread and workspace context. Do not restart from scratch or repeat completed work.`。
   - 首轮 turn 传入渲染好的 prompt 模板；后续 continuation turns 传入指导文本。
   - 每次 turn 成功完成后从事件流捕获 `turn_completed` 并调用 `executeContinuationDecider()`。
   - 若 decider 返回 `stop`，attempt 以 `stopReason: "decider_stop"` 正常结束；若返回 `continue` 且 `turnCount >= maxTurns`，attempt 以 `stopReason: "max_turns"` 正常结束；否则更新 issue 快照并继续下一轮 turn。
3. **有界 Decider 等待与取消**：
   - `executeContinuationDecider()` 默认提供 30 秒超时窗口，传入包含 `signal: AbortSignal` 的 `TurnCompletedContext`。
   - 超时触发 `controller.abort()` 并抛出 `AgentError("continuation_timeout")`。
   - 决议返回后严格校验 issue ID 一致性；decider 抛错或返回非法对象封装为 `AgentError("continuation_failed")`。
   - 超时后到达的 late resolution 或 late rejection 在内部吞掉，杜绝进程级 unhandled rejection。
4. **握手期 Exit 127 分类**：
   - `startAppServerSession()` 监听子进程 exit info。若在握手完成（initialize / thread/start）前子进程非主动退出且 exitCode 为 127，将 `port_exit` 映射为 `AgentError("codex_not_found")`，并将原错误保留在 `cause` 中。已建立 session 的后续 turn 退出保持 `port_exit`。

## Alternatives considered

- **在 Continuation Turn 中重新渲染并发送完整 prompt**：
  不采纳。这会导致严重的 token 浪费与上下文重复，违背 SPEC §10.2；且模型在已有 thread 历史中已经持有原始任务背景，简短的 guidance 即可引导模型继续推进未完成部分。
- **让 Agent Runner 内建 tracker 状态检查与 eligibility 过滤**：
  不采纳。这会直接破坏项目的核心依赖规则（agent 不得 import tracker / orchestrator）。因此通过 `ContinuationDecider` 将策略完全注入，agent 仅执行决策、不解释工单状态。
- **对 Decider 等待不设超时或允许无界挂起**：
  不采纳。外部注入的 tracker refresh 网络请求如果发生挂死，会导致整个 worker attempt 泄漏并不响应。默认 30 秒有界等待并在超时后发出 AbortSignal，能保证 runner 生命周期稳定收敛。
- **Attempt 结束后删除 workspace**：
  不采纳。SPEC §10.7 明确要求保留 attempt 结束后的 workspace，以便进行增量 attempt 或人工复查调试。workspace 的清理属 M5 startup sweep / reconciliation 的职责范围。

## Consequences

正面：
- SPEC §10.7、§12、§16.5 规定的 Agent Runner 组装、prompt 渲染、continuation 机制与 turn 预算完全落地。
- 交付并通过全套 14 个专用验收测试（`agent-runner.test.ts`），包内 111 个用例全绿。
- AST 级别断言持续守卫架构边界，保持 `agent → domain + config + workspace` 依赖方向。

负面与后续承诺：
- 跨包 Core Conformance 收口（端到端 WORKFLOW.md → Runner）留待 M4.6。
- 真实的 tracker refresh 逻辑与多工单调度分配留待 M5。
