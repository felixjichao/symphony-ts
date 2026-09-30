import { spawn } from "node:child_process";

/**
 * Workspace lifecycle hook 执行层（SPEC §5.3.4 / §9.4 / §15.4，#29 / M3.3）。
 *
 * 本模块只提供「执行一个受信任的 shell 脚本、捕获输出、超时终止、并把问题
 * 经 callback 暴露给 operator」的底层 primitive。它**不理解**任何调度语义：
 * attempt scheduling、terminal-state 判断、retry policy、claim / concurrency
 * 全部归 M4（agent runner）/ M5（orchestrator）。四个 hook（after_create /
 * before_run / after_run / before_remove）共用 {@link executeWorkspaceHook}，
 * 由 {@link WorkspaceManager} 决定各自的 fatal / best-effort 语义。
 *
 * 执行契约（SPEC §9.4 / §15.4）：
 * - 以 shell 执行脚本，POSIX 上 `sh -lc <script>` 为 conforming default，
 *   **cwd = workspace path**（§9.4 / §17.2，验收 1）；
 * - timeout 使用**调用时传入**的 `HooksConfig.timeoutMs`（本模块不缓存旧值，
 *   config reload 后的新调用即用新值；§5.3.4 / §6.2，验收 2）；
 * - timeout 后终止整个 hook 子进程**进程组**（detached + 负 pid SIGKILL），
 *   确保脚本派生的孙进程不成为孤儿，且不残留 timer / stdio handle（§15.4）；
 * - stdout / stderr 捕获用于诊断，但捕获缓冲有硬上限
 *   （{@link HOOK_OUTPUT_CAPTURE_LIMIT}），事件 / message 只携带更小的摘录
 *   （{@link HOOK_OUTPUT_EXCERPT_LIMIT}），避免无界输出（§15.4 "SHOULD be truncated"）；
 * - workspace 包不依赖 observability：operator 可见性经 {@link WorkspaceHookEventSink}
 *   callback / {@link WorkspaceHookResult} 结构化返回暴露，只有 failed / timeout 发事件。
 */

/** SPEC §9.4 支持的四个生命周期 hook。 */
export type WorkspaceHookName =
  | "after_create"
  | "before_run"
  | "after_run"
  | "before_remove";

/**
 * hook 执行结果判别式：
 * - `success`：脚本以退出码 0 结束；
 * - `failed`：非零退出、无法退出（signal 终止但非本模块的 timeout）或 spawn failure；
 * - `timeout`：超过 effective `timeoutMs`，本模块主动终止了进程组。
 */
export type WorkspaceHookOutcome = "success" | "failed" | "timeout";

/**
 * 单条流（stdout / stderr）捕获缓冲的硬上限（字符数近似）。超限后停止累积并置
 * `truncated`——hook 持续刷屏不会导致无界内存增长（§15.4）。诊断足够即可，取值保守。
 */
export const HOOK_OUTPUT_CAPTURE_LIMIT = 1024 * 1024;

/** operator 事件 / 错误 message 中携带的输出摘录上限（字符数近似）。 */
export const HOOK_OUTPUT_EXCERPT_LIMIT = 8 * 1024;

/**
 * `hooks.timeoutMs` 缺失或非法（非有限正数）时的回退值，与 §5.3.4 默认一致。
 * `@symphony/config` 已保证解析后的 `timeoutMs` 合法（默认 60000、正整数校验）；
 * 本回退仅防御绕过 config 直接构造 `HooksConfig` 的调用方。
 */
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

/**
 * operator-visible hook 事件（callback 契约，SPEC §9.4 "Log hook start, failures,
 * and timeouts" 的失败 / 超时面）。workspace 包不 import observability——事件经此
 * 结构化对象暴露，实际落地到 structured logging sink 由 M6 / 组合根装配。
 *
 * 最小面（issue 要求）：hook name、workspace path、identifier（可用时）、
 * outcome（failed / timeout）、exit status / truncated output（可用时）。
 * success 不发事件（不打扰 operator；start 日志属 M6 structured logging sink，
 * 为本 issue 明确非目标）。
 */
