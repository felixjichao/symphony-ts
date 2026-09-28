# SPEC Conformance Matrix

实现进度与官方 SPEC 验收项（§17 Test and Validation Matrix、§18 Implementation Checklist）的可追踪映射。规范 baseline 与升级规则见 [upstream.md](upstream.md)；owner 包的职责边界见 [architecture.md](architecture.md)。

## 规则

1. **状态词汇**：`planned M#`（已排入里程碑）→ `in-progress`（实现中）→ `implemented`。**只有代码 + 验收测试都落地后才能标 `implemented`**，Test 列同时从 `—` 变为可复跑的测试入口。
2. **每个 milestone PR 必须更新对应行**（Status 与 Test 列），属于 review 的一部分；不更新矩阵的实现 PR 不完整。
3. **升级 SPEC baseline 时优先 diff 本表**：新增 / 变化的 section 先补行或改标注，再排期实现（流程见 [upstream.md](upstream.md)）。
4. Test 列填写对应 SPEC §17 validation profile（`Core Conformance` / `Extension Conformance` / `Real Integration Profile`）与 §18 checklist 项的可复跑入口（如 `npm test -w @symphony/config` + 具体测试文件）。

## 矩阵

| SPEC | Capability | Owner | Status | Test |
|---|---|---|---|---|
| §4 | Issue / WorkflowDefinition / ServiceConfig 等领域类型 | `packages/domain` | implemented | Core Conformance — `npm test -w @symphony/domain`（`src/issue.test.ts`、`src/contracts.test.ts`：§4.1.1–§4.1.3 字段 / 缺值语义，§11.3 在场性约束；§6.4 cheat-sheet 形状） |
| §4 | Workspace / RunAttempt / LiveSession / RetryEntry / RuntimeState 类型 | `packages/domain` | implemented | Core Conformance — `npm test -w @symphony/domain`（`src/workspace.test.ts`、`src/session.test.ts`、`src/contracts.test.ts`：§4.1.4–§4.1.8 + §4.2 归一化纯函数；workspace-key 净化 / 防碰撞为 §17.2 的纯函数层预覆盖，provisioning 行为仍见 §9 行） |
| §5 | `WORKFLOW.md` 发现与加载（解析优先级） | `packages/config` | implemented | Core Conformance — `npm test -w @symphony/config`（`src/workflow-loader.test.ts`：§17.1 explicit/default path 优先级、missing file 与 read failure 的 typed error、无 front matter、合法 YAML、unknown keys 原样保留、malformed YAML、非 map 根、prompt trim；端到端链路 `src/integration.test.ts`） |
| §5 | front matter schema 解析与校验 | `packages/config` | implemented | Core Conformance — `npm test -w @symphony/config`（`src/config-resolution.test.ts`：§17.1 typed field validation——数值 / 字符串 / 列表错类型 → `invalid_config`（message 携带字段路径）、pass-through 字符串字段不做枚举、hook 脚本原样保留、section 非 map 报错；unknown top-level / section 内 unknown 键忽略（forward-compat）；端到端链路 `src/integration.test.ts`） |
| §5 | 严格模板渲染（未识别变量 / filter 即失败） | `packages/config` | implemented | Core Conformance — `npm test -w @symphony/config`（`src/prompt-rendering.test.ts`：§17.1 "Prompt template renders `issue` and `attempt`" 与 "Prompt rendering fails on unknown variables (strict mode)"——`issue` snake_case 变量面逐字段 / `attempt` 整数与 null / 嵌套 labels·blockers 迭代 / registered filter；unknown variable·filter → `template_render_error`、语法错误 → `template_parse_error` 且第三方异常经 `cause`；空正文 → `DEFAULT_PROMPT_TEMPLATE`；`{% include %}`·`{% render %}`·`{% layout %}` 等读盘标签被结构性拒绝，渲染恒为文件系统无关（`filesystem-free contract` 用例）；端到端链路 `src/integration.test.ts`） |
| §5 / §6 | 热重载、无效配置安全回退与类型化报错 | `packages/config` | implemented | Core Conformance — `npm test -w @symphony/config`（`src/workflow-reload.test.ts`：§17.1 "Workflow file changes are detected and trigger re-read/re-apply without restart" 与 "Invalid workflow reload keeps last known good effective configuration and emits an operator-visible error"——真实临时文件的 valid reload 更新 effective config·prompt、invalid reload（坏 YAML / 非 map 根 / 非法 typed 值 / 文件删除）保留 last-known-good + `onEvent(error)`、修好后自愈、模板正文损坏不升级为 reload 错误且 `renderPrompt` 只抛 `template_parse_error`·不污染 last-known-good（§5.5 gating）、监听器异常被隔离（不崩溃、不误报 `error`）、初始加载 fail-fast、`reload()` 防御性再校验、`close()` 幂等且不再产生事件；M2.1 注入的 tracker 扩展点**自身抛异常**（契约缺陷）也被收敛成 `invalid_tracker_config` 而**不逃逸为 uncaughtException**，reload 仍保留 last-known-good + `error` 事件（`src/tracker-extension.test.ts`：定时器 reload 用例 + 初始加载 fail-fast 用例）；类型化错误码面另见 `src/config-resolution.test.ts` 与 `src/workflow-loader.test.ts`；端到端链路 `src/integration.test.ts`） |
| §6 | typed config、默认值合并、`$VAR` 环境解析 | `packages/config` | implemented | Core Conformance — `npm test -w @symphony/config`（`src/config-resolution.test.ts`：§17.1 defaults applied（裸 `WORKFLOW.md` → §6.4 全量默认值表）、explicit `$VAR` / `${VAR}` resolution、missing env var → `missing_env_reference`、env 不覆盖显式 YAML 值、`$VAR` 仅限 `workspace.root`（command / provider / 整数字段不展开）、env/home/cwd 注入；端到端链路 `src/integration.test.ts`） |
| §6 | 路径规范化（tilde 展开 / 相对路径） | `packages/config` | implemented | Core Conformance — `npm test -w @symphony/config`（`src/config-resolution.test.ts`：§17.1 `~` / `~/…` 展开（`~user` 不展开、YAML 裸 `~` = null = 默认值）、相对路径按 WORKFLOW.md 所在目录解析、absolute 保留 + normalize、resolved 恒为绝对路径、默认 `<tmpdir>/symphony_workspaces`；端到端链路 `src/integration.test.ts`） |
| §6 | per-state 并发覆盖与无效条目过滤 | `packages/config` | implemented | Core Conformance — `npm test -w @symphony/config`（`src/config-resolution.test.ts`：§17.1 by-state key 经 `normalizeIssueState` 归一化、非法条目（非数值 / 非整数 / 非正数）静默过滤、归一化冲突 last-wins、map 本身非 object → `invalid_config`；端到端链路 `src/integration.test.ts`） |
| §17.1 | `tracker.kind` 校验实现支持的 adapter | `packages/config` + `packages/tracker` | implemented | Core Conformance — `npm test -w @symphony/tracker`（`src/registry.test.ts`：未注册 kind → `unsupported_tracker_kind`（message 携带 supported kinds）、`kind: ""` 哨兵 → `invalid_tracker_config`、精确匹配不改写大小写；`src/config-integration.test.ts`：真实 `WORKFLOW.md` + `loadEffectiveWorkflow` 端到端 `unsupported_tracker_config` 拒绝、非 built-in kind 注册即支持（config 无 provider 分支）；扩展点契约与 fail-fast / last-known-good 两态另见 `npm test -w @symphony/config` `src/tracker-extension.test.ts`） |
| §17.1 | `tracker.provider` 保留 adapter-owned keys 并经所选 adapter 校验 | `packages/config` + `packages/tracker` | implemented | Core Conformance — `npm test -w @symphony/config`（`src/config-resolution.test.ts`：provider map 原样保留、不展开 `$VAR`；`src/tracker-extension.test.ts`：core 校验优先于扩展、未注入扩展 = M1 行为逐字节不变）；`npm test -w @symphony/tracker`（`src/registry.test.ts`：`validateConfig` 语义校验、未知 provider key 由 adapter 自行放行、`resolveProviderConfig` secret 回落 env；`src/config-integration.test.ts`：`future_provider_key` 原样到达 adapter、`missing_tracker_secret` 两种失败路径） |
| §11.1 | REQUIRED adapter operations 的**调用面**（两个 operation + 空输入 MUST + normalized `Issue` 返回形状） | `packages/tracker` | implemented | Core Conformance — `npm test -w @symphony/tracker`（`src/adapter.test.ts`：`fetchIssuesByStates` / `fetchIssuesByIds` 返回 normalized `Issue`、空输入零 provider 请求、共享冻结空数组、async 契约；`src/config-integration.test.ts`：`registry.create()` 产出的 kernel 端到端可用） |
| §11.1 | provider-side scope selection / pagination、malformed-record 策略（state-list 可省略并 SHOULD log、ID-refresh MUST fail）、operation 原子性 | `packages/tracker` | planned M2（#19 / #20） | 要求真实 provider payload 才有语义；M2.1 只交付上一点的调用面（kernel 的 `TrackerAdapterOperations` 即这两个 operation 的接口位） |
| §11.2 | adapter profile 契约与注册表 / factory | `packages/tracker` | implemented | Core Conformance — `npm test -w @symphony/tracker`（`src/registry.test.ts`：registration 拒空 kind / 重复 kind、`supportedKinds` 稳定序、resolve 顺序 select → validateConfig → resolveProviderConfig、active/terminal 的 profile 默认只注入 `TrackerAdapterContext`、不写进 resolved `ServiceConfig`（`src/registry.test.ts` + `src/config-integration.test.ts` 两端断言）、校验失败则 `createAdapter` 不被调用、`createConfigExtension()` 形状；跨包双侧结构兼容由 `src/config-integration.test.ts` 的编译期双向断言锁定） |
| §11.4 | tracker 错误契约（8 类） | `packages/tracker` | implemented | Core Conformance — `npm test -w @symphony/tracker`（`src/errors.test.ts`：§11.4 全 8 个字面量、message 原样、可选字段 absent ≠ false、`cause` 保留；`src/registry.test.ts`：非 `TrackerError` 异常归一化为 `TrackerConfigExtensionFailure` 且保留 `cause`） |
| §11.3 | payload 归一化（保留 `native_ref` / provider keys） | `packages/tracker` | in-progress | 归一化**类型**约束已由 §4 行覆盖（`npm test -w @symphony/domain` `src/issue.test.ts`）；provider payload → `Issue` 的归一化实现随首个 adapter 落地（#19） |
| §11 | 首个 built-in provider（`github`） | `packages/tracker` | planned M2（#19） | `BUILT_IN_TRACKER_ADAPTER_PROFILES`（当前为空数组）即预留注册点，注册无需改动 config / registry（`src/config-integration.test.ts` 以 `github` + `linear` 双 profile 用例锁定） |
| §9 | workspace provisioning（id 净化、防碰撞） | `packages/workspace` | planned M3 | — |
| §9 | 路径 containment 校验 | `packages/workspace` | planned M3 | — |
| §9 | lifecycle scripts（setup / cleanup hooks） | `packages/workspace` | planned M3 | — |
| §10 | coding agent 子进程控制与 live session 事件流 | `packages/agent` | planned M4 | — |
| §12 | prompt 构建与上下文组装 | `packages/agent` | planned M4 | — |
| §7 | orchestration 状态机（单一权威 runtime state） | `packages/orchestrator` | planned M5 | — |
| §8 | polling / claim / dispatch 排序 / 并发上限 | `packages/orchestrator` | planned M5 | — |
| §8 / §14 | reconciliation 与失败恢复 | `packages/orchestrator` | planned M5 | — |
| §14 / §16 | retry / backoff（参考算法对齐） | `packages/orchestrator` | planned M5 | — |
| §13 | 结构化日志（保留关键标识符） | `packages/observability` | planned M6 | — |
| §13 | status surface（可选 HTTP / dashboard） | `packages/observability` | planned M6 | — |
| §17 / §18 | CLI lifecycle 与组件装配 | `apps/cli` | planned M6 | — |
| §15 | 安全与运维安全加固 | 跨包（orchestrator / workspace 主导） | planned M7 | — |
| App. A | SSH worker 扩展（可选） | 待定 | planned M7（可选） | — |

