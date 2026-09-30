import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  deriveWorkspaceKey as deriveWorkspaceKeyDomain,
  type HooksConfig,
  type Workspace,
  type WorkspaceConfig,
} from "@symphony/domain";
import { WorkspaceError } from "./errors";
import {
  isLexicallyContained,
  isNodeError,
  validateWorkspacePathSafety,
  workspaceErrorFromValidation,
  type WorkspacePathAssertOptions,
  type WorkspacePathValidation,
} from "./path-safety";

/**
 * 构造 {@link WorkspaceManager} 所需的已解析运行时配置（SPEC §4.1.3 / §9）。
 *
 * 直接消费 `@symphony/domain` 中的领域类型契约，不依赖 `@symphony/config`。
 */
export interface WorkspaceManagerOptions {
  /** Workspace 运行时配置（必须包含已解析的绝对路径 `root`）。 */
  readonly workspace: WorkspaceConfig;
  /** 可选生命周期 hook 配置（SPEC §5.3.4，行为由 #29 落地）。 */
  readonly hooks?: HooksConfig | undefined;
}

/**
 * Workspace Manager（SPEC §3 / §9 Workspace Management and Safety）。
 *
 * 负责从 issue identifier 派生确定性 workspace key 与绝对路径、
 * 目录 provisioning（新建 / 复用 / 并发与安全边界保护）、以及错误分类。
 */
export class WorkspaceManager {
  /** 规范化后的绝对 workspace 根目录。 */
  readonly root: string;
  /** 原始 workspace 配置。 */
  readonly workspaceConfig: WorkspaceConfig;
  /** 可选 hooks 配置。 */
  readonly hooksConfig?: HooksConfig | undefined;

  constructor(options: WorkspaceManagerOptions) {
    if (
      !options ||
      typeof options !== "object" ||
      !options.workspace ||
      typeof options.workspace !== "object"
    ) {
      throw new WorkspaceError(
        "invalid_root_path",
        "WorkspaceManagerOptions must provide a workspace configuration",
      );
    }

    const rawRoot = options.workspace.root;
    if (typeof rawRoot !== "string" || rawRoot.trim().length === 0) {
      throw new WorkspaceError(
        "invalid_root_path",
        "workspace.root must be a non-empty string (SPEC §9.1)",
      );
    }

    if (!path.isAbsolute(rawRoot)) {
      throw new WorkspaceError(
        "invalid_root_path",
        `workspace.root must be an absolute path (SPEC §9.1), received: "${rawRoot}"`,
      );
    }

    this.root = path.resolve(rawRoot);
    this.workspaceConfig = options.workspace;
    if (options.hooks !== undefined) {
      this.hooksConfig = options.hooks;
    }
  }

  /**
   * 从 issue identifier 派生 workspace key（SPEC §4.2）。
   *
   * 直接复用 `@symphony/domain` 的权威实现，不得在本包复制净化 / hash 逻辑。
   * 非法输入转换为类型化 {@link WorkspaceError}。
   */
  deriveWorkspaceKey(identifier: string): string {
    try {
      if (typeof identifier !== "string") {
        throw new TypeError(
          `Identifier must be a string, received ${typeof identifier}`,
        );
      }
      return deriveWorkspaceKeyDomain(identifier);
    } catch (err: unknown) {
      throw new WorkspaceError(
        "invalid_identifier",
        `Failed to derive workspace key: ${err instanceof Error ? err.message : String(err)}`,
        {
          identifier: typeof identifier === "string" ? identifier : undefined,
          cause: err,
        },
      );
    }
  }

  /**
   * 计算指定 issue identifier 的绝对 workspace 路径（SPEC §9.1）。
   *
   * workspace path = configured absolute root + workspace key
   */
  resolveWorkspacePath(identifier: string): string {
    const workspaceKey = this.deriveWorkspaceKey(identifier);
    return this.resolveWorkspacePathFromKey(workspaceKey, identifier);
  }

  /**
   * 别名方法：计算指定 issue identifier 的绝对 workspace 路径。
   */
  resolvePath(identifier: string): string {
    return this.resolveWorkspacePath(identifier);
  }