export interface WorkspaceHookEvent {
  /** 触发的 hook。 */
  readonly hook: WorkspaceHookName;
  /** hook 执行（或应执行）的 workspace 绝对路径。 */
  readonly workspacePath: string;
  /** 关联 issue identifier（可用时）。 */
  readonly identifier?: string | undefined;
  /** 关联 workspaceKey（可用时）。 */
  readonly workspaceKey?: string | undefined;
  /** 仅 `failed` / `timeout` 会发事件。 */
  readonly outcome: "failed" | "timeout";
  /** 进程退出码（因 signal 终止或 spawn failure 时缺席）。 */
  readonly exitCode?: number | undefined;
  /** 终止进程的 signal（timeout → `SIGKILL`；可用时）。 */
  readonly signal?: string | undefined;
  /** stdout + stderr 合并摘录（≤ {@link HOOK_OUTPUT_EXCERPT_LIMIT}；可用时）。 */
  readonly output?: string | undefined;
  /** 输出是否因超过捕获上限或摘录上限被截断。 */
  readonly outputTruncated?: boolean | undefined;
  /** human-readable 诊断信息。 */
  readonly message: string;
}

/** operator-visible hook 事件回调（注入点；缺席时事件被丢弃，不影响执行语义）。 */
export type WorkspaceHookEventSink = (event: WorkspaceHookEvent) => void;

/** {@link executeWorkspaceHook} 的结构化返回（供调用方决定 fatal / best-effort）。 */
export interface WorkspaceHookResult {
  readonly hook: WorkspaceHookName;
  readonly outcome: WorkspaceHookOutcome;
  /** 退出码；因 signal 终止或 spawn failure 时为 `null`。 */
  readonly exitCode: number | null;
  /** 终止 signal；正常退出时为 `null`。 */
  readonly signal: NodeJS.Signals | null;
  /** 捕获的 stdout（≤ {@link HOOK_OUTPUT_CAPTURE_LIMIT}）。 */
  readonly stdout: string;
  /** 捕获的 stderr（≤ {@link HOOK_OUTPUT_CAPTURE_LIMIT}）。 */
  readonly stderr: string;
  /** stdout / stderr 任一超过捕获上限被截断。 */
  readonly truncated: boolean;
  /** 是否因超时被主动终止。 */
  readonly timedOut: boolean;
  /** human-readable 诊断信息（失败 / 超时时含输出摘录）。 */
  readonly message: string;
  /** spawn failure 的原始异常（可用时经 `cause` 语义保留）。 */
  readonly error?: unknown;
}

/** {@link executeWorkspaceHook} 入参。 */
export interface ExecuteWorkspaceHookParams {
  readonly hook: WorkspaceHookName;
  /** 脚本正文；`null` / 空白 = 未配置该 hook，视为 success no-op（不 spawn）。 */
  readonly script: string | null;
  /** 子进程 cwd —— 必须是调用方已完成安全校验的 workspace 绝对路径。 */
  readonly cwd: string;
  /** workspace 绝对路径（进事件；通常等于 `cwd`）。 */
  readonly workspacePath: string;
  readonly workspaceKey?: string | undefined;
  readonly identifier?: string | undefined;
  /** 调用时的 effective `hooks.timeoutMs`（本模块不缓存）。 */
  readonly timeoutMs: number;
  readonly onEvent?: WorkspaceHookEventSink | undefined;
}

/** 归一化 effective timeout：非有限正数回退到 {@link DEFAULT_HOOK_TIMEOUT_MS}。 */
export function resolveHookTimeoutMs(timeoutMs: number): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_HOOK_TIMEOUT_MS;
  }
  return timeoutMs;
}

/** 追加输出但不超过 `limit`；超限置 `truncated`。按字符切片以避免破坏多字节码点。 */
function appendCapped(
  current: string,
  chunk: Buffer | string,
  limit: number,
): { value: string; truncated: boolean } {
  if (current.length >= limit) {
    return { value: current, truncated: true };
  }
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const combined = current + text;
  if (combined.length > limit) {
    return { value: combined.slice(0, limit), truncated: true };
  }
  return { value: combined, truncated: false };
}

