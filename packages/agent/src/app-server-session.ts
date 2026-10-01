import * as path from "node:path";
import {
  composeSessionId,
  type CodexPassThroughValue,
} from "@symphony/domain";
import { AgentError } from "./errors";
import {
  launchTransport,
  type WorkspacePathSafetyGate,
} from "./process-launcher";
import type {
  Transport,
  TransportExitInfo,
  TransportNotification,
  TransportProtocolIssue,
  TransportServerRequest,
} from "./transport";

/**
 * 默认 turn silence 超时（毫秒），与 SPEC §5.3.6 codex.turn_timeout_ms 默认 1 小时对齐。
 */
export const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;

/**
 * {@link startAppServerSession} 入参。
 */
export interface AppServerSessionOptions {
  /** codex.command（SPEC §5.3.6）：交给 process-launcher 的 shell 命令。 */
  readonly command: string;
  /** per-issue workspace 绝对路径（SPEC §9.5 / §10.1）。 */
  readonly workspacePath: string;
  /** §9.5 execution-boundary primitive 提供方。 */
  readonly workspacePathSafety: WorkspacePathSafetyGate;
  /** 关联 issue identifier（用于错误诊断上下文）。 */
  readonly identifier?: string | undefined;
  /** 显式注入子进程的环境变量。 */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** 排除名单（从继承的环境中剔除）。 */
  readonly excludeEnvNames?: readonly string[] | undefined;
  /** transport 侧 request/response 超时（毫秒）。 */
  readonly readTimeoutMs?: number | undefined;
  /** turn silence 超时（毫秒）：等待 turn/completed 期间无有效输出时触发。 */
  readonly turnTimeoutMs?: number | undefined;
  /** stop() 时 SIGTERM 到 SIGKILL 的等待窗口（毫秒）。 */
  readonly shutdownTimeoutMs?: number | undefined;
  /** approval 策略 pass-through 值（SPEC §5.3.6）。 */
  readonly approvalPolicy?: CodexPassThroughValue | null | undefined;
  /** thread 级 sandbox pass-through 字符串（SPEC §5.3.6）。 */
  readonly threadSandbox?: string | null | undefined;
  /** turn 级 sandbox policy pass-through 值（SPEC §5.3.6）。 */
  readonly turnSandboxPolicy?: CodexPassThroughValue | null | undefined;
  /** 观测点：子进程 stderr 输出行。 */
  readonly onStderr?: ((line: string) => void) | undefined;
  /** 观测点：transport framing 或协议 issue。 */
  readonly onProtocolIssue?: ((issue: TransportProtocolIssue) => void) | undefined;
  /** 观测点：对端主动发起的 server request。 */
  readonly onServerRequest?: ((request: TransportServerRequest) => void) | undefined;
  /** 观测点：对端发出的 notification。 */
  readonly onNotification?: ((notification: TransportNotification) => void) | undefined;
}

/**
 * 单个 turn 完成的产出（SPEC §4.1.6 / §4.2）。
 */
export interface TurnCompletedOutcome {
  readonly turnId: string;
  readonly sessionId: string;
}

/**
 * Codex app-server live session 契约面（SPEC §10.2 / §10.3 / §10.6 / §17.5，M4.3 / #39）。
 */
export interface AppServerSession {
  readonly threadId: string;
  readonly codexAppServerPid: string | null;
  startTurn(input: { readonly text: string }): Promise<TurnCompletedOutcome>;
  stop(): Promise<void>;
}

interface ActiveTurnState {
  turnId: string | null;
  bufferedCompleted: Record<string, unknown> | null;
  resolve: (outcome: TurnCompletedOutcome) => void;
  reject: (error: AgentError) => void;
}

class AppServerSessionImpl implements AppServerSession {
  private threadIdValue: string | null = null;
  private readonly transport: Transport;
  private readonly options: AppServerSessionOptions;
  private activeTurn: ActiveTurnState | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(transport: Transport, options: AppServerSessionOptions) {
    this.transport = transport;
    this.options = options;
  }

  public initThread(threadId: string): void {
    this.threadIdValue = threadId;
  }