  /**
   * 从已有 workspaceKey 计算绝对 workspace 路径并执行基本安全校验（SPEC §9.1 / §9.5 Invariant 2）。
   *
   * 同步 lexical 层校验（`path.resolve` + segment containment），拒绝等于 root
   * 或逃逸 root 的路径（`unsafe_path` + `unsafeReason` 细分）。filesystem 级
   * canonical / symlink 校验见异步的 {@link WorkspaceManager.validateWorkspacePath}
   * 与 {@link WorkspaceManager.assertWorkspacePathSafe}（#28）。
   */
  resolveWorkspacePathFromKey(workspaceKey: string, identifier?: string): string {
    if (typeof workspaceKey !== "string" || workspaceKey.length === 0) {
      throw new WorkspaceError(
        "invalid_identifier",
        "Workspace key must be a non-empty string",
        {
          workspaceKey: typeof workspaceKey === "string" ? workspaceKey : undefined,
          identifier,
        },
      );
    }

    const resolved = path.resolve(this.root, workspaceKey);

    if (resolved === this.root) {
      throw new WorkspaceError(
        "unsafe_path",
        `Workspace path equals workspace root (SPEC §9.5): ${resolved}`,
        {
          path: resolved,
          workspaceKey,
          identifier,
          unsafeReason: "workspace_equals_root",
        },
      );
    }
    if (!isLexicallyContained(this.root, resolved)) {
      throw new WorkspaceError(
        "unsafe_path",
        `Workspace path escapes workspace root (SPEC §9.5): ${resolved}`,
        {
          path: resolved,
          workspaceKey,
          identifier,
          unsafeReason: "workspace_outside_root",
        },
      );
    }

    return resolved;
  }

  /**
   * 对候选 workspace path 执行完整的 filesystem 级安全校验（SPEC §9.5 / #28）。
   *
   * 校验 #28 安全不变量：
   *
   * ```text
   * absolute(workspace)
   * && workspace !== root
   * && lexicalContained(workspace, root)
   * && canonicalContained(workspace, canonicalRoot)
   * ```
   *
   * canonical containment 以每次调用实时解析的 `fs.realpath(root)` 为权威
   * （root 自身含 symlink 时以 canonical root 判定；不缓存）；尚不存在的路径
   * 按最近已存在 ancestor 的 realpath 推定落点，不因目标缺失而跳过校验。
   *
   * 不抛安全拒绝：返回 discriminated 结果（`safe: true` / 四类 `unsafeReason`
   * （`UnsafePathReason`）/ `invalid_root`）。throwing 形态见
   * {@link WorkspaceManager.assertWorkspacePathSafe}。
   *
   * @param workspacePath 候选绝对路径（如 {@link WorkspaceManager.resolveWorkspacePath} 的产物）
   */
  async validateWorkspacePath(workspacePath: string): Promise<WorkspacePathValidation> {
    return validateWorkspacePathSafety(this.root, workspacePath);
  }

  /**
   * {@link WorkspaceManager.validateWorkspacePath} 的 throwing 形态——
   * execution-boundary safety primitive（#28）。
   *
   * 校验通过时 resolve；否则抛出类型化 {@link WorkspaceError}：
   * - 四类路径安全拒绝：`code === "unsafe_path"` 且 `unsafeReason` 携带具体原因；
   * - root 自身不可用（非目录对象 / dangling symlink）：`code === "invalid_root_path"`。
   *
   * **M4 / #29 复用契约**：agent launch 前（以 workspace path 为 subprocess cwd 前）
   * 与任何 destructive cleanup（删除 workspace 目录）前 **必须** 重新调用本方法，
   * 防止「创建后目录被替换成 symlink」一类 TOCTOU 绕过字符串路径校验。
   *
   * @param workspacePath 候选绝对路径
   * @param options 可选诊断上下文（透传进 `WorkspaceError.workspaceKey` / `.identifier`）
   */
  async assertWorkspacePathSafe(
    workspacePath: string,
    options: WorkspacePathAssertOptions = {},
  ): Promise<void> {
    const validation = await this.validateWorkspacePath(workspacePath);
    if (validation.safe) {
      return;
    }
    throw workspaceErrorFromValidation(validation, options);
  }

