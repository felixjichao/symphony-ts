# Agent Notes — 决策记录

轻量决策记录（简化版 Agent Notes）：架构 / 选型 / 跨包契约的**已定结论**写在这里，代码只保留结论、Note 保留为什么。

## 什么时候写

- 新增或改变包边界、依赖方向、协议模型；
- 工具链 / 包管理 / 测试策略选型；
- 任何"下一个人（或 Agent）会问为什么不用另一种做法"的决定。

日常 bugfix、单包内部实现细节不需要 Note。

## 目录与命名

```
notes/{lifecycle}/{class}/yyyy-mm-dd-topic.md
```

- `{lifecycle}`：`accepted`（已生效）｜ `proposed`（评审中）｜ `superseded`（被取代，保留原文，头部注明取代者）
- `{class}`：`architecture` / `tooling` / `testing` / `product`（按需新增）
- 文件名用短横线小写，如 `2026-09-25-npm-workspaces.md`

提案先落 `proposed/`，接受后移入 `accepted/`（git mv 保留历史）。

## 格式契约

头两行固定，随后四个小节**全部必填**：

```markdown
# Agent Note: <title>
Status: proposed | accepted | superseded

## Problem
<当时的处境与约束>

## Decision
<定了什么，一段话说清>

## Alternatives considered
<至少一条被否掉的替代方案 + 否掉的理由；本小节强制存在且不允许只有空标题>

## Consequences
<正面与负面后果、后续承诺（例如"不得再引入 X"）>
```

M0.5 暂不引入机器校验（validator 归后续 doc gate 批次）；review 时按上述契约人工把关。

## 现有 Notes

- [accepted/architecture/2026-10-04-github-delivery-dogfood.md](accepted/architecture/2026-10-04-github-delivery-dogfood.md) — GitHub Delivery 真实集成 dogfood harness（SPEC §17.8 Real Integration，NEST-94 / #83）：opt-in `symphony dogfood github` 子命令驱动真实 Symphony host / 真实 Codex / 真实 GitHub 闭环（happy / repair / reuse / foreign / conflict），harness 只准备场景、注入受控故障与读回断言，交付动作全部走既有真实入口；缺 `--yes` 或凭据显式 SKIP，默认 gate 保持 credential-free；隔离目标模板与脱敏证据 manifest 落在 workspace 之外。
- [accepted/architecture/2026-10-04-codex-delivery-skill.md](accepted/architecture/2026-10-04-codex-delivery-skill.md) — Codex 交付与自动合入工作流 Skill（SPEC §11.5 / MVP.2，NEST-91 / #80）：`runDeliverySkill` 与 `symphony delivery-skill` CLI 支撑代码提交、分支推送、PR 创建与复用（`<!-- symphony-delivery-marker -->`）、HEAD 检查评估（复用 MVP.3 canonical `evaluateChecksAutoMergePolicy`）、有限修复循环（`maxRepairAttempts`）与自动 Squash Merge。落实用户确认决策：预算耗尽或 Blocker 时保持 Issue Open、自动移除 `symphony-ready` 标签停止调度派发，并输出 Operator 可见交接报告。
- [accepted/architecture/2026-10-04-github-delivery-mvp.md](accepted/architecture/2026-10-04-github-delivery-mvp.md) — GitHub Delivery MVP.3 交付原语与自动合并能力（SPEC §11.5 / §17.3，NEST-92 / #81）：`GitHubDeliveryService` 与 `symphony pr` CLI 支撑创建/复用 PR（精确保留 Symphony 所有权 marker 与 closing 关联、拒绝外国 PR / 歧义候选 / closed-unmerged）、基于 head commit SHA 的 required 与 current checks 判定（确认用户决策：有 required 严格全 green，无 required 至少 1 条严格全 green，其余均拒绝）、严格 squash 自动合并（显式 opt-in、服务端 `--match-head-commit` 校验、合并后重读事实验证 final merged state）、全链路凭据脱敏（URL/Token/Headers 零泄露）与子进程超时孤儿子树清理。

