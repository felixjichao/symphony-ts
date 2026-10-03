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
 * - `codexTotals` 按"绝对快照 − 已入账高水位"的**正差额**聚合，重复快照不重复入账，
 *   换 turn 不清零，回退 / 迟到快照保留已入账高水位；
 * - **thread 身份是隔离边界**：异 thread 的无关 / 迟到遥测一律隔离，不推进身份、不计数、
 *   不入账、不写 LiveSession；
 * - **turn 身份只由可靠的生命周期事件推进**（`session_started` / `turn_completed` /
 *   `turn_failed` / `turn_cancelled` / `turn_ended_with_error`），`other_message` /
 *   `notification` / `malformed` 等诊断事件携带的 turn id 不得改变当前身份或计数；
 * - 身份未齐时不伪造 session：把 usage / PID / last event / timestamp / message 暂存在
 *   {@link AgentTelemetryState}，取得完整身份后回填；usage 在身份未齐时也立即按高水位入账，
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

/**
 * 单个 worker 的 per-attempt 遥测状态（不驻留在 domain 模型上）。
 *
 * 由 authority 为每个 attempt 新建并长期持有，随 attempt 结束丢弃；授权 `applyAgentEvent`
 * 跨事件积累"身份未齐时的暂存遥测"与"当前 thread 的已入账 token 高水位"。
 */
export interface AgentTelemetryState {
  /** 已确认的当前 thread 身份（只能由可靠生命周期事件确认）；尚未确认时 `null`。 */
  threadId: string | null;
  /**
   * 确认前的候选 thread（来自 token usage 等非诊断事件）。真实 thread 确认时若候选不一致，
   * 丢弃候选高水位，避免把无关 thread 的消耗与真实 thread 混用。
   */
  pendingThreadId: string | null;
  /** 已确认的当前 turn 身份；尚未确认时 `null`。 */
  turnId: string | null;
  /** 当前 thread 内已确认的 turn 数（按身份去重）。 */
  turnCount: number;
  /** 当前 thread 的已入账 token 高水位（跨 turn 保留，回退快照不降低）。 */
  reportedInputTokens: number;
  reportedOutputTokens: number;
  reportedTotalTokens: number;
  /** 最近一次绝对 usage 快照（用于回填 `LiveSession.codex*Tokens`）。 */
  lastUsage: AgentTokenUsage | null;
  /** 身份未齐时暂存的 last event / timestamp / message / pid。 */
  pendingLastEvent: CodexEventName | null;
  pendingLastTimestamp: UtcTimestampMs | null;
  pendingLastMessage: string | null;
  pendingPid: string | null;
}

/** 新建一个空的 per-attempt 遥测状态。 */
export function createAgentTelemetryState(): AgentTelemetryState {
  return {
    threadId: null,
    pendingThreadId: null,
    turnId: null,
    turnCount: 0,
    reportedInputTokens: 0,
    reportedOutputTokens: 0,
    reportedTotalTokens: 0,
    lastUsage: null,
    pendingLastEvent: null,
    pendingLastTimestamp: null,
    pendingLastMessage: null,
    pendingPid: null,
  };
}

