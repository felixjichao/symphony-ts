/**
 * @symphony/agent 稳定错误契约（SPEC **§10.6 Timeouts and Error Mapping**，M4.1 / #37）。
 *
 * 与 `@symphony/config` / `@symphony/tracker` / `@symphony/workspace` 同一模式：
 * - {@link AgentError.code} 是跨包 / 对 orchestrator 稳定的**机器判别契约**；
 * - `message` 是 human-readable 诊断，不构成判别面；
 * - 底层异常（`child_process` spawn 失败、JSON parse、`WorkspaceError`、第三方
 *   transport 错误）经 `cause` 保留，**不得**成为公共错误契约的一部分（§10.6 的
 *   "RECOMMENDED normalized categories" 就是这一层唯一的对外词汇）。
 *
 * 命名纪律：SPEC §10.6 列出的九个 category 名字**逐字采用**，不造第二套词汇；
 * `approval_required` / `protocol_error` / `launch_failed` 是 §10.6 之外、
 * implementation-defined 的 headless policy 与 protocol 完整性所需类别（SPEC §10.5
 * 允许 "fail the run according to its documented policy"），policy 本身在包 README
 * 与 `docs/upstream.md` 的 Codex 协议基线一节记录。
 *
 * 这里没有 raw Codex JSON：错误对象只携带 Symphony 自己的标识符（thread / turn /
 * session id、PID、诊断用的 method 名），M5 不需要理解 Codex payload 就能分支处理。
 */

/**
 * agent 包对外错误码。前九个与 SPEC §10.6 的推荐 category 一字不差。
 *
 * - `codex_not_found`：`codex.command` 指向的可执行 / shell 环境里找不到 coding agent。
 * - `invalid_workspace_cwd`：launch 边界上的 workspace path 不满足 §9.5 containment
 *   （M4 复用 `assertWorkspacePathSafe`，原始 `WorkspaceError` 进 `cause`）。
 * - `response_timeout`：`codex.read_timeout_ms` 内没等到 request 的 response。
 * - `turn_timeout`：`codex.turn_timeout_ms` 的 turn 流静默窗口超时（每条 app-server
 *   输出都会重置它，因此它是 silence timeout，不是 turn 总时长上限，§10.6）。
 * - `port_exit`：session 仍需要子进程时它退出了（SPEC 原文 category 名；
 *   stdio transport 下同样用它表示 process exit）。
 * - `response_error`：app-server 对 request 返回 JSON-RPC error response。
 * - `turn_failed`：turn 以失败状态结束。
 * - `turn_cancelled`：turn 被取消 / 中断。
 * - `turn_input_required`：turn 需要人工输入，headless worker 无法满足。
 * - `approval_required`：出现 approval request，而当前配置的 policy 不允许自动满足。
 * - `protocol_error`：stdout 上的字节不符合 pinned baseline framing，或 payload 结构
 *   无法解释（transport 层判定，不作为 raw JSON 透出）。
 * - `launch_failed`：process launch 本身失败（spawn 失败、`bash -lc` 无法起步）。
 *
 * 消费方应容忍未知码（未来里程碑可能追加），并按 `code` 精确分支。
 */
export type AgentErrorCode =
  | "codex_not_found"
  | "invalid_workspace_cwd"
  | "response_timeout"
  | "turn_timeout"
  | "port_exit"
  | "response_error"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_input_required"
  | "approval_required"
  | "protocol_error"
  | "launch_failed";

/** {@link AGENT_ERROR_CODES} 是 {@link AgentErrorCode} 的稳定清单（顺序即文档顺序）。 */
export const AGENT_ERROR_CODES = [
  "codex_not_found",
  "invalid_workspace_cwd",
  "response_timeout",
  "turn_timeout",
  "port_exit",
  "response_error",
  "turn_failed",
  "turn_cancelled",
  "turn_input_required",
  "approval_required",
  "protocol_error",
  "launch_failed",
] as const satisfies readonly AgentErrorCode[];

/** {@link AgentError} 的可选附加信息（诊断用，均不参与 `code` 判别）。 */
export interface AgentErrorDetails {
  /** 已建立的 coding-agent thread 标识；尚未取得时**缺席**（不是空串）。 */
  readonly threadId?: string | undefined;
  /** 当前 turn 标识；尚未取得时缺席。 */
  readonly turnId?: string | undefined;
  /** `composeSessionId(threadId, turnId)` 的结果；任一分量缺失时缺席。 */
  readonly sessionId?: string | undefined;
  /** app-server 子进程 PID（字符串形式，与 §4.1.6 `codex_app_server_pid` 同口径）。 */
  readonly codexAppServerPid?: string | undefined;
  /**
   * 相关协议 method 名（如 `turn/start`），仅供日志判别。它是**不透明诊断字符串**：
   * 消费方不得据此解释 payload，也不得假设它在 Codex 版本间稳定。
   */
  readonly protocolMethod?: string | undefined;
  /** 相关 workspace / workflow 路径（绝对路径）。 */
  readonly path?: string | undefined;
  /** 底层原始异常（spawn / JSON parse / `WorkspaceError` 等），经 `cause` 保留。 */
  readonly cause?: unknown;
}

/**
 * agent 包对外唯一的 typed error。判别式是 {@link AgentError.code}。
 *
 * optional 附加字段遵循 `exactOptionalPropertyTypes` 下的既有约定：**缺席 ≠ 空值**，
 * 未提供的字段不会出现在对象上（与 `WorkspaceError` 一致）。
 */
export class AgentError extends Error {
  /** 稳定错误码判别式（SPEC §10.6）。 */
  readonly code: AgentErrorCode;
  declare readonly threadId?: string;
  declare readonly turnId?: string;
  declare readonly sessionId?: string;
  declare readonly codexAppServerPid?: string;
  declare readonly protocolMethod?: string;
  declare readonly path?: string;

  constructor(code: AgentErrorCode, message: string, details: AgentErrorDetails = {}) {
    super(message, "cause" in details ? { cause: details.cause } : undefined);
    this.name = "AgentError";
    this.code = code;
    if (details.threadId !== undefined) {
      this.threadId = details.threadId;
    }
    if (details.turnId !== undefined) {
      this.turnId = details.turnId;
    }
    if (details.sessionId !== undefined) {
      this.sessionId = details.sessionId;
    }
    if (details.codexAppServerPid !== undefined) {
      this.codexAppServerPid = details.codexAppServerPid;
    }
    if (details.protocolMethod !== undefined) {
      this.protocolMethod = details.protocolMethod;
    }
    if (details.path !== undefined) {
      this.path = details.path;
    }
  }
}
