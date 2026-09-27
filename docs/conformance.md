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
| §4 | Issue / WorkflowDefinition / ServiceConfig 等领域类型 | `packages/domain` | planned M1 | — |
| §4 | Workspace / RunAttempt / LiveSession / RetryEntry / RuntimeState 类型 | `packages/domain` | planned M1 | — |
| §5 | `WORKFLOW.md` 发现与加载（解析优先级） | `packages/config` | planned M1 | — |
| §5 | front matter schema 解析与校验 | `packages/config` | planned M1 | — |
| §5 | 严格模板渲染（未识别变量 / filter 即失败） | `packages/config` | planned M1 | — |
| §5 / §6 | 热重载、无效配置安全回退与类型化报错 | `packages/config` | planned M1 | — |
| §6 | typed config、默认值合并、`$VAR` 环境解析 | `packages/config` | planned M1 | — |
| §6 | 路径规范化（tilde 展开 / 相对路径） | `packages/config` | planned M1 | — |
| §6 | per-state 并发覆盖与无效条目过滤 | `packages/config` | planned M1 | — |
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
