/**
 * @symphony/agent 稳定事件契约（SPEC **§10.4 Emitted Runtime Events**，M4.1 / #37）。
 *
 * 这是 Symphony 面向 orchestrator / observability 的事件面，**不是** Codex method enum：
 * - 事件的 `event` 取值是 Symphony 自己的词汇（§10.4 清单），Codex method 名只作为
 *   不透明诊断字段 {@link AgentEvent.protocolMethod} 出现；
 * - payload 只携带已抽取的 Symphony 侧信息（session 标识、token 快照、rate-limit
 *   快照、可判别的结果码），M5 消费它时**不需要**理解 raw Codex JSON；
 * - `event` 的类型是开放 string 别名 {@link CodexEventName}：§10.4 的清单是
 *   "include, for example" 的开放集合，冻结成 enum 会随 Codex 漂移而破裂。消费方
 *   必须容忍未知事件名，并把 {@link AGENT_EVENT_NAMES} 当作**保证存在**的词汇表。
 *
 * 事件的产生与映射（哪个 Codex notification → 哪个事件名）随 M4.4 落地；本文件只
 * 定型对外形状。
 */
import type { CodexEventName, CodexRateLimits, UtcTimestampMs } from "@symphony/domain";

/**
 * 本契约保证存在的事件名清单（SPEC §10.4 的示例集合，逐字采用）。它是**开放**集合：
 * 后续里程碑可以追加，消费方不得假设"只会出现这些"。
 */
export const AGENT_EVENT_NAMES = [
  "session_started",
  "startup_failed",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
  "turn_ended_with_error",
  "turn_input_required",
  "approval_auto_approved",
  "unsupported_tool_call",
  "notification",
  "other_message",
  "malformed",
] as const satisfies readonly CodexEventName[];

/**
 * 契约保证存在的事件名联合类型（{@link AGENT_EVENT_NAMES} 的成员）。
 *
 * 消费方若需要对已知事件集做严格分支，可使用此类型或 {@link isAgentEventName} guard。
 * 注意运行时事件名仍是开放的（{@link CodexEventName}），未知事件名必须被容忍。
 */
export type AgentEventName = (typeof AGENT_EVENT_NAMES)[number];

/**
 * 判断一个任意字符串是否为契约保证存在的已知事件名（类型收窄至 {@link AgentEventName}）。
 * 避免消费方在 strict 模式下直接调用 `AGENT_EVENT_NAMES.includes(str)` 触发 TS2345。
 */
export function isAgentEventName(name: string): name is AgentEventName {
  return (AGENT_EVENT_NAMES as readonly string[]).includes(name);
}

/**
 * 一个 turn 的 token 用量快照（SPEC §10.4 "OPTIONAL `usage` map (token counts)"）。
 *
 * 口径与 §13.5 / §4.1.6 一致：M4 只**抽取并转发**快照，delta 入账与 totals 聚合归
 * orchestrator / observability（M5 / M6）。`absolute` 与 `delta` 之分由 adapter 层在
 * 映射时判定，事件面只表达"这次上报的计数"。
 */
export interface AgentTokenUsage {
  /** 输入 token 数。 */
  readonly inputTokens: number;
  /** 输出 token 数。 */
  readonly outputTokens: number;
  /** 总 token 数。 */
  readonly totalTokens: number;
}

/**
 * app-server client 向上游发射的结构化运行时事件（SPEC §10.4）。
 *
 * 必填三件套是 §10.4 对"每条事件 SHOULD 包含"的要求：`event`、UTC `timestamp`、
 * 可用的 `codex_app_server_pid`（未知时为 `null`，与 §4.1.6 `LiveSession` 同口径）。
 * 其余字段按"可得时携带"建模：**缺席 = 该事件没有这个上下文**（不是空串、不是 0）。
 */
export interface AgentEvent {
  /** 事件名，取值见 {@link AGENT_EVENT_NAMES}（开放集合，未知值须被容忍）。 */
  readonly event: CodexEventName;
  /** 事件产生的 UTC 时间戳（§10.4 / §11.3 墙上时钟域）。 */
  readonly timestamp: UtcTimestampMs;
  /** app-server 子进程 PID（字符串形式）；尚未 launch 或已退出且不可知时为 `null`。 */
  readonly codexAppServerPid: string | null;
  /** thread 标识；`thread/start` 成功前缺席（§10.2）。 */
  readonly threadId?: string | undefined;
  /** turn 标识；无活跃 turn 的事件缺席。 */
  readonly turnId?: string | undefined;
  /** `composeSessionId(threadId, turnId)`；任一分量不可知时缺席（§4.2）。 */
  readonly sessionId?: string | undefined;
  /** token 用量快照（§10.4 / §13.5）；该事件不带 usage 时缺席。 */
  readonly usage?: AgentTokenUsage | undefined;
  /**
   * rate-limit 快照（§10.4 / §4.1.8 `codex_rate_limits`）：opaque payload，
   * 原样转发、不解释、不 schema 化。
   */
  readonly rateLimits?: CodexRateLimits | undefined;
  /**
   * 相关协议 method 名（如 `thread/tokenUsage/updated`），observability-only 诊断字符串：
   * 消费方不得据此分支业务行为，也不得假设它在 Codex 版本间稳定。
   */
  readonly protocolMethod?: string | undefined;
  /**
   * payload 的 humanized 摘要（§13.6 OPTIONAL humanized agent event summaries）。
   * 仅用于日志 / dashboard，不构成判别面；adapter 层负责脱敏（不回显 secret）。
   */
  readonly summary?: string | undefined;
}
