import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 受管 Git 进程组执行器（NEST-119 审查裁决后的 A 修订方案）。
 *
 * 背景：`execGit` 曾依赖「枚举 + 冻结 + 逐 PID 终止」清理 Git 子树。审查证明
 * 「枚举快照 → SIGSTOP/SIGKILL」之间存在可复现的 `fork + exit` 重挂父逃逸窗口
 * （逃逸进程不再属于根或任何已观察 PID 的子树），快照式算法无法闭合。
 *
 * 机制：每条 Git 操作放入**独立进程组**（`detached: true`，POSIX 下 Node spawn
 * 创建新 session / 进程组），对「仍在该组内的 fork / 重挂父子孙」，`kill(-pgid)`
 * 是 POSIX 下唯一的原子覆盖句柄。ownership 不依赖父子快照：
 *
 * - **hook 内调用 bootstrap**：`executeWorkspaceHook` 宿主为本次 hook 建立一个
 *   {@link GitOperationSupervisor}（Unix socket 监督者），hook 内的 CLI / 库经
 *   本地 IPC **请求监督者创建 Git 操作**；创建与登记由监督者串行完成并先于
 *   启动许可响应，即使请求方或中间进程退出，登记仍保留在监督者内存中
 *   （不依赖 PPID 可追溯）。外层 hook 超时：先停止接纳新受管操作，再对已持有
 *   的 Git 组与原 hook 进程组发终止信号，并在统一有界上界内确认。
 * - **直接调用 bootstrap**：宿主进程自身即监督者——`execGit` 以 detached 方式
 *   spawn git 并持有 ChildProcess / PGID，超时对组发信号后有界确认退出。
 *
 * 通信失效或监督信息无效时**拒绝启动**并报告错误，绝不静默降级成未登记的
 * 独立组。所有收尾（终止、退出确认、平台查询、IPC 等待）均有界并纳入预算；
 * 到达上界仍无法确认清理时输出明确诊断，不宣称全部退出。
 *
 * 保证边界：本机制覆盖 Symphony 管理的 Git 操作及其**继承该组**的正常
 * fork / 重挂父子孙；不是对任意恶意 `setsid` / `daemonize` 脚本的 OS 沙箱。
 */

/** hook 宿主向 hook 子进程注入监督 socket 路径的环境变量名。 */
export const SUPERVISOR_SOCKET_ENV = "SYMPHONY_GIT_SUPERVISOR_SOCKET";

/** 每个流（stdout / stderr）的转发 / 捕获上限（字节近似，与 execGit 捕获上限一致）。 */
const STREAM_FORWARD_LIMIT = 1024 * 1024;

/** IPC 协议单行上限（base64 chunk 不得超过）。 */
const MAX_LINE_BYTES = 2 * 1024 * 1024;

