# symphony-ts — OpenAI Symphony 的 TypeScript 实现

按 [OpenAI Symphony](https://github.com/openai/symphony) 官方 `SPEC.md` 实现的 TypeScript 版本：**一个长运行的 orchestrator**，从 issue tracker 读取工作（issue），为每个 issue 建立隔离的 workspace，运行 coding agent（如 Codex）完成工作，并负责 retry / reconciliation / observability。

运行模型（SPEC §3）：

```
WORKFLOW.md → Config → Issue Tracker → Orchestrator → Workspace → Agent Runner → Observability
```

规范来源与进度追踪：

- 唯一产品规范是官方 `SPEC.md`，baseline 固定为 `be10a1b79df723d6d7612b5651c8522704dafb2e`；coding agent 协议另有独立的 Codex app-server 基线（`rust-v0.159.2` / `ff6aec96948b70d94983af2641a6b67c94faeff5`）——两条版本轴、schema source paths 与各自的升级规则见 [docs/upstream.md](docs/upstream.md)；
- 实现与 SPEC §17 / §18 验收项的映射见 [docs/conformance.md](docs/conformance.md)；
- 参考实现与第三方 TypeScript 实现只用于设计对照，不构成规范。

## 快速开始

要求 Node >= 20；npm 是唯一 canonical 包管理器。

```bash
npm ci                        # 安装（严格按 package-lock.json）
npm run gate                  # 一键门禁：typecheck + test + lint + docs:check
npm test -w @symphony/domain  # 只跑某个 workspace 的测试
```

日常开发命令、TS 布局约定见 [docs/development.md](docs/development.md)。

## 运行 CLI

```bash
npm run build
node apps/cli/dist/bin/symphony.js ./WORKFLOW.md
# 无路径参数时使用 cwd 的 ./WORKFLOW.md；SIGINT / SIGTERM 等待资源收口后退出 0。
npm test -w @symphony/cli -- src/bin.test.ts src/lifecycle.test.ts
```

startup/preflight、致命生命周期或 shutdown 失败退出 1。CLI 自然退出，不以强制 exit 隐藏 watcher、poll、retry 或 agent 遗留。M6 Core 各项文件、用例名与命令见 [conformance](docs/conformance.md#m65-core-证据索引)。本地 HTTPS tracker / app-server fixture 证据不代表外部 GitHub / Codex Real Integration；HTTP §13.7、provider-native tools §11.5、durable recovery、SSH 均不在 M6 Core 范围。

## 包布局

| 包 | SPEC §3 组件 | SPEC sections | 职责 |
|---|---|---|---|
| `packages/domain` | —（共享契约） | §4 | 领域类型唯一权威：Issue、WorkflowDefinition、ServiceConfig、Workspace、RunAttempt、RetryEntry… |
| `packages/config` | Workflow Loader + Config Layer | §5、§6 | `WORKFLOW.md` 解析、front matter schema、typed config、env / path resolution、模板渲染 |
| `packages/tracker` | Issue Tracker Adapter | §11 | provider 无关的工单读取、认证、payload → Issue 归一化 |
| `packages/workspace` | Workspace Manager | §9 | per-issue 隔离目录、路径 containment、生命周期 hooks |
| `packages/agent` | Agent Runner | §10、§12 | prompt / 上下文组装、coding agent 子进程、live session 事件流 |
| `packages/orchestrator` | Orchestrator | §7、§8、§14 | 状态机、polling / scheduling / reconciliation、retry / backoff |
| `packages/observability` | Logging + Status Surface | §13 | 结构化日志、只读 runtime snapshot、状态出口 |
| `apps/cli` | —（宿主入口） | §17、§18 | CLI / 进程生命周期、组件装配 |

每个包都有自己的 `README.md`（purpose / configuration / extension points / known limitations）。依赖方向与两条硬约束（tracker 不 import orchestrator；agent 不拥有调度 / retry）见 [docs/architecture.md](docs/architecture.md)。

## 文档导航

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | Agent / 贡献者 standing orders：命令矩阵、扩展点表、TODO 分级 |
| [docs/upstream.md](docs/upstream.md) | 两条上游 baseline：Symphony SPEC（SHA、同步 / 升级规则）与 Codex app-server 协议（tag / commit、schema source paths、升级落点） |
| [docs/conformance.md](docs/conformance.md) | 实现 ↔ SPEC §17 / §18 验收项矩阵（milestone PR 必须更新） |
| [docs/architecture.md](docs/architecture.md) | 产品模型、workspace 职责与依赖方向（SPEC §3 映射）、里程碑 |
| [docs/development.md](docs/development.md) | 环境搭建、日常命令、TS 布局与依赖约定 |
| [docs/testing.md](docs/testing.md) | 测试分层（对齐 SPEC §17 profiles）与三条测试哲学 |
| [docs/github-delivery-workflow.md](docs/github-delivery-workflow.md) | GitHub 自动交付闭环（start / run / stop、GitHub lifecycle 与安全边界） |
| [notes/](notes/README.md) | 架构 / 选型决策记录（Agent Notes） |

## 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 / M0.5 | 工程基建：monorepo、strict TS、测试、`npm run gate`、AGENTS / docs / notes | ✅ 已完成 |
| M0.6 | 对齐官方 SPEC：固定 baseline、按 §3 重建 workspace 边界、删除协议栈 scaffold、CI + doc gate、conformance 矩阵 | ✅ 已完成 |
| M1 | Domain + Workflow + Config：领域模型、`WORKFLOW.md` loader、typed config / defaults / env / path resolution 与校验（SPEC §4、§5、§6，验收 §17.1） | ✅ 已完成 |
| M2 | Issue Tracker Adapter：provider 无关 read kernel / registry、built-in `github` profile + 归一化 + REST transport 与端到端 conformance 收口（§11，验收 §17.3） | ✅ 已完成 |
| M3 | Workspace Manager：确定性 provisioning、lexical + canonical containment、lifecycle hooks、safe cleanup 与端到端 Core Conformance（§9，验收 §17.2；agent launch cwd 绑定随 M4.2 落地） | ✅ 已完成 |
| M4 | Agent Runner：prompt 组装、子进程控制、session 事件流（§10、§12） | ✅ 已完成（M4.1–M4.5 各层实现，以及 WORKFLOW.md → config → workspace → runner → fake app-server 端到端 Core Conformance 与 §17.2 / §17.5 / §10 / §12 收口） |
| M5 | Orchestrator：状态机、polling / scheduling / reconciliation、retry（§7、§8、§14、§16） | ✅ 已完成（M5.1–M5.6；§17.4 非 conditional 条目已收口） |
| M6 | Observability + Status Surface + CLI 装配（§13、§17 CLI lifecycle） | ✅ 已完成（Core）：M6.1–M6.5 已合入；merge commit [`dc08f1e3bc1b087131579f35c154104da6bb134e`](https://github.com/felixjichao/symphony-ts/commit/dc08f1e3bc1b087131579f35c154104da6bb134e)，main CI [run 37161569329](https://github.com/felixjichao/symphony-ts/actions/runs/37161569329) 全绿。HTTP §13.7 / provider-native tools §11.5 / durable recovery / SSH 保持为范围外 extension |
| M7 | 加固：安全 / 运维（§15）、可选 SSH worker 扩展（Appendix A） | 未开始 |

里程碑顺序跟随依赖方向（orchestrator 最后接线）；每个 issue 必须标注对应 SPEC section，进度以 [docs/conformance.md](docs/conformance.md) 矩阵为准。

## 注意事项

- 包间依赖使用 `*` 语义（npm workspaces 自动链接本地包），tsconfig `paths` 映射到各包 `src`；发布形态（dist 产物）在首个打包里程碑切换。
- 严格模式：`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`。
- M0 的协议栈 scaffold（`sym/0` / protobuf / UDP / gateway / relay）已随 M0.6 架构重校准删除，历史见 Git；决策记录见 [align-with-upstream-spec note](notes/accepted/architecture/2026-09-26-align-with-upstream-spec.md)。
