# Agent Note: EffectiveRuntime 单一权威与 Workspace 动态重载生命周期（SPEC §6.2 / §13 / §18.1）
Status: accepted

## Problem

Symphony 长期运行宿主（SPEC §6.2 / §18.1）允许操作员在服务运行期间热修改 `WORKFLOW.md`。每次修改可能波及六个强相关的运行期状态：
1. `EffectiveWorkflow` 及其已解析配置；
2. `ServiceConfig`（含 polling、agent 并发、retry cap、stall timeout 等）；
3. 所选 tracker adapter profile 与实例（如变更 provider 配置或凭据）；
4. child process 环境变量排除列表（`excludeEnvNames`）；
5. `WorkspaceManager`（若 `workspace.root` 改变）；
6. orchestrator 运行期调度参数（`applyEffectiveSchedulingConfig`、stall getter、retry cap getter、continuation decider）。

若各组件分别监听文件系统或采用各自的缓存/状态，极易产生状态漂移：
- `watchWorkflow.current()` 与 `preflight` 返回不同版本；
- dispatch 派发取到了新 workflow prompt，但子进程环境变量仍暴露旧 tracker secrets，或相反；
- `workspace.root` 发生 reload 后，已运行或已派发的 attempt 在终态清理（reconciliation terminal cleanup）时按新 root 计算路径，导致误删新根中的同名目录，或残留旧根中的工作区。

必须在 CLI 宿主建立唯一的不可变原子快照与生命周期归属机制。

## Decision

在 `apps/cli` 组合根建立单点真相 `EffectiveRuntime` 权威模型与 `WorkspaceLifecycleCoordinator`，确立三个明确的生命周期分层：

1. **当前宿主运行时生命周期（Current Runtime Lifetime）**：
   - 由 `EffectiveRuntimeController` 独占维护当前有效的不可变 `EffectiveRuntime` 快照。
   - `EffectiveWorkflowStore` 接口实现与 `watchWorkflow({ store })` 结合：watcher 的 `current()` 与 `accept()` 均直接代理至该 controller，消灭任何双重真相源。
   - 原子事务写入（`accept`）：
     - 校验 tracker kind 与 profile 匹配；
     - 重新构造 tracker adapter；
     - 若构造失败或配置校验失败（如 empty codex command），整个 reload 立即拒绝并抛出异常，保持上一版本完全不被污染，同时发出 operator-visible 错误日志；
     - 仅在所有组件就绪后原子替换 `current` 快照，并同步调用 `authority.applyEffectiveSchedulingConfig`。
   - 暴露只读动态 proxy `trackerProxy` 与动态 `preflight`，确保调度循环、重试队列与状态探测始终统一读取最新快照。

2. **Attempt 执行期生命周期（Attempt Execution Lifetime）**：
   - 每次 attempt 被 authority 派发时，由 `WorkspaceLifecycleCoordinator` 建立绑定：
     - issue identifier 及 id 绑定至当前 runtime 的 `workspaceManager` 与 `EffectiveRuntime`；
     - attempt options 冻结当前 runtime 的 `workflow` 定义、`serviceConfig`、`excludeEnvNames`；
     - 运行中的 worker 子进程在其整个生命周期中继续使用派发时的配置与环境变量隔离策略，**reload 绝不重启或中断正在运行的 worker**；
     - 但 hook 调用通过 live getter 读取最新配置，允许动态更新 hook 脚本。

3. **Workspace 清理生命周期（Cleanup Binding Lifetime）**：
   - 终态对齐清理（terminal cleanup）经 `WorkspaceLifecycleCoordinator.resolveForCleanup(context)` 执行；
   - 命中 issue 绑定的清理操作严格使用该 issue 派发时记录的旧 `WorkspaceManager` 执行，保证在 `root-A` 下启动的 attempt 在 `root-A` 中被清理，**绝不会因 `workspace.root` reload 到 `root-B` 而在 `root-B` 下误删**；
   - 清理成功后释放绑定；失败或拒绝时保留绑定以备 retry；
   - 未绑定的清理操作（如启动期 sweep）回退使用当前最新 runtime 的 `WorkspaceManager`；
   - **禁止全量扫描或清理旧 roots**，旧 root 中的非受管文件严格由操作员自行管理。

## Alternatives considered

1. **静态不变 WorkspaceManager（Static Manager）**：
   - *方案*：启动后 workspaceManager 保持单例，不随 `workspace.root` reload。
   - *否决理由*：违反 SPEC §6.2 / §17.1 对全字段热重载的要求，操作员迁移工作区存储卷时无法生效。
2. **无状态动态拼接根路径（Unconditioned Cleanup on Current Manager）**：
   - *方案*：清理时总是读取当前最新的 `controller.current.workspaceManager.removeWorkspace()`。
   - *否决理由*：严重破坏隔离性。若 Attempt A 在 `root-A` 运行期间 `workspace.root` 改为 `root-B` 且 Attempt B 在 `root-B` 运行同名或不同名 issue，Attempt A 终态清理时会在 `root-B` 查找甚至误删 `root-B` 内的目录，造成跨根文件污染或数据丢失。
3. **热重载时强行杀死运行中 worker（Aggressive Worker Termination）**：
   - *方案*：每次检测到 workflow 变化，立即 kill 运行中的 coding agent 子进程以应用新配置。
   - *否决理由*：严重违背 orchestrator 长期运行不变量与 SPEC §6.2；agent worker 通常耗时数分钟，暴力 kill 会丢失进行中的代码生成和外部交互，且可能导致外部 tracker 状态错乱。
4. **重载时自动遍历扫描旧根（Sweeping Abandoned Roots）**：
   - *方案*：切换 `workspace.root` 时自动递归扫描并清理旧根中的所有目录。
   - *否决理由*：极度危险。旧根可能被操作员挂载给其他任务或归档，自动化扫描和批量删除可能造成非预期的灾难性数据丢失。

## Consequences

- **正面效果**：
  - `host.effective`、`watcher.current()`、`preflight`、`tracker` 代理与调度器实现了强一致的单一权威，无任何状态漂移；
  - 无论配置如何频繁热重载，运行中 worker 保持稳定不中断，环境变量与 tracker secrets 隔离保持绝对安全；
  - 工作区根目录切换时各 attempt 终态清理落点精准，绝不跨根误删。
- **负面与约束**：
  - 调度派发与清理协调器需显式建立 lifecycle 绑定与释放机制；
  - 后续实现不得绕过 `EffectiveRuntimeController` 自行缓存 `EffectiveWorkflow` 或 `ServiceConfig` 的内部字段；
  - 未绑定历史 attempt 的未清理工作区不会被自动感知，需依赖操作员人工或专用离线维护工具清理。
