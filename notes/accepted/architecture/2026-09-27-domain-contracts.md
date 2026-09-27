# Agent Note: SPEC §4 领域契约的 TypeScript 建模约定（M1.1）
Status: accepted

## Problem

M1.1 要在 `packages/domain` 落地 SPEC §4 的全部领域契约（Issue、WorkflowDefinition、ServiceConfig typed view、Workspace、RunAttempt、LiveSession、RetryEntry、OrchestratorRuntimeState）。SPEC 用语言无关的 snake_case 字段与两种缺值语义（`(X or null)` vs OPTIONAL）描述实体，而本仓启用 `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`：`null` 与 `undefined` 必须择一且不允许含糊。此外 §4.1.7 / §4.1.8 含 runtime-specific 句柄（timer / worker 引用），§11.3 允许 in-memory 时间戳类型 implementation-defined，§4.2 的归一化规则（state 比较、workspace key、session id）需要一个明确的归属包。这些选择会被所有下游包 import，属跨包契约，须一次定死并记录。

## Decision

1. **命名映射**：TS 属性一律 camelCase，SPEC snake_case 字段按词逐一映射（`native_ref`→`nativeRef`、`due_at_ms`→`dueAtMs`、`prompt_template`→`promptTemplate`），每个字段 JSDoc 标注 SPEC 字段名与 section；不引入第二套字段名。
2. **缺值语义**：SPEC `(X or null)` → 必填属性 `field: X | null`（present-but-null）；SPEC OPTIONAL 且可整体缺席 → `field?: X`（`exactOptionalPropertyTypes` 下禁止显式 `undefined`）。§11.3 要求 normalized Issue 所有字段在场（nullable 用 null、集合用空数组），故 Issue 无任何 optional 属性；当前全模型唯一 optional 属性是 `RunAttempt.error`。
3. **时间戳**：in-memory 统一 epoch 毫秒 `number`（§11.3 允许），并以 `UtcTimestampMs` / `MonotonicTimestampMs` 两个别名显式区分墙上时钟与单调时钟——§4.1.7 `due_at_ms` 与 §13.5 elapsed 核算用单调域，日志 / 快照用 UTC 域。
4. **不透明句柄**：`RetryEntry.timerHandle`、`RunningEntry.workerHandle` 类型为 `unknown`——领域层只存不解释，使用前由持有方（orchestrator）narrow；不用泛型参数把 runtime 类型渗进领域契约。
5. **值对象 readonly、运行时记录 mutable**：Issue / WorkflowDefinition / ServiceConfig / Workspace 全字段 readonly（reload / provisioning 语义是整体替换）；RunAttempt / LiveSession / RetryEntry / RunningEntry / OrchestratorRuntimeState 不加 readonly（orchestrator 按 §7.3 原地更新）。
6. **§4.2 归一化纯函数随类型落在 domain**：`normalizeIssueState`（trim+lowercase，仅比较用、不回写 provider 拼写）、`deriveWorkspaceKey`（`[^A-Za-z0-9._-]`→`_`；净化改变过原文时追加 `--` + 原文 SHA-256 前 16 个 hex 字符 = 64 bit 熵，与上游参考实现同构；空 identifier 抛 `TypeError`，§11.3 非空约束前置）、`composeSessionId`（`<thread_id>-<turn_id>`）。`RunAttemptStatus` 只含 §7.2 状态**集合**（单一来源 `RUN_ATTEMPT_STATUSES`），转移逻辑仍归 orchestrator（M5）。
7. **ServiceConfig typed view 归属 domain**：按 §4.1.3 + §5.3 / §6.4 字段定型（resolved 语义：全字段必填，`| null` 表示取值决策交给下游——adapter profile 默认 / implementation-defined 默认 / 未配置 hook）；解析、默认值、`$VAR`、路径规范化等**行为**仍归 `@symphony/config`（M1.3）。
8. **测试中的 `@ts-expect-error` 是负例类型断言而非绕过编译**：断言"某写法必须不合法"（如 eOPT 下 `error: undefined`、readonly 字段赋值、Issue 缺 `dispatchable`）；若写法变合法，unused directive 会让 typecheck 失败，这正是断言机制本身。与 standing order 6 禁止的"为过编译加 `@ts-expect-error`"不冲突，特此记录理由。

## Alternatives considered

- **属性保留 SPEC snake_case**（模板 / 日志字段名与上游逐字一致）：否——违反 TS 与本仓命名惯例，且 §5.4 模板变量面由 config 包渲染层决定（M1.4 可为上游模板生态做字段名映射），领域类型不必为渲染层牺牲一致性。
- **branded/nominal 类型区分两个时钟域**（`number & {__brand}`）：否——M1 阶段给所有构造点（`Date.now()`、`performance.now()`、测试字面量）强加 cast 噪音；编译期防混用暂由命名 + JSDoc + review 承担，若 M5 orchestrator 出现混用 bug 再升级为 branded。
- **`lastCodexEvent` 固化为 §10.4 事件名枚举**：否——§10.4 清单是开放示例（"include, for example"），现在固化会在 M4 之前形成会漂移的第二权威；暂用 `CodexEventName = string` 别名，事件协议随 agent 包定型。
- **`ServiceConfig` 推迟到 M1.3 由 config 包定义**：否——conformance §4 行与本包 README（M0.6 起）均把 ServiceConfig 类型划归 domain 权威；类型放 config 会迫使 workspace / orchestrator 为取配置形状而 import 行为包，违反依赖方向的最小化原则。
- **`deriveWorkspaceKey` 放在 `packages/workspace`（M3 再实现）**：否——规则出自 §4.2（Core Domain Model 的归一化规则），且 §17.2 要求 key 派生跨调用方一致（"callers that only know the identifier can derive the same key"）；放 domain 使 M3 之前即可用纯函数测试预覆盖 §4.2 / §17.2 的 key 规则，workspace 包只负责 provisioning 行为。

## Consequences

- 下游包（config / tracker / workspace / agent / orchestrator / observability）只 import 这些类型与纯函数，不得重声明或"本地微调"字段名 / 缺值语义；需要不同形状时先改 domain 并附 Note。
- WORKFLOW.md 模板若需 snake_case 变量面（与上游生态兼容），由 M1.4 渲染层显式映射，不回改领域类型。
- `deriveWorkspaceKey` 的 `--` 分隔符与 16-hex 后缀是跨实现稳定约定：M3 workspace 包不得另起一套 key 派生；§17.2 的 provisioning 测试直接复用本函数。
- 空 identifier 抛 `TypeError` 属契约的一部分，调用方不得捕获后静默降级。
- `@ts-expect-error` 负例断言写法仅限测试文件中"断言非法"的场景；产品代码中的使用仍按 standing order 6 逐案记录。
