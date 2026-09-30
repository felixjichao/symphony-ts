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
  - `options.workspace.root`：必须为非空且已规范化的绝对路径（SPEC §9.1）；
  - `options.hooks`：可选已解析的生命周期脚本配置（SPEC §5.3.4，执行见 #29）。
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
- `createWorkspace(identifier: string): Promise<Workspace>`（别名 `ensureWorkspace`）：
  - 缺失目录：创建并返回 `{ path, workspaceKey, createdNow: true }`；
  - 已有目录：原样复用并返回 `{ path, workspaceKey, createdNow: false }`；
  - 复用与新建两条路径都先通过 filesystem 级 safety gate（#28）：canonical containment / symlink escape 校验失败抛 `unsafe_path`，绝不复用或创建出根外目录；
  - 并发保护：处理 EEXIST 竞态，重检文件系统确保最终返回的必定是可用目录；
  - 非目录对象：执行下述 Safe Failure Policy。

### 错误契约（SPEC §9 / §17.2）

对外统一抛出类型化 `WorkspaceError`，主要判别契约为 `error.code`（`WorkspaceErrorCode`），不把 Node fs 原始异常暴露为主要判别式，底层异常经 `error.cause` 保留：

| 错误码（`code`） | 触发时机 |
|---|---|
| `invalid_identifier` | identifier 为空、非字符串或无法派生 key |
| `invalid_root_path` | `workspace.root` 未提供、空路径、非绝对路径，root 本身为非目录文件（ENOTDIR），或 root 为 dangling symlink |
| `existing_non_directory` | 目标路径已存在同名常规文件、符号链接等非目录对象 |
| `directory_creation_failed` | 文件系统权限不足（EACCES）、只读（EROFS）或 I/O 故障 |
| `unsafe_path` | 路径等于 root 本身或逃逸出 root 边界（§9.5 Invariant 2）；具体原因经 `error.unsafeReason` 细分（见下表） |
| `hook_execution_failed` | 生命周期脚本执行失败（非零退出码；SPEC §9.4，#29 预留） |
| `hook_timeout` | 生命周期脚本执行超时（SPEC §9.4，#29 预留） |

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
5. **dangling symlink fail-closed**：目标不存在的 symlink 无法 canonicalize，按 `workspace_path_unreadable` 拒绝，不自行解析多级 symlink 链预测落点；
6. **TOCTOU 重验入口**：validate 与后续动作（launch / delete）之间存在固有窗口，只能收窄不能根除。M4 在 agent launch 前、#29 / M5 在任何 destructive cleanup 前，**必须重新调用 `assertWorkspacePathSafe`**，防止「创建后目录被替换成 symlink」绕过字符串路径校验。

决策记录（为何每次 realpath 不缓存、为何错误面用 `unsafeReason` 子字段而非新顶层错误码等）见 Agent Note：`notes/accepted/architecture/2026-09-30-workspace-path-safety-contract.md`。

## Implementation-Defined Non-Directory Policy

SPEC §17.2 允许当目标 workspace 路径已存在非目录对象时，“replace or fail per implementation policy”。

本实现明确采用 **Fail Safely（安全失败）** 策略：
1. **不自动删除**：绝不隐式调用 `rm` / `unlink` 销毁未知常规文件或符号链接；
2. **不自动替换**：绝不对已有文件进行覆盖写入或目录替换；
3. **稳定报错**：抛出带有 `path`、`workspaceKey`、`identifier` 诊断上下文的 `existing_non_directory` 错误；
4. 决策理由与备选方案取舍见 Agent Note：`notes/accepted/architecture/2026-09-29-workspace-non-directory-policy.md`。

## Extension points

- 生命周期脚本阶段：在本包的 hook 序列中登记，执行语义遵循 SPEC §9.4（#29 落地）；
- execution-boundary 校验：M4 agent launch（cwd 绑定）与 #29 / M5 cleanup 复用 `assertWorkspacePathSafe`，不另行实现 containment 判定；
- 目录布局 / 净化规则调整属于跨包契约变更：附 Agent Note 并同步 `docs/conformance.md`。

## Known limitations

- M3.1 完成本地 workspace provisioning 内核与确定性路径算法；M3.2（#28）落地 lexical + canonical 双层 containment、symlink escape 拒绝与可复用校验入口；
- validate 与后续动作（launch / delete）之间的 TOCTOU 窗口只能收窄不能根除（O_NOFOLLOW / openat 级原子手段不在范围）；消费方必须在破坏性动作前重新调用 `assertWorkspacePathSafe`；
- symlink 相关测试依赖 host 能力：不支持创建 symlink 的平台（如受限 Windows）上相关用例显式 skip（测试报告中可见，不静默 pass）；chmod 000 不可读用例在 root 运行时同样显式 skip（权限位对 root 不适用），其错误面由 ELOOP / ENOTDIR canonicalization failure 用例覆盖；
- 生命周期脚本（hooks）subprocess 与 cleanup primitive 随 #29 落地；
- 端到端 conformance 收口随 #30 落地。
