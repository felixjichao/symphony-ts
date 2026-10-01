# AGENTS.md — Standing Orders

symphony-ts：按官方 [OpenAI Symphony](https://github.com/openai/symphony) `SPEC.md` 实现的 TypeScript 版本——长运行 orchestrator 从 issue tracker 读取工作、建立 per-issue workspace、运行 coding agent，并负责 retry / reconciliation / observability。唯一产品规范来源是固定 baseline 的官方 SPEC（见 [docs/upstream.md](docs/upstream.md)）；当前 **M0.6（架构重校准）、M1（Domain + Workflow + Config）与 M2（Tracker Adapter）已完成——M2 覆盖 provider 无关 read kernel / registry / config 接线（M2.1）、built-in `github` profile + 归一化（M2.2）、GitHub REST transport（M2.3）与 `WORKFLOW.md → registry → adapter → 本地 REST fixture` 的端到端 conformance 收口（M2.4）；provider-native tools（§11.5）与 malformed 省略日志（§13）仍属 M6+**，**M3（Workspace Manager）已完成**——M3 覆盖确定性 provisioning 与 existing non-directory 的 Fail Safely 策略（M3.1）、lexical + canonical 双层 containment 与 symlink escape 拒绝（M3.2）、四个 lifecycle hook 的执行层与 safe cleanup primitive（M3.3），以及 `WORKFLOW.md → resolved ServiceConfig → workspace → 真实 temp filesystem → 真实 shell hook` 的端到端 conformance 收口（M3.4）；M4 已开始——M4.1 固定独立的 Codex app-server 协议基线（见 [docs/upstream.md](docs/upstream.md)）并落地 config / agent 契约层（`CodexPassThroughValue`、`AgentError` / `AgentEvent` / `ContinuationDecider`），M4.2 落地与 Codex 业务无关的 transport / launch 内核（`bash -lc <codex.command>` 真实子进程、launch 前重过 `assertWorkspacePathSafe` 且 `cwd === workspace.path`、NDJSON framing / request-id 关联 / `readTimeoutMs` / stdout 与 stderr 隔离 / 进程组有界关停，M3 遗留的 agent launch cwd 绑定与 out-of-root 拒绝由此收口），但 `initialize` / `thread/*` / `turn/*` 生命周期、prompt 组装与 `turn/*` → `AgentEvent` 事件映射均**未实现**；M5 起的组件仍为占位。本文件只放 standing orders；详细内容一律看文末"文档导航"。

## Command Matrix

| 目的 | 命令 |
|---|---|
| 安装（CI / 干净环境） | `npm ci` |
| 安装（增删依赖后） | `npm install` |
| 类型检查（strict tsc，noEmit） | `npm run typecheck` |
| 全仓测试（vitest） | `npm test` |
| 单个 workspace 测试 | `npm test -w @symphony/config` |
| 静态检查 | `npm run lint` |
| 文档门禁（Markdown 相对链接 + AGENTS.md 行数预算） | `npm run docs:check` |
| 一键门禁（typecheck + test + lint + docs:check） | `npm run gate` |

npm 是唯一 canonical 包管理器（npm workspaces + `package-lock.json`）。不要引入 pnpm/yarn，不要提交第二份 lockfile。要求 Node >= 20。

## Working Rules

1. **每个 SPEC section 有唯一 owner 包**：修改前先按下方扩展点表定位所属 workspace，在该包内改代码、补该包的测试。
2. **新增实现必须标注 SPEC section**：issue / PR / 提交说明写清对应 section（baseline 见 [docs/upstream.md](docs/upstream.md)），并更新 [docs/conformance.md](docs/conformance.md) 矩阵对应行。
3. 本地跑最小相关检查（受影响 workspace 的 `test` + 根 `typecheck`）；提交前 / CI 跑全量 `npm run gate`。
4. 不跨包复制类型或配置语义——领域类型的唯一权威是 `@symphony/domain`，配置解析的唯一落点是 `@symphony/config`；跨包只 import，不重声明。
5. 架构 / 选型 / 跨包契约的决策要写 Agent Note（流程与模板见 [notes/README.md](notes/README.md)）；`## Alternatives considered` 为强制小节，不允许空标题。
6. TypeScript 严格模式（`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`）；不要为过编译加 `any` / `@ts-expect-error`，除非 Note 中记录理由。
7. 包间 import 走包名（如 `@symphony/domain`），由根 `tsconfig.base.json` 的 `paths` 映射到各包 `src`；不要写跨包相对路径。

## Where New Behavior Goes

| 你要新增 / 修改… | 去这里 | SPEC |
|---|---|---|
| 领域实体 / 共享类型契约（Issue、RunAttempt、RetryEntry…） | `packages/domain` | §4 |
| WORKFLOW front matter 字段、配置校验 / 默认值 / env 解析、模板渲染 | `packages/config` | §5、§6 |
| tracker provider（如 Linear）、工单归一化 | `packages/tracker` | §11 |
| workspace lifecycle hook、目录隔离 / containment | `packages/workspace` | §9 |
| Codex app-server 交互、prompt 组装、session 事件流 | `packages/agent` | §10、§12 |
| retry policy、polling / 调度 / reconciliation、runtime state | `packages/orchestrator` | §7、§8、§14 |
| 结构化日志、状态出口（dashboard / HTTP surface） | `packages/observability` | §13 |
| CLI 子命令、进程装配 / 生命周期 | `apps/cli` | §17、§18 |

依赖方向（下游可依赖上游，反向禁止）：

```
domain              ← 共享领域契约，不依赖任何包
config / tracker    → domain
workspace           → domain
agent               → domain + config + workspace
orchestrator        → domain + config + tracker + workspace + agent
observability       → domain（以及只读 runtime snapshot 契约）
apps/cli            → config + tracker + workspace + agent + orchestrator + observability
```

两条硬约束（最常见错误）：

1. **tracker adapter 不得 import orchestrator**——轮询节奏、claim、调度属 coordination 层；
2. **agent runner 不得拥有 scheduler / retry policy**——coordination 只由 orchestrator 拥有。

## TODO 三级标记

| 标记 | 含义 |
|---|---|
| `FIXME` | 正确性问题，**阻断发布**；相关里程碑合并前必须处理 |
| `TODO` | 具体的近期待办，尽快跟进 |
| `XXX` | 未决设计问题 / 存疑；保留到结论落成 Agent Note 为止 |

## 文档导航

- [docs/upstream.md](docs/upstream.md) — 上游 SPEC baseline（SHA、同步 / 升级规则）
- [docs/conformance.md](docs/conformance.md) — 实现 ↔ SPEC §17 / §18 验收项矩阵（milestone PR 必须更新对应行）
- [docs/architecture.md](docs/architecture.md) — 产品模型、workspace 职责与依赖方向（SPEC §3 映射）、里程碑
- [docs/development.md](docs/development.md) — 环境搭建、日常命令、TS 布局与依赖约定
- [docs/testing.md](docs/testing.md) — 测试分层（对齐 SPEC §17 profiles）与三条测试哲学
- [notes/README.md](notes/README.md) — 决策记录（Agent Notes）契约
- 各包 `README.md` — 该包 purpose / configuration / extension points / known limitations
