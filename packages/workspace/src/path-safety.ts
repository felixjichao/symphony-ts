import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WorkspaceError, type UnsafePathReason } from "./errors";

/**
 * Workspace path filesystem safety boundary（SPEC §9.5 / §17.2，#28）。
 *
 * 本模块是 M4（agent launch 前校验 cwd）与 M5 / #29（destructive cleanup 前重验）
 * 复用的 execution-boundary safety primitive 的实现层，公共入口是
 * `WorkspaceManager.validateWorkspacePath` / `WorkspaceManager.assertWorkspacePathSafe`。
 *
 * 安全不变量（#28）——任何准备执行 shell、agent 或 destructive delete 的
 * workspace path 都必须满足：
 *
 * ```text
 * absolute(workspace)
 * && workspace !== root
 * && lexicalContained(workspace, root)
 * && canonicalContained(workspace, canonicalRoot)
 * ```
 *
 * 实现要点：
 * - lexical 层：`path.resolve` 规范化后按 path segment（含 `path.sep` 前缀）判定，
 *   不使用裸 `startsWith(root)`（防 `/root2` 前缀混淆）；
 * - canonical 层：以 `fs.realpath(root)` 为 containment 权威（每次调用实时解析、不缓存，
 *   root 被替换成 symlink 后立即生效）；已存在路径必须 realpath 后仍严格位于
 *   canonical root 之下且不等于 canonical root；
 * - 尚不存在的路径：向上找最近已存在 ancestor，对 ancestor 做 realpath，再 join
 *   剩余 segment 得到 predicted canonical path，要求其严格位于 canonical root 之下
 *   ——不因目标尚不存在而跳过 safety validation；
 * - dangling symlink（目标不存在）无法 canonicalize：fail-closed，按
 *   `workspace_path_unreadable` 拒绝，不自行解析多级 symlink 链预测落点。
 */

export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * segment 级 lexical containment：`child` 是否严格位于 `parent` 之下。
 *
 * 双方必须都是 `path.resolve` 产物（绝对、规范化）。等价于带 `path.sep`
 * 的前缀判定并显式排除相等，防止 `/root2` 一类前缀混淆。
 */
export function isLexicallyContained(parent: string, child: string): boolean {
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child !== parent && child.startsWith(prefix);
}

/** `validateWorkspacePath` 的通过结果。 */
export interface SafeWorkspacePathValidation {
  readonly safe: true;
  /** 规范化（`path.resolve`）后的绝对 workspace path（lexical 形态，保留 configured root 前缀）。 */
  readonly path: string;
  /** canonical root：`fs.realpath(root)` 解析后的 containment 权威（root 尚不存在时为 projected canonical root）。 */
  readonly canonicalRoot: string;
  /** canonical 目标路径：已存在路径为 realpath 结果；尚不存在路径为按最近已存在 ancestor 推定的 predicted canonical path（校验时点值）。 */
  readonly canonicalPath: string;
  /** workspace path 上是否已存在文件系统对象（`lstat` 成功即为 true，含 symlink）。 */
  readonly exists: boolean;
}

/** `validateWorkspacePath` 的路径安全拒绝结果（#28 四类错误面）。 */
export interface UnsafeWorkspacePathValidation {
  readonly safe: false;
  /** 具体拒绝原因（与 `WorkspaceError.unsafeReason` 同一契约）。 */
  readonly reason: UnsafePathReason;
  /** 规范化后的被拒路径。 */
  readonly path: string;
  /** human-readable 诊断信息。 */
  readonly message: string;
  /** 如已完成 canonical root 解析，则携带权威边界。 */
  readonly canonicalRoot?: string | undefined;
  /** 底层原始 fs 异常（canonicalization failure 等），经 `cause` 保留。 */
  readonly cause?: unknown;
}

/**
 * `validateWorkspacePath` 的 root 不可用结果。
 *
 * 不属于四类 path-safety 拒绝面：root 自身是非目录对象 / dangling symlink 时，
 * `assertWorkspacePathSafe` 映射为 M3.1 已发布的 `invalid_root_path` 错误码。
 */