- [accepted/architecture/2026-10-04-repository-workspace-bootstrap.md](accepted/architecture/2026-10-04-repository-workspace-bootstrap.md) — 仓储工作区引导与确定性 Issue 分支同步（SPEC §9 / §17.2，NEST-90 / #79）：`bootstrapRepository` 与 `symphony repo-bootstrap` CLI 支撑目标仓库 clone、动态默认分支探测（非硬编码 main）、确定性分支命名（`symphony/<workspaceKey>`）、安全重入与同步（脏工作区与本地提交零破坏性覆盖、干净工作区 fast-forward、未识别内容与 origin URL 不匹配安全失败）、URL 敏感凭据过滤与 hook 环境变量注入（`SYMPHONY_WORKSPACE_KEY` / `SYMPHONY_ISSUE_IDENTIFIER`）。


- [accepted/architecture/2026-10-04-codex-protocol-drift-assessment-0.160.0.md](accepted/architecture/2026-10-04-codex-protocol-drift-assessment-0.160.0.md) — Codex 协议漂移评估（rust-v0.159.2 → rust-v0.160.0）：app-server-protocol 树哈希完全一致，24 项必查 schema surface 零漂移，裁定保持 pinned rust-v0.159.2，无迁移需求（NEST-88 / #75）。

- [accepted/architecture/2026-10-03-cli-process-lifecycle.md](accepted/architecture/2026-10-03-cli-process-lifecycle.md) — M6.5 host/shell 分层、显式 monitoring、共享 shutdown、failure priority 与真实 HTTPS process / timer 证据。

- [accepted/architecture/2026-10-03-effective-runtime-and-workspace-reload-lifecycle.md](accepted/architecture/2026-10-03-effective-runtime-and-workspace-reload-lifecycle.md) — EffectiveRuntime 单一权威与 Workspace 动态重载生命周期（SPEC §6.2 / §13 / §18.1，M6.4 / NEST-84）：`EffectiveRuntimeController` 单点真相（不可变快照、watcher store 结合零双源、原子 `accept` 校验与回滚）、三种生命周期分层（current runtime / attempt frozen execution options / coordinator-bound cleanup）、workspace 根目录热重载与终态清理精准归属（旧 attempt 清理在旧 root、新 attempt 清理在新 root、不跨根误删、不暴力杀 worker、不遍历扫旧根）、secret boundary 运行时隔离（child env 严格排除 tracker secrets、宿主 adapter 正常认证）

- [accepted/architecture/2026-10-03-cli-host-and-executable-contract.md](accepted/architecture/2026-10-03-cli-host-and-executable-contract.md) — CLI 宿主组合根与可执行契约（SPEC §17.7 / §18.1，M6.3 / NEST-83）：`createHost()` 进程内组合根与测试注入、`parseCliArgs` / `resolveWorkflowPath` 优先级解析、`apps/cli` 真实 `bin` 契约（`dist/bin/symphony.js` shebang 与执行权限）、Node >= 20 原生 ESM 运行、真实子进程生命周期测试与 SIGINT/SIGTERM 优雅停机

- [accepted/architecture/2026-10-03-orchestrator-core-conformance.md](accepted/architecture/2026-10-03-orchestrator-core-conformance.md) — M5.6 完整 loop 证据、effective store 与 M6 宿主接线 policy