/** 构造事件 / message 用的合并输出摘录（≤ {@link HOOK_OUTPUT_EXCERPT_LIMIT}）。 */
function buildOutputExcerpt(
  stdout: string,
  stderr: string,
  capturedTruncated: boolean,
): { output: string; outputTruncated: boolean } {
  const parts: string[] = [];
  if (stdout.length > 0) {
    parts.push(`[stdout] ${stdout}`);
  }
  if (stderr.length > 0) {
    parts.push(`[stderr] ${stderr}`);
  }
  const combined = parts.join("\n");
  if (combined.length > HOOK_OUTPUT_EXCERPT_LIMIT) {
    return { output: combined.slice(0, HOOK_OUTPUT_EXCERPT_LIMIT), outputTruncated: true };
  }
  return { output: combined, outputTruncated: capturedTruncated };
}

/**
 * 终止 hook 子进程**整个进程组**（detached spawn 时 pgid === pid）。
 * SIGKILL 不可被 trap，确保脚本派生的孙进程一并终止、不留孤儿；ESRCH（已退出）忽略。
 */
function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // 进程组可能已退出（ESRCH）；best-effort，忽略。
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已彻底退出，忽略。
    }
  }
}

/** 发 operator 事件（sink 缺席或自身抛异常都不得影响 hook 执行语义）。 */
function emitHookEvent(
  onEvent: WorkspaceHookEventSink | undefined,
  event: WorkspaceHookEvent,
): void {
  if (onEvent === undefined) {
    return;
  }
  try {
    onEvent(event);
  } catch {
    // operator sink 自身异常不得冒泡为 hook 失败；隔离之。
  }
}

/** 供 manager 层（after_run unsafe-path skip 等非 spawn 场景）复用的事件发射。 */
export function emitWorkspaceHookEvent(
  onEvent: WorkspaceHookEventSink | undefined,
  event: WorkspaceHookEvent,
): void {
  emitHookEvent(onEvent, event);
}

/**
 * 执行单个 workspace lifecycle hook（共用底层 primitive）。
 *
 * 行为：
 * - `script` 为 `null` / 空白 → 立即返回 `success`（未配置该 hook，不 spawn）；
 * - `sh -lc <script>`，cwd = `params.cwd`，detached（独立进程组）；
 * - stdout / stderr 捕获至 {@link HOOK_OUTPUT_CAPTURE_LIMIT}（超限停止累积、置 truncated）；
 * - `timeoutMs`（归一化后）到期 → SIGKILL 整个进程组，`outcome = "timeout"`；
 * - 退出码非 0 → `outcome = "failed"`；spawn failure（如 `sh` 缺失）→ `failed`；
 * - failed / timeout 经 `onEvent` 发 operator-visible 事件；
 * - 无论结果如何，清理 timer 与 stdio，不留 handle。
 *
 * **完成判定用 `close`（stdio 关闭）而非 `exit`（进程退出）**（PR #33 审查 Suggestion 1）：
 * 这样能读到脚本产生的全部输出。副作用是——脚本本身退出码 0、但留下**持有继承
 * stdout/stderr 的后台进程**（如 `daemon &` 未重定向）时，`close` 会被后台进程拖住，
 * 直到 `timeoutMs` 到期 SIGKILL 整个进程组，结果为 `timeout` 而非 `success`（对
 * `after_create` 还会触发半成品清理）。此行为确定、有界（≤ timeoutMs）、与「孙进程不留
 * 孤儿」一致，非缺陷；确需 daemonize 的 hook 应自行重定向 stdio（如 `daemon >/dev/null 2>&1 &`）
 * 以免拖住 `close`。见 README Known limitations 与 workspace-hook-execution-contract Note。
 *
 * 本函数**不做**路径安全校验：调用方必须在 spawn 前对 `cwd` 完成
 * `assertWorkspacePathSafe`（#28 不变量：执行 shell 前路径必须安全）。
 */
