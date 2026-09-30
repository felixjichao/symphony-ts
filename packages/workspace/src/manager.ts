import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  deriveWorkspaceKey as deriveWorkspaceKeyDomain,
  type HooksConfig,
  type Workspace,
  type WorkspaceConfig,
} from "@symphony/domain";
import { WorkspaceError, type UnsafePathReason } from "./errors";
import {
  emitWorkspaceHookEvent,
  executeWorkspaceHook,
  type WorkspaceHookEventSink,
  type WorkspaceHookResult,
} from "./hooks";
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
 *
 * **注意（#29）**：hook 配置（`HooksConfig`）**不再**是构造器字段——它必须由调用方
 * 在每次 lifecycle 调用时传入当前 effective 值（见 {@link WorkspaceLifecycleHookOptions}）。
 * 构造器快照会违反 §5.3.4 / §6.2 的 reload 语义（config reload 后旧值仍被缓存），
 * 故 M3.1 预留的 `options.hooks` / `manager.hooksConfig` 已移除（无既有消费方）。
 */
export interface WorkspaceManagerOptions {
  /** Workspace 运行时配置（必须包含已解析的绝对路径 `root`）。 */
  readonly workspace: WorkspaceConfig;
}

/**
 * lifecycle 调用时传入的 hook 执行选项（SPEC §5.3.4 / §9.4，#29）。
 *
 * `hooks` 必须是**调用时的当前 effective** `HooksConfig`——本包不缓存、不持有旧快照，
 * config reload 后的下一次调用即使用新值（验收 2）。缺席时不运行任何 hook。
 */
export interface WorkspaceLifecycleHookOptions {
  /** 调用时的当前 effective hooks 配置（SPEC §5.3.4）；缺席 = 不运行 hook。 */
  readonly hooks?: HooksConfig | undefined;
  /** operator-visible hook 事件回调（failed / timeout）；缺席时事件被丢弃。 */
  readonly onHookEvent?: WorkspaceHookEventSink | undefined;
}

/**
 * {@link WorkspaceManager.runBeforeRunHook} / {@link WorkspaceManager.runAfterRunHook}
 * 的选项：在 {@link WorkspaceLifecycleHookOptions} 之上附带可进入事件 / 错误的
 * issue identifier（M4 每 attempt 调用时可用）。
 */
export interface RunWorkspaceHookOptions extends WorkspaceLifecycleHookOptions {
  /** 关联 issue identifier（可用时；进入 operator 事件与错误诊断上下文）。 */
  readonly identifier?: string | undefined;
}

/**
 * {@link WorkspaceManager.removeWorkspace} 拒绝删除时的可判别原因：
 * 复用 #28 的四类 {@link UnsafePathReason}，外加非目录对象（Fail Safely，与 M3.1
 * `existing_non_directory` 同源）与 root 自身不可用（`invalid_root`）。
 */
export type RemoveWorkspaceRefusalReason =
  | UnsafePathReason
  | "existing_non_directory"
  | "invalid_root";

/**
 * {@link WorkspaceManager.removeWorkspace} 的可判别结果（M5 startup sweep §8.6 /
 * reconciliation cleanup 在循环里逐项消费；调用方 **必须** 检查 `status`）。
 *
 * - `removed`：目录已存在且被成功删除；
 * - `missing`：目录不存在——幂等成功，不运行 hook、不删除（§9 / 验收）；
 * - `refused`：目标 unsafe / out-of-root / 非目录 / root 不可用——**未运行 hook、
 *   未执行任何 destructive delete**（验收 7）；`reason` 为 typed 判别式；
 * - `failed`：安全校验通过、`before_remove` 已 best-effort 运行，但 filesystem 删除
 *   失败（EACCES / EROFS / EBUSY 等）——不吞，`message` + `cause` 透出。
 */
export type RemoveWorkspaceResult =
  | { readonly status: "removed"; readonly path: string; readonly workspaceKey: string }
  | { readonly status: "missing"; readonly path: string; readonly workspaceKey: string }
  | {
      readonly status: "refused";
      readonly path: string;
      readonly workspaceKey: string;
      readonly reason: RemoveWorkspaceRefusalReason;
      readonly message: string;
    }
  | {
      readonly status: "failed";
      readonly path: string;
      readonly workspaceKey: string;
      readonly message: string;
      readonly cause?: unknown;
    };

