# @symphony/workspace

## Purpose

SPEC **§9 Workspace Management and Safety** 的 owner 包，对应 §3 的 Workspace Manager：per-issue 隔离目录的 provisioning（issue id 净化、防碰撞命名）、路径 containment 校验、生命周期脚本（startup / cleanup hooks）的执行。**修改 workspace lifecycle hook 的唯一落点在本包。**

## Configuration & Dependencies

Workspace Manager 接收已解析的运行时配置，不自行读取或解析 `WORKFLOW.md`。

运行期依赖方向（严格单向）：
```text
@symphony/workspace → @symphony/domain
```
`@symphony/domain` 提供 `Workspace`、`WorkspaceConfig`、`HooksConfig` 契约以及权威 `deriveWorkspaceKey` 实现；本包不依赖 `@symphony/config`。

## Public API

包的唯一公共入口为 `src/index.ts`：

### 核心管理接口

- `WorkspaceManager` / `createWorkspaceManager(options: WorkspaceManagerOptions)`：
  - `options.workspace.root`：必须为非空且已规范化的绝对路径（SPEC §9.1）。
  - **hooks 配置不是构造器字段（#29）**：`HooksConfig` 必须在每次 lifecycle 调用时作为
    `options.hooks` 传入当前 effective 值（见下方 Lifecycle Hooks）。M3.1 预留的
    `options.hooks` / `manager.hooksConfig` 构造器快照已移除——快照会在 config reload 后
    缓存旧值、违反 §5.3.4 / §6.2 的 reload 语义（验收 2）。
- `deriveWorkspaceKey(identifier: string): string`：
  - 直接复用 `@symphony/domain` 的权威实现（SPEC §4.2），包含对非 `[A-Za-z0-9._-]` 字符的 `_` 净化与 64-bit SHA-256 熵防碰撞后缀；
  - 非法 / 空 identifier 抛出类型化 `invalid_identifier`。
- `resolveWorkspacePath(identifier: string): string`（别名 `resolvePath`）：
  - 确定性计算 `workspace.root + workspaceKey`；
  - 校验路径不等于 root 且不逃逸 root（SPEC §9.5 Invariant 2），非法时抛出 `unsafe_path`（含 `unsafeReason` 细分）。同步 lexical 层校验；filesystem 级 canonical 校验见 `validateWorkspacePath` / `assertWorkspacePathSafe`。
- `resolveWorkspacePathFromKey(workspaceKey: string): string`：
  - 基于已知 workspaceKey 计算并校验路径（同步 lexical 层，同上）。
- `validateWorkspacePath(workspacePath: string): Promise<WorkspacePathValidation>`：
  - 完整执行 #28 安全不变量校验（absolute + lexical containment + canonical containment，见下节）；
  - 不抛安全拒绝：返回 discriminated 结果（`safe: true` 携带 `canonicalRoot` / `canonicalPath` / `exists`；拒绝携带 `reason` 与诊断信息）。
- `assertWorkspacePathSafe(workspacePath: string, options?): Promise<void>`：
  - 同一校验的 throwing 形态，是 M4（agent launch 前）与 #29 / M5（destructive cleanup 前）必须调用的 execution-boundary safety primitive；
  - 拒绝时抛出 `unsafe_path`（`error.unsafeReason` 细分四类）；root 自身不可用时抛出 `invalid_root_path`；
  - `options` 可携带 `workspaceKey` / `identifier` 诊断上下文（透传进 `WorkspaceError`）。
- `createWorkspace(identifier: string, options?: WorkspaceLifecycleHookOptions): Promise<Workspace>`（别名 `ensureWorkspace`）：
  - 缺失目录：创建并返回 `{ path, workspaceKey, createdNow: true }`；
  - 已有目录：原样复用并返回 `{ path, workspaceKey, createdNow: false }`；
  - 复用与新建两条路径都先通过 filesystem 级 safety gate（#28）：canonical containment / symlink escape 校验失败抛 `unsafe_path`，绝不复用或创建出根外目录；
  - 并发保护：处理 EEXIST 竞态，重检文件系统确保最终返回的必定是可用目录；
  - 非目录对象：执行下述 Safe Failure Policy；
  - **`after_create` hook（#29）**：仅当 `createdNow = true` 且 `options.hooks.afterCreate` 已配置时执行；复用目录绝不运行、绝不删除（详见下方 Lifecycle Hooks）。
- `runBeforeRunHook(workspace: Workspace, options: RunWorkspaceHookOptions): Promise<void>`（#29，SPEC §9.4）：
  - M4 Agent Runner 每 attempt 前显式调用；`before_run` failure / timeout → 抛可判别 fatal 错误（`hook_execution_failed` / `hook_timeout`），供 M4 中止当前 attempt；
  - **本包不调度 retry**（retry policy 归 M4 / M5）；未配置脚本 → no-op 成功；spawn 前重过 #28 安全校验，unsafe → 抛 `unsafe_path`。