export interface InvalidWorkspaceRootValidation {
  readonly safe: false;
  readonly reason: "invalid_root";
  /** 规范化后的被检路径。 */
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}

/** `WorkspaceManager.validateWorkspacePath` 的 discriminated 结果。 */
export type WorkspacePathValidation =
  | SafeWorkspacePathValidation
  | UnsafeWorkspacePathValidation
  | InvalidWorkspaceRootValidation;

/** `assertWorkspacePathSafe` 的可选诊断上下文（透传进 `WorkspaceError`）。 */
export interface WorkspacePathAssertOptions {
  readonly workspaceKey?: string | undefined;
  readonly identifier?: string | undefined;
}

type Canonicalization =
  | { readonly kind: "canonical" | "projected"; readonly canonical: string }
  | { readonly kind: "not_directory"; readonly message: string; readonly cause?: unknown }
  | { readonly kind: "unreadable"; readonly message: string; readonly cause?: unknown };

/**
 * 将目录路径 canonicalize 为 containment 权威。
 *
 * - 已存在：`realpath` + 目录性核验（`kind: "canonical"`）；
 * - 尚不存在：向上找最近已存在 ancestor，realpath 该 ancestor 后 join 剩余
 *   segment（`kind: "projected"`）；
 * - 非目录对象（含 dangling symlink）：`kind: "not_directory"`；
 * - 权限 / ELOOP / ENOTDIR 等 canonicalization failure：`kind: "unreadable"`。
 */
async function canonicalizeDirectory(
  target: string,
  label: string,
): Promise<Canonicalization> {
  try {
    const canonical = await fs.realpath(target);
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) {
      return {
        kind: "not_directory",
        message: `${label} resolves to a non-directory object: ${target} -> ${canonical}`,
      };
    }
    return { kind: "canonical", canonical };
  } catch (err: unknown) {
    if (isNodeError(err)) {
      if (err.code === "ENOTDIR") {
        return {
          kind: "not_directory",
          message: `${label} has a non-directory component: ${target}`,
          cause: err,
        };
      }
      if (err.code === "ENOENT") {
        // 区分「路径不存在」与「dangling symlink（对象存在但目标缺失）」
        try {
          await fs.lstat(target);
          return {
            kind: "not_directory",
            message: `${label} is an unresolvable (dangling) symlink: ${target}`,
            cause: err,
          };
        } catch (lstatErr: unknown) {
          if (!isNodeError(lstatErr) || lstatErr.code !== "ENOENT") {
            return {
              kind: "unreadable",
              message: `${label} cannot be inspected at ${target}: ${lstatErr instanceof Error ? lstatErr.message : String(lstatErr)}`,
              cause: lstatErr,
            };
          }
        }
        return projectFromNearestExistingAncestor(target, label);
      }
    }
    return {
      kind: "unreadable",
      message: `${label} cannot be canonicalized at ${target}: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    };
  }
}

/**
 * 对尚不存在的 `target` 向上找最近已存在 ancestor，realpath 后 join 剩余 segment，
 * 得到 target 一旦创建时的 predicted canonical path。
 */
async function projectFromNearestExistingAncestor(
  target: string,
  label: string,
): Promise<Canonicalization> {
  let ancestor = path.dirname(target);
  const rest: string[] = [path.basename(target)];
  for (;;) {
    let realAncestor: string;
    try {
      realAncestor = await fs.realpath(ancestor);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          // 理论上不可达（文件系统根恒存在）；防御性 fail-closed
          return {
            kind: "unreadable",
            message: `${label} has no existing ancestor to canonicalize: ${target}`,
            cause: err,
          };
        }
        rest.unshift(path.basename(ancestor));
        ancestor = parent;
        continue;
      }
      if (isNodeError(err) && err.code === "ENOTDIR") {
        return {
          kind: "not_directory",
          message: `${label} has a non-directory component: ${target} (at ${ancestor})`,
          cause: err,
        };
      }
      return {
        kind: "unreadable",
        message: `${label} cannot canonicalize existing ancestor ${ancestor}: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      };
    }

    const ancestorStat = await fs.stat(ancestor).catch((statErr: unknown) => {
      if (isNodeError(statErr) && statErr.code === "ENOENT") {
        // 竞态：ancestor 在 realpath 与 stat 之间被移除；按不存在继续上溯
        return null;
      }
      throw statErr;
    });
    if (ancestorStat === null) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        return {
          kind: "unreadable",
          message: `${label} has no existing ancestor to canonicalize: ${target}`,
        };
      }
      rest.unshift(path.basename(ancestor));
      ancestor = parent;
      continue;
    }
    if (!ancestorStat.isDirectory()) {
      return {
        kind: "not_directory",
        message: `${label} has a non-directory component: ${target} (at ${ancestor})`,
      };
    }

    return { kind: "projected", canonical: path.join(realAncestor, ...rest) };
  }
}

