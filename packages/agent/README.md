# @symphony/agent

## Purpose

SPEC **§10 Agent Runner Protocol (Coding Agent Integration)** 与 **§12 Prompt Construction and Context Assembly** 的 owner 包，对应 §3 的 Agent Runner：组装注入 issue 上下文的 prompt、启动 coding agent 子进程（如 Codex app-server client）、把 live session 事件（token 消耗、turn 进度、PID）向上转发。**修改 Codex app-server 交互的唯一落点在本包。**

当前状态：**M4.1（#37）已落地契约层**——pinned Codex 协议基线、稳定 `AgentError` / `AgentEvent` 面、continuation 判定契约。**M4.2（#38）已落地 transport / launch 内核**——`bash -lc <codex.command>` 的真实子进程 launch、含 workspace cwd 校验的 launch 边界、JSON-RPC 2.0 over NDJSON 的 framing / request-id 关联 / read timeout / stderr 分流 / 有界关停（均为 Codex 业务无关，见下节）。**尚未落地**：initialize / thread / turn 生命周期、server request 的 approval 裁决、`turn/*` → `AgentEvent` 映射、prompt 组装（进度见 [docs/conformance.md](../../docs/conformance.md)）。

## Codex 协议基线

本包只承认一条协议基线，固定与升级规则见 [docs/upstream.md](../../docs/upstream.md)：

| 项 | 值 |
|---|---|
| upstream | https://github.com/openai/codex |
| release tag | `rust-v0.159.2` |
| commit | `ff6aec96948b70d94983af2641a6b67c94faeff5` |
| schema 来源 | `codex-rs/app-server-protocol/schema/typescript/**`（ts-rs 生成，与 `codex app-server generate-json-schema` 同源） |

与 Symphony SPEC baseline 是**两条独立版本轴**：SPEC 决定 orchestration / prompt / session 语义，Codex schema 决定 method / payload / framing。冲突时 wire 形状以 Codex 为准（SPEC §10 "Protocol source of truth"），理由与备选记录见 [Agent Note](../../notes/accepted/architecture/2026-09-30-codex-protocol-baseline-and-agent-contracts.md)。

### 本基线的 initialize / thread / turn 子集

| 步骤 | pinned 事实（来源文件） |
|---|---|
| 握手 | `initialize` 的 params 是 `{ clientInfo, capabilities }`，`InitializeCapabilities` 的 `experimentalApi` / `requestAttestation` **非 optional**；response 携带 `userAgent` / `codexHome` / `platformFamily` / `platformOs` |
| 建 thread | `thread/start` 的 params 接受 `cwd`、`approvalPolicy`、`sandbox`（`SandboxMode`）、`model`、`baseInstructions` 等可选覆盖；response 的 `thread.id` 就是 §4.1.6 的 `thread_id` |
| 起 turn | `turn/start` 的 params 必填 `threadId` + `input`，可带 `cwd` / `approvalPolicy` / `sandboxPolicy`（`SandboxPolicy`）覆盖；response 的 `turn.id` 就是 `turn_id`，`session_id = composeSessionId(threadId, turnId)` |
| turn 结束 | **本 baseline 没有 `turn/failed` / `turn/cancelled` notification method**。终止语义在 `turn/completed` 的 payload 里：`turn.status ∈ "completed" \| "interrupted" \| "failed" \| "inProgress"`，失败原因在 `turn.error`。因此"M4 只看 notification 方法名判断成败"在本基线是错的（SPEC §17.5 也要求按 targeted protocol 的实际状态判断） |
| 用量 / 限流 | usage 走 `thread/tokenUsage/updated`，rate-limit 走 `RateLimitSnapshot` 一类 notification；本包只**抽取并转发快照**，delta 聚合归 M5 / M6 |

### `codex.*` 配置到 wire 的映射

