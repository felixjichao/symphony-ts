import type { ChildProcess } from "node:child_process";
import { AgentError, type AgentErrorDetails } from "./errors";

/**
 * JSON-RPC 2.0 / NDJSON stdio transport kernel（SPEC §10.1 transport framing、
 * §10.3 "Transport handling requirements"、§10.6 read timeout 与错误映射、
 * §17.5 framing / read timeout / stderr 分流，M4.2 / #38）。
 *
 * 本模块是 **Codex 业务无关** 的最底层：它只认识 JSON-RPC envelope 的四个判别位
 * （`id` / `method` / `params` / `result` / `error`），不理解任何 method 名的语义
 * ——`initialize`、`thread/start`、`turn/start`、approval / user-input / tool 与
 * continuation policy 全部归 M4.3 / M4.4。因此本层的测试 fixture 用的是
 * `test/*` 虚构 method，而不是真实 Codex 协议词汇。
 *
 * 四条不变量：
 * 1. **协议流与诊断流物理隔离**：只有 stdout 进入 frame parser；stderr 逐行交给
 *    `onStderr`，即使它打印出一整行合法 JSON-RPC response 也不得影响 pending 状态。
 * 2. **有界缓冲**：stdout / stderr 的单行累积上限 `maxProtocolLineBytes`（SPEC §10.1
 *    RECOMMENDED "Max line size: 10 MB (for safe buffering)"）。超限即丢弃该行剩余
 *    字节直到下一个换行，内存不随对端输出无界增长，且不误报进程退出。
 * 3. **一次调用只有一个了结算**：`sendRequest` 的 Promise 由 response / read timeout /
 *    进程退出三条路径共同竞争，先到先得，超时与退出都会删除 pending entry。
 * 4. **listener 异常不得破坏 transport**：所有回调经 try/catch 隔离，与
 *    `@symphony/workspace` hook 事件面同一惯例。
 */

/** JSON-RPC request / response 的 `id` 取值域（wire 上允许 string 或 integer）。 */
export type RequestId = string | number;

/** {@link Transport.sendRequest} 的入参：`id` 由 transport 生成，调用方不供给。 */
export interface TransportRequest {
  /** 不透明的协议 method 名（transport 不解释）。 */
  readonly method: string;
  /** 协议 payload；缺席时不写出 `params` 键。 */
  readonly params?: unknown;
}

/** 成功 resolve 的 response（JSON-RPC error response 走 `AgentError` 拒绝路径）。 */
export interface TransportResponse {
  /** transport 为本次请求生成的 id（与 wire 上的 `id` 一致）。 */
  readonly id: string;
  /** result payload；对端未携带时**缺席**。 */
  readonly result?: unknown;
}

/** 双向的 notification（对端 → 本地，或本地 → 对端）。 */
export interface TransportNotification {
  readonly method: string;
  readonly params?: unknown;
}