/**
 * 完整执行 #28 安全不变量校验（不抛安全拒绝，返回 discriminated 结果）。
 *
 * `root` 必须是构造函数已接受的 absolute resolved root（本模块不展开 `~` / `$VAR`）。
 */
export async function validateWorkspacePathSafety(
  root: string,
  workspacePath: string,
): Promise<WorkspacePathValidation> {
  // 0. 入参面：必须是绝对路径（含空串 / 非字符串的防御）
  if (typeof workspacePath !== "string" || !path.isAbsolute(workspacePath)) {
    return {
      safe: false,
      reason: "workspace_outside_root",
      path: typeof workspacePath === "string" ? workspacePath : String(workspacePath),
      message: `Workspace path must be an absolute path (SPEC §9.5): ${String(workspacePath)}`,
    };
  }
  const normalized = path.resolve(workspacePath);

  // 1. lexical containment（同步、零 syscall）：拒绝等于 root 与任何出根路径
  if (normalized === root) {
    return {
      safe: false,
      reason: "workspace_equals_root",
      path: normalized,
      message: `Workspace path equals workspace root (SPEC §9.5 Invariant 2): ${normalized}`,
    };
  }
  if (!isLexicallyContained(root, normalized)) {
    return {
      safe: false,
      reason: "workspace_outside_root",
      path: normalized,
      message: `Workspace path escapes workspace root (SPEC §9.5 Invariant 2): ${normalized} is not under ${root}`,
    };
  }

  // 2. canonical root 权威（每次实时 realpath，不缓存）
  const rootCanonicalization = await canonicalizeDirectory(root, "Workspace root");
  if (rootCanonicalization.kind === "not_directory") {
    return {
      safe: false,
      reason: "invalid_root",
      path: normalized,
      message: rootCanonicalization.message,
      ...(rootCanonicalization.cause !== undefined
        ? { cause: rootCanonicalization.cause }
        : {}),
    };
  }
  if (rootCanonicalization.kind === "unreadable") {
    return {
      safe: false,
      reason: "workspace_path_unreadable",
      path: normalized,
      message: rootCanonicalization.message,
      cause: rootCanonicalization.cause,
    };
  }
  const canonicalRoot = rootCanonicalization.canonical;

  // 3. canonical containment：先探测目标路径现状
  let targetStat: import("node:fs").Stats | null = null;
  try {
    targetStat = await fs.lstat(normalized);
  } catch (err: unknown) {
    if (!isNodeError(err) || err.code !== "ENOENT") {
      // ENOTDIR（ancestor 是普通文件）/ EACCES / ELOOP 等：canonicalization failure
      return {
        safe: false,
        reason: "workspace_path_unreadable",
        path: normalized,
        canonicalRoot,
        message: `Workspace path cannot be inspected at ${normalized}: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      };
    }
  }

  if (targetStat !== null) {
    // 3a. 已存在：realpath 必须严格位于 canonical root 之下且不等于 canonical root
    let realTarget: string;
    try {
      realTarget = await fs.realpath(normalized);
    } catch (err: unknown) {
      // dangling symlink（ENOENT）无法确认落点：fail-closed
      return {
        safe: false,
        reason: "workspace_path_unreadable",
        path: normalized,
        canonicalRoot,
        message: `Workspace path exists but cannot be canonicalized (dangling symlink or unreadable component) at ${normalized}: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      };
    }

    if (realTarget === canonicalRoot) {
      return {
        safe: false,
        reason: "workspace_equals_root",
        path: normalized,
        canonicalRoot,
        message: `Workspace path resolves to workspace root itself (SPEC §9.5 Invariant 2): ${normalized} -> ${realTarget}`,
      };
    }
    if (!isLexicallyContained(canonicalRoot, realTarget)) {
      return {
        safe: false,
        reason: "workspace_symlink_escape",
        path: normalized,
        canonicalRoot,
        message: `Workspace path resolves outside canonical workspace root (SPEC §9.5): ${normalized} -> ${realTarget} is not under ${canonicalRoot}`,
      };
    }
    return {
      safe: true,
      path: normalized,
      canonicalRoot,
      canonicalPath: realTarget,
      exists: true,
    };
  }

  // 3b. 尚不存在：对最近已存在 ancestor 做 canonical containment，
  //     predicted canonical path 必须严格落在 canonical root 之下
  let ancestor = path.dirname(normalized);
  const rest: string[] = [path.basename(normalized)];
  for (;;) {
    let realAncestor: string;
    try {
      realAncestor = await fs.realpath(ancestor);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          return {
            safe: false,
            reason: "workspace_path_unreadable",
            path: normalized,
            canonicalRoot,
            message: `Workspace path has no existing ancestor to canonicalize: ${normalized}`,
            cause: err,
          };
        }
        rest.unshift(path.basename(ancestor));
        ancestor = parent;
        continue;
      }
      return {
        safe: false,
        reason: "workspace_path_unreadable",
        path: normalized,
        canonicalRoot,
        message: `Workspace path ancestor cannot be canonicalized at ${ancestor}: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      };
    }

    const predicted = path.join(realAncestor, ...rest);
    if (predicted === canonicalRoot) {
      return {
        safe: false,
        reason: "workspace_equals_root",
        path: normalized,
        canonicalRoot,
        message: `Workspace path would resolve to workspace root itself (SPEC §9.5 Invariant 2): ${normalized} -> ${predicted}`,
      };
    }
    if (!isLexicallyContained(canonicalRoot, predicted)) {
      return {
        safe: false,
        reason: "workspace_symlink_escape",
        path: normalized,
        canonicalRoot,
        message: `Existing ancestor of workspace path resolves outside canonical workspace root (SPEC §9.5): ${ancestor} -> ${realAncestor}, projected path ${predicted} is not under ${canonicalRoot}`,
      };
    }
    return {
      safe: true,
      path: normalized,
      canonicalRoot,
      canonicalPath: predicted,
      exists: false,
    };
  }
}

/**
 * 将非 safe 的校验结果映射为类型化 {@link WorkspaceError}（throwing 形态公用）。
 */
export function workspaceErrorFromValidation(
  validation: UnsafeWorkspacePathValidation | InvalidWorkspaceRootValidation,
  options: WorkspacePathAssertOptions = {},
): WorkspaceError {
  if (validation.reason === "invalid_root") {
    return new WorkspaceError("invalid_root_path", validation.message, {
      path: validation.path,
      ...(validation.cause !== undefined ? { cause: validation.cause } : {}),
      ...(options.workspaceKey !== undefined
        ? { workspaceKey: options.workspaceKey }
        : {}),
      ...(options.identifier !== undefined
        ? { identifier: options.identifier }
        : {}),
    });
  }
  return new WorkspaceError("unsafe_path", validation.message, {
    path: validation.path,
    unsafeReason: validation.reason,
    ...(validation.canonicalRoot !== undefined
      ? { canonicalRoot: validation.canonicalRoot }
      : {}),
    ...(validation.cause !== undefined ? { cause: validation.cause } : {}),
    ...(options.workspaceKey !== undefined
      ? { workspaceKey: options.workspaceKey }
      : {}),
    ...(options.identifier !== undefined
      ? { identifier: options.identifier }
      : {}),
  });
}