  public get threadId(): string {
    if (this.threadIdValue === null) {
      throw new AgentError(
        "protocol_error",
        "Session has not finished initialization",
      );
    }
    return this.threadIdValue;
  }

  public get codexAppServerPid(): string | null {
    return this.transport.pid;
  }

  public async startTurn(input: { readonly text: string }): Promise<TurnCompletedOutcome> {
    if (this.stopped) {
      throw new AgentError(
        "port_exit",
        "Cannot start turn: session has already been stopped",
        {
          threadId: this.threadIdValue ?? undefined,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
        },
      );
    }

    if (this.activeTurn !== null) {
      throw new AgentError(
        "protocol_error",
        "Cannot start a new turn while a previous turn is still in progress (single active turn invariant)",
        {
          threadId: this.threadIdValue ?? undefined,
          turnId: this.activeTurn.turnId ?? undefined,
          sessionId: this.activeTurn.turnId
            ? composeSessionId(this.threadId, this.activeTurn.turnId)
            : undefined,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
        },
      );
    }

    if (typeof input !== "object" || input === null || typeof input.text !== "string") {
      throw new AgentError(
        "protocol_error",
        "turn/start input must contain string 'text' property",
        {
          threadId: this.threadIdValue ?? undefined,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
        },
      );
    }

    const effectiveTurnTimeoutMs =
      typeof this.options.turnTimeoutMs === "number" && this.options.turnTimeoutMs > 0
        ? this.options.turnTimeoutMs
        : DEFAULT_TURN_TIMEOUT_MS;

    let turnResolve!: (outcome: TurnCompletedOutcome) => void;
    let turnReject!: (error: AgentError) => void;

    const turnPromise = new Promise<TurnCompletedOutcome>((resolve, reject) => {
      turnResolve = resolve;
      turnReject = reject;
    });

    this.activeTurn = {
      turnId: null,
      bufferedCompleted: null,
      resolve: turnResolve,
      reject: turnReject,
    };

    const resetSilenceTimer = (): void => {
      if (this.silenceTimer !== null) {
        clearTimeout(this.silenceTimer);
      }
      this.silenceTimer = setTimeout(() => {
        if (this.activeTurn === null) {
          return;
        }
        const error = new AgentError(
          "turn_timeout",
          `turn stream silent for ${effectiveTurnTimeoutMs} ms`,
          {
            threadId: this.threadId,
            turnId: this.activeTurn.turnId ?? undefined,
            sessionId: this.activeTurn.turnId
              ? composeSessionId(this.threadId, this.activeTurn.turnId)
              : undefined,
            codexAppServerPid: this.codexAppServerPid ?? undefined,
          },
        );
        const { reject } = this.activeTurn;
        this.cleanupActiveTurn();
        reject(error);
      }, effectiveTurnTimeoutMs);
    };

    resetSilenceTimer();

    const turnStartParams: Record<string, unknown> = {
      threadId: this.threadId,
      input: [
        {
          type: "text",
          text: input.text,
          text_elements: [],
        },
      ],
      cwd: path.resolve(this.options.workspacePath),
    };

    if (this.options.approvalPolicy !== null && this.options.approvalPolicy !== undefined) {
      turnStartParams.approvalPolicy = this.options.approvalPolicy;
    }
    if (this.options.turnSandboxPolicy !== null && this.options.turnSandboxPolicy !== undefined) {
      turnStartParams.sandboxPolicy = this.options.turnSandboxPolicy;
    }

    try {
      const response = await this.transport.sendRequest({
        method: "turn/start",
        params: turnStartParams,
      });

      if (this.activeTurn !== null) {
        resetSilenceTimer();
      }

      if (
        typeof response.result !== "object" ||
        response.result === null ||
        typeof (response.result as Record<string, unknown>).turn !== "object" ||
        (response.result as Record<string, unknown>).turn === null
      ) {
        throw new AgentError(
          "protocol_error",
          "turn/start response invalid: missing turn object",
          {
            threadId: this.threadId,
            codexAppServerPid: this.codexAppServerPid ?? undefined,
            protocolMethod: "turn/start",
          },
        );
      }

      const turn = (response.result as Record<string, unknown>).turn as Record<string, unknown>;
      if (typeof turn.id !== "string" || turn.id.length === 0 || turn.status !== "inProgress") {
        throw new AgentError(
          "protocol_error",
          "turn/start response invalid: turn.id must be non-empty string and turn.status must be 'inProgress'",
          {
            threadId: this.threadId,
            codexAppServerPid: this.codexAppServerPid ?? undefined,
            protocolMethod: "turn/start",
          },
        );
      }

      if (this.activeTurn !== null) {
        this.activeTurn.turnId = turn.id;
        if (this.activeTurn.bufferedCompleted !== null) {
          const buffered = this.activeTurn.bufferedCompleted;
          this.activeTurn.bufferedCompleted = null;
          if (buffered.id === turn.id) {
            this.settleTurnCompleted(buffered);
          }
        }
      }
    } catch (error) {
      if (this.activeTurn !== null) {
        const { reject } = this.activeTurn;
        this.cleanupActiveTurn();
        if (error instanceof AgentError) {
          reject(error);
        } else {
          reject(
            new AgentError(
              "protocol_error",
              error instanceof Error ? error.message : String(error),
              {
                cause: error,
                threadId: this.threadId,
                codexAppServerPid: this.codexAppServerPid ?? undefined,
                protocolMethod: "turn/start",
              },
            ),
          );
        }
      }
    }

    return turnPromise;
  }

