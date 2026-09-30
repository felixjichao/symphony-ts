/**
 * @symphony/workspace 稳定错误契约（SPEC §9 / §17.2）。
 *
 * 判别式是 {@link WorkspaceError.code}，取值来自 {@link WorkspaceErrorCode}。
 * 遵循与 `@symphony/config`、`@symphony/tracker` 一致的模式：
 * - code 作为跨包 / 对外稳定的机器判别契约；
 * - message 作为 human-readable 诊断；
 * - 原始异常（Node.js fs / 系统异常等）通过 `cause` 保留，不得作为主要判别契约。
 */

/**
 * Workspace 错误码（SPEC §9 / §17.2）。
 *
 * - `invalid_identifier`：issue identifier 非法（非字符串、空字符串、无法生成 key）。
 * - `invalid_root_path`：workspace.root 配置非法或解析失败（非绝对路径、空路径、父路径非目录等）。
 * - `existing_non_directory`：目标路径已存在且非目录对象（文件、符号链接、FIFO 等），按 safe failure 策略报错。
 * - `directory_creation_failed`：目录创建失败（权限不足 EACCES、只读文件系统 EROFS、I/O 故障等）。
 * - `unsafe_path`：路径不安全（逃逸出 workspace.root、指向 root 本身等；SPEC §9.5 Invariant 2）。
 *   具体拒绝原因经 {@link WorkspaceError.unsafeReason}（{@link UnsafePathReason}）细分（#28）。
 * - `hook_execution_failed`：lifecycle hook 执行失败（非零退出码等；SPEC §9.4，#29 预留）。
 * - `hook_timeout`：lifecycle hook 执行超时（SPEC §9.4，#29 预留）。
 */
export type WorkspaceErrorCode =
  | "invalid_identifier"
  | "invalid_root_path"
  | "existing_non_directory"
  | "directory_creation_failed"
  | "unsafe_path"
  | "hook_execution_failed"
  | "hook_timeout";

/**
 * `unsafe_path` 的细分拒绝原因（#28 错误面，SPEC §9.5）。
 *
 * 仅当 `code === "unsafe_path"` 时出现；顶层错误码集合保持 M3.1 已发布契约不变。
 *
 * - `workspace_equals_root`：workspace path 等于（或经 symlink 解析后等于）workspace root 本身。
 * - `workspace_outside_root`：workspace path 非绝对路径，或 lexical 上逃逸出 workspace root（`../`、sibling、前缀混淆等）。
 * - `workspace_symlink_escape`：workspace path（或其已存在 ancestor）经 symlink / canonical 解析后落在 canonical root 之外。
 * - `workspace_path_unreadable`：路径或 root 无法 canonicalize（权限不足、dangling symlink fail-closed、ELOOP、ENOTDIR 等）；原始 fs 异常经 `cause` 保留。
 */
export type UnsafePathReason =
  | "workspace_equals_root"
  | "workspace_outside_root"
  | "workspace_symlink_escape"
  | "workspace_path_unreadable";

/** {@link WorkspaceError} 的可选附加信息。 */
export interface WorkspaceErrorDetails {
  /** 触发错误的 workspace 或相关文件系统路径（绝对路径）。 */
  readonly path?: string | undefined;
  /** 相关的 workspaceKey（如已派生）。 */
  readonly workspaceKey?: string | undefined;
  /** 相关的原始 issue identifier。 */
  readonly identifier?: string | undefined;
  /** `unsafe_path` 的细分拒绝原因（#28；仅当 code 为 `unsafe_path` 时有意义）。 */
  readonly unsafeReason?: UnsafePathReason | undefined;
  /** canonical containment 权威边界（`fs.realpath(root)`，如已解析）。 */
  readonly canonicalRoot?: string | undefined;
  /** 底层原始异常（Node fs、系统错误等），经 `cause` 保留。 */
  readonly cause?: unknown;
}

/**
 * workspace 包对外唯一的 typed error。
 * 判别式是 {@link WorkspaceError.code}。
 */
export class WorkspaceError extends Error {
  /** 稳定错误码判别式。 */
  readonly code: WorkspaceErrorCode;
  declare readonly path?: string;
  declare readonly workspaceKey?: string;
  declare readonly identifier?: string;
  /** `unsafe_path` 的细分拒绝原因（#28；仅当 `code === "unsafe_path"` 时出现）。 */
  declare readonly unsafeReason?: UnsafePathReason;
  /** canonical containment 权威边界（如已解析）。 */
  declare readonly canonicalRoot?: string;

  constructor(
    code: WorkspaceErrorCode,
    message: string,
    details: WorkspaceErrorDetails = {},
  ) {
    super(message, "cause" in details ? { cause: details.cause } : undefined);
    this.name = "WorkspaceError";
    this.code = code;
    if (details.path !== undefined) {
      this.path = details.path;
    }
    if (details.workspaceKey !== undefined) {
      this.workspaceKey = details.workspaceKey;
    }
    if (details.identifier !== undefined) {
      this.identifier = details.identifier;
    }
    if (details.unsafeReason !== undefined) {
      this.unsafeReason = details.unsafeReason;
    }
    if (details.canonicalRoot !== undefined) {
      this.canonicalRoot = details.canonicalRoot;
    }
  }
}