/** JSON-RPC error object（`error` 成员）。 */
export interface JsonRpcErrorPayload {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** 对端主动发起的 request（如 app-server 的 approval / tool call）。transport 只转发语义，不裁决。 */
export interface TransportServerRequest {
  /** 回信时必须原样带回的 id（wire 原始值）。 */
  readonly id: RequestId;
  readonly method: string;
  readonly params?: unknown;
}

/** 回给对端 request 的信封。 */
export interface TransportServerResponse {
  readonly id: RequestId;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorPayload;
}

/** framing / 协议完整性问题的可判别通知（不抛出，不影响其它消息）。 */
export interface TransportProtocolIssue {
  /**
   * - `oversized_line`：单行累积超过 `maxProtocolLineBytes`，已丢弃至下一个换行；
   *   该行**不**进入 parser（防无界缓冲与 hang 的核心信号）；
   * - `malformed_line`：完整一行不是合法 JSON，或 envelope 结构不可判别；
   *   被丢弃的超限行的尾部字节按此原因报告（对端行为异常，不是本地缺陷）。
   */
  readonly reason: "oversized_line" | "malformed_line";
  readonly message: string;
  /** 当前已累积 / 该行的字节数（`oversized_line` 携带）。 */
  readonly byteLength?: number;
  /** 最多 256 字节的行摘录（诊断用，可能因非 UTF-8 而失真）。 */
  readonly excerpt?: string;
}

/** 进程退出通知（`exit` 与 `close` 中先到的一次，之后不再重复）。 */
export interface TransportExitInfo {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** 本地是否主动调用过 {@link Transport.stop}。 */
  readonly stopped: boolean;
}

/** 上层注入的观察点。全部可选：缺席时对应信号被丢弃，不改变 transport 行为。 */
export interface TransportListener {
  onNotification?(notification: TransportNotification): void;
  onServerRequest?(request: TransportServerRequest): void;
  /** stderr 的一行（不含换行符）。 */
  onStderr?(line: string): void;
  onProtocolIssue?(issue: TransportProtocolIssue): void;
  /** 对端发来的未知 response ID 或非请求/非通知消息。 */
  onOtherMessage?(message: unknown): void;
  /** 对端输出任意有效协议消息（server request / notification / 匹配的 response）时的活动信号。 */
  onActivity?(): void;
  onExit?(info: TransportExitInfo): void;
}

/** transport 生命周期面（M4.3 的 Codex client 是本包内唯一消费者）。 */
export interface Transport {
  /**
   * 发送 request 并等待匹配的 response。
   *
   * 拒绝路径（全部是 typed {@link AgentError}）：
   * - `response_timeout`：`readTimeoutMs` 内没有等到 response（pending entry 已清理）；
   * - `response_error`：对端返回 JSON-RPC error response；
   * - `port_exit`：子进程在 response 之前退出 / 已退出；
   * - `protocol_error`：匹配到的 response envelope 不合法。
   */
  sendRequest(request: TransportRequest): Promise<TransportResponse>;
  /** 发送 notification（无 response，不等 IO）。transport 已关闭时抛 `port_exit`。 */
  sendNotification(notification: TransportNotification): void;
  /** 回复对端发起的 request。协议语义（result / error 内容）由调用方决定。 */
  respondToServerRequest(response: TransportServerResponse): void;
  /** SIGTERM → `shutdownTimeoutMs` → SIGKILL 的有界关闭；幂等，永不遗留子进程。 */
  stop(): Promise<void>;
  /** 子进程 PID（字符串形式，§4.1.6 口径）；未 spawn 成功时为 `null`。 */
  readonly pid: string | null;
  /** 子进程已退出或 transport 已关闭。 */
  readonly closed: boolean;
}

/** SPEC §10.1 RECOMMENDED "Max line size: 10 MB (for safe buffering)"。 */
export const DEFAULT_MAX_PROTOCOL_LINE_BYTES = 10 * 1024 * 1024;

/** `readTimeoutMs` 非法（非有限正数）时的回退值，与 §5.3.6 `codex.read_timeout_ms` 默认一致。 */
export const DEFAULT_READ_TIMEOUT_MS = 5_000;

/** {@link Transport.stop} 在 SIGTERM 与 SIGKILL 之间的等待窗口默认值。 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

/** 协议 issue 摘录的字节上限（避免把 10 MB 行塞进诊断回调）。 */
const PROTOCOL_ISSUE_EXCERPT_BYTES = 256;

/** {@link createNdjsonTransport} 的选项。 */
export interface NdjsonTransportOptions {
  readonly readTimeoutMs?: number | undefined;
  readonly maxProtocolLineBytes?: number | undefined;
  readonly shutdownTimeoutMs?: number | undefined;
  readonly listener?: TransportListener | undefined;
  /** 诊断上下文中携带的 method 名以外的 workspace 路径（可选）。 */
  readonly workspacePath?: string | undefined;
}

/** 归一化为有限正数，否则回退默认值（与 workspace hook timeout 同一防御惯例）。 */
function resolvePositiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** wire `id` → pending map key（string 与 number 不互相碰撞）。 */
function pendingKey(id: RequestId): string {
  return typeof id === "number" ? `n:${id}` : `s:${id}`;
}

function excerpt(text: string): string {
  return text.length > PROTOCOL_ISSUE_EXCERPT_BYTES
    ? text.slice(0, PROTOCOL_ISSUE_EXCERPT_BYTES)
    : text;
}

/**
 * 有界 NDJSON 行读取器。
 *
 * 只负责「字节流 → 完整行」，不理解 JSON：
 * - 跨 chunk 的 partial line 会累积到下一个 `0x0A`；
 * - 累积超过 `maxBytes` 时立即释放已缓冲字节并进入 discard 模式，直到下一个换行
 *   （因此一个永不换行的对端最多占用 `maxBytes`，不会让本地无界增长，也不会 hang）；
 * - 流结束（EOF）时把未以换行结尾的残余按一行交出（对端漏写末尾换行时不丢消息）。
 */
class NdjsonLineReader {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private discarding = false;

