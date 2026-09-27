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
| §5 | `WORKFLOW.md` 发现与加载（解析优先级） | `packages/config` | implemented | Core Conformance — `npm test -w @symphony/config`（`src/workflow-loader.test.ts`：§17.1 explicit/default path 优先级、missing file 与 read failure 的 typed error、无 front matter、合法 YAML、unknown keys 原样保留、malformed YAML、非 map 根、prompt trim） |
| §5 | front matter schema 解析与校验 | `packages/config` | implemented | Core Conformance — `npm test -w @symphony/config`（`src/config-resolution.test.ts`：§17.1 typed field validation——数值 / 字符串 / 列表错类型 → `invalid_config`（message 携带字段路径）、pass-through 字符串字段不做枚举、hook 脚本原样保留、section 非 map 报错；unknown top-level / section 内 unknown 键忽略（forward-compat）） |
| §5 | 严格模板渲染（未识别变量 / filter 即失败） | `packages/config` | planned M1 | — |
| §5 / §6 | 热重载、无效配置安全回退与类型化报错 | `packages/config` | planned M1 | —（其中"类型化报错"的错误码面已随 M1.3 落地：`invalid_config` / `missing_env_reference`，见上方 §5 / §6 各行；reload 与 last-known-good 回退归 M1.4，整行届时收口） |
| §6 | typed config、默认值合并、`$VAR` 环境解析 | `packages/config` | implemented | Core Conformance — `npm test -w @symphony/config`（`src/config-resolution.test.ts`：§17.1 defaults applied（裸 `WORKFLOW.md` → §6.4 全量默认值表）、explicit `$VAR` / `${VAR}` resolution、missing env var → `missing_env_reference`、env 不覆盖显式 YAML 值、`$VAR` 仅限 `workspace.root`（command / provider / 整数字段不展开）、env/home/cwd 注入） |
| §6 | 路径规范化（tilde 展开 / 相对路径） | `packages/config` | implemented | Core Conformance — `npm test -w @symphony/config`（`src/config-resolution.test.ts`：§17.1 `~` / `~/…` 展开（`~user` 不展开、YAML 裸 `~` = null = 默认值）、相对路径按 WORKFLOW.md 所在目录解析、absolute 保留 + normalize、resolved 恒为绝对路径、默认 `<tmpdir>/symphony_workspaces`） |
| §6 | per-state 并发覆盖与无效条目过滤 | `packages/config` | implemented | Core Conformance — `npm test -w @symphony/config`（`src/config-resolution.test.ts`：§17.1 by-state key 经 `normalizeIssueState` 归一化、非法条目（非数值 / 非整数 / 非正数）静默过滤、归一化冲突 last-wins、map 本身非 object → `invalid_config`） |
| §11 | tracker adapter 接口与 payload 归一化（保留 provider keys） | `packages/tracker` | planned M2 | — |
| §11 | 首个 provider 接入（如 Linear） | `packages/tracker` | planned M2 | — |
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