  public handleNotification(notification: TransportNotification): void {
    if (this.activeTurn !== null) {
      this.resetActiveTurnSilenceTimer();
    }

    if (notification.method === "turn/completed") {
      this.handleTurnCompletedNotification(notification);
    }
  }

  public handleServerRequest(_request: TransportServerRequest): void {
    if (this.activeTurn !== null) {
      this.resetActiveTurnSilenceTimer();
    }
  }

  public handleExit(info: TransportExitInfo): void {
    if (this.activeTurn !== null) {
      const error = new AgentError(
        "port_exit",
        info.stopped
          ? "Codex app-server process was stopped while turn was in progress"
          : `Codex app-server process exited unexpectedly while turn was in progress (code ${String(info.exitCode)}, signal ${String(info.signal)})`,
        {
          threadId: this.threadIdValue ?? undefined,
          turnId: this.activeTurn.turnId ?? undefined,
          sessionId: this.activeTurn.turnId
            ? composeSessionId(this.threadId, this.activeTurn.turnId)
            : undefined,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
        },
      );
      const { reject } = this.activeTurn;
      this.cleanupActiveTurn();
      reject(error);
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.activeTurn !== null) {
      const error = new AgentError(
        "port_exit",
        "Codex app-server session was stopped while turn was in progress",
        {
          threadId: this.threadIdValue ?? undefined,
          turnId: this.activeTurn.turnId ?? undefined,
          sessionId: this.activeTurn.turnId
            ? composeSessionId(this.threadId, this.activeTurn.turnId)
            : undefined,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
        },
      );
      const { reject } = this.activeTurn;
      this.cleanupActiveTurn();
      reject(error);
    }
    await this.transport.stop();
  }

  private resetActiveTurnSilenceTimer(): void {
    if (this.activeTurn === null) {
      return;
    }
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
    }
    const timeoutMs =
      typeof this.options.turnTimeoutMs === "number" && this.options.turnTimeoutMs > 0
        ? this.options.turnTimeoutMs
        : DEFAULT_TURN_TIMEOUT_MS;