/** 单个受管操作被 terminate 后，确认根进程退出的有界窗口（毫秒）。 */
const TERMINATE_CONFIRM_GRACE_MS = 1_500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 对进程组发 SIGKILL；组已不存在（ESRCH）时退回按 PID 兜底，均 best-effort。 */
export function killProcessGroupSigkill(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    try {
      process.kill(pgid, "SIGKILL");
    } catch {
      // 已彻底退出，忽略。
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 根进程退出后的组收尾预算（毫秒）：扫描确认 / 防误杀收尾均须在此上界内完成。
 */
export const GROUP_EXIT_CONFIRM_BUDGET_MS = 1_000;

/** {@link terminateOrphanedProcessGroup} 的结构化结果。 */
export interface GroupTerminationOutcome {
  /** 组内已无可运行成员（且查询可信）。 */
  readonly confirmed: boolean;
  /** 末次扫描发现的残留可运行成员 PID（用于诊断）。 */
  readonly leftoverPids: readonly number[];
  /** 平台查询未能在预算内完成或失败——结果不可信。 */
  readonly queryFailed: boolean;
}

/**
 * 根进程已退出的进程组的有界收尾：清除残留成员并确认组为空。
 *
 * 前提是调用方已确认根进程退出（close / exit 事件）。残留成员（同组的正常
 * fork / 重挂父子孙）被 SIGKILL；若扫描发现「组长仍在」——根已退出而组长 PID
 * 仍存活只能是 PID/PGID 复用——**绝不投递组信号**，按未确认返回，宁可保留
 * ownership 也不误杀无关进程。
 */
export async function terminateOrphanedProcessGroup(
  pgid: number,
  deadline: number,
): Promise<GroupTerminationOutcome> {
  for (;;) {
    const scan = await scanProcessGroupsForLiveMembers([pgid], deadline);
    if (scan.queryFailed) {
      return { confirmed: false, leftoverPids: scan.leftoverPids, queryFailed: true };
    }
    if (scan.leftoverPids.length === 0) {
      return { confirmed: true, leftoverPids: [], queryFailed: false };
    }
    if (scan.leftoverPids.includes(pgid) || isProcessAlive(pgid)) {
      // 组长应已退出；其 PID 仍存活 → PID/PGID 复用嫌疑，不误杀。
      return { confirmed: false, leftoverPids: scan.leftoverPids, queryFailed: false };
    }
    killProcessGroupSigkill(pgid);
    if (Date.now() >= deadline) {
      const finalScan = await scanProcessGroupsForLiveMembers([pgid], deadline);
      return {
        confirmed: !finalScan.queryFailed && finalScan.leftoverPids.length === 0,
        leftoverPids: finalScan.leftoverPids,
        queryFailed: finalScan.queryFailed,
      };
    }
    await delay(Math.min(50, deadline - Date.now()));
  }
}

/**
 * 扫描给定 PGID 集合中仍「可运行」的成员 PID（排除僵尸 Z / X）。
 *
 * - Linux：读 `/proc/<pid>/stat` 的 state 与 pgrp 字段；
 * - 其他平台（macOS）：`pgrep -g <pgid>`。
 *
 * 平台查询消耗计入剩余预算：到达 `deadline` 前未能完成扫描时返回
 * `queryFailed = true`，调用方**不得**据此宣称清理成功。查询本身失败
 * （EPERM、pgrep 缺失等）同样置 `queryFailed`，不吞错误。
 */
export async function scanProcessGroupsForLiveMembers(
  pgids: readonly number[],
  deadline: number,
): Promise<GroupScanResult> {
  const unique = [...new Set(pgids)];
  if (unique.length === 0) {
    return { leftoverPids: [], queryFailed: false };
  }
  if (process.platform === "linux") {
    return scanProcFs(unique, deadline);
  }
  return scanWithPgrep(unique, deadline);
}

export interface GroupScanResult {
  /** 扫描发现的仍可运行成员 PID。 */
  readonly leftoverPids: readonly number[];
  /** 查询未能在预算内完成或自身失败——结果不可信，不得当作「已确认」。 */
  readonly queryFailed: boolean;
}

async function scanProcFs(targetPgids: readonly number[], deadline: number): Promise<GroupScanResult> {
  const pgidSet = new Set(targetPgids);
  const leftover: number[] = [];
  let entries: string[];
  try {
    entries = nodeFs.readdirSync("/proc");
  } catch {
    return { leftoverPids: [], queryFailed: true };
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    if (Date.now() >= deadline) {
      return { leftoverPids: leftover, queryFailed: true };
    }
    try {
      const stat = nodeFs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const lastParen = stat.lastIndexOf(")");
      if (lastParen === -1) {
        continue;
      }
      const rest = stat.slice(lastParen + 2).trimStart().split(" ");
      const state = rest[0]?.charAt(0) ?? "";
      if (state === "Z" || state === "X" || state === "x") {
        continue;
      }
      const pgrp = Number.parseInt(rest[2] ?? "", 10);
      if (!Number.isNaN(pgrp) && pgidSet.has(pgrp)) {
        leftover.push(Number.parseInt(entry, 10));
      }
    } catch {
      // 进程可能在读取期间退出；忽略。
    }
  }
  return { leftoverPids: leftover, queryFailed: false };
}

export async function scanWithPgrep(
  targetPgids: readonly number[],
  deadline: number,
  pgrepPathOverride?: string,
): Promise<GroupScanResult> {
  const leftover: number[] = [];
  for (const pgid of targetPgids) {
    if (Date.now() >= deadline) {
      return { leftoverPids: leftover, queryFailed: true };
    }
    const outcome = await new Promise<{ status: "matched" | "empty" | "error"; pids: number[] }>((resolve) => {
      const child = spawn("pgrep", ["-g", String(pgid)], {
        stdio: ["ignore", "pipe", "ignore"],
        ...(pgrepPathOverride !== undefined
          ? { env: { ...process.env, PATH: pgrepPathOverride } }
          : {}),
      });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer | string) => {
        output += chunk.toString();
      });
      const finish = (status: "matched" | "empty" | "error"): void => {
        const pids =
          status === "matched"
            ? output
                .split("\n")
                .map((s) => Number.parseInt(s.trim(), 10))
                .filter((n) => !Number.isNaN(n))
            : [];
        resolve({ status, pids });
      };
      // BSD pgrep 退出码语义：0 = 有匹配；1 = 无匹配（正常结果，不是查询故障）；
      // 其余退出码 / spawn 错误 / 预算内未完成（超时终止）才按查询失败处理。
      child.on("close", (code) => {
        if (code === 0) {
          finish("matched");
        } else if (code === 1) {
          finish("empty");
        } else {
          finish("error");
        }
      });
      child.on("error", () => resolve({ status: "error", pids: [] }));
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        child.kill("SIGKILL");
        return;
      }
      setTimeout(() => child.kill("SIGKILL"), remaining).unref();
    });
    if (outcome.status === "error") {
      return { leftoverPids: leftover, queryFailed: true };
    }
    if (outcome.status === "matched") {
      leftover.push(...outcome.pids);
    }
  }
  return { leftoverPids: leftover, queryFailed: false };
}

