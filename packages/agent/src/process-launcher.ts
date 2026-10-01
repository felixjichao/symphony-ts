import { spawn } from "node:child_process";
import * as path from "node:path";
import type { WorkspacePathAssertOptions } from "@symphony/workspace";
import { AgentError } from "./errors";
import {
  createNdjsonTransport,
  type NdjsonTransportOptions,
  type Transport,
  type TransportListener,
} from "./transport";

/**
 * Coding-agent 子进程 launch 边界（SPEC §10.1 Launch Contract、§17.2 "Agent launch
 * uses the per-issue workspace path as cwd and rejects out-of-root paths"、
 * §17.5 "Launch command uses workspace cwd and invokes `bash -lc <codex.command>`"，
 * M4.2 / #38）。
 *
 * 本模块是 transport kernel 之上唯一的「进程 + 安全边界」层，职责严格三件事：
 *
 * 1. **workspace cwd 安全**：spawn 前紧邻调用 `@symphony/workspace` 的
 *    `assertWorkspacePathSafe`（M3.2 的 execution-boundary primitive，#28 约定
 *    M4 launch 前必须重验），拒绝即 `AgentError("invalid_workspace_cwd")`
 *    且**子进程从未启动**；原始 `WorkspaceError` 只经 `cause` 保留。
 * 2. **launch 形态**：`bash -lc <codex.command>`，`cwd = workspace path`，
 *    detached 到独立进程组。command 字符串**原样交给 shell**，本层绝不 parse argv
 *    （§10.1 的 invocation 就是 shell 语义）。
 * 3. **进程环境**：显式构造 child env = `process.env` 去掉 `excludeEnvNames` 再合并
 *    `env`。排除名单由调用方给出，本层**不硬编码**任何 provider secret 名。
 *
 * 明确不做：协议握手内容（`initialize` / `thread/start` / `turn/start`）、approval /
 * user-input / tool 语义、continuation policy、`turn_timeout_ms` 与 stall 检测。
 */

/**
 * launch 前必须复用的 workspace path 安全 gate。
 *
 * 结构化接口（而非直接依赖 `WorkspaceManager` 类）：`WorkspaceManager` 实现它，
 * 测试与组合根也可以传入等价 stub，同时保持 `agent → workspace` 的单向依赖。
 */
export interface WorkspacePathSafetyGate {
  assertWorkspacePathSafe(
    workspacePath: string,
    options?: WorkspacePathAssertOptions,
  ): Promise<void>;
}

/** {@link launchTransport} 的入参。 */
export interface LaunchTransportOptions {
  /** `codex.command`（SPEC §5.3.6）：原样作为 `bash -lc` 的脚本参数，不做 argv 解析。 */
  readonly command: string;
  /** 子进程 cwd，必须是 workspace 根目录**之内**的绝对路径（§9.5）。 */
  readonly workspacePath: string;
  /** §9.5 execution-boundary primitive 的提供方（通常是 `WorkspaceManager`）。 */
  readonly workspacePathSafety: WorkspacePathSafetyGate;
  /** 关联 issue identifier（进入错误诊断上下文，不参与判定）。 */
  readonly identifier?: string | undefined;
  readonly listener?: TransportListener | undefined;
  /** 显式注入子进程的环境变量（在继承集合之后合并）。 */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /**
   * 从继承集合中剔除的环境变量名（generic，无 provider 语义）。
   *
   * 调用方负责决定剔除什么（例如组合根按 §5.3.6 / §11.5 的策略剔除 tracker 凭证）；
   * 本层不预设任何名字，也不猜测哪些名字是 secret。
   */
  readonly excludeEnvNames?: readonly string[] | undefined;
  /** `codex.read_timeout_ms`（transport 侧 request/response 超时）。 */
  readonly readTimeoutMs?: number | undefined;
  /** §10.1 RECOMMENDED max line size。 */
  readonly maxProtocolLineBytes?: number | undefined;
  /** `stop()` 中 SIGTERM → SIGKILL 的等待窗口。 */
  readonly shutdownTimeoutMs?: number | undefined;
}

