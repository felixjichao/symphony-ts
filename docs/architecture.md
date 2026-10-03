# 架构

> 当前 M1–M5 已实现：domain/config、tracker、workspace、agent 与 orchestrator core 均有默认 CI 可复跑的 Core Conformance。M5 的真实跨包入口为 `WORKFLOW.md → loadEffectiveWorkflow + tracker registry → OrchestratorLoop → WorkspaceManager / runAgentAttempt → fake app-server subprocess → events / outcome → retry / refresh / reconciliation / cleanup`。装配证据见 [testing.md](testing.md)，逐项范围见 [conformance.md](conformance.md)。M6.1 已实现 `packages/observability` 的同步只读 snapshot 输出与 unavailable；获取层 timeout 尚未实现，本地同步入口不适用。M6.2 已提供 structured logger、提交点事实事件与 `apps/cli` 日志接线 helpers（真实 subprocess 验证）；M6.3 已完成静态 initial effective runtime CLI host 与 bin executable 契约（真实子进程覆盖）；live reload 与 exit-code matrix 归 M6.4–M6.5，HTTP/dashboard 为可选扩展。

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
| `packages/workspace` | Workspace Manager | §9 | 隔离目录 provisioning、containment 校验、lifecycle hooks | domain（`config` 仅为 devDependency，见下） |
| `packages/agent` | Agent Runner | §10、§12 | prompt / 上下文组装、coding agent 子进程控制、session 事件流 | domain, config, workspace |
| `packages/orchestrator` | Orchestrator | §7、§8、§14、§16 | 状态机、polling / scheduling / reconciliation、retry / backoff、单一权威 runtime state | domain, config, tracker, workspace, agent |
| `packages/observability` | Logging + Status Surface | §13 | 结构化日志、只读 runtime snapshot、状态出口 | domain |
| `apps/cli` | —（宿主入口） | §17、§18 | CLI / 进程生命周期、组件装配 | config, tracker, workspace, agent, orchestrator, observability |

依赖只允许自上表"依赖"列的方向流动；新增跨包依赖前先读 [AGENTS.md](../AGENTS.md) 的扩展点表。表中的"依赖"列指**运行期**（`dependencies`）方向；为了证明跨包接线而引入的 **devDependency / 测试专用**边不视为违反方向流动，但必须在表里显式标注。当前两条例外：`packages/tracker` 与 `packages/workspace` 各以 devDependency 引用 `@symphony/config`（各自仅 `src/config-integration.test.ts` 使用），用来证明扩展点或 typed 契约两侧真的对得上——`@symphony/config` 侧不引用它们，运行期方向仍是 `tracker → domain`、`workspace → domain`。两条硬约束：

1. **tracker 永不 import orchestrator**——轮询节奏 / claim / 调度属 coordination 层；
2. **agent runner 不拥有 scheduler / retry policy**——coordination 只由 orchestrator 拥有。

`observability` 对 orchestrator state 的消费是**只读 snapshot 契约**（类型归属 domain），不回写、不参与调度。