  constructor(
    private readonly maxBytes: number,
    private readonly onLine: (line: Buffer) => void,
    private readonly onOversized: (byteLength: number, lineStart: Buffer) => void,
  ) {}

  push(chunk: Buffer): void {
    let offset = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline === -1) {
        this.accumulate(chunk.subarray(offset));
        return;
      }
      this.accumulate(chunk.subarray(offset, newline));
      offset = newline + 1;
      this.emitLine();
    }
  }

  /** EOF：交出无换行结尾的最后一行（discard 模式下什么都没有）。 */
  finish(): void {
    if (this.discarding) {
      this.reset();
      return;
    }
    if (this.bytes > 0) {
      this.emitLine();
    }
  }

  private accumulate(data: Buffer): void {
    if (this.discarding || data.length === 0) {
      return;
    }
    if (this.bytes + data.length > this.maxBytes) {
      const lineStart = Buffer.concat(this.chunks);
      this.onOversized(this.bytes + data.length, lineStart);
      this.reset();
      this.discarding = true;
      return;
    }
    this.chunks.push(data);
    this.bytes += data.length;
  }

  private emitLine(): void {
    const line = Buffer.concat(this.chunks);
    this.reset();
    // 换行结束了被丢弃的那一行：下一个字节属于新的一行，必须恢复缓冲。
    this.discarding = false;
    this.onLine(line);
  }

  private reset(): void {
    this.chunks = [];
    this.bytes = 0;
  }
}

interface PendingRequest {
  readonly id: string;
  readonly method: string;
  readonly timer: NodeJS.Timeout;
  resolve(response: TransportResponse): void;
  reject(error: AgentError): void;
}

/**
 * 把已建立的 stdio 子进程包装成 {@link Transport}。
 *
 * 由 `./process-launcher` 在 spawn 成功后调用；不 own spawn，也不做路径安全校验
 * （launch 边界的全部前置条件在 `process-launcher.ts`）。
 */
export class NdjsonTransport implements Transport {
  private readonly readTimeoutMs: number;
  private readonly maxProtocolLineBytes: number;
  private readonly shutdownTimeoutMs: number;
  private readonly listener: TransportListener;
  private readonly workspacePath: string | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly exitPromise: Promise<void>;
  private nextId = 1;
  private exited = false;
  private exitReported = false;
  private stopRequested = false;