    this.silenceTimer = setTimeout(() => {
      if (this.activeTurn === null) {
        return;
      }
      const error = new AgentError(
        "turn_timeout",
        `turn stream silent for ${timeoutMs} ms`,
        {
          threadId: this.threadId,
          turnId: this.activeTurn.turnId ?? undefined,
          sessionId: this.activeTurn.turnId
            ? composeSessionId(this.threadId, this.activeTurn.turnId)
            : undefined,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
        },
      );
      const { reject } = this.activeTurn;
      this.cleanupActiveTurn();
      reject(error);
    }, timeoutMs);
  }

  private handleTurnCompletedNotification(notification: TransportNotification): void {
    if (this.activeTurn === null) {
      return;
    }

    const params = notification.params;
    if (typeof params !== "object" || params === null) {
      const error = new AgentError(
        "protocol_error",
        "turn/completed payload missing params object",
        {
          threadId: this.threadId,
          turnId: this.activeTurn.turnId ?? undefined,
          sessionId: this.activeTurn.turnId
            ? composeSessionId(this.threadId, this.activeTurn.turnId)
            : undefined,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
          protocolMethod: "turn/completed",
        },
      );
      const { reject } = this.activeTurn;
      this.cleanupActiveTurn();
      reject(error);
      return;
    }

    const turnObj = (params as Record<string, unknown>).turn;
    if (typeof turnObj !== "object" || turnObj === null) {
      const error = new AgentError(
        "protocol_error",
        "turn/completed payload missing turn object",
        {
          threadId: this.threadId,
          turnId: this.activeTurn.turnId ?? undefined,
          sessionId: this.activeTurn.turnId
            ? composeSessionId(this.threadId, this.activeTurn.turnId)
            : undefined,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
          protocolMethod: "turn/completed",
        },
      );
      const { reject } = this.activeTurn;
      this.cleanupActiveTurn();
      reject(error);
      return;
    }

    const turn = turnObj as Record<string, unknown>;
    if (typeof turn.id !== "string" || turn.id.length === 0) {
      const error = new AgentError(
        "protocol_error",
        "turn/completed payload missing valid turn.id string",
        {
          threadId: this.threadId,
          turnId: this.activeTurn.turnId ?? undefined,
          sessionId: this.activeTurn.turnId
            ? composeSessionId(this.threadId, this.activeTurn.turnId)
            : undefined,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
          protocolMethod: "turn/completed",
        },
      );
      const { reject } = this.activeTurn;
      this.cleanupActiveTurn();
      reject(error);
      return;
    }

    if (this.activeTurn.turnId === null) {
      this.activeTurn.bufferedCompleted = turn;
      return;
    }

    if (turn.id !== this.activeTurn.turnId) {
      return;
    }

    this.settleTurnCompleted(turn);
  }

  private settleTurnCompleted(turn: Record<string, unknown>): void {
    if (this.activeTurn === null) {
      return;
    }

    const turnId = this.activeTurn.turnId!;
    const sessionId = composeSessionId(this.threadId, turnId);
    const status = turn.status;

    if (status === "completed") {
      const outcome: TurnCompletedOutcome = {
        turnId,
        sessionId,
      };
      const { resolve } = this.activeTurn;
      this.cleanupActiveTurn();
      resolve(outcome);
      return;
    }

    if (status === "failed") {
      const errorObj =
        typeof turn.error === "object" && turn.error !== null
          ? (turn.error as Record<string, unknown>)
          : null;
      const message =
        typeof errorObj?.message === "string" && errorObj.message.length > 0
          ? errorObj.message
          : "turn failed";
      const error = new AgentError("turn_failed", message, {
        threadId: this.threadId,
        turnId,
        sessionId,
        codexAppServerPid: this.codexAppServerPid ?? undefined,
        protocolMethod: "turn/completed",
      });
      const { reject } = this.activeTurn;
      this.cleanupActiveTurn();
      reject(error);
      return;
    }

    if (status === "interrupted") {
      const errorObj =
        typeof turn.error === "object" && turn.error !== null
          ? (turn.error as Record<string, unknown>)
          : null;
      const message =
        typeof errorObj?.message === "string" && errorObj.message.length > 0
          ? errorObj.message
          : "turn was interrupted";
      const error = new AgentError("turn_cancelled", message, {
        threadId: this.threadId,
        turnId,
        sessionId,
        codexAppServerPid: this.codexAppServerPid ?? undefined,
        protocolMethod: "turn/completed",
      });
      const { reject } = this.activeTurn;
      this.cleanupActiveTurn();
      reject(error);
      return;
    }

    const error = new AgentError(
      "protocol_error",
      `turn/completed reported invalid turn status: ${String(status)}`,
      {
        threadId: this.threadId,
        turnId,
        sessionId,
        codexAppServerPid: this.codexAppServerPid ?? undefined,
        protocolMethod: "turn/completed",
      },
    );
    const { reject } = this.activeTurn;
    this.cleanupActiveTurn();
    reject(error);
  }

  private cleanupActiveTurn(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.activeTurn = null;
  }
}

