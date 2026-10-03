# @symphony/domain

## Purpose

SPEC **§4 Core Domain Model** 的 owner 包：Issue、Workflow Definition、Service Config、Workspace、Run Attempt、Live Session、Retry Entry、Orchestrator Runtime State 等共享领域类型与 §4.2 归一化纯逻辑的唯一权威。其他包只 import、不重声明（与 M0.5 的"单一权威包"原则一致）。

M1.1 已落地的公共 API（唯一出口 `src/index.ts`；进度见 [docs/conformance.md](../../docs/conformance.md)）：

| 契约 | SPEC | 说明 |
|---|---|---|
| `Issue` / `IssueNativeRef` / `IssueBlockerRef` | §4.1.1 | 归一化可调度工作项；所有字段必填，nullable 用 `null`、集合缺省用空数组（§11.3） |
| `WorkflowDefinition` | §4.1.2 | `config`（front matter 根对象）+ `promptTemplate`（trimmed 正文） |
| `ServiceConfig` 及 `Tracker` / `Polling` / `Workspace` / `Hooks` / `Agent` / `Codex` 子结构 | §4.1.3 | resolved typed view，字段对应 §5.3 / §6.4；解析 / 校验 / 默认值**行为**归 `@symphony/config`；`codex.approval_policy` / `turn_sandbox_policy` 为 `CodexPassThroughValue`（string 或 map，M4.1 / #37） |
| `Workspace` + `deriveWorkspaceKey()` | §4.1.4 / §4.2 | workspace key 净化 + ≥64 bit hash 后缀防碰撞（纯函数） |
| `RunAttempt` / `RunAttemptStatus` / `RUN_ATTEMPT_STATUSES` | §4.1.5 / §7.2 | 单次执行尝试记录；只含状态**集合**，转移逻辑归 orchestrator |
| `LiveSession` + `composeSessionId()` | §4.1.6 / §4.2 | coding-agent session 元数据；token 计数口径见 §13.5 |
| `RetryEntry` / `TimerHandle` | §4.1.7 | retry 队列条目；算法归 `@symphony/orchestrator`（§8.4 / §16） |
| `OrchestratorRuntimeState` / `RunningEntry` / `CodexTotals` / `CodexRateLimits` | §4.1.8 | 单一权威内存状态的共享契约 |
| `normalizeIssueState()` | §4.2 | 调度比较用 trim + lowercase（不回写 provider 拼写，§11.3） |
| `UtcTimestampMs` / `MonotonicTimestampMs` | §11.3 / §13.5 | 墙上时钟与单调时钟两个时钟域，显式区分、不可混用 |

## Configuration

无运行时配置；领域类型本身即本包对外的契约面。

## 建模约定（跨包契约）

决策记录见 [Agent Note: 领域契约建模约定](../../notes/accepted/architecture/2026-09-27-domain-contracts.md)：

- **命名映射**：TS 属性 camelCase，与 SPEC snake_case 字段一一对应（`native_ref` → `nativeRef`、`due_at_ms` → `dueAtMs`…）；每个字段 JSDoc 标注 SPEC 字段名与 section。
- **nullable vs optional**：SPEC 写 `(X or null)` → 必填属性 `field: X | null`（present-but-null）；SPEC 写 OPTIONAL 且可整体缺席 → `field?: X`，在 `exactOptionalPropertyTypes` 下不接受显式 `undefined`。当前全模型唯一 optional 属性是 `RunAttempt.error`。
- **值对象 vs 运行时记录**：归一化 / resolved 数据（Issue、WorkflowDefinition、ServiceConfig、Workspace）字段 readonly；orchestrator 持续变更的运行时记录（RunAttempt、LiveSession、RetryEntry、RunningEntry、OrchestratorRuntimeState）不加 readonly。
- **不透明句柄**：runtime-specific 引用（`RetryEntry.timerHandle`、`RunningEntry.workerHandle`）类型为 `unknown`——领域层只存不解释，使用前由持有方 narrow。
- **pass-through 只建模形状类别，不存枚举快照**：外部协议（Codex app-server）的字面量取值不进领域类型。`codex.approval_policy` / `turn_sandbox_policy` 用 `CodexPassThroughValue = string | Readonly<Record<string, unknown>>` 表达"string 或结构化对象"这一**类别**（pinned schema 两处都有 object 分支，string-only 无法无损承载），语义与枚举成员由协议自己裁决；`CodexEventName` 是开放 string 别名、`CodexRateLimits` 是 opaque map，同一道理由。协议基线与裁决记录见 [Agent Note: Codex Protocol Baseline and Agent Contract Layers](../../notes/accepted/architecture/2026-09-30-codex-protocol-baseline-and-agent-contracts.md)；`packages/agent` 的结构测试持续守住"运行期代码不复制 Codex generated schema"这条线。
- **时间戳**：in-memory 统一 epoch 毫秒（§11.3 允许 implementation-defined；adapter 从 RFC 3339 解析），时钟域用类型别名标注。

## Extension points

- 新增 / 修改领域实体属于跨包契约变更：必须附 Agent Note（见根 [notes/README.md](../../notes/README.md)）；
- provider payload 的**归一化结果**类型定义在本包；归一化**动作**（adapter）在 `packages/tracker`（§11）；
- 配置字段语义 / 默认值 / 校验的唯一落点在 `packages/config`（§5 / §6）——本包只承载 resolved 后的类型形状；
- WORKFLOW.md 模板若需 snake_case 变量面（与上游生态兼容），由 config 包渲染层（M1.4）显式映射，不回改领域类型。

## Known limitations

- 只含类型与 §4.2 纯函数，无任何业务行为：状态机转移（§7）归 orchestrator（M5）、workspace provisioning（§9）归 workspace（M3）、归一化动作（§11.3）归 tracker（M2）、config 解析与热重载（§5 / §6）归 config（M1.2–M1.4）；
- §13.3 只读 runtime snapshot 的行类型归属本包（见 [architecture.md](../../docs/architecture.md)），随 observability（M6）落地；
- `CodexEventName` 是 string 别名而非闭合枚举：§10.4 事件清单是开放集合。M4.1（#37）已在 `@symphony/agent` 定型事件**形状**（`AgentEvent`）与保证存在的名称清单（`AGENT_EVENT_NAMES`），但事件**产生与映射**（哪个 Codex notification → 哪个事件名）随 M4.4 落地；
- `deriveWorkspaceKey` 对空 identifier 抛 `TypeError`（§11.3 非空约束前置），调用方不得捕获后静默降级。

## M6.1 observability contracts

`ObservabilityRuntimeView` 排除 handles 并提供 readonly 输入；`ObservabilitySnapshot` / running / retry rows 与 `SnapshotClock` / `SnapshotResult` 是 §13.3 / §13.5 的公共共享类型。`RetryEntry.issueUrl?: string | null` 为兼容旧调用的展示 metadata，snapshot 将缺席值归一为 null。state 的 secondsRunning 仅保存 ended 累计，投影另加 active elapsed。见 [snapshot Note](../../notes/accepted/architecture/2026-10-03-observability-snapshot.md)。