- [accepted/architecture/2026-10-03-poll-loop-and-live-config-reapply.md](accepted/architecture/2026-10-03-poll-loop-and-live-config-reapply.md) — poll loop、startup 编排与 live config re-apply 跨包契约（SPEC §8.1、§14.2 / §14.3 / §14.4、§16.1 / §16.2、§6.2 / §6.3，M5.5 / NEST-78 / #54）：单 timer 链替代 `setInterval`（tick 结束按最新 interval 排下一次、首 tick 零延迟、慢 tick 不重叠）、startup 三步且 preflight fail-fast / terminal sweep best-effort、tick 严格按 §16.2 且降级出口经 `finally` 只排一个下一次 tick、authority `applyEffectiveSchedulingConfig` 原子 apply（policy 改可变 + continuation decider getter，retry cap / stall 继续 getter）、并发下调不终止运行 worker、`shutdown` 先失效全部 retry ownership 再停 worker 且幂等
- [accepted/architecture/2026-10-03-reconciliation-stall-startup-cleanup.md](accepted/architecture/2026-10-03-reconciliation-stall-startup-cleanup.md) — active-run reconciliation / stall detection / terminal cleanup / startup sweep 跨包契约（SPEC §7.3 / §7.4、§8.5 / §8.6、§14.2 / §14.3、§16.3、§17.4，M5.4 / NEST-77 / #53）：纯判定抽离、stall 用同一 UTC 时钟域并回退身份未齐的暂存时间戳、`<= 0` 禁用 / 严格大于阈值、先 stall 后批量 refresh 且无 running 零请求、按 attempt token 丢弃迟到结果并在 stop 分支接管旧生命周期 retry、cleanup 端口提升为 authority 顶层能力（回退旧 retry 接线）、per-issue 收尾屏障先于 stop 建立并串行化后续 refresh / launch、startup sweep best-effort 且不做 `fs.rm` fallback
- [accepted/architecture/2026-10-03-retry-queue-timer-ownership.md](accepted/architecture/2026-10-03-retry-queue-timer-ownership.md) — retry queue 与 timer ownership 跨包契约（SPEC §8.4 / §14.2 / §16.6 / §17.4，M5.3 / NEST-76 / #52）：authority 独占 retry 状态与 timer（`RetryScheduler` / `RetryOptions` 可注入，默认 `setTimeout`）、normal 固定 attempt 1 / 1s 与 failure `min(10000 * 2^(attempt-1), cap)`、替换取消旧 timer、ownership token 在入口与每个 await 后校验以隔离 stale / canceled 回调、`on_retry_timer` refresh 全分支（missing / terminal 安全 cleanup / inactive·unroutable / `no available orchestrator slots` / 重派）、`isRetryDispatchAllowed` 的 retry claim 豁免与私有重派提交路径、terminal cleanup 只经 workspace 端口且 refused / failed 只记诊断
- [accepted/architecture/2026-10-03-orchestrator-dispatch-and-worker-lifecycle.md](accepted/architecture/2026-10-03-orchestrator-dispatch-and-worker-lifecycle.md) — orchestrator dispatch 与 worker lifecycle 跨包契约（SPEC §7.3 / §7.4 / §16.4 / §16.5 / §17.4，M5.2 / NEST-75 / #51）：单一 `OrchestratorAuthority` 写入者、无 `await` 的 dispatch 提交段（claimed/running 双检查 + 原子写入 + retry 清除）、幂等且有界停止的 `WorkerControl`（attempt `AbortSignal`）、`AgentAttemptOptions` 最小新增 `signal` / `onPhase`、主动 stop reason 优先的终态分类与 `suppressRetry` / `retryKind` outcome、claim 经 `onOutcome` 交接给 M5.3、attempt token 隔离、绝对 token 正差额入账与高水位、注入式 tracker refresh continuation decider
- [accepted/architecture/2026-10-02-agent-integration-and-core-conformance.md](accepted/architecture/2026-10-02-agent-integration-and-core-conformance.md) — agent 端到端集成与 M4 Core Conformance 收口（SPEC §10 / §12 / §17.2 / §17.5 / §18.1，M4.6 / NEST-71 / #42）：`WORKFLOW.md → loadEffectiveWorkflow → WorkspaceManager → real temp fs + hooks → runAgentAttempt → bash -lc app-server subprocess → JSON-RPC session/events` 完整真实链路、verify the world 重读世界与双向外部证据断言、十组场景覆盖（创建/复用、hook 时序、prompt 展开、before/after 失败、child cwd、握手时序、exit 127 映射 `codex_not_found`、silence timeout 与 stderr 隔离、headless 自动决策、多轮 continuation 循环与 launch 负例）、AST 扫描锁定 Liquid/containment 与 wire method 不泄漏
- [accepted/architecture/2026-10-01-agent-runner-composition-and-continuation.md](accepted/architecture/2026-10-01-agent-runner-composition-and-continuation.md) — Agent Runner 编排、prompt/hooks 组装与同 thread continuation 循环（SPEC §10.7 / §12 / §16.5，M4.5 / NEST-70 / #41）：`runAgentAttempt()` 单一 worker attempt 驱动原语、create 失败不调 after_run、before_run fatal、严格 prompt 前置校验、握手期 127 退出映射为 `codex_not_found`、首轮模板与后续轮 `DEFAULT_CONTINUATION_GUIDANCE` 指导文本、`agent.max_turns` 硬上限、`ContinuationDecider` 依赖反转与 30s 有界等待、`after_run` best-effort 永不覆盖原结果
- [accepted/architecture/2026-10-01-headless-server-requests-and-event-mapping.md](accepted/architecture/2026-10-01-headless-server-requests-and-event-mapping.md) — headless server requests 处理与 runtime event 映射（SPEC §10.4 / §10.5 / §10.6 / §17.5，M4.4 / NEST-69 / #40）：`approvalPolicy === "never"` 下 v2 与 legacy approval 自动同意（`approval_auto_approved`）、非 never 稳定失败为 `approval_required`、人工输入即时失败（`turn_input_required`）、未支持动态工具调用返回结构化 failure 且 session 可用、遥测提取（tokenUsage total 快照与 rateLimits 快照）、全 12 种 `AgentEvent` 稳定映射与 early completion 缓冲收敛
- [accepted/architecture/2026-10-01-codex-session-lifecycle.md](accepted/architecture/2026-10-01-codex-session-lifecycle.md) — pinned `rust-v0.159.2` schema 的 Codex app-server live session 生命周期（SPEC §10.2 / §10.3 / §10.6 / §17.5，M4.3 / NEST-68 / #39）：`initialize` → `initialized` → `thread/start` → `turn/start` → `turn/completed` 严格时序、thread / turn 身份抽取与 `composeSessionId`、`cwd === workspace.path` 绑定、pass-through policies 映射、基于 `turn.status` 完成判定（`completed` / `failed` / `interrupted` / `inProgress`）、turn silence timeout 与有效输出重置 timer、多 turn 连续执行与单活跃 turn 不变量
- [accepted/architecture/2026-10-01-agent-transport-kernel-and-launch-boundary.md](accepted/architecture/2026-10-01-agent-transport-kernel-and-launch-boundary.md) — agent transport kernel 与 coding-agent launch 边界（SPEC §10.1 / §10.3 / §10.6 / §17.2 / §17.5，M4.2 / NEST-67 / #38）：`transport.ts`（纯协议 kernel、不 own 进程）与 `process-launcher.ts`（唯一 spawn 点）的分层、envelope 四判别位分类且 `method` 恒为不透明字符串（fixture 只用 `test/*`，出现真实 Codex method 即写穿边界）、有界行长 + discard-until-newline 后恢复成帧、协议流与 stderr 物理隔离、一次调用只有一个了结算、`detached` + SIGTERM→窗口→SIGKILL 整个进程组、launch 顺序「env → `assertWorkspacePathSafe` → 同一同步续体 `spawn`（中间不 await）」、gate 以结构化 `WorkspacePathSafetyGate` 而非 `WorkspaceManager` 具体类、env 面只有显式注入 + 通用 `excludeEnvNames`（不硬编码 provider secret 名）、方案 A 的包外可见性（导出类型与默认常量、不导出 `launchTransport` / `createNdjsonTransport`）
- [accepted/architecture/2026-09-30-codex-protocol-baseline-and-agent-contracts.md](accepted/architecture/2026-09-30-codex-protocol-baseline-and-agent-contracts.md) — Codex 协议基线与 agent 契约层（SPEC §5.3.6 / §6.1 / §10.2–§10.6 / §17.5，M4.1 / #37）：Symphony SPEC 与 Codex app-server 是**两条独立版本轴**（各自的权威与升级流程、pinned `rust-v0.159.2` / `ff6aec96…` + schema source paths）、`CodexPassThroughValue` 只表达**形状类别**而非手抄 enum 且 config 只做 JSON-safety + 无环校验（wire 无损是 Symphony 的义务、枚举合法性是 Codex 的裁决）、`AgentError` / `AgentEvent` 以 Symphony 词汇为判别面且不透出 raw Codex JSON、continuation 以注入点（`ContinuationDecider`）绕开 `agent → tracker` 禁令、"不复制 Codex generated schema"由结构测试守
- [accepted/architecture/2026-09-30-workspace-hook-execution-contract.md](accepted/architecture/2026-09-30-workspace-hook-execution-contract.md) — workspace lifecycle hook 执行层与 safe cleanup 跨包契约（SPEC §5.3.4 / §9.4 / §15.4 / §8.6，M3.3 / #29）：四个 hook 共用 `sh -lc` runner（cwd = workspace、timeout SIGKILL 进程组、有界输出捕获 + 事件摘录）、hooks 配置改为调用时传入并移除构造器快照（杜绝 reload 后旧值缓存）、失败语义按 §9.4 分流（after_create / before_run fatal，after_run / before_remove best-effort）、operator 事件经 callback 暴露（不依赖 observability）、`removeWorkspace` 返回可判别结果（removed / missing / refused / failed，不新增顶层错误码）、destructive 动作前双重 #28 containment 校验、本包不拥有调度 / retry / terminal-state
- [accepted/architecture/2026-09-30-workspace-path-safety-contract.md](accepted/architecture/2026-09-30-workspace-path-safety-contract.md) — workspace path filesystem safety boundary 跨包契约（SPEC §9.5，M3.2 / #28）：lexical + canonical（每次实时 `realpath`、不缓存）双层 containment、尚不存在路径按最近已存在 ancestor 推定、dangling symlink fail-closed、`unsafe_path` 经 `unsafeReason` 子字段细分四类拒绝面（顶层错误码集合不变）、M4 launch 前与 #29 / M5 cleanup 前必须重验 `assertWorkspacePathSafe`
- [accepted/architecture/2026-09-29-workspace-non-directory-policy.md](accepted/architecture/2026-09-29-workspace-non-directory-policy.md) — 已存在非目录对象的安全失败策略（SPEC §17.2，M3.1 / #27）：对已有常规文件、符号链接等非目录对象绝不自动删除或替换，抛出稳定类型化 `existing_non_directory` 错误，并在 EEXIST 竞态下重检可用目录不变量
- [accepted/architecture/2026-09-28-github-rest-transport-pagination.md](accepted/architecture/2026-09-28-github-rest-transport-pagination.md) — GitHub REST transport（M2.3 / #20）：默认 transport 在 `createAdapter` 内按 context 构造并删除 M2.2 的 unconfigured 桩、`Link` 分页的 origin 守卫与"读不懂即失败"、state 过滤不判 malformed、ID refresh 串行 + 坏 ID 整批前置失败、`fetchImpl` 注入点而非放宽 HTTPS-only 校验
- [accepted/architecture/2026-09-28-github-adapter-transport-boundary.md](accepted/architecture/2026-09-28-github-adapter-transport-boundary.md) — GitHub adapter 的 transport 注入边界（M2.2 / #19 方案 B）：`GitHubIssueTransport` 单端口、未配置 transport 抛 `tracker_request`、归一化失败用抛出而非 union、payload 保持 `unknown`、§11.1 "SHOULD log" 以 `onMalformedRecord` 注入点交付、显式 `$VAR` 不做二次 env 回落（其中"built-in 注册 unconfigured transport"已由 M2.3 取代，见上一条）
- [accepted/architecture/2026-09-28-tracker-adapter-config-extension.md](accepted/architecture/2026-09-28-tracker-adapter-config-extension.md) — tracker adapter 注册表与 `@symphony/config` 的跨包扩展点契约：契约归 config / 实现归 tracker 的结构化对接、失败以返回值而非异常表达、三个 tracker 错误码进 `ConfigErrorCode`、profile 默认不回写 `ServiceConfig`，M2.1（SPEC §6.3 / §11.1 / §11.2 / §11.4 / §17.1）
- [accepted/architecture/2026-09-27-prompt-rendering-contract.md](accepted/architecture/2026-09-27-prompt-rendering-contract.md) — 严格 prompt 渲染契约：snake_case 变量面、`attempt` 恒在场、空正文默认 prompt、ISO 时间戳、错误归类与 `<inline>` 哨兵，M1.4（SPEC §5.4 / §12.2）
- [accepted/architecture/2026-09-27-workflow-reload-contract.md](accepted/architecture/2026-09-27-workflow-reload-contract.md) — 热重载契约：轮询 + stamp 检测、last-known-good 不变量、valid / invalid reload 与事件面、`reload()` 防御性再校验，M1.4（SPEC §6.2 / §6.3）
- [accepted/tooling/2026-09-27-config-liquidjs-dependency.md](accepted/tooling/2026-09-27-config-liquidjs-dependency.md) — `@symphony/config` 引入 `liquidjs` 作为第二个运行时依赖的选型与严格模式行为（M1.4）
- [accepted/architecture/2026-09-27-config-resolution-contract.md](accepted/architecture/2026-09-27-config-resolution-contract.md) — typed config resolution 的管道语义与边缘裁定：`tracker.kind` 空串哨兵、`$VAR` 仅限 `workspace.root`、双 invalid-value 策略、显式 null / `~user` / by-state last-wins，M1.3（SPEC §5.3 / §6）
- [accepted/architecture/2026-09-27-workflow-loader-contract.md](accepted/architecture/2026-09-27-workflow-loader-contract.md) — WORKFLOW.md loader 的公共 API、`SymphonyConfigError` 错误契约与边缘语义（空块 / 未闭合 / 非 map 根 / BOM·CRLF），M1.2（SPEC §5.1–§5.3）
- [accepted/tooling/2026-09-27-config-yaml-dependency.md](accepted/tooling/2026-09-27-config-yaml-dependency.md) — `@symphony/config` 引入 `yaml` 作为仓库首个运行时外部依赖的选型（M1.2）
- [accepted/tooling/2026-09-27-typescript-5x-pin.md](accepted/tooling/2026-09-27-typescript-5x-pin.md) — 根级 TypeScript 收敛到 5.x（devDependencies + overrides）并移除已弃用的 `baseUrl`（TS5101 隐患）
- [accepted/architecture/2026-09-27-domain-contracts.md](accepted/architecture/2026-09-27-domain-contracts.md) — SPEC §4 领域契约的 TypeScript 建模约定：命名映射、nullable vs optional、时钟域、不透明句柄、§4.2 纯函数归属（M1.1）
- [accepted/architecture/2026-09-26-align-with-upstream-spec.md](accepted/architecture/2026-09-26-align-with-upstream-spec.md) — 对齐官方 SPEC：固定 baseline、删除协议栈 scaffold、按 SPEC 主组件重建 workspace 边界（M0.6）
- [accepted/tooling/2026-09-25-npm-workspaces.md](accepted/tooling/2026-09-25-npm-workspaces.md) — npm workspaces 为唯一 canonical 包管理

- [accepted/architecture/2026-10-03-structured-logging.md](accepted/architecture/2026-10-03-structured-logging.md) — M6.2 structured logging、提交点事实事件、安全预算与 composition 接线边界（§13.1/§13.2/§17.6）

### Superseded（保留原文，不改写历史）

- [superseded/architecture/2026-09-25-m0-scaffold.md](superseded/architecture/2026-09-25-m0-scaffold.md) — M0 脚手架：8-workspace 边界先行（被 align-with-upstream-spec 取代）
- [superseded/architecture/2026-09-26-ctl-gateway-access.md](superseded/architecture/2026-09-26-ctl-gateway-access.md) — symctl 访问网关的路径（被 align-with-upstream-spec 取代，ctl / gateway 已删除）

- [accepted/architecture/2026-10-03-observability-snapshot.md](accepted/architecture/2026-10-03-observability-snapshot.md) — M6.1 snapshot、双时钟与 retry URL 最小跨包透传。