/**
 * 启动 Codex app-server 并完成初始化握手，建立 live session。
 *
 * 内部执行序列（按 pinned schema）：
 * 1. launchTransport() 启动子进程；
 * 2. initialize 请求：clientInfo + capabilities；
 * 3. initialized 通知；
 * 4. thread/start 请求：cwd + approvalPolicy / sandbox 映射；
 * 5. 校验 thread.id 并返回 AppServerSession 实例。
 *
 * 任何一步失败均先 stop transport 再抛出，不留孤儿子进程。
 */
export async function startAppServerSession(
  options: AppServerSessionOptions,
): Promise<AppServerSession> {
  let session: AppServerSessionImpl | null = null;

  const listener = {
    onNotification(notification: TransportNotification) {
      session?.handleNotification(notification);
      options.onNotification?.(notification);
    },
    onServerRequest(request: TransportServerRequest) {
      session?.handleServerRequest(request);
      options.onServerRequest?.(request);
    },
    onStderr(line: string) {
      options.onStderr?.(line);
    },
    onProtocolIssue(issue: TransportProtocolIssue) {
      options.onProtocolIssue?.(issue);
    },
    onExit(info: TransportExitInfo) {
      session?.handleExit(info);
    },
  };

  const transport = await launchTransport({
    command: options.command,
    workspacePath: options.workspacePath,
    workspacePathSafety: options.workspacePathSafety,
    ...(options.identifier !== undefined ? { identifier: options.identifier } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.excludeEnvNames !== undefined ? { excludeEnvNames: options.excludeEnvNames } : {}),
    ...(options.readTimeoutMs !== undefined ? { readTimeoutMs: options.readTimeoutMs } : {}),
    ...(options.shutdownTimeoutMs !== undefined
      ? { shutdownTimeoutMs: options.shutdownTimeoutMs }
      : {}),
    listener,
  });

  try {
    session = new AppServerSessionImpl(transport, options);

    // 1. initialize request
    const initResponse = await transport.sendRequest({
      method: "initialize",
      params: {
        clientInfo: {
          name: "symphony-ts",
          title: null,
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
        },
      },
    });

    if (
      typeof initResponse.result !== "object" ||
      initResponse.result === null ||
      typeof (initResponse.result as Record<string, unknown>).userAgent !== "string"
    ) {
      throw new AgentError(
        "protocol_error",
        "initialize response missing userAgent string",
        {
          protocolMethod: "initialize",
          codexAppServerPid: transport.pid ?? undefined,
        },
      );
    }

    // 2. initialized notification
    transport.sendNotification({ method: "initialized" });

    // 3. thread/start request
    const threadStartParams: Record<string, unknown> = {
      cwd: path.resolve(options.workspacePath),
    };
    if (options.approvalPolicy !== null && options.approvalPolicy !== undefined) {
      threadStartParams.approvalPolicy = options.approvalPolicy;
    }
    if (options.threadSandbox !== null && options.threadSandbox !== undefined) {
      threadStartParams.sandbox = options.threadSandbox;
    }

    const threadResponse = await transport.sendRequest({
      method: "thread/start",
      params: threadStartParams,
    });

    if (
      typeof threadResponse.result !== "object" ||
      threadResponse.result === null ||
      typeof (threadResponse.result as Record<string, unknown>).thread !== "object" ||
      (threadResponse.result as Record<string, unknown>).thread === null
    ) {
      throw new AgentError(
        "protocol_error",
        "thread/start response missing thread object",
        {
          protocolMethod: "thread/start",
          codexAppServerPid: transport.pid ?? undefined,
        },
      );
    }

    const thread = (threadResponse.result as Record<string, unknown>).thread as Record<
      string,
      unknown
    >;
    if (typeof thread.id !== "string" || thread.id.length === 0) {
      throw new AgentError(
        "protocol_error",
        "thread/start response missing valid thread.id string",
        {
          protocolMethod: "thread/start",
          codexAppServerPid: transport.pid ?? undefined,
        },
      );
    }

    session.initThread(thread.id);
    return session;
  } catch (error) {
    await transport.stop();
    throw error;
  }
}
