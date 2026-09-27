# Agent Note: prompt 渲染契约（严格模式、变量面、空正文、错误归类）（M1.4）

Status: accepted

## Problem

M1.4 要在 `packages/config` 实现 SPEC §5.4 的严格 prompt 渲染。SPEC 给了硬约束
（strict engine、未知变量 / filter 失败、`issue` / `attempt` 两个输入、空正文 MAY 用
默认 prompt、`template_parse_error` / `template_render_error` 两个错误码），但若干
会被 M4（agent prompt 组装）与 M5（orchestrator 渲染）直接依赖的裁定未逐字规定：
变量面用 camelCase 还是 SPEC 的 snake_case、`attempt` 首次运行为 null 还是缺席、
空正文的 fallback 粒度、时间戳以 number 还是字符串暴露、无文件上下文时错误的 `path`
取什么、以及 `liquidjs` 把未知 filter 报在 parse 阶段时如何对齐 §5.5 的分类。这些须
一次定死，避免 M4 / M5 各自漂移。

## Decision

1. **公共 API**：`renderPrompt(template, { issue, attempt?, workflowPath? })` →
   `string`，纯函数、无 IO。`template` 由调用方（M4 / M5）从
   `WorkflowDefinition.promptTemplate` 取出；本层不读文件。
2. **变量面恒为 SPEC §4.1.1 的 snake_case 键**：`issue` 映射为 plain map
   （`id`、`native_ref`、`identifier`、`title`、`description`、`priority`、`state`、
   `branch_name`、`url`、`assignee_id`、`labels`、`blocked_by`、`dispatchable`、
   `created_at`、`updated_at`）。**不同时暴露 camelCase 双份键面**（避免两套变量名
   漂移，模板生态与 SPEC 字段名一致）。映射职责显式落在渲染层，不回改 `@symphony/domain`
   的 `Issue`（呼应 [domain-contracts](2026-09-27-domain-contracts.md) 的预留决策）。
3. **嵌套集合原样保留**（§12.2）：`labels`（string 数组）、`blocked_by`（`{ id,
   identifier, state }` 数组）、`native_ref`（不透明 provider 载荷）直接透传供模板
   迭代 / 取值，不做展平或字符串化。
4. **`created_at` / `updated_at` 映射为 ISO 8601 字符串**（`new Date(ms).toISOString()`）；
   不可得时保持 `null`。理由：模板可读性与日期 filter 兼容；`null` 是"已定义的
   空值"，渲染为空串而非报错（对齐 §11.3 "所有字段在场、nullable 用 null"）。
5. **`attempt` 键恒在场**：上下文恒含 `issue` 与 `attempt`；首次运行显式传 `null`
   （调用方省略也归一为 `null`）。不得让键缺席——`strictVariables` 下缺席会让
   `{{ attempt }}` 报错，违背 §5.4 / §12.3 的 "null/absent on first attempt" 合法
   语义。`null` 在 `liquidjs` 下渲染为空串、在 `{% if %}` 中为 falsey，均符合预期。
6. **空正文策略：采用 §5.4 MAY 的默认 prompt**。`renderPrompt` 收到空串或纯空白模板
   时直接返回常量 `DEFAULT_PROMPT_TEMPLATE`（逐字 `You are working on an issue from
   the configured tracker.`，与 SPEC 原文、上游 `Config.workflow_prompt()` 一致），
   该常量无模板变量、不经引擎。理由：loader 已把"空正文"固化为合法输入（裸
   `WORKFLOW.md` 可解析），渲染层报错会自相矛盾；SPEC 明示 MAY。
7. **错误归类**：
   - `renderSync()` 阶段失败（未知变量、求值错误）→ `template_render_error`；
   - `parse()` 阶段的**未注册 filter** → `template_render_error`；
   - 其余 `parse()` 失败（tokenization / 语法错误）→ `template_parse_error`。
   filter 一项与"parse 阶段"的错位源于 `liquidjs` 在 `parse()` 时即解析 filter 名
   （见 [liquidjs 选型 Note](../tooling/2026-09-27-config-liquidjs-dependency.md)）；
   本包据 `undefined filter:` 前缀把它归入 §5.5 明列的 `template_render_error`，
   以对齐 SPEC 的错误分类而非引擎的内部阶段。
8. **`SymphonyConfigError.path`**：调用方传入 `workflowPath` 时用它；无文件上下文的
   裸模板调用用哨兵值 `"<inline>"`（类形状 `code` / `path` / `cause` 不变）。
9. **失败只影响当次调用**：`renderPrompt` 是纯函数，失败抛 typed error；重试 / 派发
   处置归 orchestrator（§12.4 / §5.5，M5），本层不缓存、不重试、不改 effective config。

## Alternatives considered

- **同时暴露 camelCase 与 snake_case 两套键**：否——两套变量名必然漂移，模板作者
  无法判断哪套权威；SPEC §4.1.1 与上游参考实现都用 snake_case，只保留一套更稳。
- **`attempt` 首次运行让键缺席**：否——`strictVariables` 会把 `{{ attempt }}` 当成
  未定义变量报错，把"首次运行"这一合法语义变成渲染失败。
- **空正文报错（严格照 §5.4 MUST 字面）**：否——§5.4 明示 MAY 用默认 prompt，且
  loader 已把空正文固化为合法输入；报错会让裸 `WORKFLOW.md` 的 prompt 渲染永远失败。
- **时间戳以 epoch ms number 暴露**：否——模板里 number 不可读，且上 / 下游对
  "时间字段是字符串"有共同预期；ISO 8601 字符串无歧义且可接日期 filter。
- **未知 filter 归 `template_parse_error`（顺 `liquidjs` 的实际阶段）**：否——§5.5
  把 "unknown variable/filter" 明列在 `template_render_error`，按其**分类语义**
  归码，而非按引擎内部阶段；用前缀判定并加测试锁定，升级引擎时回归可见。
- **手写 AST 遍历区分 filter 错误（不依赖消息前缀）**：否——需遍历 `liquidjs` 内部
  token 结构、与版本耦合更深，收益不抵复杂度；前缀判定有测试锁定，退化时也只落到
  `template_parse_error`（仍是 typed error，不会静默通过）。

## Consequences

- M4（agent prompt 组装）/ M5（orchestrator）渲染 prompt 一律走 `renderPrompt`，
  不得自行模板化或直接依赖 `liquidjs`；变量面固定为 snake_case，SPEC §4.1.1 字段名
  即模板变量名。
- `DEFAULT_PROMPT_TEMPLATE` 是公共导出常量，消费方可直接引用而不必复刻字符串。
- 空正文 / 时间戳格式 / `attempt` 在场性等边缘语义由本 Note 与包 README 固化，后续
  里程碑不得各自漂移；需要变更时先改本 Note 再改代码。
- 新增模板变量（如 §12.3 提及的 OPTIONAL `retry_kind`，非 core conformance）须回到
  本层显式扩展映射，并在 README 记录。
