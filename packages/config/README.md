# @symphony/config

## Purpose

SPEC **§5 Workflow Specification (Repository Contract)** 与 **§6 Configuration Specification** 的 owner 包，对应 §3 的 Workflow Loader + Config Layer：`WORKFLOW.md` 发现与解析（YAML front matter + 原始 prompt 正文）、front matter schema（追踪过滤、轮询间隔、目录根、生命周期脚本、并发上限、沙箱策略）、typed config 校验、默认值合并、`$VAR` 环境解析、tilde 展开与相对路径规范化、严格模板渲染、无效配置的类型化报错与安全回退（验收项见 §17.1）。

**新增 / 修改 WORKFLOW front matter 字段的唯一落点在本包。**

## Public API（M1.2 + M1.3）

公共出口是 `src/index.ts`（唯一 API 面）。

### 文件级组合入口（M1.3）

```ts
import { loadEffectiveWorkflow, SymphonyConfigError } from "@symphony/config";

const eff = loadEffectiveWorkflow({ cwd: "/repo", env: process.env, home: os.homedir() });
// eff.definition      → WorkflowDefinition（config 仍是未经校验的原始 YAML 根对象）
// eff.serviceConfig   → ServiceConfig（@symphony/domain，§4.1.3 typed view，§6.4 全部 core fields）
// eff.workflowPath    → 实际加载的 WORKFLOW.md 绝对路径
```

- `loadEffectiveWorkflow(options?)`：`loadWorkflow`（§5.1–§5.3）+ `resolveServiceConfig`
  （§6.1）的组合。`path` / `cwd` / `env` / `home` 全部可注入，测试不依赖机器环境；
  workflow 路径解析与 `loadWorkflow` 共用同一 helper，`WORKFLOW.md` 所在目录即相对
  `workspace.root` 的解析基准。
- `resolveServiceConfig(raw, options)`：纯 resolver（无 IO），把原始 front matter
  config 解析为 typed `ServiceConfig`；注入点 `{ workflowDir, env?, home?, sourcePath? }`
  （`env` 默认 `process.env`、`home` 默认 `os.homedir()`）。M1.4 热重载直接复用。
- `loadWorkflow(options?)`（M1.2）：同步发现并加载 `WORKFLOW.md`，返回未经校验的
  `WorkflowDefinition`。路径优先级（§5.1）——显式 `options.path` 优先（相对路径按
  `options.cwd` 解析）；未提供 `path` 时用 `options.cwd`（默认 `process.cwd()`）下的
  `WORKFLOW.md`。

### 错误契约（§5.5）

`SymphonyConfigError` / `ConfigErrorCode`：稳定 typed error。第三方 fs / YAML /
schema 异常不越过包边界，一律转换后经 `cause` 保留、`path` 携带诊断用绝对路径。

- M1.2 的码：`missing_workflow_file`（缺失或不可读，含 ENOENT / EACCES / EISDIR）、
  `workflow_parse_error`（YAML 语法错误或 front matter 未闭合）、
  `workflow_front_matter_not_a_map`（根为 list / 标量）。
- M1.3 追加：`invalid_config`（front matter 值未通过 typed 校验；message 携带字段
  路径如 `agent.max_turns` 与诊断详情）、`missing_env_reference`（显式 `$VAR` 引用
  的环境变量未设置或为空；message 携带变量名）。
- 消费方须容忍未知码并按 `code` 精确分支。

### resolution 管道（§6.1）

缺失 OPTIONAL → 默认值（§6.4）→ 显式 `$VAR` 环境解析 → coerce + validate。硬语义：

- **env 不得全局覆盖 YAML**：环境变量只参与字符串里的显式 `$VAR` / `${VAR}` 引用；
  YAML 显式值永远胜出。
- **核心层唯一做 env / path expansion 的字段是 `workspace.root`**（§17.1 "$VAR for
  path values"）。`codex.command` 原样保留（不做 `~` / `$VAR` / URI / shell 改写）；
  `tracker.provider` 内容原样保留（`$VAR` / secret / 键校验归所选 adapter，M2）。
- 无效值 → `invalid_config`（fail-fast，按 tracker → polling → workspace → hooks →
  agent → codex 顺序抛第一个），不 crash、不静默修正；**唯一例外**：
  `agent.max_concurrent_agents_by_state` 的非法条目（非数值 / 非整数 / 非正数）**静默
  忽略**（§5.3.5 原文 "are ignored"——与 `max_turns` 的 fail-validation 是 SPEC 刻意
  的双策略，不得统一）。
- `tracker.kind` 缺失 → `""`（哨兵）：resolution 不强制 present——"kind present &
  supported" 是 dispatch preflight（§6.3）检查项，supported-adapter 校验需注册表（M2）。
