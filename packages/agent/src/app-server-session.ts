import * as path from "node:path";
import {
  composeSessionId,
  type CodexPassThroughValue,
  type CodexRateLimits,
} from "@symphony/domain";
import { AgentError } from "./errors";
import type { AgentEvent } from "./events";
import {
  launchTransport,
  type WorkspacePathSafetyGate,
} from "./process-launcher";
import type {
  Transport,
  TransportExitInfo,
  TransportListener,
  TransportNotification,
  TransportProtocolIssue,
  TransportResponse,
  TransportServerRequest,
} from "./transport";

/**
 * 默认 turn silence 超时（毫秒），与 SPEC §5.3.6 codex.turn_timeout_ms 默认 1 小时对齐。
 */
export const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;

/** 握手期外部取消的 typed 错误（复用 §10.6 `turn_cancelled`，见 M5.2 / #51）。 */
function handshakeCancellationError(workspacePath: string, cause?: unknown): AgentError {
  return new AgentError(
    "turn_cancelled",
    "App-server session startup was cancelled by the attempt AbortSignal",
    cause === undefined ? { path: workspacePath } : { path: workspacePath, cause },
  );
}

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
  /** 观测点：上层消费的结构化运行时事件（SPEC §10.4，M4.4）。 */
  readonly onEvent?: ((event: AgentEvent) => void) | undefined;
  /** 观测点：子进程 stderr 输出行。 */
  readonly onStderr?: ((line: string) => void) | undefined;
  /** 观测点：transport framing 或协议 issue。 */
  readonly onProtocolIssue?: ((issue: TransportProtocolIssue) => void) | undefined;
  /** 观测点：对端发来的未知 response ID 或非请求/非通知消息。 */
  readonly onOtherMessage?: ((message: unknown) => void) | undefined;
  /** 观测点：对端主动发起的 server request。 */
  readonly onServerRequest?: ((request: TransportServerRequest) => void) | undefined;
  /** 观测点：对端发出的 notification。 */
  readonly onNotification?: ((notification: TransportNotification) => void) | undefined;
  /**
   * attempt 级外部取消信号（M5.2 / #51）。握手阶段同样生效：abort 会终止已 launch
   * 的 transport，使进行中的 `sendRequest` 以取消错误收敛，且不遗留孤儿子进程。
   */
  readonly signal?: AbortSignal | undefined;
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

interface BufferedCompletion {
  readonly threadId: string;
  readonly turn: Record<string, unknown>;
}

interface ActiveTurnState {
  turnId: string | null;
  readonly bufferedCompleted: BufferedCompletion[];
  settled: boolean;
  readonly resolve: (outcome: TurnCompletedOutcome) => void;
  readonly reject: (error: AgentError) => void;
}

const MAX_BUFFERED_COMPLETIONS = 16;

class AppServerSessionImpl implements AppServerSession {
  private threadIdValue: string | null = null;
  private readonly transport: Transport;
  private readonly options: AppServerSessionOptions;
  private activeTurn: ActiveTurnState | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private sessionFatalError: AgentError | null = null;

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

  public get currentThreadId(): string | null {
    return this.threadIdValue;
  }

  public get activeTurnId(): string | null {
    return this.activeTurn?.turnId ?? null;
  }

  public emitEvent(event: AgentEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      /* listener 异常隔离，不影响 session 状态 */
    }
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