/**
 * 构造子进程环境：继承 `processEnv` 中值为字符串的项，剔除 `excludeEnvNames`
 * 命中的名字，最后合并显式 `env`（显式值优先，且不受排除名单影响）。
 */
function buildChildEnvironment(
  processEnv: Readonly<NodeJS.ProcessEnv>,
  env: Readonly<Record<string, string>> | undefined,
  excludeEnvNames: readonly string[] | undefined,
): NodeJS.ProcessEnv {
  const excluded = new Set(excludeEnvNames ?? []);
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value === "string" && !excluded.has(key)) {
      result[key] = value;
    }
  }
  if (env !== undefined) {
    for (const [key, value] of Object.entries(env)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 启动 coding-agent 子进程并返回已接好的 NDJSON {@link Transport}。
 *
 * 失败面（全部 typed {@link AgentError}）：
 * - `invalid_workspace_cwd`：launch 前的 containment 重验失败，**未 spawn**；
 * - `launch_failed`：`command` 为空 / 非法，或 `bash` 本身无法起步（spawn error）；
 * - 其余协议 / 超时错误由 transport 承担。
 *
 * 本函数**不等**子进程输出任何启动标记：§10.1 只规定 launch 形态，握手归 M4.3。
 * `bash -lc` 找不到 command 时由 bash 的非零退出表现，映射为 transport 的
 * `port_exit`（带 exitCode 诊断）；`codex_not_found` 的判定属 M4.5 runner。
 */
export async function launchTransport(options: LaunchTransportOptions): Promise<Transport> {
  if (typeof options.command !== "string" || options.command.trim().length === 0) {
    throw new AgentError(
      "launch_failed",
      "codex.command must be a non-empty string (SPEC §5.3.6 / §10.1)",
    );
  }
  const cwd = path.resolve(options.workspacePath);
  const transportOptions: NdjsonTransportOptions = {
    ...(options.readTimeoutMs !== undefined ? { readTimeoutMs: options.readTimeoutMs } : {}),
    ...(options.maxProtocolLineBytes !== undefined
      ? { maxProtocolLineBytes: options.maxProtocolLineBytes }
      : {}),
    ...(options.shutdownTimeoutMs !== undefined
      ? { shutdownTimeoutMs: options.shutdownTimeoutMs }
      : {}),
    ...(options.listener !== undefined ? { listener: options.listener } : {}),
    workspacePath: cwd,
  };
  // env 在安全校验**之前**构造：校验与 spawn 之间不留任何可被 TOCTOU 利用的 await 间隙。
  const env = buildChildEnvironment(process.env, options.env, options.excludeEnvNames);

  try {
    await options.workspacePathSafety.assertWorkspacePathSafe(cwd, {
      ...(options.identifier !== undefined ? { identifier: options.identifier } : {}),
    });
  } catch (error) {
    throw new AgentError(
      "invalid_workspace_cwd",
      `Refused to launch coding agent: workspace path failed §9.5 containment re-validation before spawn (${error instanceof Error ? error.message : String(error)})`,
      { path: cwd, cause: error },
    );
  }

  // SPEC §10.1: invocation is `bash -lc <codex.command>`, working directory is the
  // workspace path. The command string is handed to the shell verbatim.
  const child = spawn("bash", ["-lc", options.command], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  const spawnFailed = new Promise<never>((_resolve, reject) => {
    child.once("error", (error: Error) => {
      reject(
        new AgentError(
          "launch_failed",
          `Failed to spawn \`bash -lc\` for codex.command: ${error.message}`,
          { path: cwd, cause: error },
        ),
      );
    });
  });
  const spawned = new Promise<void>((resolve) => {
    child.once("spawn", () => {
      resolve();
    });
  });

  await Promise.race([spawned, spawnFailed]);

  try {
    return createNdjsonTransport(child, transportOptions);
  } catch (error) {
    // transport 建立失败（stdio 不是 pipe 等）绝不遗留已 spawn 的子进程。
    try {
      if (child.pid !== undefined) {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      /* 已退出 */
    }
    throw error;
  }
}