| `ServiceConfig.codex` | pinned schema | 落点 |
|---|---|---|
| `approvalPolicy` | `AskForApproval` = string 分支 ∪ `{ "granular": { … } }` object 分支 | `thread/start.approvalPolicy` / `turn/start.approvalPolicy` |
| `threadSandbox` | `SandboxMode` = 纯 string 联合 | `thread/start.sandbox` |
| `turnSandboxPolicy` | `SandboxPolicy` = 以 `"type"` 判别的 tagged object（`workspaceWrite` 带 `writableRoots: string[]` 等） | `turn/start.sandboxPolicy` |
| `command` | —（SPEC §5.3.6 / §10.1） | `bash -lc <codex.command>`，cwd = workspace path（M4.2） |
| `readTimeoutMs` / `turnTimeoutMs` / `stallTimeoutMs` | — | transport / orchestrator 侧计时（M4.2 / M5） |

形状证据只摘录这三条 type 表达式（完整 schema 一律回 pinned commit，本包不复制、不手维枚举）：

```ts
// v2/AskForApproval.ts
export type AskForApproval = "untrusted" | "on-request"
  | { "granular": { sandbox_approval: boolean, rules: boolean, skill_approval: boolean,
                    request_permissions: boolean, mcp_elicitations: boolean } }
  | "never";

// v2/SandboxMode.ts
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

// v2/SandboxPolicy.ts
export type SandboxPolicy = { "type": "dangerFullAccess" }
  | { "type": "readOnly", networkAccess: boolean }
  | { "type": "externalSandbox", networkAccess: NetworkAccess }
  | { "type": "workspaceWrite", writableRoots: Array<AbsolutePathBuf>, networkAccess: boolean,
      excludeTmpdirEnvVar: boolean, excludeSlashTmp: boolean };
```

这三条表达式**只出现在文档里**，不构成代码契约：`packages/agent` 的结构性测试会断言 domain / config / agent 的运行期源码里不出现这些成员名或生成类型名。

### Server request 与 headless policy（已定，实现随 M4.4）

