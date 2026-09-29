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
  - 校验路径不等于 root 且不逃逸 root（SPEC §9.5 Invariant 2），非法时抛出 `unsafe_path`。
- `resolveWorkspacePathFromKey(workspaceKey: string): string`：
  - 基于已知 workspaceKey 计算并校验路径。
- `createWorkspace(identifier: string): Promise<Workspace>`（别名 `ensureWorkspace`）：
  - 缺失目录：创建并返回 `{ path, workspaceKey, createdNow: true }`；
  - 已有目录：原样复用并返回 `{ path, workspaceKey, createdNow: false }`；
  - 并发保护：处理 EEXIST 竞态，重检文件系统确保最终返回的必定是可用目录；
  - 非目录对象：执行下述 Safe Failure Policy。

### 错误契约（SPEC §9 / §17.2）

对外统一抛出类型化 `WorkspaceError`，主要判别契约为 `error.code`（`WorkspaceErrorCode`），不把 Node fs 原始异常暴露为主要判别式，底层异常经 `error.cause` 保留：

| 错误码（`code`） | 触发时机 |
|---|---|
| `invalid_identifier` | identifier 为空、非字符串或无法派生 key |
| `invalid_root_path` | `workspace.root` 未提供、空路径、非绝对路径，或 root 本身为非目录文件（ENOTDIR） |
| `existing_non_directory` | 目标路径已存在同名常规文件、符号链接等非目录对象 |
| `directory_creation_failed` | 文件系统权限不足（EACCES）、只读（EROFS）或 I/O 故障 |
| `unsafe_path` | 路径等于 root 本身或逃逸出 root 边界（§9.5 Invariant 2） |
| `hook_execution_failed` | 生命周期脚本执行失败（非零退出码；SPEC §9.4，#29 预留） |
| `hook_timeout` | 生命周期脚本执行超时（SPEC §9.4，#29 预留） |

## Implementation-Defined Non-Directory Policy

SPEC §17.2 允许当目标 workspace 路径已存在非目录对象时，“replace or fail per implementation policy”。

本实现明确采用 **Fail Safely（安全失败）** 策略：
1. **不自动删除**：绝不隐式调用 `rm` / `unlink` 销毁未知常规文件或符号链接；
2. **不自动替换**：绝不对已有文件进行覆盖写入或目录替换；
3. **稳定报错**：抛出带有 `path`、`workspaceKey`、`identifier` 诊断上下文的 `existing_non_directory` 错误；
4. 决策理由与备选方案取舍见 Agent Note：`notes/accepted/architecture/2026-09-29-workspace-non-directory-policy.md`。

## Extension points

- 生命周期脚本阶段：在本包的 hook 序列中登记，执行语义遵循 SPEC §9.4（#29 落地）；
- 路径安全与 containment 校验：进一步细化见 SPEC §9.5 与 #28；
- 目录布局 / 净化规则调整属于跨包契约变更：附 Agent Note 并同步 `docs/conformance.md`。

## Known limitations

- M3.1 完成本地 workspace provisioning 内核与确定性路径算法；
- canonical / realpath 与 symlink escape containment 校验随后续 #28 落地；
- 生命周期脚本（hooks）subprocess 与 cleanup primitive 随 #29 落地；
- 端到端 conformance 收口随 #30 落地。