- `runAfterRunHook(workspace: Workspace, options: RunWorkspaceHookOptions): Promise<void>`（#29，SPEC §9.4）：
  - M4 每 attempt 结束后显式调用；**best-effort，永不 throw**——success / failure / timeout 都正常返回，绝不覆盖原 attempt outcome；
  - failure / timeout 经 `onHookEvent` 产生 operator-visible 事件；unsafe 路径 → 发 `failed` 事件说明 skipped，正常返回（绝不在 unsafe 路径执行 shell）。
- `removeWorkspace(identifier: string, options?: WorkspaceLifecycleHookOptions): Promise<RemoveWorkspaceResult>`（#29，SPEC §8.6 / §9）：
  - M5 Orchestrator 在 startup terminal sweep（§8.6）与 reconciliation cleanup 调用；
  - 返回可判别结果 `RemoveWorkspaceResult`：`removed` / `missing`（幂等成功，不运行 hook）/ `refused`（unsafe·out-of-root·非目录·root 不可用——**未运行 hook、未执行任何 destructive delete**，携带 typed `reason`）/ `failed`（filesystem 删除失败，不吞、携带 `cause`）；
  - `before_remove` 为 best-effort（failure / timeout → operator 事件，cleanup 继续）；删除前**双重** #28 containment 校验（hook 前 + destructive delete 前，收窄 TOCTOU）；
  - 除非法 identifier（抛 `invalid_identifier`）外全部经结果返回，便于 M5 在 sweep 循环里逐项处理；**调用方必须检查 `status`**。

### 错误契约（SPEC §9 / §17.2）

对外统一抛出类型化 `WorkspaceError`，主要判别契约为 `error.code`（`WorkspaceErrorCode`），不把 Node fs 原始异常暴露为主要判别式，底层异常经 `error.cause` 保留：

| 错误码（`code`） | 触发时机 |
|---|---|
| `invalid_identifier` | identifier 为空、非字符串或无法派生 key |
| `invalid_root_path` | `workspace.root` 未提供、空路径、非绝对路径，root 本身为非目录文件（ENOTDIR），或 root 为 dangling symlink |
| `existing_non_directory` | 目标路径已存在同名常规文件、符号链接等非目录对象 |
| `directory_creation_failed` | 文件系统权限不足（EACCES）、只读（EROFS）或 I/O 故障 |
| `unsafe_path` | 路径等于 root 本身或逃逸出 root 边界（§9.5 Invariant 2）；具体原因经 `error.unsafeReason` 细分（见下表） |
| `hook_execution_failed` | 生命周期脚本执行失败（非零退出码 / spawn failure；SPEC §9.4，#29 已启用）。仅 `after_create` / `before_run`（fatal hook）会抛出；`after_run` / `before_remove` 为 best-effort，改经 operator 事件暴露 |
| `hook_timeout` | 生命周期脚本执行超时（超过 effective `timeoutMs`，进程组被 SIGKILL 终止；SPEC §9.4，#29 已启用）。抛出/事件语义同上 |

`unsafe_path` 的细分拒绝面（`error.unsafeReason`，#28；仅当 `code === "unsafe_path"` 时出现）：

| `unsafeReason` | 触发时机 |
|---|---|
| `workspace_equals_root` | workspace path 等于（或经 symlink 解析后等于）workspace root 本身 |
| `workspace_outside_root` | workspace path 非绝对路径，或 lexical 上逃逸出 root（`../`、sibling、`/root2` 一类前缀混淆等） |
| `workspace_symlink_escape` | workspace path（或其已存在 ancestor）经 symlink / canonical 解析后落在 canonical root 之外 |
| `workspace_path_unreadable` | 路径或 root 无法 canonicalize：权限不足、dangling symlink（fail-closed）、ELOOP、ENOTDIR 等；原始 fs 异常经 `cause` 保留 |

## Safety Invariants & Path Safety（SPEC §9.5 / #28）

任何准备执行 shell、agent 或 destructive delete 的 workspace path 都必须满足：

```text
absolute(workspace)
&& workspace !== root
&& lexicalContained(workspace, root)
&& canonicalContained(workspace, canonicalRoot)
```

实现要点：