M1 的 config / domain 行落地时，以 **§17.1（Workflow and Config Parsing）** 的验收项作为 Test 列的逐项口径。

**§17.1 延后项（M1.5 决策）→ M2.1 已还**：`tracker.kind` 校验实现支持的 adapter、`tracker.provider` 经所选 adapter 校验两项需要 adapter 注册表（§6.3 / §11），M1.5 显式延后、由 M2.1 以 `TrackerConfigExtension`（契约归 config、实现归 tracker 的 registry）落地，见上方两行。§17.1 的 `$VAR` 条目（"works for documented adapter secret keys and path values"）同理：path values 一半在 M1.3（`workspace.root`），adapter secret key 一半现在有了机制（`env` 注入 `TrackerAdapterProfile.resolveProviderConfig`，空串按缺失），具体"哪些 secret 键 / env 变量名有文档"随 built-in adapter 的 profile 文档落地（#19）。历史决策见 [config-resolution Agent Note](../notes/accepted/architecture/2026-09-27-config-resolution-contract.md)，跨包扩展点契约见 [tracker adapter config extension Agent Note](../notes/accepted/architecture/2026-09-28-tracker-adapter-config-extension.md)。限制见 [packages/config/README.md](../packages/config/README.md) 与 [packages/tracker/README.md](../packages/tracker/README.md) 的 Known limitations。
