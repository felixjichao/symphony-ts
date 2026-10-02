# Agent Note: Agent integration and M4 Core Conformance closure
Status: accepted

## Problem

在 M4 前序子里程碑中，协议基线与对外契约层（M4.1 / #37）、Codex 无关的 transport 与 launch 边界（M4.2 / #38）、pinned schema 的 session 生命周期（M4.3 / #39）、headless server requests 处理与事件流映射（M4.4 / #40）以及 Agent Runner 编排与同 thread continuation 循环（M4.5 / #41）均已按模块落地。然而：

1. 各层测试主要以单元或模块级 fixture 驱动，尚未建立从真实 `WORKFLOW.md` 经 `@symphony/config`、`@symphony/workspace` 到 `@symphony/agent`、最终由真实 `bash -lc` app-server 子进程交互的端到端集成链路；
2. SPEC §10、§17.5 在 `docs/conformance.md` 中仍标记为 `in-progress`，§17.2 针对 agent launch cwd 与 containment 的验收项尚未汇总端到端复验证据；
3. SPEC §18.1 Implementation Checklist 中属于 M4 的项（coding-agent app-server subprocess client、`codex.command` launch、strict prompt rendering）尚需统一收口与测试映射；
4. 运行期依赖与协议边界需要通过结构性 AST 断言持续守住，防止 Liquid、containment 算法或 wire 协议词汇向高层泄漏。

## Decision

以 `packages/agent/src/config-integration.test.ts` 为核心建立跨包端到端 Core Conformance 验收套件，将整条执行链路作为统一验收对象：

1. **真实流水线驱动**：测试每例在独立临时目录创建真实 `WORKFLOW.md`（包含 workspace.root、hooks、agent.max_turns、codex.command、approval_policy、timeouts），通过 `@symphony/config` 的 `loadEffectiveWorkflow` 解析为 typed `ServiceConfig` 与 prompt 模板，再将它们原样交付 `runAgentAttempt()`。测试不 mock 模板渲染、workspace 管理器、containment gate、session 或 spawn。
2. **重读世界与双向外部证据**：复用真实子进程 fixture `app-server.mjs`，由子进程记录真实 `process.cwd()`、PID、`bash -lc` 展开后的参数（`$(pwd)`、`$BASH_VERSION`）以及收发消息 transcript；测试断言同时检查磁盘 marker、hook 顺序日志、wire 协议时序、`AgentEvent` / `WorkspaceHookEvent` 与最终 `AgentAttemptResult`。
3. **十组场景覆盖**：覆盖 workspace 创建 / 复用与 hook 时序、workflow 解析与 prompt 严格渲染、before_run / after_run 失败与 non-masking 不变量、child cwd 与 launch boundary containment、initialize / thread / turn 握手与错误参数化、turn 终态判定与提前退出映射（握手前 127 映射 `codex_not_found`）、silence timeout 与 stderr 物理隔离、headless server requests 自动决策、telemetry 快照与多轮 continuation 循环，以及公共 `startAppServerSession` 的 launch 负例补充。
4. **扩展结构边界断言**：在 `packages/agent/src/contracts.test.ts` 中通过 AST 扫描断言：agent 运行期不引入 `liquidjs` 或 containment 算法副本（复用 config 与 workspace）；高层 runner、continuation 与 Symphony 契约面不出现 wire method 字面量；spawn 唯一落在 `process-launcher.ts` 且底层 transport / launcher 实现不从 `index.ts` 导出。
5. **文档与状态一致性收口**：同步翻转 `packages/agent/README.md`、`docs/conformance.md`（§10、§17.5 标为 implemented，追加 §18.1 入口）、`docs/architecture.md`、`docs/testing.md`、根 `README.md` 与 `AGENTS.md` 的 M4 状态为已完成，下一里程碑推进至 M5（Orchestrator）。

## Alternatives considered

1. **在测试中 mock `child_process.spawn` 或 transport**：
   - *否决原因*：违反 `docs/testing.md` 的核心哲学（prefer the real implementation over a mock；verify the world, not the self-report）。mock spawn 无法证明真实的 `bash -lc` 参数展开、真实 child `process.cwd()` 绑定、stdio 管道背压与进程组 SIGKILL 终止，容易演化为测试自证。
2. **在测试中手造 `ServiceConfig` 对象**：
   - *否决原因*：M4.5 的 `agent-runner.test.ts` 已经验证了手造 config 的场景。M4.6 端到端 Core Conformance 的目标是验证上游从磁盘 `WORKFLOW.md` 加载、环境变量解析、tilde 展开、typed 校验到 runner 消费的完整真实链路，必须从真实文件进入。
3. **依赖外部真实在线 Codex 作为默认 CI 门禁**：
   - *否决原因*：违反 SPEC §17 的 Core Conformance 设计原则。真实 Codex 依赖外部网络、凭证鉴权与收费模型，在默认 CI 中不稳定且不可行；真实本地 fixture 子进程能够完全在无外网、无凭证环境下稳定运行并验证完整协议与异常分支。在线验证留待 opt-in 的 Real Integration Profile。

## Consequences

1. M4 里程碑（Agent Runner / SPEC §10 / §12 / §17.5）正式完成收口。
2. 完整工作流 `WORKFLOW.md → config → workspace → runner → fake app-server subprocess` 拥有可重复、无凭证依赖、运行迅速（约 5 秒）的 Core Conformance 测试套件，纳入 `npm run gate`。
3. 架构依赖与分层边界得到测试机器保护，M5（Orchestrator）可安全依赖稳定的 `runAgentAttempt`、`AgentEvent` 与 `ContinuationDecider` 契约。
4. 在线真实 Codex 验证与跨机器/Windows 深度测试留待后续发布前阶段；orchestration 调度、重试队列与状态持久化留待 M5。
