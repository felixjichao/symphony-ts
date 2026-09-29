import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  deriveWorkspaceKey as deriveWorkspaceKeyDomain,
  type HooksConfig,
  type Workspace,
  type WorkspaceConfig,
} from "@symphony/domain";
import { WorkspaceError } from "./errors";

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

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
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
    const rootPrefix = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;

    if (resolved === this.root || !resolved.startsWith(rootPrefix)) {
      throw new WorkspaceError(
        "unsafe_path",
        `Workspace path escapes or equals workspace root (SPEC §9.5): ${resolved}`,
        { path: resolved, workspaceKey, identifier },
      );
    }

    return resolved;
  }

  /**
   * 为指定 issue identifier 确保 / 创建 workspace 目录（SPEC §9.2 / §17.2）。
   *
   * 行为：
   * 1. 缺失目录：创建并返回 `createdNow: true`；
   * 2. 已有目录：原样复用并返回 `createdNow: false`；
   * 3. 已有同名非目录对象（文件 / 符号链接 / 设备等）：fail safely，不删除、不替换，抛出 `existing_non_directory` 错误；
   * 4. 文件系统竞态（EEXIST）：重新检查实际状态，确保最终返回的只有可用目录或明确失败。
   */
  async createWorkspace(identifier: string): Promise<Workspace> {
    const workspaceKey = this.deriveWorkspaceKey(identifier);
    const workspacePath = this.resolveWorkspacePath(identifier);

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

    // 2. 目标路径不存在，执行目录创建
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