// ---------------------------------------------------------------------------
// IPC 协议
// ---------------------------------------------------------------------------

type ServerMessage =
  | { type: "spawned" }
  | { type: "stdout"; b64: string }
  | { type: "stderr"; b64: string }
  | {
      type: "exit";
      exitCode: number | null;
      signal: string | null;
      cleanupConfirmed: boolean;
    }
  | { type: "error"; code?: string | undefined; reason?: string | undefined; message: string };

type ClientMessage =
  | { op: "spawn"; id: string; argv: string[]; cwd: string; env: Record<string, string> }
  | { op: "terminate"; id: string };

function sendMessage(socket: net.Socket, message: ServerMessage): void {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

// ---------------------------------------------------------------------------
// 监督者（hook 宿主侧）
// ---------------------------------------------------------------------------

interface ManagedOperation {
  readonly id: string;
  readonly child: ChildProcess;
  readonly pgid: number;
  connection: net.Socket | null;
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  /** 终止流程已接管本操作的收尾：close 事件不再重复发 exit 报告 / 解除登记。 */
  terminateInFlight: boolean;
  /** ownership 已释放：组已确认无可运行成员（登记解除）。 */
  finalized: boolean;
  /** 自然退出后的确认 / 收尾去重句柄。 */
  finalizePromise: Promise<boolean> | null;
  /** 根进程 close（stdio 关闭）时逐个 resolve。 */
  readonly closeWaiters: Array<() => void>;
  /** 登记时创建；根进程 close 时 resolve（等待退出确认用）。 */
  readonly closePromise: Promise<void>;
}

/** {@link GitOperationSupervisor.terminateAll} 的结构化报告。 */
export interface TerminateAllReport {
  /** 本次请求终止的存活受管操作数。 */
  readonly requested: number;
  /** 已对其发出组终止信号的操作数。 */
  readonly terminated: number;
  /** 全部根进程退出且组扫描无可运行成员；false 时不得宣称清理完成。 */
  readonly exitConfirmed: boolean;
  /** 组扫描发现的残留可运行成员 PID。 */
  readonly leftoverPids: readonly number[];
  /** 平台查询未能在预算内完成或失败——确认结果不可信。 */
  readonly queryFailed: boolean;
}

/**
 * 单次 hook 的受管 Git 操作监督者。
 *
 * 生命周期与 `executeWorkspaceHook` 一一对应：start（Unix socket 就绪）→
 * hook 子进程内 CLI 经 IPC 请求 spawn / terminate → 外层超时或 hook 结束时
 * `stopAccepting` + `terminateAll` + `dispose`。
 */
export class GitOperationSupervisor {
  private readonly ops = new Map<string, ManagedOperation>();
  private readonly server: net.Server;
  private readonly connections = new Set<net.Socket>();
  private stopping = false;
  private disposed = false;

  private constructor(
    server: net.Server,
    readonly socketPath: string,
    private readonly dir: string | null,
  ) {
    this.server = server;
    server.on("connection", (socket) => this.handleConnection(socket));
  }

  /** 创建临时目录并监听监督 socket；失败时抛出（调用方必须拒绝启动 hook）。 */
  static async start(): Promise<GitOperationSupervisor> {
    if (process.platform === "win32") {
      const socketPath = `\\\\.\\pipe\\symphony-git-supervisor-${randomUUID()}`;
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => resolve());
      });
      return new GitOperationSupervisor(server, socketPath, null);
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-git-supervisor-"));
    const socketPath = path.join(dir, "git-supervisor.sock");
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    return new GitOperationSupervisor(server, socketPath, dir);
  }

  /**
   * 锁定关闭：拒绝接纳新的受管操作（新连接与既有连接上的 spawn 请求都会被拒）。
   * 已接纳但尚未完成的操作仍由本次关闭负责（外层超时清理路径随后 terminateAll）。
   */
  stopAccepting(): void {
    this.stopping = true;
  }

  /**
   * 终止全部未释放 ownership 的受管 Git 进程组（含「根已退出但组仍有残留成员」
   * 的登记项），并在有界窗口内确认退出。
   *
   * 顺序：先对全部未 finalized 的组发终止信号（根已退出的组走防误杀收尾，
   * 排除 PID/PGID 复用），再有界等待根进程 close，最后在剩余预算内做组扫描
   * 确认可运行成员已清空。到达上界仍不能确认时返回 `exitConfirmed: false`
   * （含残留 PID 与查询状态诊断），不宣称全部退出。
   */
  async terminateAll(budgetMs: number): Promise<TerminateAllReport> {
    this.stopping = true;
    const deadline = Date.now() + Math.max(0, budgetMs);
    const live = [...this.ops.values()].filter((op) => !op.finalized);
    for (const op of live) {
      op.terminateInFlight = true;
      if (!op.exited) {
        killProcessGroupSigkill(op.pgid);
      }
    }
    for (const op of live) {
      if (op.exited || Date.now() >= deadline) {
        continue;
      }
      await Promise.race([op.closePromise, delay(Math.max(0, deadline - Date.now()))]);
    }
    let exitConfirmed = true;
    const leftoverPids: number[] = [];
    let queryFailed = false;
    for (const op of live) {
      const outcome = op.exited
        ? await terminateOrphanedProcessGroup(op.pgid, deadline)
        : await this.confirmKilledGroupEmpty(op.pgid, deadline);
      if (!outcome.confirmed) {
        exitConfirmed = false;
      }
      leftoverPids.push(...outcome.leftoverPids);
      queryFailed = queryFailed || outcome.queryFailed;
    }
    for (const op of live) {
      // 向仍连接的请求方补发 exit 报告（terminateAll 接管了收尾报告），
      // 保证客户端不悬挂；随后解除登记。
      const socket = op.connection;
      if (socket !== null && !socket.destroyed) {
        sendMessage(socket, {
          type: "exit",
          exitCode: op.exitCode,
          signal: op.signal,
          cleanupConfirmed: exitConfirmed,
        });
      }
      op.finalized = true;
      this.ops.delete(op.id);
    }
    return {
      requested: live.length,
      terminated: live.length,
      exitConfirmed,
      leftoverPids,
      queryFailed,
    };
  }

  /** 已被组信号终止的运行中操作：有界等待 close 后扫描确认（不重复杀组）。 */
  private async confirmKilledGroupEmpty(pgid: number, deadline: number): Promise<GroupTerminationOutcome> {
    for (;;) {
      const scan = await scanProcessGroupsForLiveMembers([pgid], deadline);
      if (scan.queryFailed) {
        return { confirmed: false, leftoverPids: scan.leftoverPids, queryFailed: true };
      }
      if (scan.leftoverPids.length === 0) {
        return { confirmed: true, leftoverPids: [], queryFailed: false };
      }
      if (Date.now() >= deadline) {
        return { confirmed: false, leftoverPids: scan.leftoverPids, queryFailed: false };
      }
      await delay(Math.min(50, deadline - Date.now()));
    }
  }

  /**
   * 关闭监督 socket 并清理临时目录；所有未释放 ownership 的受管组做防误杀收尾
   * （运行中的组直接终止，根已退出的组清残留成员），有界等待确认。
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopping = true;
    const pending = [...this.ops.values()].filter((op) => !op.finalized);
    for (const op of pending) {
      op.terminateInFlight = true;
    }
    const deadline = Date.now() + TERMINATE_CONFIRM_GRACE_MS;
    const finalizeAll = (async () => {
      for (const op of pending) {
        if (!op.exited) {
          killProcessGroupSigkill(op.pgid);
        }
      }
      for (const op of pending) {
        if (op.exited) {
          await terminateOrphanedProcessGroup(op.pgid, deadline);
        } else {
          await Promise.race([op.closePromise, delay(Math.max(0, deadline - Date.now()))]);
          await this.confirmKilledGroupEmpty(op.pgid, deadline);
        }
        op.finalized = true;
        this.ops.delete(op.id);
      }
    })();
    await Promise.allSettled([finalizeAll, new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      // 语义上 close 回调已覆盖；防御性兜底避免悬挂。
      setTimeout(resolve, 500).unref();
    })]);
    for (const socket of this.connections) {
      socket.destroy();
    }
    if (this.dir !== null) {
      await fs.rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private handleConnection(socket: net.Socket): void {
    // stopping 时不在此处断开：保留连接并按请求拒绝（handleSpawnRequest），
    // 客户端能收到明确的 refused 响应而不是 ECONNRESET。
    this.connections.add(socket);
    let buffer = "";
    socket.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          if (buffer.length > MAX_LINE_BYTES) {
            socket.destroy();
          }
          return;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        this.handleRequest(socket, line);
      }
    });
    socket.on("close", () => {
      this.connections.delete(socket);
      // 请求方退出：登记保留由监督者持有（不依赖 PPID）。对本次连接的操作：
      // 未退出的直接终止；根已退出但 ownership 未释放（组仍有残留成员）的做
      // 防误杀收尾——请求方已消失，输出无消费者，残留必须清掉。
      for (const op of this.ops.values()) {
        if (op.connection !== socket || op.finalized) {
          continue;
        }
        if (!op.exited) {
          void this.terminateOp(op, Date.now() + TERMINATE_CONFIRM_GRACE_MS);
        } else {
          void this.finalizeExitedOp(op, Date.now() + TERMINATE_CONFIRM_GRACE_MS);
        }
      }
    });
    socket.on("error", () => {
      // close 事件随后触发，统一在那里清理。
    });
  }

  private handleRequest(socket: net.Socket, line: string): void {
    let request: ClientMessage;
    try {
      request = JSON.parse(line) as ClientMessage;
    } catch {
      sendMessage(socket, { type: "error", reason: "protocol", message: "invalid request encoding" });
      return;
    }
    if (request.op === "terminate") {
      const op = typeof request.id === "string" ? this.ops.get(request.id) : undefined;
      void this.handleTerminateRequest(socket, op);
      return;
    }
    if (request.op === "spawn") {
      this.handleSpawnRequest(socket, request);
      return;
    }
    sendMessage(socket, { type: "error", reason: "protocol", message: "unknown operation" });
  }

  private async handleTerminateRequest(socket: net.Socket, op: ManagedOperation | undefined): Promise<void> {
    if (!op) {
      sendMessage(socket, { type: "exit", exitCode: null, signal: null, cleanupConfirmed: true });
      return;
    }
    if (op.exited) {
      // 根已退出：显式 terminate 请求对残留成员做防误杀收尾（不假定组为空）。
      const confirmed = op.finalized
        ? true
        : await this.finalizeExitedOp(op, Date.now() + TERMINATE_CONFIRM_GRACE_MS);
      sendMessage(socket, { type: "exit", exitCode: op.exitCode, signal: op.signal, cleanupConfirmed: confirmed });
      return;
    }
    const confirmed = await this.terminateOp(op, Date.now() + TERMINATE_CONFIRM_GRACE_MS);
    sendMessage(socket, { type: "exit", exitCode: op.exitCode, signal: op.signal, cleanupConfirmed: confirmed });
  }

  private handleSpawnRequest(socket: net.Socket, request: Extract<ClientMessage, { op: "spawn" }>): void {
    if (this.stopping) {
      sendMessage(socket, {
        type: "error",
        reason: "stopping",
        message: "git supervisor is stopping; refusing to start managed git operation",
      });
      return;
    }
    if (
      !Array.isArray(request.argv) ||
      request.argv.length === 0 ||
      request.argv[0] !== "git" ||
      request.argv.some((arg) => typeof arg !== "string") ||
      typeof request.cwd !== "string" ||
      request.cwd.length === 0 ||
      typeof request.env !== "object" ||
      request.env === null
    ) {
      sendMessage(socket, { type: "error", reason: "protocol", message: "invalid spawn request" });
      return;
    }
    let cwdStat: nodeFs.Stats;
    try {
      cwdStat = nodeFs.statSync(request.cwd);
    } catch {
      sendMessage(socket, { type: "error", reason: "invalid_cwd", message: `cwd does not exist: ${request.cwd}` });
      return;
    }
    if (!cwdStat.isDirectory()) {
      sendMessage(socket, { type: "error", reason: "invalid_cwd", message: `cwd is not a directory: ${request.cwd}` });
      return;
    }

    // 每条 Git 操作独立进程组（detached）；监督者持有 ChildProcess / PGID。
    const child = spawn("git", request.argv.slice(1), {
      cwd: request.cwd,
      env: { ...request.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid === undefined) {
      // spawn 失败（ENOENT 等）经 'error' 事件异步报告。
      child.once("error", (err: NodeJS.ErrnoException) => {
        sendMessage(socket, { type: "error", code: err.code ?? "SPAWN_FAILED", message: err.message });
      });
      return;
    }

    // 登记先于启动许可响应：此响应到达前，操作已在监督者注册表中。
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const op: ManagedOperation = {
      id: request.id,
      child,
      pgid: child.pid,
      connection: socket,
      exited: false,
      exitCode: null,
      signal: null,
      terminateInFlight: false,
      finalized: false,
      finalizePromise: null,
      closeWaiters: [resolveClose],
      closePromise,
    };
    this.ops.set(request.id, op);
    sendMessage(socket, { type: "spawned" });

    let forwardedStdout = 0;
    let forwardedStderr = 0;
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (forwardedStdout >= STREAM_FORWARD_LIMIT) {
        return;
      }
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      forwardedStdout += text.length;
      sendMessage(socket, { type: "stdout", b64: Buffer.from(text, "utf8").toString("base64") });
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (forwardedStderr >= STREAM_FORWARD_LIMIT) {
        return;
      }
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      forwardedStderr += text.length;
      sendMessage(socket, { type: "stderr", b64: Buffer.from(text, "utf8").toString("base64") });
    });

    child.once("error", (err: NodeJS.ErrnoException) => {
      if (!op.exited) {
        op.exited = true;
        sendMessage(socket, { type: "error", code: err.code ?? "SPAWN_FAILED", message: err.message });
        this.ops.delete(op.id);
      }
    });

    child.once("close", (code, signal) => {
      if (op.exited) {
        return;
      }
      op.exited = true;
      op.exitCode = code;
      op.signal = signal;
      for (const resolve of op.closeWaiters) {
        resolve();
      }
      if (op.terminateInFlight) {
        // 终止流程持有收尾：exit 报告与登记解除由其负责（含组扫描确认）。
        return;
      }
      // 根 close 不释放 ownership：同组的正常 fork / 重挂父子孙可能仍存活。
      // 先有界确认组是否已无可运行成员——确认空才释放登记；否则保留 ownership
      // （cleanupConfirmed=false 如实上报），由请求方断开 / terminateAll / dispose
      // 的防误杀收尾清理（终止流程见 finalizeExitedOp）。
      const connection = socket;
      void this.finalizeNaturalExit(op).then((confirmed) => {
        if (connection !== null && !connection.destroyed) {
          sendMessage(connection, { type: "exit", exitCode: code, signal, cleanupConfirmed: confirmed });
        }
      });
    });
  }

  /**
   * 根进程自然退出后的确认：仅扫描（不清理）——组空则释放 ownership 并上报
   * confirmed；组仍有可运行成员或查询不可信时**保留登记**（cleanupConfirmed=false），
   * 清理责任由 terminateAll / dispose / 请求方断开的防误杀收尾承担。
   */
  private finalizeNaturalExit(op: ManagedOperation): Promise<boolean> {
    if (op.finalizePromise === null) {
      op.finalizePromise = (async () => {
        const deadline = Date.now() + GROUP_EXIT_CONFIRM_BUDGET_MS;
        const scan = await scanProcessGroupsForLiveMembers([op.pgid], deadline);
        const confirmed = !scan.queryFailed && scan.leftoverPids.length === 0;
        if (confirmed) {
          op.finalized = true;
          this.ops.delete(op.id);
        }
        return confirmed;
      })();
    }
    return op.finalizePromise;
  }

  /**
   * 根已退出但 ownership 未释放的收尾：对残留成员发终止信号（带 PID/PGID 复用
   * 防误杀），确认组为空后释放登记；不能确认时保留 ownership（不宣称清理完成）。
   */
  private async finalizeExitedOp(op: ManagedOperation, deadline: number): Promise<boolean> {
    if (op.finalized) {
      return true;
    }
    const outcome = await terminateOrphanedProcessGroup(op.pgid, deadline);
    if (outcome.confirmed) {
      op.finalized = true;
      this.ops.delete(op.id);
    }
    return outcome.confirmed;
  }

  /** 终止单个受管操作：组信号 + 有界等待根退出 + 剩余预算内组扫描。 */
  private async terminateOp(op: ManagedOperation, deadline: number): Promise<boolean> {
    op.terminateInFlight = true;
    killProcessGroupSigkill(op.pgid);
    await Promise.race([op.closePromise, delay(Math.max(0, deadline - Date.now()))]);
    const scan = await scanProcessGroupsForLiveMembers([op.pgid], deadline);
    const confirmed = op.exited && !scan.queryFailed && scan.leftoverPids.length === 0;
    const socket = op.connection;
    if (socket !== null && !socket.destroyed) {
      sendMessage(socket, {
        type: "exit",
        exitCode: op.exitCode,
        signal: op.signal,
        cleanupConfirmed: confirmed,
      });
    }
    this.ops.delete(op.id);
    return confirmed;
  }
}