pinned baseline 的 `ServerRequest` 联合包含：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/tool/requestUserInput`、`item/permissions/requestApproval`、`item/tool/call`、`mcpServer/elicitation/request`、`account/chatgptAuthTokens/refresh`、`attestation/generate`，以及 legacy `applyPatchApproval` / `execCommandApproval`。

headless worker 的确定策略（SPEC §10.5 允许 "fail the run according to its documented policy"；本小节就是那份文档，**M4.1 不实现**）：

- `approvalPolicy === "never"` 且 request 是可识别的 command / file-change approval → 返回 protocol-valid 批准，发 `approval_auto_approved` 事件；
- 其余 approval-required request → typed `approval_required` 失败；
- 真正需要人回答的 `item/tool/requestUserInput` → typed `turn_input_required` 失败；
- 未实现 / 未广告的 `item/tool/call` → 返回 protocol-valid structured failure **并继续 session**，不悬挂 request；
- 任何路径都不得无限等待 operator；provider-native tracker tools 不属 M4（§11.5 → M6+）。

## Transport 与 launch 内核（M4.2 / #38）

两个模块，都**不理解 Codex 业务**：

- `src/transport.ts` — `NdjsonTransport`：按 envelope 的四个判别位（`method` / `id` 在场与否）分类 request / response / notification / server→client request，`method` 全程是不透明字符串。四个不变量：协议 stdout 与诊断 stderr 物理隔离（§10.3）；单行累积有界，默认 `DEFAULT_MAX_PROTOCOL_LINE_BYTES` = 10 MiB（对齐 §10.1 的 RECOMMENDED 上限），超限行丢弃到下一个换行后**恢复成帧**、不中断流，且只报告一次带 256 字节摘录的 `TransportProtocolIssue`；一次调用只有一个了结算（response / `readTimeoutMs` / 进程退出三路，缺席 ≠ 空值）；listener 抛出的异常一律被隔离。子进程 `detached` 启动，`stop()` 是 SIGTERM → `shutdownTimeoutMs` 窗口 → SIGKILL **整个进程组**（与 `packages/workspace` 的 hook runner 同一约定，不留孤儿）。
- `src/process-launcher.ts` — `launchTransport()`：包内唯一 spawn 点。固定顺序是 非空 `command` 校验 → `path.resolve(workspacePath)` → 组装 child env → `await workspacePathSafety.assertWorkspacePathSafe(cwd)`（M3.2 的 execution-boundary primitive，以结构化接口 `WorkspacePathSafetyGate` 声明，`WorkspaceManager` 天然满足）→ **同一同步续体里** `spawn("bash", ["-lc", command], { cwd, env, detached: true })`。`command` 原样交给 shell，本层绝不 parse argv。

错误面复用 M4.1 冻结的 `AgentError`，不新增码：`invalid_workspace_cwd`（保留 `WorkspaceError` 作为 `cause`）/ `launch_failed`（保留 spawn error 作为 `cause`）/ `response_timeout` / `response_error` / `port_exit` / `protocol_error`。

env 面是**显式注入 `env` + 通用 `excludeEnvNames` 名单**（`excludeEnvNames` 只作用于继承自 `process.env` 的部分，显式 `env` 恒赢）：本包不知道任何 tracker provider 的 secret 变量名，哪些名字该从继承环境里剔除由调用方（组合根 / M5）决定。

验收用真实 fixture 子进程 `test-fixtures/echo-server.mjs`（由 `bash -lc` 启动，自行回报 `process.cwd()` / `argv` / `pid` / `$BASH_VERSION` / env），method 一律是虚构的 `test/*` —— **这个文件里出现真实 Codex method 就意味着分层被写穿了**。分层与备选见 [Agent Note](../../notes/accepted/architecture/2026-10-01-agent-transport-kernel-and-launch-boundary.md)。

## Public API（M4.1 契约层 + M4.2 类型面）

唯一出口 `src/index.ts`。三个面都是 **Symphony-facing**：M5 / orchestrator / observability 只 import 它们，不需要（也不应该）解释 raw Codex JSON。

```ts
import {
  AgentError,          // typed error，判别式是 code
  AGENT_ERROR_CODES,
  AGENT_EVENT_NAMES,   // §10.4 保证存在的事件名词表（开放集合）
  type AgentEvent,
  type AgentErrorCode,
  type AgentTokenUsage,
  type ContinuationDecider,
  type ContinuationDecision,
  type TurnCompletedContext,
} from "@symphony/agent";
```

transport 面按**方案 A** 收敛：`src/index.ts` 只 re-export transport 的**类型与三个默认常量**（`Transport` / `TransportListener` / `TransportRequest` / `TransportResponse` / `TransportNotification` / `TransportServerRequest` / `TransportServerResponse` / `TransportProtocolIssue` / `TransportExitInfo` / `JsonRpcErrorPayload` / `RequestId` + `DEFAULT_*`），**不导出 `launchTransport` / `createNdjsonTransport`**。理由是分层：唯一消费者是同包的 M4.3 Codex client，包外（orchestrator / apps/cli）拿到「能直接起子进程」的入口就会绕过 prompt 组装、session 生命周期与事件映射。

### Error 契约（SPEC §10.6）

`AgentError` 的 `code` 覆盖 §10.6 全部推荐 category 并逐字采用其名字：`codex_not_found` / `invalid_workspace_cwd` / `response_timeout` / `turn_timeout` / `port_exit` / `response_error` / `turn_failed` / `turn_cancelled` / `turn_input_required`；再加三个 implementation-defined 类别：`approval_required` / `protocol_error` / `launch_failed`。

- `port_exit` 是 SPEC 原文名字：stdio transport 下它表示"子进程在 session 仍需要它时退出"，不改名以免失去与 §10.6 / §14.1 的对照；
- 底层异常（spawn、JSON parse、`WorkspaceError`）只经 `cause` 保留，**不得**成为公共错误契约；
- 可选诊断字段（`threadId` / `turnId` / `sessionId` / `codexAppServerPid` / `protocolMethod` / `path`）遵循**缺席 ≠ 空值**；`protocolMethod` 是不透明诊断字符串，不是分支依据。

### Event 契约（SPEC §10.4）

`AgentEvent` 的必填三件套是 `event` / `timestamp`（UTC）/ `codexAppServerPid`（不可知为 `null`）；session 分量、`usage`、`rateLimits`、`protocolMethod`、`summary` 按"可得时携带"建模。`event` 的类型是 domain 的开放别名 `CodexEventName`，`AGENT_EVENT_NAMES` 只是保证存在的词汇表——**消费方必须容忍未知事件名**（Codex 与 Symphony 都会往里加东西）。`rateLimits` 复用 domain 的 opaque `CodexRateLimits`，原样转发、不解释。

### Continuation 契约（SPEC §10.2 / §10.3）

`ContinuationDecider(context: TurnCompletedContext) => Promise<ContinuationDecision>`，decision 只有 `stop` 与 `continue`（携带 issue 快照）两个分支。**为什么是个注入点**：官方参考实现在每个 turn 后 refresh tracker 再决定是否继续，而那需要 tracker 语义；AGENTS.md 禁止 `agent → tracker`，所以 eligibility 由 M5 注入，本包只提供同一个 live thread 上继续 turn 的能力与契约形状。`agent.max_turns` 的强制与 decider 异常处理随 M4.5 落地。

## Configuration

daemon 启动命令、并发 / 沙箱限制等由 `@symphony/config` 产出的 typed config 提供；模板变量注入契约见 SPEC §5（渲染在 config）与 §12（组装在本包）。`codex.approval_policy` / `thread_sandbox` / `turn_sandbox_policy` 是 **JSON-safe pass-through**：类型只约束 string ∪ JSON object 这一层形状（`CodexPassThroughValue`），合法性由 Codex 在 wire 边界判定，详见 [packages/config/README.md](../config/README.md)。

## Extension points

- 新的 coding-agent 后端：实现本包的 runner 协议，对 orchestrator 暴露统一的 session 事件流（`AgentEvent` / `AgentError` 是共用面）；
- prompt 上下文的新来源：在本包的组装管道中登记，不在 orchestrator 或 workspace 里拼 prompt；
- 协议基线升级：按 [docs/upstream.md](../../docs/upstream.md) 的升级规则走独立 PR，漂移只允许落在 protocol adapter / transport 层。

## Known limitations

- **M4.2 只有内核，没有 Codex 语义**：`NdjsonTransport` 只做 envelope 分类，`initialize` / `thread/start` / `turn/start` 的 payload 与生命周期属 M4.3；`ServerRequest` 的 approval / user-input 裁决（本包只提供 `respondToServerRequest` 管道，未应答的 server request 会一直悬挂到 `stop()`）与 `turn/*` → `AgentEvent` 映射属 M4.4；runner 组合与 prompt / hooks / continuation 执行属 M4.5；跨包集成与 §17.2 / §17.5 conformance 收口属 M4.6。
- **bash 的 "command not found"（exit 127）不在 M4.2 判定**：`launchTransport` 只在 spawn 失败时报 `launch_failed`，shell 已起来但命令不存在属于协议 / 进程错误分类问题，留 M4.5 —— 因此 `codex_not_found` 目前还没有产生它的代码路径。
- `readTimeoutMs` / `maxProtocolLineBytes` / `shutdownTimeoutMs` 目前**逐次 launch 传入**（`ServiceConfig.codex.read_timeout_ms` 到这里的接线随 M4.3 组合根落地）；turn 级超时与 stall 检测不属本层。
- 事件名表、`AgentEvent` 字段与 error code 是**本次冻结**的基线：M4.4 的映射若发现某个 §10.4 名字无法从 pinned protocol 状态里判定，按"协议优先"原则回来改这份契约，而不是在 adapter 里私加对外字段。
- 文档里的三条 Codex type 表达式是**证据摘录**，随基线升级需重新核对；不要在代码或类型里复制它们。
- 边界约束：**不拥有 scheduler / retry policy / tracker eligibility**——coordination 属 `@symphony/orchestrator`。
