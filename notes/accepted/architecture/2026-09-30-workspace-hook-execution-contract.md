# Agent Note: Workspace Hook Execution Contract
Status: accepted

## Problem

SPEC §5.3.4 / §9.4 定义了四个 workspace lifecycle hook（`after_create` / `before_run` /
`after_run` / `before_remove`）：以 host shell 执行、cwd = workspace、`hooks.timeout_ms`
超时、失败语义各不相同（after_create / before_run fatal，after_run / before_remove
best-effort）。§15.4 进一步要求 hook timeout 为 REQUIRED、输出 SHOULD 截断。§8.6 要求
startup 时对 terminal issue 的 workspace 目录做 cleanup。

M3.1 只在 `WorkspaceManagerOptions` 预留了一个 `hooks` 构造器字段与 `hooks_execution_failed`
/ `hook_timeout` 两个错误码，零行为；M3.2（#28）落地了 execution-boundary safety primitive
（`assertWorkspacePathSafe`），并在其契约里写明「#29 / M5 任何 destructive cleanup 前必须
重新调用」。#29 要在此之上落地 hook 执行层与 safe cleanup primitive，且必须严守 issue 的
设计边界：hook runner 属 execution layer，**不得**拥有 attempt scheduling、terminal-state
判断、retry policy、claim / concurrency（AGENTS.md 硬约束 2 的同源逻辑）。这些是跨包契约
（M4 消费 before/after_run、M5 消费 removeWorkspace），按 Working Rule 5 记录。

关键约束：`HooksConfig` 已在 M3.1 被放进构造器（`manager.hooksConfig`），但 §5.3.4 /§6.2
要求 hook timeout「Changes SHOULD be re-applied at runtime」——构造器快照会在 config reload
后缓存旧值，直接违反验收 2。同时 workspace 包不得依赖 observability（依赖方向），operator
可见性必须有别的出口。

## Decision

1. **执行层单一 runner**：新增 `packages/workspace/src/hooks.ts`，底层 `executeWorkspaceHook`
   负责 spawn（POSIX `sh -lc`）+ 有界输出捕获 + timeout 进程组终止 + operator 事件发射，
   四个 hook 共用。它**不做**路径安全校验（那是 manager 的职责），也**不理解**任何调度语义。
2. **hooks 配置改为调用时传入，移除构造器快照**：删除 `WorkspaceManagerOptions.hooks` 与
   `manager.hooksConfig`（无任何既有消费方，破坏面为零）。`HooksConfig` 经每次 lifecycle
   调用的 `options.hooks` 传入当前 effective 值；timeout 取 `options.hooks.timeoutMs`，包内
   不缓存旧值（验收 2）。非法 timeout 回退 `DEFAULT_HOOK_TIMEOUT_MS`（60000，与 §5.3.4 一致）。
3. **失败语义按 §9.4 分流**（`WorkspaceManager` 决定，非 runner）：
   - `after_create`（内嵌 `createWorkspace`）：仅 `createdNow=true` 执行；fatal——失败 / 超时
     抛 `hook_execution_failed` / `hook_timeout`，并 best-effort 删除**本次新建**的半成品目录；
     复用目录绝不运行、绝不删除。
   - `before_run`（`runBeforeRunHook`）：fatal——失败 / 超时抛可判别错误供 M4 中止 attempt；
     **本包不调度 retry**。
   - `after_run`（`runAfterRunHook`）：best-effort——永不 throw、不覆盖原 attempt outcome；
     失败 / 超时经 callback 发 operator 事件。
   - `before_remove`（`removeWorkspace` 内）：best-effort——失败 / 超时发事件，cleanup 继续。
4. **operator 可见性经 callback，不依赖 observability**：`WorkspaceHookEventSink`
   （`(event: WorkspaceHookEvent) => void`）承载 hook name / workspace path / identifier
   （可用时）/ outcome（failed / timeout）/ exit status·signal / truncated output。success
   不发事件（不打扰 operator）；hook start 日志属 §9.4 "Log hook start" 的 structured logging
   sink，为本 issue 明确非目标（归 M6）。sink 自身抛异常被隔离，不得冒泡为 hook 失败。
5. **有界输出**：单流捕获硬上限 `HOOK_OUTPUT_CAPTURE_LIMIT`（1 MiB）后停止累积并置
   `truncated`（继续 drain 以防子进程管道阻塞，但丢弃超限部分）；事件 / message 只带
   `HOOK_OUTPUT_EXCERPT_LIMIT`（8 KiB）摘录。上限为诊断用途的实现约定常量，非 SPEC 值。
6. **timeout 终止整个进程组**：detached spawn（child 为进程组组长）+ 负 pid `SIGKILL`，
   确保脚本派生的孙进程一并终止、不留孤儿；SIGKILL 不可 trap，避免 SIGTERM 被忽略导致的
   残留。finalize 时清理 timer、destroy stdio，不残留 handle。完成判定用 **`close`（stdio
   关闭）而非 `exit`（进程退出）**，以捕获脚本的全部输出；代价是「脚本秒退码 0 但后台进程
   持有继承的 stdout/stderr」会把 `close` 拖到 timeout（结果 `timeout`，进程组被 SIGKILL）
   ——确定、有界（≤ timeoutMs）、与不留孤儿一致，属文档化语义而非缺陷（PR #33 审查
   Suggestion 1，README Known limitations 同步记载；确需 daemonize 的 hook 应自行重定向
   stdio）。`child.stdout` / `child.stderr` 挂 no-op `error` 监听：管道读 EIO 类故障时
   stream 级 'error' 若无监听会成为 uncaught exception 击穿长驻 orchestrator 进程，
   降级为输出捕获中断、结果仍由进程级路径收敛（PR #33 审查 Suggestion 2）。
