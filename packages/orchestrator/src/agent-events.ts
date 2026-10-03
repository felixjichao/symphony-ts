/**
 * AgentEvent → orchestrator runtime state 的稳定映射（SPEC §7.3、§10.4、§13.5，
 * M5.2 / #51）。
 *
 * 只消费 `@symphony/agent` 导出的稳定 {@link AgentEvent} 契约：
 *
 * - 不解析 raw Codex JSON；
 * - 不按 Codex protocol method literal 分支（`protocolMethod` 只作诊断，不参与判定）；
 * - 不 import agent 私有 transport / protocol 实现。
 *
 * 口径（§13.5）：
 * - `LiveSession.codex*Tokens` 是当前 thread 的**绝对累计**快照；
 * - `codexTotals` 按"绝对快照 − 该 thread 已入账高水位"的**正差额**聚合：重复快照不重复入账，
 *   换 turn 不清零，回退 / 迟到快照保留已入账高水位；
 * - **每个 thread 独立维护高水位**（{@link AgentTelemetryState.baselines}）。thread 身份未确认
 *   前可能出现多个候选 thread（含真实 thread 早到的 usage）：各自记在各自基线里，候选切换 /
 *   owner 确认都不清除任何 thread 已计入的额度，因此 A→B→A 的重复绝对快照不会重复入账；
 * - **thread 身份是隔离边界**：owner 确认后，异 thread 的无关 / 迟到遥测一律隔离，不推进身份、
 *   不计数、不入账、不写 LiveSession；
 * - **thread owner 与 turn 身份只由可靠生命周期事件确认/推进**（`session_started` /
 *   `turn_completed` / `turn_failed` / `turn_cancelled` / `turn_ended_with_error`）；
 *   `other_message` / `malformed` 在 owner 确认前不得抢占 owner，`notification` 等携带的 turn
 *   id 不得改写身份或计数；
 * - 身份未齐时不伪造 session：把 usage / PID / last event / timestamp / message 暂存在
 *   {@link AgentTelemetryState}，取得完整身份后回填；usage 到达即按所属 thread 高水位入账，
 *   因此"先到 usage、后到身份"或"身份始终未齐、最终启动失败"都不会漏账。
 */
import type { AgentEvent, AgentTokenUsage } from "@symphony/agent";
import type {
  CodexEventName,
  OrchestratorRuntimeState,
  RunningEntry,
  UtcTimestampMs,
} from "@symphony/domain";
import { composeSessionId } from "@symphony/domain";

/** 单个 thread 的已入账 token 基线（绝对快照高水位 + 最后一次快照）。 */
export interface ThreadUsageBaseline {
  /** 该 thread 已入账的绝对高水位（回退快照不降低）。 */
  reportedInputTokens: number;
  reportedOutputTokens: number;
  reportedTotalTokens: number;
  /** 该 thread 最近一次绝对快照（用于回填 `LiveSession.codex*Tokens`）。 */
  lastUsage: AgentTokenUsage | null;
}

/**
 * 单个 worker 的 per-attempt 遥测状态（不驻留在 domain 模型上）。
 *
 * 由 authority 为每个 attempt 新建并长期持有，随 attempt 结束丢弃；授权 `applyAgentEvent`
 * 跨事件积累"身份未齐时的暂存遥测"与"每个 thread 的已入账 token 高水位"。
 */
export interface AgentTelemetryState {
  /** 已确认的当前 thread 身份（只能由可靠生命周期事件确认）；尚未确认时 `null`。 */
  threadId: string | null;
  /** 已确认的当前 turn 身份；尚未确认时 `null`。 */
  turnId: string | null;
  /** 当前 thread 内已确认的 turn 数（按身份去重）。 */
  turnCount: number;
  /** threadId（或身份未齐时的占位 key）→ 该 thread 的 token 基线。 */
  baselines: Map<string, ThreadUsageBaseline>;
  /** 身份未齐时暂存的 last event / timestamp / message / pid。 */
  pendingLastEvent: CodexEventName | null;
  pendingLastTimestamp: UtcTimestampMs | null;
  pendingLastMessage: string | null;
  pendingPid: string | null;
}

/** 尚无 thread 身份的 usage（会话 thread 建立前）归入的占位基线 key。 */
const UNKNOWN_THREAD_KEY = "\u0000unknown-thread";

/** 新建一个空的 per-attempt 遥测状态。 */
export function createAgentTelemetryState(): AgentTelemetryState {
  return {
    threadId: null,
    turnId: null,
    turnCount: 0,
    baselines: new Map(),
    pendingLastEvent: null,
    pendingLastTimestamp: null,
    pendingLastMessage: null,
    pendingPid: null,
  };
}

