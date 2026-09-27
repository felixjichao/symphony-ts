import { createHash } from "node:crypto";

/**
 * 分配给单个 issue identifier 的文件系统 workspace（SPEC §4.1.4）。
 * provisioning **行为**（创建 / 复用 / hooks / containment 校验）归
 * `@symphony/workspace`（§9，M3）；本类型是 provisioning 结果的共享契约。
 */
export interface Workspace {
  /** 绝对 workspace 路径（root + workspaceKey，containment 见 §9.5）。 */
  readonly path: string;
  /** 防碰撞的净化 issue identifier（§4.2），由 {@link deriveWorkspaceKey} 派生。 */
  readonly workspaceKey: string;
  /** 本次是否新建——用于 gate `after_create` hook（§4.1.4 / §5.3.4）。 */
  readonly createdNow: boolean;
}

/** §4.2：净化时 `[^A-Za-z0-9._-]` 内的字符一律替换为 `_`。 */
const DISALLOWED_WORKSPACE_KEY_CHARS = /[^A-Za-z0-9._-]/g;

/** §4.2：hash 后缀 MUST 有至少 64 bit 熵——16 个 hex 字符恰为 64 bit，且全是允许字符。 */
const WORKSPACE_KEY_HASH_HEX_CHARS = 16;

/** 净化改变过原文时，key 形如 `<sanitized>--<hash>`（分隔符与上游参考实现同构）。 */
const WORKSPACE_KEY_HASH_SEPARATOR = "--";

/**
 * 从 issue identifier 派生 workspace 目录名（SPEC §4.2 "Workspace Key"）：
 *
 * 1. 把不在 `[A-Za-z0-9._-]` 内的字符替换为 `_`；
 * 2. 若净化改变了原文，追加**原文** SHA-256 前 16 个 hex 字符（64 bit 熵、仅允许
 *    字符）作为稳定后缀——净化后同文的不同 identifier 因此得到不同 key（防碰撞）；
 * 3. 未被净化改变的 identifier 保持确定性 key（无后缀）。
 *
 * 纯函数：同一 identifier 恒得同一 key，无 I/O。空 identifier 违反 §11.3
 * （identifier MUST 非空），抛 {@link TypeError}，调用方不得静默降级。
 */
export function deriveWorkspaceKey(identifier: string): string {
  if (identifier.length === 0) {
    throw new TypeError(
      "deriveWorkspaceKey: identifier must be a non-empty string (SPEC §11.3)",
    );
  }
  const sanitized = identifier.replace(DISALLOWED_WORKSPACE_KEY_CHARS, "_");
  if (sanitized === identifier) {
    return sanitized;
  }
  const hash = createHash("sha256")
    .update(identifier)
    .digest("hex")
    .slice(0, WORKSPACE_KEY_HASH_HEX_CHARS);
  return `${sanitized}${WORKSPACE_KEY_HASH_SEPARATOR}${hash}`;
}
