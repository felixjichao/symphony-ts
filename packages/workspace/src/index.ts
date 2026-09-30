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
 */

export { WorkspaceError } from "./errors";
export type { WorkspaceErrorCode, WorkspaceErrorDetails } from "./errors";

export {
  WorkspaceManager,
  createWorkspaceManager,
} from "./manager";
export type { WorkspaceManagerOptions } from "./manager";
