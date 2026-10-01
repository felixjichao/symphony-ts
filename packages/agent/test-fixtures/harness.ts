import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspaceManager, type WorkspaceManager } from "@symphony/workspace";

import { launchTransport, type LaunchTransportOptions } from "../src/process-launcher";
import type { Transport } from "../src/transport";

/**
 * M4.2（#38）测试夹具：真实 workspace 目录 + 真实 `bash -lc` launch 的 fixture
 * subprocess（docs/testing.md：真实 subprocess、真实临时文件系统，不 mock）。
 *
 * 只服务于测试，不进 `src/`，因此不会被任何运行期代码 import。
 */

/** fixture 子进程脚本（与 harness 同目录）。 */
export const FIXTURE_PATH = fileURLToPath(new URL("./echo-server.mjs", import.meta.url));

/** shell 层引用一个路径：单引号包裹，内部单引号按 `'\''` 转义。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 构造 `codex.command` 字符串（**故意**包含 shell 语法：`$(pwd)` 与 `$BASH_VERSION`
 * 只有真正经过 `bash -lc` 才会被展开，naive argv parse 会原样传给子进程）。
 */
export function fixtureCommand(extraArgs: readonly string[] = []): string {
  return [
    shellQuote(process.execPath),
    shellQuote(FIXTURE_PATH),
    "--cwd",
    '"$(pwd)"',
    "--bash",
    '"$BASH_VERSION"',
    ...extraArgs.map(shellQuote),
  ].join(" ");
}

export interface WorkspaceFixture {
  /** canonical 化的 workspace 根目录（`realpath`，避免 tmpdir 本身是 symlink）。 */
  readonly root: string;
  /** 根内的 per-issue workspace 目录（launch cwd）。 */
  readonly workspacePath: string;
  readonly manager: WorkspaceManager;
  dispose(): Promise<void>;
}

/** 建立 `root/issue-7` 两层真实目录，并提供 §9.5 安全 gate 的提供方。 */
export async function createWorkspaceFixture(options: {
  /** 是否真实创建 workspace 目录（launch 需要目录存在）。 */
  readonly createWorkspaceDirectory?: boolean;
  readonly workspaceKey?: string;
} = {}): Promise<WorkspaceFixture> {
  const realTmp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(realTmp, "symphony-m42-root-"));
  const workspaceKey = options.workspaceKey ?? "issue-7";
  const workspacePath = path.join(root, workspaceKey);
  if (options.createWorkspaceDirectory !== false) {
    await fs.mkdir(workspacePath, { recursive: true });
  }
  const manager = createWorkspaceManager({ workspace: { root } });

  return {
    root,
    workspacePath,
    manager,
    async dispose() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/** 用 fixture 命令启动一个 transport（其余参数由调用方覆盖）。 */
export async function launchFixtureTransport(
  fixture: WorkspaceFixture,
  overrides: Partial<Omit<LaunchTransportOptions, "workspacePathSafety">> = {},
): Promise<Transport> {
  return launchTransport({
    command: fixtureCommand(),
    workspacePath: fixture.workspacePath,
    workspacePathSafety: fixture.manager,
    ...overrides,
  });
}

/** 轮询等待条件成立（用于「进程确实消失」这类 OS 级观测，不用固定 sleep 猜测）。 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 进程是否仍存活（ESRCH / EPERM 语义：只有 ESRCH 才算消失）。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** 读取一个 request response 的 `result`（fixture 全部返回 object）。 */
export function resultObject(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null) {
    throw new Error(`fixture result is not an object: ${String(result)}`);
  }
  return result as Record<string, unknown>;
}
