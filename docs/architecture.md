# 架构

> 本文描述 symphony-ts 的**当前真实状态**（M1 完成后：`@symphony/domain` 的 §4 契约与 `@symphony/config` 的 `WORKFLOW.md` 加载 / 解析 / 校验 / 渲染 / 热重载已实现并有测试；M2.1 又落地了 `@symphony/tracker` 的 provider 无关 read kernel + adapter 注册表与 config 校验接线，M2.2 在其上注册了首个 built-in provider `github`（profile + payload 归一化），但其 **REST transport 尚未实现**——`kind: github` 能通过配置校验，真正读取工单会失败；其余组件仍为占位）与里程碑规划。写作原则：不把 scaffold 写成已实现能力——未落地的组件只有包边界与占位 `src/index.ts`，凡标注 M2+ 的部分代码中尚不存在。

## 产品模型

symphony-ts 是 [OpenAI Symphony](https://github.com/openai/symphony) 官方 `SPEC.md` 的 TypeScript 实现（baseline 固定与升级规则见 [upstream.md](upstream.md)）。Symphony 是一个**长运行的 orchestrator**：从 issue tracker 读取工作，为每个 issue 建立隔离 workspace，运行 coding agent，并负责 retry / reconciliation / observability。

运行模型（SPEC §3）：

```
WORKFLOW.md → Config → Issue Tracker → Orchestrator → Workspace → Agent Runner → Observability
```

1. **Workflow Loader** 解析仓库内的 `WORKFLOW.md`（YAML front matter + 原始 prompt 正文）；
2. **Config Layer** 产出 typed config：默认值合并、`$VAR` 环境解析、tilde 展开 / 相对路径规范化、无效配置类型化报错并安全回退；
3. **Issue Tracker Adapter** 按配置轮询符合条件的工单，把 provider payload 归一化为 Issue（保留 provider keys）；
4. **Orchestrator** 维护单一权威 runtime state：claim 集合、并发上限、dispatch 排序、retry / backoff 队列与 reconciliation；
5. **Workspace Manager** 为每个 issue provisioning 隔离目录（id 净化、防碰撞），校验路径 containment，执行生命周期脚本；
6. **Agent Runner** 组装注入 issue 上下文的 prompt，启动 coding agent 子进程（如 Codex app-server），向上转发 live session 事件（token / turn / PID）；
7. **Logging / Status Surface** 输出结构化日志（保留关键标识符），并以只读 snapshot 提供面向操作者的状态出口。

## Workspace 职责与依赖方向（SPEC §3 映射）

| 包 | SPEC §3 组件 | SPEC sections | 职责 | 依赖 |
|---|---|---|---|---|
| `packages/domain` | —（共享契约） | §4 | Issue、WorkflowDefinition、ServiceConfig、Workspace、RunAttempt、LiveSession、RetryEntry、OrchestratorRuntimeState 等类型与纯逻辑的唯一权威 | 无 |
| `packages/config` | Workflow Loader + Config Layer | §5、§6 | `WORKFLOW.md` 发现 / 解析、front matter schema、typed 校验、env / path resolution、模板渲染、热重载回退 | domain |
| `packages/tracker` | Issue Tracker Adapter | §11 | provider 无关的读取接口、认证、payload → Issue 归一化 | domain（`config` 仅为 devDependency，见下） |
| `packages/workspace` | Workspace Manager | §9 | 隔离目录 provisioning、containment 校验、lifecycle hooks | domain, config |
| `packages/agent` | Agent Runner | §10、§12 | prompt / 上下文组装、coding agent 子进程控制、session 事件流 | domain, config, workspace |
| `packages/orchestrator` | Orchestrator | §7、§8、§14、§16 | 状态机、polling / scheduling / reconciliation、retry / backoff、单一权威 runtime state | domain, config, tracker, workspace, agent |
| `packages/observability` | Logging + Status Surface | §13 | 结构化日志、只读 runtime snapshot、状态出口 | domain |
| `apps/cli` | —（宿主入口） | §17、§18 | CLI / 进程生命周期、组件装配 | config, tracker, workspace, agent, orchestrator, observability |

依赖只允许自上表"依赖"列的方向流动；新增跨包依赖前先读 [AGENTS.md](../AGENTS.md) 的扩展点表。表中的"依赖"列指**运行期**（`dependencies`）方向；为了证明跨包接线而引入的 **devDependency / 测试专用**边不视为违反方向流动，但必须在表里显式标注。当前唯一例外：`packages/tracker` 以 devDependency 引用 `@symphony/config`（仅 `src/config-integration.test.ts` 使用），用来证明扩展点两侧的结构化契约真的对得上——`@symphony/config` 侧不引用 tracker，运行期方向仍是 `tracker → domain`。两条硬约束：

1. **tracker 永不 import orchestrator**——轮询节奏 / claim / 调度属 coordination 层；
2. **agent runner 不拥有 scheduler / retry policy**——coordination 只由 orchestrator 拥有。

`observability` 对 orchestrator state 的消费是**只读 snapshot 契约**（类型归属 domain），不回写、不参与调度。

## 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 / M0.5 | 工程基建：monorepo、strict TS、测试、`npm run gate`、AGENTS / docs / notes | ✅ 已完成 |
| M0.6 | 对齐官方 SPEC：固定 baseline、按 §3 重建边界、删除旧协议栈 scaffold、CI + doc gate、conformance 矩阵 | ✅ 本次 |
| M1 | Domain + Workflow + Config（§4、§5、§6，验收 §17.1） | ✅ 已完成（M1.5 集成与 conformance 收口） |
| M2 | Issue Tracker Adapter（§11） | 🔄 进行中（M2.1：read kernel / profile / registry / 错误契约 + config 校验接线已完成；M2.2：built-in `github` profile + payload 归一化已完成；REST transport / pagination = #20） |
| M3 | Workspace Manager（§9） | 未开始 |
| M4 | Agent Runner（§10、§12） | 未开始 |
| M5 | Orchestrator：状态机 / polling / scheduling / reconciliation / retry（§7、§8、§14、§16） | 未开始 |
| M6 | Observability + Status Surface + CLI 装配（§13、§17 CLI lifecycle） | 未开始 |
| M7 | 加固：安全 / 运维（§15）、可选 SSH worker 扩展（Appendix A） | 未开始 |

里程碑顺序跟随依赖方向（orchestrator 在 tracker / workspace / agent 之后接线），单个里程碑的范围以 issue 标注的 SPEC section 与 [conformance.md](conformance.md) 矩阵为准。

## 历史：M0 协议栈 scaffold 已删除

M0 / M0.5 曾把 Symphony 理解为 `sym/0` 消息协议 + protobuf wire + 可靠 UDP + gateway + relay + 插件协议栈，与官方 SPEC 无对应关系；M0.6 已整体删除（sym / proto / transport / gateway / plugins / relay / ctl / examples），历史仅存于 Git。决策与被否备选见 [align-with-upstream-spec note](../notes/accepted/architecture/2026-09-26-align-with-upstream-spec.md)。

## 后续基建批次（随里程碑另行跟踪）

- [conformance.md](conformance.md) 矩阵的持续更新纪律（每个 milestone PR 必须更新对应行）；
- 测试分层落地（unit → 组件集成 → 端到端 loop，见 [testing.md](testing.md)）；
- CI lane 化（当前单 lane：`npm ci && npm run gate`）。