1. **lexical 层**（同步，`resolveWorkspacePath*` 与 validate 第一步）：`path.resolve` 规范化后按 path segment（含 `path.sep` 前缀）判定，**不使用裸 `startsWith(root)`**（防 `/root2` 前缀混淆）；
2. **canonical root 权威**：每次校验实时执行 `fs.realpath(root)`，**不缓存**——root 自身含 symlink 时以 canonical root 判定 containment，root 被替换后立即生效；
3. **已存在路径**：`realpath(workspacePath)` 必须严格位于 canonical root 之下且不等于 canonical root；realpath 逃逸 → `workspace_symlink_escape`；
4. **尚不存在路径**：向上找最近已存在 ancestor，对该 ancestor 做 realpath 后 join 剩余 segment 得到 predicted canonical path，要求其严格落在 canonical root 之下——不因目标尚不存在而跳过 safety validation；
5. **dangling symlink fail-closed（对称语义）**：目标不存在的 symlink 无法 canonicalize，按 `workspace_path_unreadable` 拒绝，不自行解析多级 symlink 链预测落点；无论 dangling 出现在目标级还是上溯途中的已存在 ancestor，一律 fail-closed，不得被当作「不存在」越过投影。校验全程不逃逸非类型化异常：极端 I/O 故障同样收敛为 typed 结果 / `WorkspaceError`；
6. **TOCTOU 重验入口**：validate 与后续动作（launch / delete）之间存在固有窗口，只能收窄不能根除。M4 在 agent launch 前、#29 / M5 在任何 destructive cleanup 前，**必须重新调用 `assertWorkspacePathSafe`**，防止「创建后目录被替换成 symlink」绕过字符串路径校验。

决策记录（为何每次 realpath 不缓存、为何错误面用 `unsafeReason` 子字段而非新顶层错误码等）见 Agent Note：`notes/accepted/architecture/2026-09-30-workspace-path-safety-contract.md`。

## Lifecycle Hooks（SPEC §5.3.4 / §9.4 / §15.4，#29）

本包是四个 workspace 生命周期脚本（`after_create` / `before_run` / `after_run` /
`before_remove`）的**执行层 owner**，但**不拥有**任何调度语义——attempt scheduling、
terminal-state 判断、retry policy、claim / concurrency 全部归 M4（agent runner）/
M5（orchestrator）。「谁在什么时候调用」见下方接缝表。

### 执行契约（四个 hook 共用底层 runner）

- **shell + cwd**：以 `sh -lc <script>` 执行（POSIX conforming default，§9.4），
  **cwd 恒为 workspace path**（验收 1）；multiline 脚本原样传入。
- **effective timeout**：使用**调用时传入的当前** `HooksConfig.timeoutMs`，包内不缓存旧
  快照——config reload 后的下一次调用即用新值（§5.3.4 / §6.2，验收 2）。非法值回退到
  `DEFAULT_HOOK_TIMEOUT_MS`（60000，与 §5.3.4 默认一致）。
- **timeout 终止**：超时后 SIGKILL 整个 hook **进程组**（detached spawn + 负 pid），
  确保脚本派生的孙进程不留孤儿，且清理 timer / stdio、不残留 handle（§15.4 "timeouts REQUIRED"）。
- **输出捕获有界**：stdout / stderr 各捕获至 `HOOK_OUTPUT_CAPTURE_LIMIT`（1 MiB）后停止累积并置
  `truncated`；operator 事件 / 错误 message 只携带 `HOOK_OUTPUT_EXCERPT_LIMIT`（8 KiB）摘录
  （§15.4 "output SHOULD be truncated"），避免无界内存。
- **operator-visible 事件**：failed / timeout 经 `WorkspaceHookEventSink` callback 暴露
  `WorkspaceHookEvent`（hook name、workspace path、identifier（可用时）、outcome、
  exit status / signal / truncated output）。**workspace 包不依赖 observability**——事件经
  callback / 结构化返回暴露，落地到 structured logging sink 由 M6 / 组合根装配。success 不发事件。

### 失败语义（§9.4 / 父任务决策 4）

| hook | 调用方 | failure / timeout 语义 |
|---|---|---|
| `after_create` | `createWorkspace`（仅 `createdNow=true`） | **fatal to provisioning**：抛 `hook_execution_failed` / `hook_timeout`，并 best-effort 删除本次新建的半成品目录（复用目录绝不运行、绝不删除） |
| `before_run` | M4 每 attempt 前 `runBeforeRunHook` | **fatal to attempt**：抛可判别 fatal 错误，供 M4 中止当前 attempt；本包不调度 retry |
| `after_run` | M4 每 attempt 后 `runAfterRunHook` | **best-effort**：永不 throw、不覆盖原 attempt outcome；failure / timeout 产生 operator 事件 |
| `before_remove` | M5 cleanup `removeWorkspace` | **best-effort**：failure / timeout 产生 operator 事件，cleanup 继续 |

半成品清理与 `removeWorkspace` 的 destructive delete 前**都重过 #28 containment 校验**：
unsafe / out-of-root 目标一律拒绝删除，绝不出根（验收 7）。决策记录见 Agent Note：
`notes/accepted/architecture/2026-09-30-workspace-hook-execution-contract.md`。