    if (this.sessionFatalError !== null) {
      throw new AgentError(
        "protocol_error",
        `Cannot start a new turn: session has previously encountered fatal error (${this.sessionFatalError.code})`,
        {
          cause: this.sessionFatalError,
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
      return Promise.reject(
        new AgentError(
          "protocol_error",
          "turn/start input must contain string 'text' property",
          {
            threadId: this.threadIdValue ?? undefined,
            codexAppServerPid: this.codexAppServerPid ?? undefined,
          },
        ),
      );
    }

    return new Promise<TurnCompletedOutcome>((resolve, reject) => {
      this.activeTurn = {
        turnId: null,
        bufferedCompleted: [],
        settled: false,
        resolve,
        reject,
      };

      this.resetActiveTurnSilenceTimer();

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

      this.transport
        .sendRequest({
          method: "turn/start",
          params: turnStartParams,
        })
        .then((response) => {
          this.handleTurnStartResponse(response);
        })
        .catch((error) => {
          this.handleTurnStartError(error);
        });
    });
  }

  private handleTurnStartResponse(response: TransportResponse): void {
    if (this.activeTurn === null || this.activeTurn.settled) {
      return;
    }

    if (
      typeof response.result !== "object" ||
      response.result === null ||
      typeof (response.result as Record<string, unknown>).turn !== "object" ||
      (response.result as Record<string, unknown>).turn === null
    ) {
      this.emitEvent({
        event: "malformed",
        timestamp: Date.now(),
        codexAppServerPid: this.codexAppServerPid,
        threadId: this.threadIdValue ?? undefined,
        protocolMethod: "turn/start",
        summary: "turn/start response invalid: missing turn object",
      });
      const error = new AgentError(
        "protocol_error",
        "turn/start response invalid: missing turn object",
        {
          threadId: this.threadId,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
          protocolMethod: "turn/start",
        },
      );
      this.failTurnWithFatalError(error, "Turn ended with error: invalid turn/start response");
      return;
    }

    const turn = (response.result as Record<string, unknown>).turn as Record<string, unknown>;
    if (typeof turn.id !== "string" || turn.id.length === 0 || turn.status !== "inProgress") {
      this.emitEvent({
        event: "malformed",
        timestamp: Date.now(),
        codexAppServerPid: this.codexAppServerPid,
        threadId: this.threadIdValue ?? undefined,
        protocolMethod: "turn/start",
        summary:
          "turn/start response invalid: turn.id must be non-empty string and turn.status must be 'inProgress'",
      });
      const error = new AgentError(
        "protocol_error",
        "turn/start response invalid: turn.id must be non-empty string and turn.status must be 'inProgress'",
        {
          threadId: this.threadId,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
          protocolMethod: "turn/start",
        },
      );
      this.failTurnWithFatalError(error, "Turn ended with error: invalid turn/start response");
      return;
    }

    this.activeTurn.turnId = turn.id;

    // 每次成功取得 turn 身份后发一次 session_started
    this.emitEvent({
      event: "session_started",
      timestamp: Date.now(),
      codexAppServerPid: this.codexAppServerPid,
      threadId: this.threadIdValue!,
      turnId: turn.id,
      sessionId: composeSessionId(this.threadIdValue!, turn.id),
      summary: "Turn session started",
    });

    // 检查 starting 期间暂存的 matching completion
    const bufferedIdx = this.activeTurn.bufferedCompleted.findIndex(
      (item) => item.turn.id === turn.id && item.threadId === this.threadIdValue,
    );
    if (bufferedIdx !== -1) {
      const matching = this.activeTurn.bufferedCompleted[bufferedIdx]!;
      this.activeTurn.bufferedCompleted.splice(bufferedIdx, 1);
      this.settleTurnCompleted(matching.turn);
    }
  }

  private handleTurnStartError(error: unknown): void {
    if (this.activeTurn === null || this.activeTurn.settled) {
      return;
    }
    const agentError =
      error instanceof AgentError
        ? error
        : new AgentError(
            "protocol_error",
            error instanceof Error ? error.message : String(error),
            {
              cause: error,
              threadId: this.threadIdValue ?? undefined,
              codexAppServerPid: this.codexAppServerPid ?? undefined,
              protocolMethod: "turn/start",
            },
          );
    this.failTurnWithFatalError(agentError, "Turn ended with error: turn/start failed");
  }

  public handleActivity(): void {
    if (this.activeTurn !== null && !this.activeTurn.settled) {
      this.resetActiveTurnSilenceTimer();
    }
  }

  public handleNotification(notification: TransportNotification): void {
    const { method, params } = notification;
    const paramsObj =
      typeof params === "object" && params !== null ? (params as Record<string, unknown>) : null;

    if (method === "turn/completed") {
      this.handleTurnCompletedNotification(notification);
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      this.handleTokenUsageNotification(notification);
      return;
    }

    if (method === "account/rateLimits/updated") {
      this.handleRateLimitsNotification(notification);
      return;
    }

    this.emitEvent({
      event: "notification",
      timestamp: Date.now(),
      codexAppServerPid: this.codexAppServerPid,
      threadId:
        typeof paramsObj?.threadId === "string" ? paramsObj.threadId : (this.threadIdValue ?? undefined),
      turnId:
        typeof paramsObj?.turnId === "string"
          ? paramsObj.turnId
          : (this.activeTurn?.turnId ?? undefined),
      sessionId:
        typeof paramsObj?.threadId === "string" && typeof paramsObj?.turnId === "string"
          ? composeSessionId(paramsObj.threadId, paramsObj.turnId)
          : undefined,
      protocolMethod: method,
      summary: `App-server notification: ${method}`,
    });
  }

  public handleServerRequest(request: TransportServerRequest): void {
    const { id, method, params } = request;
    const isNever = this.options.approvalPolicy === "never";
    const paramsObj =
      typeof params === "object" && params !== null ? (params as Record<string, unknown>) : null;

    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval": {
        if (
          paramsObj === null ||
          typeof paramsObj.threadId !== "string" ||
          typeof paramsObj.turnId !== "string" ||
          typeof paramsObj.itemId !== "string"
        ) {
          this.transport.respondToServerRequest({
            id,
            error: { code: -32602, message: "Invalid approval params" },
          });
          this.emitEvent({
            event: "malformed",
            timestamp: Date.now(),
            codexAppServerPid: this.codexAppServerPid,
            threadId:
              typeof paramsObj?.threadId === "string"
                ? paramsObj.threadId
                : (this.threadIdValue ?? undefined),
            turnId:
              typeof paramsObj?.turnId === "string"
                ? paramsObj.turnId
                : (this.activeTurn?.turnId ?? undefined),
            protocolMethod: method,
            summary: "Malformed approval request params",
          });
          const error = new AgentError("protocol_error", `Malformed params for ${method}`, {
            threadId:
              typeof paramsObj?.threadId === "string"
                ? paramsObj.threadId
                : (this.threadIdValue ?? undefined),
            turnId:
              typeof paramsObj?.turnId === "string"
                ? paramsObj.turnId
                : (this.activeTurn?.turnId ?? undefined),
            codexAppServerPid: this.codexAppServerPid ?? undefined,
            protocolMethod: method,
          });
          this.failTurnWithFatalError(error, "Turn ended with error: protocol error");
          return;
        }

        const reqThreadId = paramsObj.threadId;
        const reqTurnId = paramsObj.turnId;

        if (isNever) {
          this.transport.respondToServerRequest({
            id,
            result: { decision: "accept" },
          });
          this.emitEvent({
            event: "approval_auto_approved",
            timestamp: Date.now(),
            codexAppServerPid: this.codexAppServerPid,
            threadId: reqThreadId,
            turnId: reqTurnId,
            sessionId: composeSessionId(reqThreadId, reqTurnId),
            protocolMethod: method,
            summary:
              method === "item/commandExecution/requestApproval"
                ? "Command execution auto-approved under never policy"
                : "File change auto-approved under never policy",
          });
          return;
        }

        this.transport.respondToServerRequest({
          id,
          result: { decision: "decline" },
        });
        const error = new AgentError(
          "approval_required",
          `Approval required for ${method} in headless mode`,
          {
            threadId: reqThreadId,
            turnId: reqTurnId,
            sessionId: composeSessionId(reqThreadId, reqTurnId),
            codexAppServerPid: this.codexAppServerPid ?? undefined,
            protocolMethod: method,
          },
        );
        this.failTurnWithFatalError(error, "Execution terminated: approval required");
        return;
      }

      case "execCommandApproval":
      case "applyPatchApproval": {
        const isLegacyCmd = method === "execCommandApproval";
        const isValidLegacyParams =
          paramsObj !== null &&
          typeof paramsObj.conversationId === "string" &&
          paramsObj.conversationId.length > 0 &&
          typeof paramsObj.callId === "string" &&
          paramsObj.callId.length > 0 &&
          (isLegacyCmd
            ? Array.isArray(paramsObj.command) &&
              paramsObj.command.every((item) => typeof item === "string") &&
              typeof paramsObj.cwd === "string"
            : typeof paramsObj.fileChanges === "object" &&
              paramsObj.fileChanges !== null &&
              !Array.isArray(paramsObj.fileChanges));

        if (!isValidLegacyParams) {
          this.transport.respondToServerRequest({
            id,
            error: { code: -32602, message: "Invalid legacy approval params" },
          });
          this.emitEvent({
            event: "malformed",
            timestamp: Date.now(),
            codexAppServerPid: this.codexAppServerPid,
            threadId:
              typeof paramsObj?.conversationId === "string"
                ? paramsObj.conversationId
                : (this.threadIdValue ?? undefined),
            turnId: this.activeTurn?.turnId ?? undefined,
            protocolMethod: method,
            summary: "Malformed legacy approval request params",
          });
          const error = new AgentError("protocol_error", `Malformed params for ${method}`, {
            threadId:
              typeof paramsObj?.conversationId === "string"
                ? paramsObj.conversationId
                : (this.threadIdValue ?? undefined),
            turnId: this.activeTurn?.turnId ?? undefined,
            codexAppServerPid: this.codexAppServerPid ?? undefined,
            protocolMethod: method,
          });
          this.failTurnWithFatalError(error, "Turn ended with error: protocol error");
          return;
        }

        const legacyThreadId = paramsObj.conversationId as string;
        const legacyTurnId = this.activeTurn?.turnId ?? undefined;

        if (isNever) {
          this.transport.respondToServerRequest({
            id,
            result: { decision: "approved" },
          });
          this.emitEvent({
            event: "approval_auto_approved",
            timestamp: Date.now(),
            codexAppServerPid: this.codexAppServerPid,
            threadId: legacyThreadId,
            turnId: legacyTurnId,
            sessionId: legacyTurnId ? composeSessionId(legacyThreadId, legacyTurnId) : undefined,
            protocolMethod: method,
            summary:
              method === "execCommandApproval"
                ? "Legacy command execution auto-approved under never policy"
                : "Legacy file change auto-approved under never policy",
          });
          return;
        }

        this.transport.respondToServerRequest({
          id,
          result: { decision: "abort" },
        });
        const error = new AgentError(
          "approval_required",
          `Approval required for ${method} in headless mode`,
          {
            threadId: legacyThreadId,
            turnId: legacyTurnId,
            sessionId: legacyTurnId ? composeSessionId(legacyThreadId, legacyTurnId) : undefined,
            codexAppServerPid: this.codexAppServerPid ?? undefined,
            protocolMethod: method,
          },
        );
        this.failTurnWithFatalError(error, "Execution terminated: approval required");
        return;
      }

      case "item/tool/requestUserInput": {
        this.transport.respondToServerRequest({
          id,
          error: { code: -32000, message: "Headless execution does not support user input" },
        });
        const reqThreadId =
          typeof paramsObj?.threadId === "string"
            ? paramsObj.threadId
            : (this.threadIdValue ?? undefined);
        const reqTurnId =
          typeof paramsObj?.turnId === "string"
            ? paramsObj.turnId
            : (this.activeTurn?.turnId ?? undefined);
        const error = new AgentError(
          "turn_input_required",
          "User input requested but not supported in headless mode",
          {
            threadId: reqThreadId,
            turnId: reqTurnId,
            sessionId:
              reqThreadId && reqTurnId ? composeSessionId(reqThreadId, reqTurnId) : undefined,
            codexAppServerPid: this.codexAppServerPid ?? undefined,
            protocolMethod: method,
          },
        );
        this.failTurnWithUserInputRequired(error);
        return;
      }

      case "mcpServer/elicitation/request": {
        this.transport.respondToServerRequest({
          id,
          result: { action: "cancel", content: null, _meta: null },
        });
        const reqThreadId =
          typeof paramsObj?.threadId === "string"
            ? paramsObj.threadId
            : (this.threadIdValue ?? undefined);
        const reqTurnId =
          typeof paramsObj?.turnId === "string"
            ? paramsObj.turnId
            : (this.activeTurn?.turnId ?? undefined);
        const error = new AgentError(
          "turn_input_required",
          "MCP elicitation requested but not supported in headless mode",
          {
            threadId: reqThreadId,
            turnId: reqTurnId,
            sessionId:
              reqThreadId && reqTurnId ? composeSessionId(reqThreadId, reqTurnId) : undefined,
            codexAppServerPid: this.codexAppServerPid ?? undefined,
            protocolMethod: method,
          },
        );
        this.failTurnWithUserInputRequired(error);
        return;
      }

      case "item/permissions/requestApproval": {
        const isValidPermissionsParams =
          paramsObj !== null &&
          typeof paramsObj.threadId === "string" &&
          paramsObj.threadId.length > 0 &&
          typeof paramsObj.turnId === "string" &&
          paramsObj.turnId.length > 0 &&
          typeof paramsObj.itemId === "string" &&
          paramsObj.itemId.length > 0 &&
          typeof paramsObj.permissions === "object" &&
          paramsObj.permissions !== null &&
          !Array.isArray(paramsObj.permissions);

        if (!isValidPermissionsParams) {
          this.transport.respondToServerRequest({
            id,
            error: { code: -32602, message: "Invalid permissions approval params" },
          });
          this.emitEvent({
            event: "malformed",
            timestamp: Date.now(),
            codexAppServerPid: this.codexAppServerPid,
            threadId:
              typeof paramsObj?.threadId === "string"
                ? paramsObj.threadId
                : (this.threadIdValue ?? undefined),
            turnId:
              typeof paramsObj?.turnId === "string"
                ? paramsObj.turnId
                : (this.activeTurn?.turnId ?? undefined),
            protocolMethod: method,
            summary: "Malformed permissions approval request params",
          });
          const error = new AgentError("protocol_error", `Malformed params for ${method}`, {
            threadId:
              typeof paramsObj?.threadId === "string"
                ? paramsObj.threadId
                : (this.threadIdValue ?? undefined),
            turnId:
              typeof paramsObj?.turnId === "string"
                ? paramsObj.turnId
                : (this.activeTurn?.turnId ?? undefined),
            codexAppServerPid: this.codexAppServerPid ?? undefined,
            protocolMethod: method,
          });
          this.failTurnWithFatalError(error, "Turn ended with error: protocol error");
          return;
        }

        this.transport.respondToServerRequest({
          id,
          error: { code: -32000, message: "Permission requests are not supported in headless mode" },
        });
        const reqThreadId = paramsObj.threadId as string;
        const reqTurnId = paramsObj.turnId as string;
        const error = new AgentError(
          "approval_required",
          "Permissions approval requested but not supported in headless mode",
          {
            threadId: reqThreadId,
            turnId: reqTurnId,
            sessionId: composeSessionId(reqThreadId, reqTurnId),
            codexAppServerPid: this.codexAppServerPid ?? undefined,
            protocolMethod: method,
          },
        );
        this.failTurnWithFatalError(error, "Execution terminated: approval required");
        return;
      }

      case "item/tool/call": {
        this.transport.respondToServerRequest({
          id,
          result: {
            success: false,
            contentItems: [{ type: "inputText", text: "Unsupported tool" }],
          },
        });
        const reqThreadId =
          typeof paramsObj?.threadId === "string"
            ? paramsObj.threadId
            : (this.threadIdValue ?? undefined);
        const reqTurnId =
          typeof paramsObj?.turnId === "string"
            ? paramsObj.turnId
            : (this.activeTurn?.turnId ?? undefined);
        this.emitEvent({
          event: "unsupported_tool_call",
          timestamp: Date.now(),
          codexAppServerPid: this.codexAppServerPid,
          threadId: reqThreadId,
          turnId: reqTurnId,
          sessionId:
            reqThreadId && reqTurnId ? composeSessionId(reqThreadId, reqTurnId) : undefined,
          protocolMethod: method,
          summary: "Unsupported dynamic tool call rejected",
        });
        return;
      }

      case "account/chatgptAuthTokens/refresh":
      case "attestation/generate": {
        this.transport.respondToServerRequest({
          id,
          error: { code: -32000, message: `Unsupported server request: ${method}` },
        });
        this.emitEvent({
          event: "other_message",
          timestamp: Date.now(),
          codexAppServerPid: this.codexAppServerPid,
          threadId: this.threadIdValue ?? undefined,
          turnId: this.activeTurn?.turnId ?? undefined,
          protocolMethod: method,
          summary: `Unsupported server request method: ${method}`,
        });
        const error = new AgentError("protocol_error", `Unsupported server request: ${method}`, {
          threadId: this.threadIdValue ?? undefined,
          turnId: this.activeTurn?.turnId ?? undefined,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
          protocolMethod: method,
        });
        this.failTurnWithFatalError(error, `Turn ended with error: ${method} not supported`);
        return;
      }

      default: {
        this.transport.respondToServerRequest({
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
        this.emitEvent({
          event: "other_message",
          timestamp: Date.now(),
          codexAppServerPid: this.codexAppServerPid,
          threadId: this.threadIdValue ?? undefined,
          turnId: this.activeTurn?.turnId ?? undefined,
          protocolMethod: method,
          summary: `Unknown server request method: ${method}`,
        });
        const error = new AgentError("protocol_error", `Unknown server request method: ${method}`, {
          threadId: this.threadIdValue ?? undefined,
          turnId: this.activeTurn?.turnId ?? undefined,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
          protocolMethod: method,
        });
        this.failTurnWithFatalError(error, "Turn ended with error: unknown server request method");
        return;
      }
    }
  }

  public handleExit(info: TransportExitInfo): void {
    if (this.activeTurn !== null && !this.activeTurn.settled) {
      const threadId = this.threadIdValue ?? undefined;
      const turnId = this.activeTurn.turnId ?? undefined;
      const sessionId =
        threadId && turnId ? composeSessionId(threadId, turnId) : undefined;
      const error = new AgentError(
        "port_exit",
        info.stopped
          ? "Codex app-server process was stopped while turn was in progress"
          : `Codex app-server process exited unexpectedly while turn was in progress (code ${String(info.exitCode)}, signal ${String(info.signal)})`,
        {
          threadId,
          turnId,
          sessionId,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
        },
      );
      this.failTurnWithFatalError(error, "Turn ended with error: process exited");
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.activeTurn !== null && !this.activeTurn.settled) {
      const threadId = this.threadIdValue ?? undefined;
      const turnId = this.activeTurn.turnId ?? undefined;
      const sessionId =
        threadId && turnId ? composeSessionId(threadId, turnId) : undefined;
      const error = new AgentError(
        "port_exit",
        "Codex app-server session was stopped while turn was in progress",
        {
          threadId,
          turnId,
          sessionId,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
        },
      );
      this.failTurnWithFatalError(error, "Turn ended with error: session stopped");
    }
    await this.transport.stop();
  }

  private resetActiveTurnSilenceTimer(): void {
    if (this.activeTurn === null || this.activeTurn.settled) {
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
      if (this.activeTurn === null || this.activeTurn.settled) {
        return;
      }
      const threadId = this.threadIdValue ?? undefined;
      const turnId = this.activeTurn.turnId ?? undefined;
      const sessionId =
        threadId && turnId ? composeSessionId(threadId, turnId) : undefined;
      const error = new AgentError(
        "turn_timeout",
        `turn stream silent for ${timeoutMs} ms`,
        {
          threadId,
          turnId,
          sessionId,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
        },
      );
      this.failTurnWithFatalError(error, `Turn ended with error: silence timeout`);
    }, timeoutMs);
  }