  constructor(
    private readonly child: ChildProcess,
    options: NdjsonTransportOptions = {},
  ) {
    this.readTimeoutMs = resolvePositiveNumber(options.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS);
    this.maxProtocolLineBytes = resolvePositiveNumber(
      options.maxProtocolLineBytes,
      DEFAULT_MAX_PROTOCOL_LINE_BYTES,
    );
    this.shutdownTimeoutMs = resolvePositiveNumber(
      options.shutdownTimeoutMs,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );
    this.listener = options.listener ?? {};
    this.workspacePath = options.workspacePath;

    const stdout = this.child.stdout;
    const stderr = this.child.stderr;

    if (stdout === null || stderr === null || this.child.stdin === null) {
      throw new AgentError("launch_failed", "coding agent subprocess was launched without piped stdio", this.errorContext());
    }

    const stdoutReader = new NdjsonLineReader(
      this.maxProtocolLineBytes,
      (line) => {
        this.handleProtocolLine(line);
      },
      (byteLength, lineStart) => {
        this.emitProtocolIssue({
          reason: "oversized_line",
          message: `Protocol line exceeded ${this.maxProtocolLineBytes} bytes and was discarded without terminating the transport`,
          byteLength,
          excerpt: excerpt(lineStart.toString("utf8")),
        });
      },
    );
    stdout.on("data", (chunk: Buffer) => {
      stdoutReader.push(chunk);
    });
    stdout.on("end", () => {
      stdoutReader.finish();
    });

    // stderr 与协议流物理隔离：独立 reader、独立回调，永不进入 handleProtocolLine。
    const stderrReader = new NdjsonLineReader(
      this.maxProtocolLineBytes,
      (line) => {
        this.emitStderr(line.toString("utf8").replace(/\r$/, ""));
      },
      (byteLength) => {
        // stderr 是诊断流：超限只报告一次，不解析、不影响协议状态。
        this.emitProtocolIssue({
          reason: "oversized_line",
          message: `stderr line exceeded ${this.maxProtocolLineBytes} bytes and was discarded`,
          byteLength,
        });
      },
    );
    stderr.on("data", (chunk: Buffer) => {
      stderrReader.push(chunk);
    });
    stderr.on("end", () => {
      stderrReader.finish();
    });

    this.child.once("exit", (code, signal) => {
      this.handleExit(code, signal);
    });
    this.child.once("close", (code, signal) => {
      this.handleExit(code, signal);
    });
    // 子进程已消失后的 stdin 写失败（EPIPE）是预期竞态，不得变成 uncaught exception。
    this.child.stdin.on("error", () => {
      /* 由 pending 的退出 / 超时路径负责结算 */
    });

    this.exitPromise = new Promise<void>((resolve) => {
      if (this.exited) {
        resolve();
        return;
      }
      this.child.once("close", () => {
        resolve();
      });
      this.child.once("exit", () => {
        resolve();
      });
    });
  }

  get pid(): string | null {
    return this.child.pid === undefined ? null : String(this.child.pid);
  }

  get closed(): boolean {
    return this.exited || this.stopRequested;
  }