### M4 / M5 接缝

- **M4 Agent Runner**：`createWorkspace(id, { hooks, onHookEvent })` → 每 attempt
  `runBeforeRunHook(ws, { hooks, identifier, onHookEvent })`（fatal 则中止）→ 启动 agent →
  attempt 结束 `runAfterRunHook(ws, { hooks, identifier, onHookEvent })`（best-effort）。
- **M5 Orchestrator**：startup terminal sweep（§8.6）/ reconciliation 对每个 terminal identifier
  `removeWorkspace(id, { hooks, onHookEvent })`，按 `RemoveWorkspaceResult.status` 分流。

## Implementation-Defined Non-Directory Policy

SPEC §17.2 允许当目标 workspace 路径已存在非目录对象时，“replace or fail per implementation policy”。

本实现明确采用 **Fail Safely（安全失败）** 策略：
1. **不自动删除**：绝不隐式调用 `rm` / `unlink` 销毁未知常规文件或符号链接；
2. **不自动替换**：绝不对已有文件进行覆盖写入或目录替换；
3. **稳定报错**：抛出带有 `path`、`workspaceKey`、`identifier` 诊断上下文的 `existing_non_directory` 错误；
4. 决策理由与备选方案取舍见 Agent Note：`notes/accepted/architecture/2026-09-29-workspace-non-directory-policy.md`。

## Extension points

- 生命周期脚本执行：四个 hook 共用底层 runner（`sh -lc` + cwd + timeout + 有界捕获 + 事件），执行语义遵循 SPEC §9.4；调用时机 / 调度属 M4 / M5，本包只提供 primitive；
- execution-boundary 校验：M4 agent launch（cwd 绑定）与 cleanup / 半成品删除复用 `assertWorkspacePathSafe` / `validateWorkspacePath`，不另行实现 containment 判定；
- operator 可见性：hook failed / timeout 经 `WorkspaceHookEventSink` callback 暴露，落地到 structured logging sink 由 M6 / 组合根装配（本包不依赖 observability）；
- 目录布局 / 净化规则调整属于跨包契约变更：附 Agent Note 并同步 `docs/conformance.md`。

## Known limitations

- M3.1 完成本地 workspace provisioning 内核与确定性路径算法；M3.2（#28）落地 lexical + canonical 双层 containment、symlink escape 拒绝与可复用校验入口；M3.3（#29）落地四个 lifecycle hook 的执行层与 safe cleanup primitive（`removeWorkspace`）；
- validate 与后续动作（launch / delete）之间的 TOCTOU 窗口只能收窄不能根除（O_NOFOLLOW / openat 级原子手段不在范围）；消费方必须在破坏性动作前重新调用 `assertWorkspacePathSafe`——`removeWorkspace` 已内建「hook 前 + delete 前」双重校验，`after_create` 失败清理同样在 delete 前重验；
- hook shell 为 POSIX `sh -lc` 语义：Linux / macOS 原生可用；Windows 无 `sh`（未经 Git Bash / WSL 提供）时属**文档化限制**（CI / gate 在 Linux），进程组终止（detached + 负 pid SIGKILL）亦为 POSIX 语义；
- **hook 完成判定用 `close`（stdio 关闭）而非 `exit`（进程退出）**：脚本本身秒退（退出码 0）但留下持有继承 stdout/stderr 的后台进程（如未重定向的 `daemon &`）时，`close` 被后台进程拖住，直到 `timeout_ms` 到期 SIGKILL 进程组，结果为 `hook_timeout` 而非 success（对 `after_create` 还会触发半成品清理）。此语义确定、有界（≤ timeout_ms）且与「孙进程不留孤儿」一致；确需 daemonize 的 hook 应自行重定向 stdio（如 `daemon >/dev/null 2>&1 &`）以免拖住 `close`。M4 / M5 operator 诊断「秒退脚本为何报 timeout」时先看这里；
- hook 输出截断上限（捕获 1 MiB / 流、事件摘录 8 KiB）为诊断用途的实现约定常量，非 SPEC 规定值；
- symlink 相关测试依赖 host 能力：不支持创建 symlink 的平台（如受限 Windows）上相关用例显式 skip（测试报告中可见，不静默 pass）；`removeWorkspace` 的 filesystem 删除失败（`status: "failed"`）路径在 root 运行时难以稳定触发（CAP_DAC_OVERRIDE 绕过权限位），由代码审查覆盖而非运行时用例；
- M4（before_run / after_run 的实际调度与 agent launch cwd 绑定）与 M5（removeWorkspace 的 sweep / reconciliation 触发）接线随后续里程碑落地；端到端 conformance 收口随 #30 落地。