/**
 * 可靠推进 turn 身份 / 计数的稳定事件名白名单。
 *
 * 刻意**不**包含 `other_message`（异 thread/turn 诊断）、`notification`（token 遥测）、
 * `malformed`：这些事件可能携带与本 worker 无关的 turn id（见 `app-server-session.ts`
 * 的异 thread / 异 turn completion 映射），不得据此改写当前身份或增加计数。
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

  // 只有可靠生命周期事件能确认 thread owner；确认时若与此前暂存的候选 thread 不同，
  // 丢弃候选高水位，绝不把无关 thread 的消耗与真实 thread 混用。
  if (telemetry.threadId === null && reliableLifecycle && eventThreadId !== null) {
    if (telemetry.pendingThreadId !== null && telemetry.pendingThreadId !== eventThreadId) {
      resetReportedBaseline(telemetry);
    }
    telemetry.threadId = eventThreadId;
    telemetry.pendingThreadId = eventThreadId;
  } else if (
    telemetry.threadId === null &&
    !unrelatedDiagnostic &&
    eventThreadId !== null
  ) {
    // 确认前的非诊断遥测（token usage / approval 等）：按候选 thread 暂存；候选切换时重置
    // 高水位基线，避免与最终真实 thread 混用。
    if (telemetry.pendingThreadId !== null && telemetry.pendingThreadId !== eventThreadId) {
      resetReportedBaseline(telemetry);
    }
    telemetry.pendingThreadId = eventThreadId;
  }

  recordLastEvent(entry, telemetry, event);

  // usage 入账与 session 是否建立无关：身份未齐时也按高水位立即入账，避免漏账。
  if (event.usage !== undefined) {
    accountUsage(state, entry, telemetry, event.usage);
  }

  // turn 身份 / 计数只由可靠生命周期事件推进。
  const eventTurnId = nonEmptyString(event.turnId);
  if (eventTurnId !== null && TURN_IDENTITY_EVENTS.has(event.event)) {
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
 * 取得完整 thread + turn 身份后一次性建出 LiveSession，并用暂存遥测 + 已入账高水位回填。
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
    entry.session = {
      sessionId: composeSessionId(telemetry.threadId, telemetry.turnId),
      threadId: telemetry.threadId,
      turnId: telemetry.turnId,
      codexAppServerPid: telemetry.pendingPid ?? event.codexAppServerPid,
      lastCodexEvent: telemetry.pendingLastEvent,
      lastCodexTimestamp: telemetry.pendingLastTimestamp,
      lastCodexMessage: telemetry.pendingLastMessage,
      codexInputTokens: telemetry.lastUsage?.inputTokens ?? 0,
      codexOutputTokens: telemetry.lastUsage?.outputTokens ?? 0,
      codexTotalTokens: telemetry.lastUsage?.totalTokens ?? 0,
      lastReportedInputTokens: telemetry.reportedInputTokens,
      lastReportedOutputTokens: telemetry.reportedOutputTokens,
      lastReportedTotalTokens: telemetry.reportedTotalTokens,
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

/** 按正差额把绝对 token 快照入账到 `codex_totals`，并维护已入账高水位。 */
function accountUsage(
  state: OrchestratorRuntimeState,
  entry: RunningEntry,
  telemetry: AgentTelemetryState,
  usage: AgentTokenUsage,
): void {
  const reportedInput = nonNegative(usage.inputTokens);
  const reportedOutput = nonNegative(usage.outputTokens);
  const reportedTotal = nonNegative(usage.totalTokens);

  const deltaInput = Math.max(reportedInput - telemetry.reportedInputTokens, 0);
  const deltaOutput = Math.max(reportedOutput - telemetry.reportedOutputTokens, 0);
  const deltaTotal = Math.max(reportedTotal - telemetry.reportedTotalTokens, 0);

  state.codexTotals.inputTokens += deltaInput;
  state.codexTotals.outputTokens += deltaOutput;
  state.codexTotals.totalTokens += deltaTotal;

  telemetry.lastUsage = {
    inputTokens: reportedInput,
    outputTokens: reportedOutput,
    totalTokens: reportedTotal,
  };
  telemetry.reportedInputTokens = Math.max(telemetry.reportedInputTokens, reportedInput);
  telemetry.reportedOutputTokens = Math.max(telemetry.reportedOutputTokens, reportedOutput);
  telemetry.reportedTotalTokens = Math.max(telemetry.reportedTotalTokens, reportedTotal);

  const session = entry.session;
  if (session !== null) {
    session.codexInputTokens = reportedInput;
    session.codexOutputTokens = reportedOutput;
    session.codexTotalTokens = reportedTotal;
    session.lastReportedInputTokens = telemetry.reportedInputTokens;
    session.lastReportedOutputTokens = telemetry.reportedOutputTokens;
    session.lastReportedTotalTokens = telemetry.reportedTotalTokens;
  }
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 丢弃当前候选 thread 的已入账高水位与最后一次快照（真实 owner 被确认为另一个 thread 时）。
 *
 * 只重置 per-thread 基线，不回滚已写入全局 `codexTotals` 的差额——全局是跨 session 聚合，
 * 且此处无法安全反算；关键是后续真实 thread 的差额从零基线重新计，不会与候选混用。
 */
function resetReportedBaseline(telemetry: AgentTelemetryState): void {
  telemetry.reportedInputTokens = 0;
  telemetry.reportedOutputTokens = 0;
  telemetry.reportedTotalTokens = 0;
  telemetry.lastUsage = null;
}