  sendRequest(request: TransportRequest): Promise<TransportResponse> {
    const id = String(this.nextId++);
    const envelope: Record<string, unknown> = { jsonrpc: "2.0", id, method: request.method };
    if (request.params !== undefined) {
      envelope["params"] = request.params;
    }

    return new Promise<TransportResponse>((resolve, reject) => {
      if (this.closed) {
        reject(
          new AgentError(
            "port_exit",
            `Cannot send ${request.method}: coding agent subprocess is no longer running`,
            this.errorContext(request.method),
          ),
        );
        return;
      }

      let settled = false;
      const key = pendingKey(id);
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        this.pending.delete(key);
        reject(
          new AgentError(
            "response_timeout",
            `No response to ${request.method} within ${this.readTimeoutMs}ms (read_timeout_ms)`,
            this.errorContext(request.method),
          ),
        );
      }, this.readTimeoutMs);

      const entry: PendingRequest = {
        id,
        method: request.method,
        timer,
        resolve: (response) => {
          settled = true;
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      };
      this.pending.set(key, entry);

      try {
        this.writeMessage(envelope);
      } catch (error) {
        entry.reject(
          error instanceof AgentError
            ? error
            : new AgentError("protocol_error", `Failed to encode ${request.method}`, this.errorContext(request.method)),
        );
        this.pending.delete(key);
      }
    });
  }

  sendNotification(notification: TransportNotification): void {
    const envelope: Record<string, unknown> = { jsonrpc: "2.0", method: notification.method };
    if (notification.params !== undefined) {
      envelope["params"] = notification.params;
    }
    this.writeMessage(envelope);
  }

  respondToServerRequest(response: TransportServerResponse): void {
    const envelope: Record<string, unknown> = { jsonrpc: "2.0", id: response.id };
    if (response.error !== undefined) {
      envelope["error"] = response.error;
    } else {
      envelope["result"] = response.result ?? null;
    }
    this.writeMessage(envelope);
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.exited) {
      await this.exitPromise;
      return;
    }
    killProcessGroup(this.child.pid, "SIGTERM");
    // 窗口定时器必须在进程先退出时清掉：否则每个 stop() 留一个挂住的 handle
    // （daemon 里一轮 attempt 一个子进程，累积起来就是明确的资源泄漏）。
    let window: NodeJS.Timeout | undefined;
    const withinWindow = await new Promise<boolean>((resolve) => {
      window = setTimeout(() => {
        resolve(false);
      }, this.shutdownTimeoutMs);
      this.exitPromise.then(() => {
        resolve(true);
      });
    });
    if (window !== undefined) {
      clearTimeout(window);
    }
    if (!withinWindow) {
      killProcessGroup(this.child.pid, "SIGKILL");
      await this.exitPromise;
    }
  }

  /** 唯一写出口：一行 `JSON.stringify` + `\n`。 */
  private writeMessage(envelope: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (this.exited || stdin === null || stdin.destroyed || stdin.writableEnded) {
      throw new AgentError(
        "port_exit",
        "Coding agent subprocess stdin is not writable (process exited or transport stopped)",
        this.errorContext(),
      );
    }
    let text: string;
    try {
      text = `${JSON.stringify(envelope)}\n`;
    } catch (error) {
      throw new AgentError(
        "protocol_error",
        `Request payload is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
        this.errorContext(),
      );
    }
    // 写错误（含背压后的 EPIPE）不在此抛给调用方：response 由 read timeout 或
    // handleExit 结算，避免「写失败」变成第二套未类型化的错误面。
    stdin.write(text, () => {
      /* error 经 stdin 'error' 监听器吞掉 */
    });
  }

  private handleProtocolLine(line: Buffer): void {
    const text = line.toString("utf8").replace(/\r$/, "");
    if (text.length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.emitProtocolIssue({
        reason: "malformed_line",
        message: `stdout line is not valid JSON and was discarded: ${error instanceof Error ? error.message : String(error)}`,
        excerpt: excerpt(text),
      });
      return;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.emitProtocolIssue({
        reason: "malformed_line",
        message: "stdout JSON value is not a JSON-RPC message object and was discarded",
        excerpt: excerpt(text),
      });
      return;
    }

    const message = parsed as Record<string, unknown>;
    const method = message["method"];
    const rawId = message["id"];
    const hasMethod = typeof method === "string";
    const hasId = typeof rawId === "string" || typeof rawId === "number";

    if (hasMethod && hasId) {
      // 对端发起的 request：只转发语义，不裁决（approval / tool policy 归 M4.4）。
      this.emitActivity();
      this.emitServerRequest({
        id: rawId as RequestId,
        method: method as string,
        ...(message["params"] !== undefined ? { params: message["params"] } : {}),
      });
      return;
    }

    if (hasMethod) {
      this.emitActivity();
      this.emitNotification({
        method: method as string,
        ...(message["params"] !== undefined ? { params: message["params"] } : {}),
      });
      return;
    }

    if (!hasId) {
      this.emitOtherMessage(message);
      this.emitProtocolIssue({
        reason: "malformed_line",
        message: "stdout message carries neither `method` nor `id` and was discarded",
        excerpt: excerpt(text),
      });
      return;
    }

    const key = pendingKey(rawId as RequestId);
    if (this.pending.has(key)) {
      this.emitActivity();
    }
    this.settlePendingResponse(rawId as RequestId, message);
  }

  private settlePendingResponse(rawId: RequestId, message: Record<string, unknown>): void {
    const key = pendingKey(rawId);
    const entry = this.pending.get(key);
    if (entry === undefined) {
      this.emitOtherMessage(message);
      this.emitProtocolIssue({
        reason: "malformed_line",
        message: `Response for unknown or already-settled request id ${String(rawId)} was discarded`,
        excerpt: excerpt(JSON.stringify(message)),
      });
      return;
    }

    const error = message["error"];
    if (error !== undefined) {
      const errorObject =
        typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
      const code = typeof errorObject["code"] === "number" ? errorObject["code"] : null;
      const text = typeof errorObject["message"] === "string" ? errorObject["message"] : "";
      this.pending.delete(key);
      entry.reject(
        new AgentError(
          "response_error",
          `${entry.method} returned a JSON-RPC error response (code=${String(code)}, message=${text})`,
          this.errorContext(entry.method),
        ),
      );
      return;
    }

    const result = message["result"];
    if (!("result" in message) || result === undefined) {
      this.pending.delete(key);
      entry.reject(
        new AgentError(
          "protocol_error",
          `Success response to ${entry.method} carries no \`result\` member`,
          this.errorContext(entry.method),
        ),
      );
      return;
    }

    this.pending.delete(key);
    entry.resolve({ id: entry.id, result });
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) {
      return;
    }
    this.exited = true;

    const failures = [...this.pending.values()];
    this.pending.clear();
    for (const entry of failures) {
      clearTimeout(entry.timer);
      entry.reject(
        new AgentError(
          "port_exit",
          `${entry.method} failed: coding agent subprocess exited before responding (exitCode=${String(code)}, signal=${String(signal)})`,
          this.errorContext(entry.method),
        ),
      );
    }

    if (this.exitReported) {
      return;
    }
    this.exitReported = true;
    try {
      this.listener.onExit?.({ exitCode: code, signal, stopped: this.stopRequested });
    } catch {
      /* listener 异常不得影响 transport */
    }
  }

  private errorContext(method?: string): AgentErrorDetails {
    return {
      ...(this.pid !== null ? { codexAppServerPid: this.pid } : {}),
      ...(method !== undefined ? { protocolMethod: method } : {}),
      ...(this.workspacePath !== undefined ? { path: this.workspacePath } : {}),
    };
  }

  private emitNotification(notification: TransportNotification): void {
    try {
      this.listener.onNotification?.(notification);
    } catch {
      /* 隔离 */
    }
  }

  private emitServerRequest(request: TransportServerRequest): void {
    try {
      this.listener.onServerRequest?.(request);
    } catch {
      /* 隔离 */
    }
  }

  private emitStderr(line: string): void {
    try {
      this.listener.onStderr?.(line);
    } catch {
      /* 隔离 */
    }
  }

  private emitProtocolIssue(issue: TransportProtocolIssue): void {
    try {
      this.listener.onProtocolIssue?.(issue);
    } catch {
      /* 隔离 */
    }
  }

  private emitOtherMessage(message: unknown): void {
    try {
      this.listener.onOtherMessage?.(message);
    } catch {
      /* 隔离 */
    }
  }

  private emitActivity(): void {
    try {
      this.listener.onActivity?.();
    } catch {
      /* 隔离 */
    }
  }
}

/**
 * 终止子进程**整个进程组**（detached spawn 时 pgid === pid）。
 * 与 workspace hook 执行层同一做法：`bash -lc` 若未 `exec` 替换自身，codex 子进程
 * 会是 bash 的子进程，只 kill 直接孩子会留下持有 stdio 的孤儿（§17.5 "不遗留 subprocess"）。
 * ESRCH（已退出）忽略。
 */
function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* 进程组与进程都已退出 */
    }
  }
}

/** {@link NdjsonTransport} 的工厂形式（`process-launcher` 使用）。 */
export function createNdjsonTransport(
  child: ChildProcess,
  options: NdjsonTransportOptions = {},
): NdjsonTransport {
  return new NdjsonTransport(child, options);
}