7. **destructive 动作前一律复用 #28 containment 校验，双重校验收窄 TOCTOU**：
   - 每次 hook spawn 前重验（执行 shell = #28 不变量适用场景）；
   - `after_create` 失败的半成品清理、`removeWorkspace` 的 `before_remove` 之后与 `fs.rm`
     之前**各重验一次**（hook 可能长时间运行并把目录替换成 symlink）；
   - unsafe / out-of-root / 非目录目标一律拒绝删除，绝不出根（验收 7）。
8. **`removeWorkspace` 返回可判别结果而非逐异常抛出**：`RemoveWorkspaceResult` =
   `removed` / `missing`（幂等成功，不运行 hook）/ `refused`（typed `reason`：复用 #28
   `UnsafePathReason` + `existing_non_directory` + `invalid_root`；未运行 hook、未删除）/
   `failed`（filesystem 删除失败，携带 `cause`，不吞）。仅非法 identifier 抛
   `invalid_identifier`（与 `createWorkspace` 一致）。不新增顶层 `WorkspaceErrorCode`
   （决策 6 / #28 先例：优先子字段 / 结果而非扩大已发布错误码集合）。

## Alternatives considered

1. **保留构造器 `hooks` 快照**：省一个 per-call 参数，但 config reload 后旧 `timeoutMs` /
   旧脚本仍被缓存，直接违反 §5.3.4 "re-applied at runtime" 与验收 2。无既有消费方，移除
   破坏面为零。否掉。
2. **`removeWorkspace` 对 unsafe / fs 失败抛 typed error（如 `unsafe_path`）**：与
   `createWorkspace` 的 throwing 风格一致，但 M5 在 §8.6 sweep 里对**每个** terminal
   identifier 循环调用，per-item try/catch 冗长，且单个 unsafe workspace 不应中断整轮
   sweep；issue 明确认可「返回可判别结果 / error」，missing 也建议用 `status`。选结果式，
   安全拒绝仍是 typed（`reason` 复用 `UnsafePathReason`），调用方按 `status` 分流。否掉。
3. **为 fs 删除失败新增顶层错误码（如 `directory_removal_failed`）**：判别更直白，但会改变
   M3.1 已发布、#28 刻意保持不变的 `WorkspaceErrorCode` 集合；复用 `directory_creation_failed`
   语义误导（那是创建）。以 `status: "failed"` + `cause` 表达，既不外扩错误码集合也不吞失败。否掉。
4. **operator 事件直接 import observability / 写日志**：违反依赖方向（workspace 不得依赖
   observability），且 structured logging sink 是本 issue 非目标（M6）。改经 callback 契约，
   组合根装配。否掉。
5. **timeout 用 SIGTERM→SIGKILL 宽限**：给脚本优雅清理机会，但被 trap 的 SIGTERM 会拖长
   终止、增加残留 timer / 孤儿风险，且 hook 是受信任配置无需优雅退出。直接 SIGKILL 进程组
   最可靠、最易测（孙进程 marker 用例）。否掉。
6. **`after_create` 因「目录刚由本调用创建并已过 gate」豁免 spawn 前重验**：省一次 syscall，
   但 mkdir 与 hook spawn 之间存在 await 窗口，重验成本极低且保持「执行 shell 前必重验」
   规则统一。选择重验（不豁免）。否掉豁免。
7. **把 `executeWorkspaceHook` 暴露为公共 API**：便于直接单测，但 issue 设计边界把公共面
   限定为 createWorkspace / runBeforeRunHook / runAfterRunHook / removeWorkspace；runner 是
   内部实现细节，测试经 manager 公共入口（testing.md「test the real entry path」）。否掉。

## Consequences

- **正面**：M4 / M5 拿到单一、无调度语义、无 observability 依赖的 lifecycle primitive 与
  明确的失败 / 事件 / cleanup 契约；四个 hook 的 cwd、multiline、non-zero、timeout+进程组
  终止、effective timeoutMs（无旧值缓存）、输出截断、after_create gate 与半成品清理、
  before_run fatal、after_run / before_remove best-effort、cleanup containment（含 TOCTOU
  期间被换成 symlink 的拦截）全部有真实 subprocess + 真实文件系统测试锁定（经 `index.ts`）。
- **负面与承诺**：
  - hook shell 为 POSIX `sh -lc` 语义，进程组终止为 POSIX（detached + 负 pid）语义；Windows
    无 `sh` 时属文档化限制（CI / gate 在 Linux），symlink 用例在不支持平台显式 skip（不静默 pass）。
  - validate 与 destructive delete 之间的 TOCTOU 窗口固有存在，只能收窄（双重校验）不能根除；
    消费方仍必须在破坏性动作前重验，`removeWorkspace` 已内建但 M4 / M5 自行删除时同样适用。
  - `removeWorkspace` 的 `status: "failed"`（fs 删除失败）路径在 root 运行时难以稳定触发
    （CAP_DAC_OVERRIDE 绕过权限位），由代码审查覆盖而非运行时用例——列为已知未验证项。
  - `RemoveWorkspaceResult` 为结果式契约，**调用方必须检查 `status`**；不得把返回即当作已删除。
  - 后续 M4 / M5 不得绕过本包自行实现 hook 执行 / cleanup containment，也不得把调度 / retry /
    terminal-state 判断塞进本包（边界写死在 issue 与 AGENTS.md 硬约束）。
