/**
 * @symphony/workspace — SPEC §9 Workspace Management and Safety 的 owner 包
 * （§3 的 Workspace Manager）。
 *
 * 本文件是包的唯一公共 API 面。
 *
 * M3.1 落地 workspace kernel 与确定性本地文件系统 provisioning：
 * - 确定性 workspace path / key 派生：直接复用 `@symphony/domain` 的权威
 *   `deriveWorkspaceKey(identifier)`（SPEC §4.2），包含 64-bit SHA-256 熵防碰撞；
 * - 本地目录 provisioning（SPEC §9.1–§9.2 / §17.2）：
 *   - 缺失目录新建（`createdNow = true`）；
 *   - 已有目录原样复用（`createdNow = false`）；
 *   - 已有非目录对象安全失败（fail safely，不自动删除、不自动替换）；
 *   - 竞态与 EEXIST 重检保证可用目录不变量；
 * - 稳定错误契约（SPEC §9 / §17.2）：{@link WorkspaceError} + {@link WorkspaceErrorCode}。
 *
 * M3.2（#28）叠加 filesystem safety boundary（SPEC §9.5）：
 * - `WorkspaceManager.validateWorkspacePath` / `WorkspaceManager.assertWorkspacePathSafe`：
 *   absolute + lexical containment + canonical（realpath）containment 的完整校验，
 *   覆盖 root equality、symlink escape、尚不存在路径的 ancestor 推定与
 *   canonical root 权威（root 自身含 symlink 时以 realpath 解析结果判定）；
 * - execution-boundary safety primitive：M4 agent launch 前与 #29 / M5 destructive
 *   cleanup 前必须重新调用 `assertWorkspacePathSafe`（TOCTOU 重验入口）；
 * - `unsafe_path` 错误经 {@link UnsafePathReason}（`error.unsafeReason`）细分为
 *   `workspace_equals_root` / `workspace_outside_root` / `workspace_symlink_escape` /
 *   `workspace_path_unreadable` 四类拒绝面。
 */

export { WorkspaceError } from "./errors";
export type {
  UnsafePathReason,
  WorkspaceErrorCode,
  WorkspaceErrorDetails,
} from "./errors";

export {
  WorkspaceManager,
  createWorkspaceManager,
} from "./manager";
export type { WorkspaceManagerOptions } from "./manager";

export type {
  InvalidWorkspaceRootValidation,
  SafeWorkspacePathValidation,
  UnsafeWorkspacePathValidation,
  WorkspacePathAssertOptions,
  WorkspacePathValidation,
} from "./path-safety";