export function executeWorkspaceHook(
  params: ExecuteWorkspaceHookParams,
): Promise<WorkspaceHookResult> {
  const {
    hook,
    script,
    cwd,
    workspacePath,
    workspaceKey,
    identifier,
    onEvent,
  } = params;
  const timeoutMs = resolveHookTimeoutMs(params.timeoutMs);

  if (script === null || script.trim().length === 0) {
    return Promise.resolve({
      hook,
      outcome: "success",
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
      message: `hook "${hook}" not configured; skipped`,
    });
  }

  return new Promise<WorkspaceHookResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const child = spawn("sh", ["-lc", script], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const clearTimers = (): void => {
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    const destroyStreams = (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    const finish = (result: WorkspaceHookResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      destroyStreams();
      resolve(result);
    };

    const buildEvent = (
      outcome: "failed" | "timeout",
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      message: string,
      error?: unknown,
    ): WorkspaceHookEvent => {
      const { output, outputTruncated } = buildOutputExcerpt(stdout, stderr, truncated);
      return {
        hook,
        workspacePath,
        ...(identifier !== undefined ? { identifier } : {}),
        ...(workspaceKey !== undefined ? { workspaceKey } : {}),
        outcome,
        ...(exitCode !== null ? { exitCode } : {}),
        ...(signal !== null ? { signal } : {}),
        ...(output.length > 0 ? { output } : {}),
        outputTruncated,
        message: error instanceof Error ? `${message}: ${error.message}` : message,
      };
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const next = appendCapped(stdout, chunk, HOOK_OUTPUT_CAPTURE_LIMIT);
      stdout = next.value;
      truncated = truncated || next.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const next = appendCapped(stderr, chunk, HOOK_OUTPUT_CAPTURE_LIMIT);
      stderr = next.value;
      truncated = truncated || next.truncated;
    });

    // 防御性加固（PR #33 审查 Suggestion 2）：管道读发生 EIO 类故障时，stream 级
    // 'error' 事件若无监听会成为 uncaught exception，击穿长驻 orchestrator 进程。
    // 挂 no-op 监听把它降级为「输出捕获中断」——hook 结果仍由进程级 'error' /
    // 'close' / timeout 路径收敛为 typed result，不改变任何失败语义。
    const onStreamError = (): void => {
      // no-op：见上方注释；不吞进程级错误（那由 child 'error'/'close' 承担）。
    };
    child.stdout?.on("error", onStreamError);
    child.stderr?.on("error", onStreamError);

    child.on("error", (err: Error) => {
      // spawn failure（ENOENT: sh 缺失、EACCES 等）——无退出码。
      const message = `hook "${hook}" failed to spawn`;
      const result: WorkspaceHookResult = {
        hook,
        outcome: "failed",
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        truncated,
        timedOut: false,
        message: `${message}: ${err.message}`,
        error: err,
      };
      emitHookEvent(onEvent, buildEvent("failed", null, null, message, err));
      finish(result);
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) {
        const message = `hook "${hook}" timed out after ${timeoutMs}ms; terminated process group`;
        const result: WorkspaceHookResult = {
          hook,
          outcome: "timeout",
          exitCode: code,
          signal,
          stdout,
          stderr,
          truncated,
          timedOut: true,
          message,
        };
        emitHookEvent(onEvent, buildEvent("timeout", code, signal, message));
        finish(result);
        return;
      }
      if (code === 0) {
        finish({
          hook,
          outcome: "success",
          exitCode: 0,
          signal,
          stdout,
          stderr,
          truncated,
          timedOut: false,
          message: `hook "${hook}" completed`,
        });
        return;
      }
      const { output } = buildOutputExcerpt(stdout, stderr, truncated);
      const message = `hook "${hook}" failed with exit code ${code === null ? `signal ${signal}` : code}${output.length > 0 ? `\n${output}` : ""}`;
      const result: WorkspaceHookResult = {
        hook,
        outcome: "failed",
        exitCode: code,
        signal,
        stdout,
        stderr,
        truncated,
        timedOut: false,
        message,
      };
      emitHookEvent(onEvent, buildEvent("failed", code, signal, message));
      finish(result);
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid);
    }, timeoutMs);
  });
}