/**
 * 可靠确认 thread owner / 推进 turn 身份与计数的稳定事件名白名单。
 *
 * 刻意**不**包含 `other_message`（异 thread/turn 诊断）、`notification`（token 遥测）、
 * `malformed`：这些事件可能携带与本 worker 无关的 thread / turn id（见
 * `app-server-session.ts` 的异 thread / 异 turn completion 映射），不得据此确认 owner 或
 * 改写当前身份、增加计数。
 */
const TURN_IDENTITY_EVENTS: ReadonlySet<string> = new Set([
  "session_started",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
  "turn_ended_with_error",
]);

/**
 * 明确表示"与本 worker 无关"的诊断事件：异 thread / 异 turn completion 会被 agent 映射成
 * `other_message`（`app-server-session.ts` 的 incomingThreadId / turn.id 检查），`malformed`
 * 同理不可信。它们**不得**在 thread owner 确认前抢占 owner，也不得写入暂存遥测。
 */
function isUnrelatedDiagnostic(event: AgentEvent): boolean {
  return event.event === "other_message" || event.event === "malformed";
}

function nonEmptyString(value: string | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 把一个稳定 AgentEvent 归约进 runtime state、当前 running entry 与 per-attempt 遥测。
 *
 * 纯状态更新、无副作用、不抛异常（未知事件名被正常记录）。调用方负责 attempt token
 * 隔离，确保旧 worker 的迟到事件不会命中新 entry。
 */
export function applyAgentEvent(
  state: OrchestratorRuntimeState,
  entry: RunningEntry,
  telemetry: AgentTelemetryState,
  event: AgentEvent,
): void {
  // rate-limit 是 account 级快照，与会话 / thread 身份无关：任何事件携带即原样保存。
  if (event.rateLimits !== undefined) {
    state.codexRateLimits = event.rateLimits;
  }

  const eventThreadId = nonEmptyString(event.threadId);
  const reliableLifecycle = TURN_IDENTITY_EVENTS.has(event.event);
  const unrelatedDiagnostic = isUnrelatedDiagnostic(event);

  if (telemetry.threadId !== null) {
    // thread 隔离边界：owner 已确认后，异 thread 的无关 / 迟到事件被丢弃。
    if (eventThreadId !== null && eventThreadId !== telemetry.threadId) {
      return;
    }
  } else if (unrelatedDiagnostic) {
    // owner 未确认时，明确无关的诊断事件（如握手期夹入的异 thread completion）不得抢占
    // owner，也不得写入暂存遥测——否则真正的 session thread 会被永久过滤掉。
    return;
  }

  // thread owner 只由可靠生命周期事件确认。确认前到达的 usage 已按各自 thread 记入基线，
  // 因此这里**不**重置任何基线：同一 thread 已计入的额度必须保留，A→B→A 不重复入账。
  if (telemetry.threadId === null && reliableLifecycle && eventThreadId !== null) {
    telemetry.threadId = eventThreadId;
  }

  recordLastEvent(entry, telemetry, event);

  // usage 入账与 session 是否建立无关：到达即按所属 thread 的基线入账，避免漏账。
  if (event.usage !== undefined) {
    accountUsage(state, entry, telemetry, eventThreadId ?? UNKNOWN_THREAD_KEY, event.usage);
  }

  // turn 身份 / 计数只由可靠生命周期事件推进。
  const eventTurnId = nonEmptyString(event.turnId);
  if (eventTurnId !== null && reliableLifecycle && telemetry.threadId !== null) {
    if (telemetry.turnId === null) {
      telemetry.turnId = eventTurnId;
      telemetry.turnCount = Math.max(telemetry.turnCount, 1);
    } else if (eventTurnId !== telemetry.turnId) {
      telemetry.turnId = eventTurnId;
      telemetry.turnCount += 1;
    }
  }

  materializeSession(entry, telemetry, event);
}

/** 更新 last event / timestamp / message / pid；session 未建立时暂存到 telemetry。 */
function recordLastEvent(
  entry: RunningEntry,
  telemetry: AgentTelemetryState,
  event: AgentEvent,
): void {
  const session = entry.session;
  if (session !== null) {
    if (event.codexAppServerPid !== null) {
      session.codexAppServerPid = event.codexAppServerPid;
    }
    session.lastCodexEvent = event.event;
    session.lastCodexTimestamp = event.timestamp;
    if (event.summary !== undefined) {
      session.lastCodexMessage = event.summary;
    }
    return;
  }
  if (event.codexAppServerPid !== null) {
    telemetry.pendingPid = event.codexAppServerPid;
  }
  telemetry.pendingLastEvent = event.event;
  telemetry.pendingLastTimestamp = event.timestamp;
  if (event.summary !== undefined) {
    telemetry.pendingLastMessage = event.summary;
  }
}

/**
 * 取得完整 thread + turn 身份后一次性建出 LiveSession，并用该 thread 的基线 + 暂存遥测回填。
 * 缺任一分量时保持 `null`——绝不伪造 session 身份。
 */
function materializeSession(
  entry: RunningEntry,
  telemetry: AgentTelemetryState,
  event: AgentEvent,
): void {
  if (entry.session === null) {
    if (telemetry.threadId === null || telemetry.turnId === null) {
      return;
    }
    const baseline = telemetry.baselines.get(telemetry.threadId);
    entry.session = {
      sessionId: composeSessionId(telemetry.threadId, telemetry.turnId),
      threadId: telemetry.threadId,
      turnId: telemetry.turnId,
      codexAppServerPid: telemetry.pendingPid ?? event.codexAppServerPid,
      lastCodexEvent: telemetry.pendingLastEvent,
      lastCodexTimestamp: telemetry.pendingLastTimestamp,
      lastCodexMessage: telemetry.pendingLastMessage,
      codexInputTokens: baseline?.lastUsage?.inputTokens ?? 0,
      codexOutputTokens: baseline?.lastUsage?.outputTokens ?? 0,
      codexTotalTokens: baseline?.lastUsage?.totalTokens ?? 0,
      lastReportedInputTokens: baseline?.reportedInputTokens ?? 0,
      lastReportedOutputTokens: baseline?.reportedOutputTokens ?? 0,
      lastReportedTotalTokens: baseline?.reportedTotalTokens ?? 0,
      turnCount: telemetry.turnCount,
    };
    return;
  }

  // session 已建立：把 telemetry 中可能已推进的 turn 身份 / 计数同步到物化视图。
  const session = entry.session;
  session.turnCount = telemetry.turnCount;
  if (telemetry.turnId !== null && telemetry.turnId !== session.turnId) {
    session.turnId = telemetry.turnId;
    session.sessionId = composeSessionId(session.threadId, session.turnId);
  }
}

/**
 * 按正差额把绝对 token 快照入账到 `codex_totals`，并维护**该 thread** 的已入账高水位。
 *
 * 高水位按 thread key 独立保存：候选切换 / owner 确认都不会清除某 thread 已计入的额度，
 * 因此同一 thread 的重复绝对快照不会再次入账。
 */
function accountUsage(
  state: OrchestratorRuntimeState,
  entry: RunningEntry,
  telemetry: AgentTelemetryState,
  threadKey: string,
  usage: AgentTokenUsage,
): void {
  const reportedInput = nonNegative(usage.inputTokens);
  const reportedOutput = nonNegative(usage.outputTokens);
  const reportedTotal = nonNegative(usage.totalTokens);

  const baseline: ThreadUsageBaseline = telemetry.baselines.get(threadKey) ?? {
    reportedInputTokens: 0,
    reportedOutputTokens: 0,
    reportedTotalTokens: 0,
    lastUsage: null,
  };

  const deltaInput = Math.max(reportedInput - baseline.reportedInputTokens, 0);
  const deltaOutput = Math.max(reportedOutput - baseline.reportedOutputTokens, 0);
  const deltaTotal = Math.max(reportedTotal - baseline.reportedTotalTokens, 0);

  state.codexTotals.inputTokens += deltaInput;
  state.codexTotals.outputTokens += deltaOutput;
  state.codexTotals.totalTokens += deltaTotal;

  baseline.lastUsage = {
    inputTokens: reportedInput,
    outputTokens: reportedOutput,
    totalTokens: reportedTotal,
  };
  baseline.reportedInputTokens = Math.max(baseline.reportedInputTokens, reportedInput);
  baseline.reportedOutputTokens = Math.max(baseline.reportedOutputTokens, reportedOutput);
  baseline.reportedTotalTokens = Math.max(baseline.reportedTotalTokens, reportedTotal);
  telemetry.baselines.set(threadKey, baseline);

  const session = entry.session;
  if (session !== null && session.threadId === threadKey) {
    session.codexInputTokens = reportedInput;
    session.codexOutputTokens = reportedOutput;
    session.codexTotalTokens = reportedTotal;
    session.lastReportedInputTokens = baseline.reportedInputTokens;
    session.lastReportedOutputTokens = baseline.reportedOutputTokens;
    session.lastReportedTotalTokens = baseline.reportedTotalTokens;
  }
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