  /**
   * 为指定 issue identifier 确保 / 创建 workspace 目录（SPEC §9.2 / §17.2）。
   *
   * 行为：
   * 1. 缺失目录：创建并返回 `createdNow: true`；
   * 2. 已有目录：原样复用并返回 `createdNow: false`；
   * 3. 已有同名非目录对象（文件 / 符号链接 / 设备等）：fail safely，不删除、不替换，抛出 `existing_non_directory` 错误；
   * 4. 文件系统竞态（EEXIST）：重新检查实际状态，确保最终返回的只有可用目录或明确失败；
   * 5. 复用与新建两条路径在执行前都通过 filesystem 级 safety gate（#28）：
   *    canonical containment / symlink escape / root equality 校验失败时抛出
   *    `unsafe_path`（含 `unsafeReason` 细分），绝不复用或创建出根外目录。
   */
  async createWorkspace(identifier: string): Promise<Workspace> {
    const workspaceKey = this.deriveWorkspaceKey(identifier);
    const workspacePath = this.resolveWorkspacePathFromKey(
      workspaceKey,
      identifier,
    );

    // 1. 先行探测目标路径现状（使用 lstat 不穿透顶级符号链接）
    let existingStat: import("node:fs").Stats | null = null;
    try {
      existingStat = await fs.lstat(workspacePath);
    } catch (err: unknown) {
      if (!isNodeError(err) || err.code !== "ENOENT") {
        if (isNodeError(err) && err.code === "ENOTDIR") {
          throw new WorkspaceError(
            "invalid_root_path",
            `Workspace root or parent path is not a directory: ${workspacePath}`,
            { path: workspacePath, workspaceKey, identifier, cause: err },
          );
        }
        throw new WorkspaceError(
          "directory_creation_failed",
          `Failed to inspect workspace path at ${workspacePath}: ${err instanceof Error ? err.message : String(err)}`,
          { path: workspacePath, workspaceKey, identifier, cause: err },
        );
      }
    }

    // 2. filesystem 级 safety gate（SPEC §9.5 / #28）：复用或创建之前重新执行
    //    canonical containment 校验（探测先行以保持 M3.1 的 invalid_root_path
    //    错误面与 cause 不变；symlink escape 在此被拒绝，优先于对象类型分类）
    await this.assertWorkspacePathSafe(workspacePath, {
      workspaceKey,
      identifier,
    });

    if (existingStat !== null) {
      if (existingStat.isDirectory()) {
        return {
          path: workspacePath,
          workspaceKey,
          createdNow: false,
        };
      }

      // implementation-defined policy: safe failure without deleting or replacing
      throw new WorkspaceError(
        "existing_non_directory",
        `Existing non-directory path at workspace location: ${workspacePath}`,
        { path: workspacePath, workspaceKey, identifier },
      );
    }

    // 3. 目标路径不存在，执行目录创建
    try {
      const created = await fs.mkdir(workspacePath, { recursive: true });

      // 创建后重新核验实际文件系统对象，防止并发竞态（SPEC §9.2 / §17.2）
      const currentStat = await fs.lstat(workspacePath);
      if (!currentStat.isDirectory()) {
        throw new WorkspaceError(
          "existing_non_directory",
          `Existing non-directory path at workspace location: ${workspacePath}`,
          { path: workspacePath, workspaceKey, identifier },
        );
      }

      return {
        path: workspacePath,
        workspaceKey,
        createdNow: created !== undefined,
      };
    } catch (err: unknown) {
      if (err instanceof WorkspaceError) {
        throw err;
      }

      if (isNodeError(err)) {
        if (err.code === "EEXIST") {
          // 并发冲突：另一进程在探测与 mkdir 之间创建了路径，重新判定目标是否为目录
          try {
            const statAfterRace = await fs.lstat(workspacePath);
            if (statAfterRace.isDirectory()) {
              return {
                path: workspacePath,
                workspaceKey,
                createdNow: false,
              };
            }

            throw new WorkspaceError(
              "existing_non_directory",
              `Existing non-directory path at workspace location: ${workspacePath}`,
              { path: workspacePath, workspaceKey, identifier, cause: err },
            );
          } catch (statErr: unknown) {
            if (statErr instanceof WorkspaceError) {
              throw statErr;
            }
            throw new WorkspaceError(
              "directory_creation_failed",
              `Failed to verify directory after EEXIST race at ${workspacePath}: ${statErr instanceof Error ? statErr.message : String(statErr)}`,
              { path: workspacePath, workspaceKey, identifier, cause: statErr },
            );
          }
        }

        if (err.code === "ENOTDIR") {
          throw new WorkspaceError(
            "invalid_root_path",
            `Workspace root or parent path is not a directory: ${workspacePath}`,
            { path: workspacePath, workspaceKey, identifier, cause: err },
          );
        }
      }

      throw new WorkspaceError(
        "directory_creation_failed",
        `Failed to create workspace directory at ${workspacePath}: ${err instanceof Error ? err.message : String(err)}`,
        { path: workspacePath, workspaceKey, identifier, cause: err },
      );
    }
  }

  /**
   * 确保 workspace 目录就绪（{@link createWorkspace} 的别名语义）。
   */
  async ensureWorkspace(identifier: string): Promise<Workspace> {
    return this.createWorkspace(identifier);
  }
}

/**
 * 构造 {@link WorkspaceManager} 实例的工厂函数。
 */
export function createWorkspaceManager(
  options: WorkspaceManagerOptions,
): WorkspaceManager {
  return new WorkspaceManager(options);
}