  private handleTokenUsageNotification(notification: TransportNotification): void {
    const params =
      typeof notification.params === "object" && notification.params !== null
        ? (notification.params as Record<string, unknown>)
        : null;
    const tokenUsage = params?.tokenUsage as Record<string, unknown> | undefined;
    const total = tokenUsage?.total as Record<string, unknown> | undefined;

    const inputTokens = total?.inputTokens;
    const outputTokens = total?.outputTokens;
    const totalTokens = total?.totalTokens;

    const valid =
      typeof inputTokens === "number" &&
      Number.isSafeInteger(inputTokens) &&
      inputTokens >= 0 &&
      typeof outputTokens === "number" &&
      Number.isSafeInteger(outputTokens) &&
      outputTokens >= 0 &&
      typeof totalTokens === "number" &&
      Number.isSafeInteger(totalTokens) &&
      totalTokens >= 0;

    const reqThreadId =
      typeof params?.threadId === "string" ? params.threadId : (this.threadIdValue ?? undefined);
    const reqTurnId =
      typeof params?.turnId === "string" ? params.turnId : (this.activeTurn?.turnId ?? undefined);

    if (!valid) {
      this.emitEvent({
        event: "malformed",
        timestamp: Date.now(),
        codexAppServerPid: this.codexAppServerPid,
        threadId: reqThreadId,
        turnId: reqTurnId,
        sessionId:
          reqThreadId && reqTurnId ? composeSessionId(reqThreadId, reqTurnId) : undefined,
        protocolMethod: "thread/tokenUsage/updated",
        summary: "Invalid token usage payload received",
      });
      return;
    }

    this.emitEvent({
      event: "notification",
      timestamp: Date.now(),
      codexAppServerPid: this.codexAppServerPid,
      threadId: reqThreadId,
      turnId: reqTurnId,
      sessionId:
        reqThreadId && reqTurnId ? composeSessionId(reqThreadId, reqTurnId) : undefined,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens,
      },
      protocolMethod: "thread/tokenUsage/updated",
      summary: "Thread token usage updated",
    });
  }

  private handleRateLimitsNotification(notification: TransportNotification): void {
    const params =
      typeof notification.params === "object" && notification.params !== null
        ? (notification.params as Record<string, unknown>)
        : null;
    const rateLimits = params?.rateLimits;

    if (typeof rateLimits !== "object" || rateLimits === null) {
      this.emitEvent({
        event: "malformed",
        timestamp: Date.now(),
        codexAppServerPid: this.codexAppServerPid,
        protocolMethod: "account/rateLimits/updated",
        summary: "Invalid rate limits payload received",
      });
      return;
    }

    // Account 级限流快照：不强加 turn 身份
    this.emitEvent({
      event: "notification",
      timestamp: Date.now(),
      codexAppServerPid: this.codexAppServerPid,
      rateLimits: rateLimits as CodexRateLimits,
      protocolMethod: "account/rateLimits/updated",
      summary: "Account rate limits updated",
    });
  }

  private handleTurnCompletedNotification(notification: TransportNotification): void {
    const params =
      typeof notification.params === "object" && notification.params !== null
        ? (notification.params as Record<string, unknown>)
        : null;

    if (params === null) {
      this.emitEvent({
        event: "malformed",
        timestamp: Date.now(),
        codexAppServerPid: this.codexAppServerPid,
        threadId: this.threadIdValue ?? undefined,
        turnId: this.activeTurn?.turnId ?? undefined,
        protocolMethod: "turn/completed",
        summary: "turn/completed payload missing params object",
      });
      const error = new AgentError("protocol_error", "turn/completed payload missing params object", {
        threadId: this.threadIdValue ?? undefined,
        turnId: this.activeTurn?.turnId ?? undefined,
        codexAppServerPid: this.codexAppServerPid ?? undefined,
        protocolMethod: "turn/completed",
      });
      this.failTurnWithFatalError(error, "Turn ended with error: protocol error");
      return;
    }

    const turnObj = params.turn;
    if (typeof turnObj !== "object" || turnObj === null) {
      this.emitEvent({
        event: "malformed",
        timestamp: Date.now(),
        codexAppServerPid: this.codexAppServerPid,
        threadId: this.threadIdValue ?? undefined,
        turnId: this.activeTurn?.turnId ?? undefined,
        protocolMethod: "turn/completed",
        summary: "turn/completed payload missing turn object",
      });
      const error = new AgentError("protocol_error", "turn/completed payload missing turn object", {
        threadId: this.threadIdValue ?? undefined,
        turnId: this.activeTurn?.turnId ?? undefined,
        codexAppServerPid: this.codexAppServerPid ?? undefined,
        protocolMethod: "turn/completed",
      });
      this.failTurnWithFatalError(error, "Turn ended with error: protocol error");
      return;
    }

    const turn = turnObj as Record<string, unknown>;
    if (typeof turn.id !== "string" || turn.id.length === 0) {
      this.emitEvent({
        event: "malformed",
        timestamp: Date.now(),
        codexAppServerPid: this.codexAppServerPid,
        threadId: this.threadIdValue ?? undefined,
        turnId: this.activeTurn?.turnId ?? undefined,
        protocolMethod: "turn/completed",
        summary: "turn/completed payload missing valid turn.id string",
      });
      const error = new AgentError(
        "protocol_error",
        "turn/completed payload missing valid turn.id string",
        {
          threadId: this.threadIdValue ?? undefined,
          turnId: this.activeTurn?.turnId ?? undefined,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
          protocolMethod: "turn/completed",
        },
      );
      this.failTurnWithFatalError(error, "Turn ended with error: protocol error");
      return;
    }

    if (typeof params.threadId !== "string" || params.threadId.length === 0) {
      this.emitEvent({
        event: "malformed",
        timestamp: Date.now(),
        codexAppServerPid: this.codexAppServerPid,
        threadId: this.threadIdValue ?? undefined,
        turnId: turn.id,
        protocolMethod: "turn/completed",
        summary: "turn/completed payload missing valid threadId string",
      });
      const error = new AgentError(
        "protocol_error",
        "turn/completed payload missing valid threadId string",
        {
          threadId: this.threadIdValue ?? undefined,
          turnId: this.activeTurn?.turnId ?? undefined,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
          protocolMethod: "turn/completed",
        },
      );
      this.failTurnWithFatalError(error, "Turn ended with error: protocol error");
      return;
    }

    const incomingThreadId = params.threadId;

    if (incomingThreadId !== this.threadIdValue) {
      this.emitEvent({
        event: "other_message",
        timestamp: Date.now(),
        codexAppServerPid: this.codexAppServerPid,
        threadId: incomingThreadId,
        turnId: turn.id,
        protocolMethod: "turn/completed",
        summary: "Received turn/completed for different thread",
      });
      return;
    }

    if (this.activeTurn === null) {
      this.emitEvent({
        event: "other_message",
        timestamp: Date.now(),
        codexAppServerPid: this.codexAppServerPid,
        threadId: this.threadIdValue ?? undefined,
        turnId: turn.id,
        protocolMethod: "turn/completed",
        summary: "Received unexpected turn/completed with no active turn",
      });
      return;
    }

    if (this.activeTurn.turnId === null) {
      if (this.activeTurn.bufferedCompleted.length >= MAX_BUFFERED_COMPLETIONS) {
        const error = new AgentError("protocol_error", "Buffered turn completions exceeded limit", {
          threadId: this.threadIdValue ?? undefined,
          codexAppServerPid: this.codexAppServerPid ?? undefined,
          protocolMethod: "turn/completed",
        });
        this.failTurnWithFatalError(
          error,
          "Turn ended with error: buffered completions exceeded limit",
        );
        return;
      }
      this.activeTurn.bufferedCompleted.push({
        threadId: incomingThreadId,
        turn,
      });
      return;
    }

    if (turn.id !== this.activeTurn.turnId) {
      this.emitEvent({
        event: "other_message",
        timestamp: Date.now(),
        codexAppServerPid: this.codexAppServerPid,
        threadId: this.threadIdValue ?? undefined,
        turnId: turn.id,
        protocolMethod: "turn/completed",
        summary: "Received turn/completed for different turn ID",
      });
      return;
    }

    this.settleTurnCompleted(turn);
  }

  private settleTurnCompleted(turn: Record<string, unknown>): void {
    if (this.activeTurn === null || this.activeTurn.settled) {
      return;
    }

    const turnId = this.activeTurn.turnId!;
    const sessionId = composeSessionId(this.threadId, turnId);
    const status = turn.status;
    const { resolve, reject } = this.activeTurn;

    if (status === "completed") {
      const outcome: TurnCompletedOutcome = {
        turnId,
        sessionId,
      };
      this.settleActiveTurn(() => {
        this.emitEvent({
          event: "turn_completed",
          timestamp: Date.now(),
          codexAppServerPid: this.codexAppServerPid,
          threadId: this.threadId,
          turnId,
          sessionId,
          protocolMethod: "turn/completed",
          summary: "Turn completed successfully",
        });
        resolve(outcome);
      });
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
      this.settleActiveTurn(() => {
        this.emitEvent({
          event: "turn_failed",
          timestamp: Date.now(),
          codexAppServerPid: this.codexAppServerPid,
          threadId: this.threadId,
          turnId,
          sessionId,
          protocolMethod: "turn/completed",
          summary: "Turn failed",
        });
        reject(error);
      });
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
      this.settleActiveTurn(() => {
        this.emitEvent({
          event: "turn_cancelled",
          timestamp: Date.now(),
          codexAppServerPid: this.codexAppServerPid,
          threadId: this.threadId,
          turnId,
          sessionId,
          protocolMethod: "turn/completed",
          summary: "Turn was cancelled",
        });
        reject(error);
      });
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
    this.failTurnWithFatalError(error, "Turn ended with invalid status");
  }

  private settleActiveTurn(action: () => void): void {
    if (this.activeTurn === null || this.activeTurn.settled) {
      return;
    }
    this.activeTurn.settled = true;
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.activeTurn = null;
    try {
      action();
    } catch {
      /* isolate */
    }
  }

  private failTurnWithFatalError(error: AgentError, summary: string): void {
    this.sessionFatalError = error;
    if (this.activeTurn !== null && !this.activeTurn.settled) {
      const { reject } = this.activeTurn;
      const threadId = error.threadId ?? this.threadIdValue ?? undefined;
      const turnId = error.turnId ?? this.activeTurn.turnId ?? undefined;
      const sessionId =
        threadId && turnId ? composeSessionId(threadId, turnId) : undefined;
      this.settleActiveTurn(() => {
        this.emitEvent({
          event: "turn_ended_with_error",
          timestamp: Date.now(),
          codexAppServerPid: this.codexAppServerPid,
          threadId,
          turnId,
          sessionId,
          protocolMethod: error.protocolMethod,
          summary,
        });
        reject(error);
      });
    }
  }

  private failTurnWithUserInputRequired(error: AgentError): void {
    this.sessionFatalError = error;
    if (this.activeTurn !== null && !this.activeTurn.settled) {
      const { reject } = this.activeTurn;
      const threadId = error.threadId ?? this.threadIdValue ?? undefined;
      const turnId = error.turnId ?? this.activeTurn.turnId ?? undefined;
      const sessionId =
        threadId && turnId ? composeSessionId(threadId, turnId) : undefined;
      this.settleActiveTurn(() => {
        this.emitEvent({
          event: "turn_input_required",
          timestamp: Date.now(),
          codexAppServerPid: this.codexAppServerPid,
          threadId,
          turnId,
          sessionId,
          protocolMethod: error.protocolMethod,
          summary: "User input requested but not supported in headless mode",
        });
        reject(error);
      });
    }
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
  let transport: Transport | null = null;
  const exitInfoHolder: { current: TransportExitInfo | null } = { current: null };

  const signal = options.signal;
  const abortListener = (): void => {
    // 握手期取消：终止已 launch 的 transport，使在途 sendRequest 以 port_exit / 取消收敛。
    if (transport !== null) {
      void transport.stop().catch(() => {
        /* stop 幂等；异常不改变取消语义 */
      });
    }
  };
  if (signal !== undefined) {
    if (signal.aborted) {
      throw handshakeCancellationError(options.workspacePath);
    }
    signal.addEventListener("abort", abortListener, { once: true });
  }

  const listener: TransportListener = {
    onNotification(notification: TransportNotification) {
      session?.handleNotification(notification);
      try {
        options.onNotification?.(notification);
      } catch {
        /* 隔离 */
      }
    },
    onServerRequest(request: TransportServerRequest) {
      session?.handleServerRequest(request);
      try {
        options.onServerRequest?.(request);
      } catch {
        /* 隔离 */
      }
    },
    onStderr(line: string) {
      try {
        options.onStderr?.(line);
      } catch {
        /* 隔离 */
      }
    },
    onProtocolIssue(issue: TransportProtocolIssue) {
      session?.emitEvent({
        event: "malformed",
        timestamp: Date.now(),
        codexAppServerPid: session.codexAppServerPid,
        threadId: session.currentThreadId ?? undefined,
        turnId: session.activeTurnId ?? undefined,
        sessionId:
          session.currentThreadId && session.activeTurnId
            ? composeSessionId(session.currentThreadId, session.activeTurnId)
            : undefined,
        summary:
          issue.reason === "oversized_line"
            ? "Oversized protocol line discarded"
            : "Malformed protocol line discarded",
      });
      try {
        options.onProtocolIssue?.(issue);
      } catch {
        /* 隔离 */
      }
    },
    onOtherMessage(message: unknown) {
      session?.emitEvent({
        event: "other_message",
        timestamp: Date.now(),
        codexAppServerPid: session.codexAppServerPid,
        threadId: session.currentThreadId ?? undefined,
        turnId: session.activeTurnId ?? undefined,
        sessionId:
          session.currentThreadId && session.activeTurnId
            ? composeSessionId(session.currentThreadId, session.activeTurnId)
            : undefined,
        summary: "Other protocol message observed",
      });
      try {
        options.onOtherMessage?.(message);
      } catch {
        /* 隔离 */
      }
    },
    onActivity() {
      session?.handleActivity();
    },
    onExit(info: TransportExitInfo) {
      exitInfoHolder.current = info;
      session?.handleExit(info);
    },
  };

  try {
    transport = await launchTransport({
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
      ...(signal !== undefined ? { signal } : {}),
      listener,
    });

    if (signal?.aborted) {
      await transport.stop();
      throw handshakeCancellationError(options.workspacePath);
    }

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

    // 成功启动 session 并获得 thread.id 后，发射 session_started（此时无 turnId，不伪造）
    session.emitEvent({
      event: "session_started",
      timestamp: Date.now(),
      codexAppServerPid: transport.pid,
      threadId: thread.id,
      summary: "Thread session started",
    });

    return session;
  } catch (error) {
    try {
      options.onEvent?.({
        event: "startup_failed",
        timestamp: Date.now(),
        codexAppServerPid: transport?.pid ?? null,
        summary: "App-server session startup failed",
      });
    } catch {
      /* 隔离 */
    }
    if (transport !== null) {
      await transport.stop();
    }
    // 取消优先于 launch / 协议错误：orchestrator 按自己记录的 stop reason 分类，
    // 但把结果标成取消可以避免把主动停止误判成普通失败。
    if (signal?.aborted) {
      throw handshakeCancellationError(options.workspacePath, error);
    }
    if (exitInfoHolder.current !== null && !exitInfoHolder.current.stopped && exitInfoHolder.current.exitCode === 127) {
      throw new AgentError(
        "codex_not_found",
        `Coding agent command not found (subprocess exited with code 127 before completing handshake): ${options.command}`,
        {
          cause: error,
          path: options.workspacePath,
          codexAppServerPid: transport?.pid ?? undefined,
        },
      );
    }
    throw error;
  } finally {
    if (signal !== undefined) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}
