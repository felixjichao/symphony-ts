import type { UtcTimestampMs } from "./time";

/**
 * coding-agent 事件名（SPEC §10.4 `event`，如 `session_started` /
 * `turn_completed`）。§10.4 的清单是开放示例（"include, for example"），事件协议
 * 归 `@symphony/agent`（M4），因此这里保持 string 别名、不固化会漂移的枚举。
 */
export type CodexEventName = string;

/**
 * coding-agent 子进程运行期间跟踪的 session 元数据（SPEC §4.1.6）。由 agent
 * runner 上报、orchestrator 随 codex update 事件更新（§7.3）；可变运行时记录，
 * 字段不加 readonly。
 *
 * token 计数口径（§13.5）：`codex*Tokens` 为当前 thread 的**绝对累计**（来自
 * absolute thread totals 类 payload）；`lastReported*Tokens` 是上次已入账的绝对
 * 值，用于按 delta 入账、避免双计。delta 式 payload（如 `last_token_usage`）
 * 不进入 totals。
 */
export interface LiveSession {
  /** SPEC `session_id`：`<thread_id>-<turn_id>`（§4.2），由 {@link composeSessionId} 生成。 */
  sessionId: string;
  /** SPEC `thread_id`：coding-agent thread 标识。 */
  threadId: string;
  /** SPEC `turn_id`：当前 turn 标识。 */
  turnId: string;
  /** SPEC `codex_app_server_pid`：app-server 进程 PID（字符串形式）；未知为 `null`。 */
  codexAppServerPid: string | null;
  /** SPEC `last_codex_event`：最近一次事件名（{@link CodexEventName}）；尚无事件为 `null`。 */
  lastCodexEvent: CodexEventName | null;
  /** SPEC `last_codex_timestamp`：最近事件的 UTC 时间戳（§10.4）；尚无为 `null`。 */
  lastCodexTimestamp: UtcTimestampMs | null;
  /**
   * SPEC `last_codex_message`：最近事件的 summarized payload（humanized 摘要，
   * observability-only，§13.6）；尚无为 `null`。
   */
  lastCodexMessage: string | null;
  /** SPEC `codex_input_tokens`：当前 thread 绝对累计输入 token。 */
  codexInputTokens: number;
  /** SPEC `codex_output_tokens`。 */
  codexOutputTokens: number;
  /** SPEC `codex_total_tokens`。 */
  codexTotalTokens: number;
  /** SPEC `last_reported_input_tokens`：上次已入账的绝对值（§13.5 delta 口径）。 */
  lastReportedInputTokens: number;
  /** SPEC `last_reported_output_tokens`。 */
  lastReportedOutputTokens: number;
  /** SPEC `last_reported_total_tokens`。 */
  lastReportedTotalTokens: number;
  /** SPEC `turn_count`：当前 worker 生命周期内已启动的 coding-agent turn 数。 */
  turnCount: number;
}

/**
 * 组合 session id（SPEC §4.2 "Session ID"）：`<thread_id>-<turn_id>`。
 * 纯字符串组合，不校验分量内容。
 */
export function composeSessionId(threadId: string, turnId: string): string {
  return `${threadId}-${turnId}`;
}