// ---------------------------------------------------------------------------
// 客户端（hook 内 CLI / 库侧）
// ---------------------------------------------------------------------------

/** 监督 Git 执行失败的中性错误（由 `execGit` 映射为 typed RepositoryBootstrapError）。 */
export class SupervisorGitError extends Error {
  readonly code: SupervisorGitErrorCode;
  readonly errno?: string | undefined;
  readonly cleanupConfirmed?: boolean | undefined;
  readonly exitCode?: number | null | undefined;
  readonly signal?: string | null | undefined;

  constructor(
    code: SupervisorGitErrorCode,
    message: string,
    options?: {
      errno?: string | undefined;
      cleanupConfirmed?: boolean | undefined;
      exitCode?: number | null | undefined;
      signal?: string | null | undefined;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SupervisorGitError";
    this.code = code;
    if (options?.errno !== undefined) {
      this.errno = options.errno;
    }
    if (options?.cleanupConfirmed !== undefined) {
      this.cleanupConfirmed = options.cleanupConfirmed;
    }
    if (options?.exitCode !== undefined) {
      this.exitCode = options.exitCode;
    }
    if (options?.signal !== undefined) {
      this.signal = options.signal;
    }
  }
}

export type SupervisorGitErrorCode =
  /** 无法连接监督 socket（拒绝启动，绝不静默降级为未登记的独立组）。 */
  | "unavailable"
  /** 监督者拒绝（stopping / 协议 / cwd 非法）。 */
  | "refused"
  /** Git 无法 spawn（ENOENT → git_not_found 等）。 */
  | "spawn_failed"
  /** 启动后连接中断（操作仍登记在监督者侧，会被终止）。 */
  | "connection_lost"
  /** Git 命令超时，监督者已按组终止。 */
  | "timeout";

export interface SupervisedGitExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 经监督 socket 执行一条 Git 命令。
 *
 * - 连接后发送 spawn 请求；监督者完成「创建 + 登记」后才响应 `spawned`（启动许可）；
 * - stdout / stderr 经 IPC 流式转发（各 {@link STREAM_FORWARD_LIMIT} 上限）；
 * - `timeoutMs` 到期发送 terminate 请求，监督者对 Git 进程组发终止信号并有界确认，
 *   随 exit 报告以 {@link SupervisorGitError}（code `timeout`）失败——绝不翻成 success；
 * - 任何通信失败都以错误收敛（拒绝启动 / connection_lost），不降级。
 */
export async function spawnGitViaSupervisor(
  socketPath: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
  },
): Promise<SupervisedGitExecResult> {
  const opId = randomUUID();
  return new Promise<SupervisedGitExecResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let spawned = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let buffer = "";

    const socket = net.connect(socketPath);

    const clearTimers = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    };

    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      socket.destroy();
      fn();
    };

    const timeoutError = (cleanupConfirmed: boolean | undefined): SupervisorGitError =>
      new SupervisorGitError("timeout", `Git command "git ${args[0] ?? ""}" timed out after ${options.timeoutMs}ms`, {
        cleanupConfirmed,
      });

    socket.on("connect", () => {
      const request: ClientMessage = {
        op: "spawn",
        id: opId,
        argv: ["git", ...args],
        cwd: options.cwd,
        env: normalizeEnv(options.env),
      };
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          return;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) {
          continue;
        }
        let message: ServerMessage;
        try {
          message = JSON.parse(line) as ServerMessage;
        } catch {
          settle(() => reject(new SupervisorGitError("refused", "git supervisor sent an invalid response")));
          return;
        }
        if (message.type === "spawned") {
          spawned = true;
          continue;
        }
        if (message.type === "stdout") {
          if (stdout.length < STREAM_FORWARD_LIMIT) {
            stdout += Buffer.from(message.b64, "base64").toString("utf8");
          }
          continue;
        }
        if (message.type === "stderr") {
          if (stderr.length < STREAM_FORWARD_LIMIT) {
            stderr += Buffer.from(message.b64, "base64").toString("utf8");
          }
          continue;
        }
        if (message.type === "error") {
          if (message.reason === "stopping" || message.reason === "protocol" || message.reason === "invalid_cwd") {
            settle(() =>
              reject(
                new SupervisorGitError("refused", `git supervisor refused the operation: ${message.message}`),
              ),
            );
            return;
          }
          if (message.code === "ENOENT") {
            settle(() =>
              reject(new SupervisorGitError("spawn_failed", "git executable not found in PATH", { errno: "ENOENT" })),
            );
            return;
          }
          settle(() =>
            reject(new SupervisorGitError("spawn_failed", `Failed to spawn git: ${message.message}`, { errno: message.code })),
          );
          return;
        }
        if (message.type === "exit") {
          if (timedOut) {
            settle(() =>
              reject(
                timeoutError(
                  message.cleanupConfirmed,
                ),
              ),
            );
            return;
          }
          settle(() =>
            resolve({
              exitCode: message.exitCode ?? (message.signal !== null ? 128 : 0),
              stdout: stdout.trim(),
              stderr: stderr.trim(),
            }),
          );
          return;
        }
      }
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (!spawned && !settled) {
        settle(() =>
          reject(
            new SupervisorGitError(
              "unavailable",
              `Managed git supervisor unavailable at "${socketPath}": ${err.message}; refusing to run unmanaged git`,
              { cause: err },
            ),
          ),
        );
        return;
      }
      if (!settled) {
        // 启动许可之后连接中断：操作仍登记在监督者侧并被其终止，此处按失败收敛。
        settle(() =>
          reject(new SupervisorGitError("connection_lost", "Connection to git supervisor lost before completion")),
        );
      }
    });

    socket.on("close", () => {
      if (!settled) {
        if (timedOut) {
          // 超时后监督者的 exit 报告未在宽限内到达 → 清理未确认。
          settle(() => reject(timeoutError(false)));
          return;
        }
        settle(() =>
          reject(new SupervisorGitError("connection_lost", "Connection to git supervisor closed before completion")),
        );
      }
    });

    timer = setTimeout(() => {
      timedOut = true;
      socket.write(`${JSON.stringify({ op: "terminate", id: opId } satisfies ClientMessage)}\n`);
      // 硬上界：监督者确认（或其失败）必须在此窗口内收敛，绝不无界等待。
      graceTimer = setTimeout(() => {
        settle(() => reject(timeoutError(false)));
      }, TERMINATE_CONFIRM_GRACE_MS + 500);
    }, options.timeoutMs);
  });
}

function normalizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