/** 把 hook 执行结果映射为类型化 fatal 错误（after_create / before_run 复用）。 */
function hookExecutionError(
  result: WorkspaceHookResult,
  workspacePath: string,
  workspaceKey: string | undefined,
  identifier: string | undefined,
): WorkspaceError {
  const code = result.outcome === "timeout" ? "hook_timeout" : "hook_execution_failed";
  return new WorkspaceError(code, result.message, {
    path: workspacePath,
    ...(workspaceKey !== undefined ? { workspaceKey } : {}),
    ...(identifier !== undefined ? { identifier } : {}),
    ...(result.error !== undefined ? { cause: result.error } : {}),
  });
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
   *    `unsafe_path`（含 `unsafeReason` 细分），绝不复用或创建出根外目录；
   * 6. `after_create` hook（SPEC §5.3.4 / §9.2 step 5 / §9.4，#29）：**仅当
   *    `createdNow = true` 且 `options.hooks.afterCreate` 已配置**时执行——复用目录
   *    绝不运行、绝不打扰；success → provisioning 成功；non-zero / spawn failure /
   *    timeout → provisioning 失败（抛 `hook_execution_failed` / `hook_timeout`），
   *    并 best-effort 删除**本次新建**的半成品目录（删除前重过 containment 校验；
   *    清理失败不掩盖原 hook 错误）。
   *
   * @param options 调用时传入的当前 effective hooks 配置与事件回调；缺席时行为与
   *   M3.1 完全一致（不运行任何 hook，复用路径零变化）。
   */
  async createWorkspace(
    identifier: string,
    options: WorkspaceLifecycleHookOptions = {},
  ): Promise<Workspace> {
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

      const createdNow = created !== undefined;
      const workspace: Workspace = { path: workspacePath, workspaceKey, createdNow };

      // after_create 仅对本次新建目录执行；失败时 best-effort 清理半成品并抛 typed error。
      if (createdNow) {
        await this.runAfterCreateHook(workspace, identifier, options);
      }
      return workspace;
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
   * 确保 workspace 目录就绪（{@link createWorkspace} 的别名语义，含 `after_create`）。
   */
  async ensureWorkspace(
    identifier: string,
    options: WorkspaceLifecycleHookOptions = {},
  ): Promise<Workspace> {
    return this.createWorkspace(identifier, options);
  }

  /**
   * 每个 attempt 前显式运行 `before_run`（SPEC §9.4 / §16.5，#29）。
   *
   * M4 Agent Runner 在 workspace 就绪后、启动 coding agent 前调用。语义：
   * - `options.hooks.beforeRun` 未配置（null / 空白）或 `options.hooks` 缺席 → no-op 成功；
   * - spawn 前对 workspace path 重过 #28 安全校验；unsafe → 抛 `unsafe_path`（fatal）；
   * - 脚本 non-zero / spawn failure → 抛 `hook_execution_failed`；timeout → 抛 `hook_timeout`；
   *   三者均为**可判别 fatal 错误**，供 M4 中止当前 attempt（验收 4）。
   *
   * 本方法**不调度 retry**——retry policy 归 M4 / M5（issue 设计边界）。
   *
   * @param workspace 目标 workspace（通常来自 {@link createWorkspace}）
   * @param options 调用时传入的当前 effective hooks 配置、identifier 与事件回调
   */
  async runBeforeRunHook(
    workspace: Workspace,
    options: RunWorkspaceHookOptions,
  ): Promise<void> {
    const hooks = options.hooks;
    if (hooks === undefined) {
      return;
    }
    const script = hooks.beforeRun;
    if (script === null || script.trim().length === 0) {
      return;
    }
    const identifier = options.identifier;

    // execution-boundary 重验（#28 不变量：执行 shell 前路径必须安全）；unsafe → fatal
    await this.assertWorkspacePathSafe(workspace.path, {
      workspaceKey: workspace.workspaceKey,
      identifier,
    });

    const result = await executeWorkspaceHook({
      hook: "before_run",
      script,
      cwd: workspace.path,
      workspacePath: workspace.path,
      workspaceKey: workspace.workspaceKey,
      identifier,
      timeoutMs: hooks.timeoutMs,
      onEvent: options.onHookEvent,
    });
    if (result.outcome === "success") {
      return;
    }
    throw hookExecutionError(
      result,
      workspace.path,
      workspace.workspaceKey,
      identifier,
    );
  }

  /**
   * 每个 attempt 结束后显式运行 `after_run`（SPEC §9.4 / §16.5，#29）。
   *
   * M4 Agent Runner 在 attempt 结束（成功 / 失败 / 超时 / 取消）后调用。语义：
   * - **best-effort，永不 throw**：success / failure / timeout 都不得覆盖原 attempt
   *   outcome（验收 5）；本方法只运行 hook 并对 failed / timeout 发 operator-visible
   *   事件，最终总是正常返回；
   * - `options.hooks.afterRun` 未配置或 `options.hooks` 缺席 → no-op；
   * - spawn 前重过安全校验；unsafe → 发 `failed` 事件说明「skipped」并正常返回
   *   （绝不在 unsafe 路径执行 shell）。
   *
   * @param workspace 目标 workspace
   * @param options 调用时传入的当前 effective hooks 配置、identifier 与事件回调
   */
  async runAfterRunHook(
    workspace: Workspace,
    options: RunWorkspaceHookOptions,
  ): Promise<void> {
    const hooks = options.hooks;
    if (hooks === undefined) {
      return;
    }
    const script = hooks.afterRun;
    if (script === null || script.trim().length === 0) {
      return;
    }
    const identifier = options.identifier;

    // best-effort：安全重验失败不 throw，只发事件并正常返回（不在 unsafe 路径执行 shell）
    const validation = await this.validateWorkspacePath(workspace.path);
    if (!validation.safe) {
      emitWorkspaceHookEvent(options.onHookEvent, {
        hook: "after_run",
        workspacePath: workspace.path,
        ...(identifier !== undefined ? { identifier } : {}),
        workspaceKey: workspace.workspaceKey,
        outcome: "failed",
        message: `after_run skipped: workspace path failed safety re-verification: ${validation.message}`,
      });
      return;
    }

    // executeWorkspaceHook 对 failed / timeout 内部发事件；无论结果都正常返回。
    await executeWorkspaceHook({
      hook: "after_run",
      script,
      cwd: workspace.path,
      workspacePath: workspace.path,
      workspaceKey: workspace.workspaceKey,
      identifier,
      timeoutMs: hooks.timeoutMs,
      onEvent: options.onHookEvent,
    });
  }

  /**
   * 删除指定 issue identifier 的 workspace 目录（SPEC §8.6 / §9 / §17.2，#29）。
   *
   * M5 Orchestrator 在 startup terminal sweep（§8.6）与 reconciliation cleanup 调用。
   * 流程（全程不做调度 / retry / terminal-state 判断——那是 M5 的职责）：
   *
   * 1. derive workspaceKey + resolve path（同步 lexical containment）；
   * 2. #28 canonical containment 校验：unsafe / out-of-root / root 不可用 →
   *    `refused`（**不运行 hook、不执行任何 destructive delete**，验收 7）；
   * 3. 目录不存在 → `missing`（幂等成功，不运行 hook）；
   * 4. 存在但为非目录对象 → `refused`（Fail Safely，与 M3.1 同源，不删除）；
   * 5. `before_remove`（best-effort）：failure / timeout → operator 事件，**cleanup 继续**（验收 6）；
   * 6. destructive delete 前**再次** #28 校验（TOCTOU：hook 可能长时间运行并替换目录）；
   *    仍 unsafe → `refused`（不删除）；
   * 7. `fs.rm(recursive)`：成功 → `removed`；filesystem 失败 → `failed`（不吞，携带 `cause`）。
   *
   * 除非法 identifier（抛 `invalid_identifier`，与 {@link createWorkspace} 一致）外，
   * 所有 operational / safety 结果经 {@link RemoveWorkspaceResult} 可判别返回——便于 M5
   * 在 sweep 循环里逐项处理而不必 per-item try/catch。调用方 **必须** 检查 `status`。
   *
   * @param identifier 目标 issue identifier
   * @param options 调用时传入的当前 effective hooks 配置与事件回调
   */
  async removeWorkspace(
    identifier: string,
    options: WorkspaceLifecycleHookOptions = {},
  ): Promise<RemoveWorkspaceResult> {
    const workspaceKey = this.deriveWorkspaceKey(identifier);

    let workspacePath: string;
    try {
      workspacePath = this.resolveWorkspacePathFromKey(workspaceKey, identifier);
    } catch (err: unknown) {
      if (err instanceof WorkspaceError && err.code === "unsafe_path") {
        return {
          status: "refused",
          path: err.path ?? path.resolve(this.root, workspaceKey),
          workspaceKey,
          reason: err.unsafeReason ?? "workspace_outside_root",
          message: err.message,
        };
      }
      throw err;
    }

    // 2. #28 containment 校验（任何 hook / destructive 动作之前）
    const validation = await this.validateWorkspacePath(workspacePath);
    if (!validation.safe) {
      return {
        status: "refused",
        path: workspacePath,
        workspaceKey,
        reason: validation.reason,
        message: validation.message,
      };
    }

    // 3. 不存在 → 幂等成功（不运行 hook）
    if (!validation.exists) {
      return { status: "missing", path: workspacePath, workspaceKey };
    }

    // 4. 存在且安全：仅对目录执行删除；非目录对象 Fail Safely 拒绝
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.lstat(workspacePath);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") {
        // 竞态：校验后目录被移除 → 幂等成功
        return { status: "missing", path: workspacePath, workspaceKey };
      }
      return {
        status: "failed",
        path: workspacePath,
        workspaceKey,
        message: `Failed to inspect workspace path before removal at ${workspacePath}: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      };
    }
    if (!stat.isDirectory()) {
      return {
        status: "refused",
        path: workspacePath,
        workspaceKey,
        reason: "existing_non_directory",
        message: `Existing non-directory path at workspace location; refusing to remove (Fail Safely): ${workspacePath}`,
      };
    }

    // 5. before_remove（best-effort）：failure / timeout 发事件，cleanup 继续
    const hooks = options.hooks;
    if (hooks !== undefined) {
      const beforeRemove = hooks.beforeRemove;
      if (beforeRemove !== null && beforeRemove.trim().length > 0) {
        await executeWorkspaceHook({
          hook: "before_remove",
          script: beforeRemove,
          cwd: workspacePath,
          workspacePath,
          workspaceKey,
          identifier,
          timeoutMs: hooks.timeoutMs,
          onEvent: options.onHookEvent,
        });
      }
    }

    // 6. TOCTOU 重验：before_remove 可能长时间运行并把目录替换成 symlink
    const revalidation = await this.validateWorkspacePath(workspacePath);
    if (!revalidation.safe) {
      return {
        status: "refused",
        path: workspacePath,
        workspaceKey,
        reason: revalidation.reason,
        message: `Safety re-verification failed before destructive removal (possible TOCTOU): ${revalidation.message}`,
      };
    }

    // 7. destructive delete；filesystem 失败不吞
    try {
      await fs.rm(workspacePath, { recursive: true, force: true });
    } catch (err: unknown) {
      return {
        status: "failed",
        path: workspacePath,
        workspaceKey,
        message: `Failed to remove workspace directory at ${workspacePath}: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      };
    }
    return { status: "removed", path: workspacePath, workspaceKey };
  }

  /**
   * `after_create`（SPEC §9.2 step 5 / §9.4，#29）：仅在 {@link createWorkspace}
   * 判定 `createdNow = true` 后调用。success → 返回；non-zero / spawn failure /
   * timeout → best-effort 删除**本次新建**的半成品目录后抛 typed fatal 错误。
   * 复用目录绝不进入本方法（createWorkspace 只对新建路径调用）。
   */
  private async runAfterCreateHook(
    workspace: Workspace,
    identifier: string,
    options: WorkspaceLifecycleHookOptions,
  ): Promise<void> {
    const hooks = options.hooks;
    if (hooks === undefined) {
      return;
    }
    const script = hooks.afterCreate;
    if (script === null || script.trim().length === 0) {
      return;
    }

    // execution-boundary 重验（#28 不变量：执行 shell 前路径必须安全）。
    // 目录刚由本调用创建并已在 mkdir 前通过 gate；此处重验收窄「创建后被替换成
    // symlink」的 TOCTOU 窗口。unsafe → best-effort 清理（其内部同样重验，unsafe
    // 则跳过删除）后抛出。
    try {
      await this.assertWorkspacePathSafe(workspace.path, {
        workspaceKey: workspace.workspaceKey,
        identifier,
      });
    } catch (err: unknown) {
      await this.bestEffortRemoveCreatedWorkspace(workspace, identifier);
      throw err;
    }

    const result = await executeWorkspaceHook({
      hook: "after_create",
      script,
      cwd: workspace.path,
      workspacePath: workspace.path,
      workspaceKey: workspace.workspaceKey,
      identifier,
      timeoutMs: hooks.timeoutMs,
      onEvent: options.onHookEvent,
    });
    if (result.outcome === "success") {
      return;
    }

    // fatal to provisioning：先 best-effort 清理本次新建的半成品目录，再抛 typed error。
    // 清理失败不掩盖原 hook 错误（bestEffortRemove 内部吞掉自身异常）。
    await this.bestEffortRemoveCreatedWorkspace(workspace, identifier);
    throw hookExecutionError(
      result,
      workspace.path,
      workspace.workspaceKey,
      identifier,
    );
  }

  /**
   * best-effort 删除**本次新建**的 workspace 目录（`after_create` 失败后的半成品清理）。
   *
   * destructive delete 前重过 #28 安全校验：若目录已被替换成 symlink / 逃逸 root，
   * 拒绝删除（绝不出根删除）。任何失败都被吞掉——不得掩盖触发清理的原始错误。
   */
  private async bestEffortRemoveCreatedWorkspace(
    workspace: Workspace,
    identifier: string,
  ): Promise<void> {
    try {
      await this.assertWorkspacePathSafe(workspace.path, {
        workspaceKey: workspace.workspaceKey,
        identifier,
      });
      await fs.rm(workspace.path, { recursive: true, force: true });
    } catch {
      // best-effort：清理失败不得掩盖原 hook / safety 错误，忽略。
    }
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