## 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 / M0.5 | 工程基建：monorepo、strict TS、测试、`npm run gate`、AGENTS / docs / notes | ✅ 已完成 |
| M0.6 | 对齐官方 SPEC：固定 baseline、按 §3 重建边界、删除旧协议栈 scaffold、CI + doc gate、conformance 矩阵 | ✅ 已完成 |
| M1 | Domain + Workflow + Config（§4、§5、§6，验收 §17.1） | ✅ 已完成（M1.5 集成与 conformance 收口） |
| M2 | Issue Tracker Adapter（§11） | ✅ 已完成（M2.1：read kernel / profile / registry / 错误契约 + config 校验接线；M2.2：built-in `github` profile + payload 归一化；M2.3：`github` 的 REST transport / scope / pagination / error mapping；M2.4：`WORKFLOW.md → registry → adapter → 本地 REST fixture` 端到端集成与 §17.3 逐项收口。provider-native tools（§11.5）与 malformed 省略日志（§13）不属本里程碑，见 [packages/tracker/README.md](../packages/tracker/README.md) 的 Known limitations） |
| M3 | Workspace Manager（§9） | ✅ 已完成（M3.1：provisioning 内核、确定性路径与 non-directory Fail Safely 策略；M3.2：lexical + canonical 双层 containment、symlink escape 拒绝与可复用 execution-boundary primitive；M3.3：四个 lifecycle hook 的执行层、fatal / best-effort 语义与 safe cleanup primitive；M3.4：`WORKFLOW.md → resolved ServiceConfig → workspace → 真实 temp filesystem → 真实 shell hook` 端到端集成与 §17.2 逐项收口。§17.2 的 "agent launch 以 per-issue workspace path 为 cwd 并拒绝 out-of-root 路径" 属 M4，OPTIONAL workspace population / synchronization 不实现，见 [packages/workspace/README.md](../packages/workspace/README.md) 的 Known limitations） |
| M4 | Agent Runner（§10、§12） | ✅ 已完成（M4.1：独立的 Codex app-server 协议基线 + 升级规则（[docs/upstream.md](upstream.md)）、`CodexConfig` approval / sandbox pass-through 改为形状类别表达并由 config 做 JSON-safety 校验、`AgentError` / `AgentEvent` / `ContinuationDecider` 契约层与守边界的结构测试。M4.2：与 Codex 业务无关的 transport / launch 内核——`bash -lc <codex.command>` 真实子进程、launch 前重过 `assertWorkspacePathSafe` 且 `cwd === workspace.path`、NDJSON framing 与有界行长、request-id 关联与 pending 生命周期、`readTimeoutMs`、stdout/stderr 物理隔离、SIGTERM→SIGKILL 进程组有界关停，显式 `env` + 通用 `excludeEnvNames`（不硬编码 provider secret 名），§17.2 的 agent launch 项与 §17.5 的 launch / cwd / read timeout / framing 四项翻为 `implemented`。M4.3：Codex app-server live session 生命周期；M4.4：headless server requests 处理与 runtime event 映射；M4.5：Agent Runner 组合与 continuation 执行；M4.6：`WORKFLOW.md → config → workspace → runner → fake app-server` 端到端 Core Conformance 与 §17.2 / §17.5 / §10 / §12 收口） |
| M5 | Orchestrator：状态机 / polling / scheduling / reconciliation / retry（§7、§8、§14、§16） | ✅ 已完成（M5.1–M5.6；§17.4 非 conditional 条目已收口） |
| M6 | Observability + Status Surface + CLI 装配（§13、§17 CLI lifecycle） | 进行中（M6.1 snapshot、M6.2 structured logging/helpers 与 M6.3 CLI host / bin executable 已实现；获取层 timeout、live reload、完整 exit-code matrix 与可选 HTTP/dashboard 尚未实现） |
| M7 | 加固：安全 / 运维（§15）、可选 SSH worker 扩展（Appendix A） | 未开始 |

里程碑顺序跟随依赖方向（orchestrator 在 tracker / workspace / agent 之后接线），单个里程碑的范围以 issue 标注的 SPEC section 与 [conformance.md](conformance.md) 矩阵为准。

## 历史：M0 协议栈 scaffold 已删除

M0 / M0.5 曾把 Symphony 理解为 `sym/0` 消息协议 + protobuf wire + 可靠 UDP + gateway + relay + 插件协议栈，与官方 SPEC 无对应关系；M0.6 已整体删除（sym / proto / transport / gateway / plugins / relay / ctl / examples），历史仅存于 Git。决策与被否备选见 [align-with-upstream-spec note](../notes/accepted/architecture/2026-09-26-align-with-upstream-spec.md)。

## 后续基建批次（随里程碑另行跟踪）

- [conformance.md](conformance.md) 矩阵的持续更新纪律（每个 milestone PR 必须更新对应行）；
- 测试分层落地（unit → 组件集成 → 端到端 loop，见 [testing.md](testing.md)）；
- CI lane 化（当前单 lane：`npm ci && npm run gate`）。

## M6.1 read-only snapshot

`@symphony/domain` 是 snapshot/view/clock/result 共享类型权威，`@symphony/observability` 从 authority 当前 state 同步投影。无第二份 scheduler/config authority；snapshot 不作为 scheduling 输入。host 注入与 authority 同源的 monotonic clock 及 wall clock，读 snapshot 不入账 tokens/duration。retry URL 仅为可选 metadata，重排更新与显式 null 语义见 [决策 Note](../notes/accepted/architecture/2026-10-03-observability-snapshot.md)。orchestrator → observability 仅 devDependency 测试边，生产依赖方向不变。M6.2 logger/observers 独立消费提交点事实，不从 snapshot diff 推断事件；HTTP/生产 CLI host 仍属后续工作。