- pass-through 三字段（`codex.approval_policy` / `thread_sandbox` /
  `turn_sandbox_policy`）只校验 string 类型、不手维枚举（§5.3.6 SHOULD）；缺失 → `null`
  （implementation-defined 默认）。`tracker.active_states` / `terminal_states` 同理：
  缺失 → `null`（adapter profile 默认），present 须 string 列表、元素原样保留。
- 数值字段要求真正的 YAML number：整数必须；并发 / 超时 / 间隔类须为正数（`"20"`
  字符串、布尔、浮点一律 `invalid_config`，不做隐式 coerce）。唯一允许非正数的是
  `codex.stall_timeout_ms`（`<= 0` = 禁用 stall 检测，§5.3.6）。
- `workspace.root` 规范化次序：`$VAR` → `~`（`~` 与 `~/…` 用注入 home；`~user/…`
  不展开）→ 相对路径按 `WORKFLOW.md` 所在目录解析 → normalize；resolved 后恒为绝对
  路径。默认 `<system-temp>/symphony_workspaces`。
- `max_concurrent_agents_by_state` 的 key 经 domain `normalizeIssueState`（trim +
  lowercase）归一化，与 scheduler 的 state 比较同源；归一化后 key 冲突按文档序
  last-wins；归一化后为空串的 key 忽略。

### 边缘语义（本包定死，M1.4+ 不得各自漂移）

SPEC 未逐字规定的边缘情形，本包择一并固化（决策记录见
[notes（loader）](../../notes/accepted/architecture/2026-09-27-workflow-loader-contract.md)与
[notes（resolution）](../../notes/accepted/architecture/2026-09-27-config-resolution-contract.md)）：

- **无 front matter**（首行非 `---`）→ 整篇为 prompt body，`config` 为空对象；首行
  之后出现的 `---`（Markdown 水平线）不触发 front matter。
- **空 front matter 块**（`---` 紧跟 `---`）或**仅注释**的 front matter（YAML 解析为
  `null`）→ 等价于无配置，`config` 为空对象（不报 not_a_map）；resolution 得到**全量
  默认值**的 `ServiceConfig`（裸 `WORKFLOW.md` 也是合法输入）。
- **未闭合 front matter**（有起始 `---` 但无结束 `---`）→ `workflow_parse_error`，
  避免 YAML 文本静默漏进 prompt。
- **空正文** → `promptTemplate: ""`，不报错（空正文的 fallback 策略属 §5.4 / M1.4）。
- **unknown top-level keys** → 原样保留、不校验、不报错（§5.3 forward compatibility；
  丢弃会破坏扩展）。**已知 section 内部的 unknown 字段**（如 `agent.max_turn` 拼错）
  同样忽略（与 top-level 策略一致；严格模式会让 forward-compat 字段变成 breaking）。
- **显式 `null` = 未配置**：字段或 section 显式为 `null`（含 YAML 裸 `~`）按缺失处理、
  走默认值；`workspace.root: ""`（空串 / 纯空白）例外——报 `invalid_config`。
- **`$VAR` 细节**：`$NAME` 与 `${NAME}` 均识别（NAME = `[A-Za-z_][A-Za-z0-9_]*`），
  支持一个值内多处内嵌展开；引用的变量未设置**或为空串** → `missing_env_reference`
  （空串按 missing 处理，对齐 §5.3.1 secret "empty = missing" 精神）；`$` 后跟非法
  变量名字符（如 `$5`）不是引用、原样保留；无 `$$` 转义语法。
- **定界符**：`---` 行容忍行尾空白；前导单个 BOM 被剥离；CRLF 归一为 LF，保证定界符
  匹配与正文的确定性。`promptTemplate` 只 trim 正文首尾边界，不改内部行。

## Configuration

本包定义了 Symphony 自身如何读取与校验 `WORKFLOW.md`（仓库契约）；开发本包不需要额外配置。

## Extension points

- 新增 front matter 字段：在本包扩展 schema，并同步 `docs/conformance.md` 的 §5 / §6 行；
- 新的配置来源 / 覆盖层：走本包的 resolution 管道，其他包不得自行解析配置；
- 配置消费方（tracker / workspace / orchestrator…）只接受本包产出的 typed config，不接触原始文件；
- tracker adapter（M2）：从 `tracker.provider` 取 adapter-owned 原始 map 自行校验键与
  `$VAR` / secret 解析；core 不预校验 provider 内容。

## Known limitations

- 严格模板渲染（§5.4）与热重载 / last-known-good 安全回退（§6.2）归 M1.4，尚未落地；
  `resolveServiceConfig` 是纯函数，reload 编排（重新 load + resolve、失败保留旧值）
  由 M1.4 在其上组合。
- `tracker.kind` 只做 string 类型校验：supported-adapter 校验需要 adapter 注册表
  （§6.3 / §11，M2）；`tracker.provider` 内容不校验（adapter-owned）。
- `workspace.root` 只做词法规范化（`path.resolve`），不做 symlink 解析（realpath）或
  目录创建 / containment（§9，M3）。
- 进度见 [docs/conformance.md](../../docs/conformance.md)。
