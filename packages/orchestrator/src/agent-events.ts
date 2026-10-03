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
 *   换 turn 不清零，回退 / 迟到快照保留已入账高水位（避免随后再次重复累加）；
 * - `turnCount` 按新 turn 身份去重；线程级 `session_started`（无 turnId）不计数；
 * - 缺席字段不覆盖已有值，不伪造 session / turn 身份。
 */
import type { AgentEvent } from "@symphony/agent";
import { composeSessionId, type LiveSession, type OrchestratorRuntimeState, type RunningEntry } from "@symphony/domain";

/**
 * 把一个稳定 AgentEvent 归约进 runtime state 与当前 running entry。
 *
 * 纯状态更新、无副作用、不抛异常（未知事件名被正常记录）。调用方负责 attempt token
 * 隔离，确保旧 worker 的迟到事件不会命中新 entry。
 */
export function applyAgentEvent(
  state: OrchestratorRuntimeState,
  entry: RunningEntry,
  event: AgentEvent,
): void {
  // rate-limit 是 account 级快照，与会话身份无关：任何事件携带即原样保存。
  if (event.rateLimits !== undefined) {
    state.codexRateLimits = event.rateLimits;
  }

  const session = entry.session ?? tryCreateSession(entry, event);
  if (session === null) {
    // 身份尚未完整（无 thread + turn）：不伪造 session，直接丢弃会话级字段。
    return;
  }

  if (event.codexAppServerPid !== null) {
    session.codexAppServerPid = event.codexAppServerPid;
  }

  session.lastCodexEvent = event.event;
  session.lastCodexTimestamp = event.timestamp;
  if (event.summary !== undefined) {
    session.lastCodexMessage = event.summary;
  }

  if (event.threadId !== undefined && event.threadId.length > 0 && event.threadId !== session.threadId) {
    session.threadId = event.threadId;
    session.sessionId = composeSessionId(session.threadId, session.turnId);
  }

  if (event.turnId !== undefined && event.turnId.length > 0 && event.turnId !== session.turnId) {
    session.turnId = event.turnId;
    session.turnCount += 1;
    session.sessionId = composeSessionId(session.threadId, session.turnId);
  }

  if (event.usage !== undefined) {
    accountUsage(state, session, event.usage);
  }
}

/**
 * 首个同时携带 thread 与 turn 身份的事件建立 LiveSession。缺任一分量时返回 `null`
 * ——绝不伪造 session id（与 `composeSessionId` 的口径一致）。
 */
function tryCreateSession(entry: RunningEntry, event: AgentEvent): LiveSession | null {
  const threadId = event.threadId;
  const turnId = event.turnId;
  if (threadId === undefined || threadId.length === 0) {
    return null;
  }
  if (turnId === undefined || turnId.length === 0) {
    return null;
  }

  const session: LiveSession = {
    sessionId: event.sessionId ?? composeSessionId(threadId, turnId),
    threadId,
    turnId,
    codexAppServerPid: event.codexAppServerPid,
    lastCodexEvent: event.event,
    lastCodexTimestamp: event.timestamp,
    lastCodexMessage: event.summary ?? null,
    codexInputTokens: 0,
    codexOutputTokens: 0,
    codexTotalTokens: 0,
    lastReportedInputTokens: 0,
    lastReportedOutputTokens: 0,
    lastReportedTotalTokens: 0,
    turnCount: 1,
  };
  entry.session = session;
  return session;
}

/** 按正差额把绝对 token 快照入账到 `codex_totals`，并维护已入账高水位。 */
function accountUsage(
  state: OrchestratorRuntimeState,
  session: LiveSession,
  usage: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number },
): void {
  const reportedInput = nonNegative(usage.inputTokens);
  const reportedOutput = nonNegative(usage.outputTokens);
  const reportedTotal = nonNegative(usage.totalTokens);

  const deltaInput = Math.max(reportedInput - session.lastReportedInputTokens, 0);
  const deltaOutput = Math.max(reportedOutput - session.lastReportedOutputTokens, 0);
  const deltaTotal = Math.max(reportedTotal - session.lastReportedTotalTokens, 0);

  state.codexTotals.inputTokens += deltaInput;
  state.codexTotals.outputTokens += deltaOutput;
  state.codexTotals.totalTokens += deltaTotal;

  session.codexInputTokens = reportedInput;
  session.codexOutputTokens = reportedOutput;
  session.codexTotalTokens = reportedTotal;

  session.lastReportedInputTokens = Math.max(session.lastReportedInputTokens, reportedInput);
  session.lastReportedOutputTokens = Math.max(session.lastReportedOutputTokens, reportedOutput);
  session.lastReportedTotalTokens = Math.max(session.lastReportedTotalTokens, reportedTotal);
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
