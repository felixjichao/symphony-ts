/**
 * AgentEvent → LiveSession / codex_totals / rate limits 映射测试（SPEC §7.3、
 * §10.4、§13.5，M5.2 / #51）。
 */
import type { AgentEvent } from "@symphony/agent";
import type { Issue, RunningEntry } from "@symphony/domain";
import { describe, expect, it } from "vitest";

import { applyAgentEvent, createOrchestratorRuntimeState } from "./index";

function makeIssue(): Issue {
  return {
    id: "issue-1",
    nativeRef: null,
    identifier: "ABC-1",
    title: "Telemetry",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    assigneeId: null,
    labels: [],
    blockedBy: [],
    dispatchable: true,
    createdAt: null,
    updatedAt: null,
  };
}

function makeEntry(): RunningEntry {
  return {
    issue: makeIssue(),
    attempt: {
      issueId: "issue-1",
      issueIdentifier: "ABC-1",
      attempt: null,
      workspacePath: "/tmp/ws",
      startedAt: 0,
      status: "streaming_turn",
    },
    session: null,
    workspacePath: "/tmp/ws",
    startedAtMs: 0,
    workerHandle: null,
  };
}

function event(partial: Partial<AgentEvent> & Pick<AgentEvent, "event">): AgentEvent {
  return {
    timestamp: 100,
    codexAppServerPid: "12",
    ...partial,
  };
}

describe("applyAgentEvent — 验收 06/07", () => {
  it("身份不完整时不伪造 session，但 account 级 rate limits 正常保存", () => {
    const state = createOrchestratorRuntimeState({ pollIntervalMs: 1, maxConcurrentAgents: 1 });
    const entry = makeEntry();

    applyAgentEvent(
      state,
      entry,
      event({ event: "startup_failed", rateLimits: { primary: { remaining: 5 } } }),
    );

    expect(entry.session).toBeNull();
    expect(state.codexRateLimits).toEqual({ primary: { remaining: 5 } });
  });

  it("首个带 thread+turn 身份的事件建立 LiveSession 并初始化 turnCount=1", () => {
    const state = createOrchestratorRuntimeState({ pollIntervalMs: 1, maxConcurrentAgents: 1 });
    const entry = makeEntry();

    applyAgentEvent(
      state,
      entry,
      event({ event: "session_started", threadId: "t1", turnId: "u1", sessionId: "t1-u1", summary: "started" }),
    );

    expect(entry.session).toMatchObject({
      sessionId: "t1-u1",
      threadId: "t1",
      turnId: "u1",
      codexAppServerPid: "12",
      lastCodexEvent: "session_started",
      lastCodexTimestamp: 100,
      lastCodexMessage: "started",
      turnCount: 1,
    });
  });

  it("线程级 session_started（无 turnId）不计数；新 turnId 计数 +1，重复不计数", () => {
    const state = createOrchestratorRuntimeState({ pollIntervalMs: 1, maxConcurrentAgents: 1 });
    const entry = makeEntry();

    // 无 turnId 的线程级事件不会建立 session。
    applyAgentEvent(state, entry, event({ event: "session_started", threadId: "t1" }));
    expect(entry.session).toBeNull();

    applyAgentEvent(state, entry, event({ event: "session_started", threadId: "t1", turnId: "u1" }));
    expect(entry.session?.turnCount).toBe(1);

    // 同一 turn 的重复 / 后续事件不增加计数。
    applyAgentEvent(state, entry, event({ event: "turn_completed", threadId: "t1", turnId: "u1" }));
    expect(entry.session?.turnCount).toBe(1);

    // 新 turn 计数 +1。
    applyAgentEvent(state, entry, event({ event: "session_started", threadId: "t1", turnId: "u2" }));
    expect(entry.session?.turnCount).toBe(2);
    expect(entry.session?.turnId).toBe("u2");
    expect(entry.session?.sessionId).toBe("t1-u2");
  });

  it("缺席字段不覆盖已有值，未知事件名可正常记录", () => {
    const state = createOrchestratorRuntimeState({ pollIntervalMs: 1, maxConcurrentAgents: 1 });
    const entry = makeEntry();

    applyAgentEvent(
      state,
      entry,
      event({ event: "session_started", threadId: "t1", turnId: "u1", sessionId: "t1-u1", summary: "first" }),
    );
    applyAgentEvent(state, entry, event({ event: "future_unknown_event", timestamp: 999, codexAppServerPid: null }));

    expect(entry.session?.lastCodexEvent).toBe("future_unknown_event");
    expect(entry.session?.lastCodexTimestamp).toBe(999);
    expect(entry.session?.lastCodexMessage).toBe("first");
    expect(entry.session?.codexAppServerPid).toBe("12");
  });

  it("usage 按绝对快照的正差额入账，重复不重复计、回退保留高水位", () => {
    const state = createOrchestratorRuntimeState({ pollIntervalMs: 1, maxConcurrentAgents: 1 });
    const entry = makeEntry();

    const usageEvent = (inputTokens: number, outputTokens: number, totalTokens: number): AgentEvent =>
      event({
        event: "notification",
        threadId: "t1",
        turnId: "u1",
        usage: { inputTokens, outputTokens, totalTokens },
      });

    applyAgentEvent(state, entry, usageEvent(100, 20, 120));
    expect(state.codexTotals).toMatchObject({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    expect(entry.session).toMatchObject({ codexInputTokens: 100, lastReportedInputTokens: 100 });

    // 重复快照：不重复入账。
    applyAgentEvent(state, entry, usageEvent(100, 20, 120));
    expect(state.codexTotals.inputTokens).toBe(100);

    // 增长：按差额入账。
    applyAgentEvent(state, entry, usageEvent(150, 30, 180));
    expect(state.codexTotals).toMatchObject({ inputTokens: 150, outputTokens: 30, totalTokens: 180 });

    // 回退 / 迟到快照：不入账，高水位保留。
    applyAgentEvent(state, entry, usageEvent(10, 2, 12));
    expect(state.codexTotals.inputTokens).toBe(150);
    expect(entry.session?.lastReportedInputTokens).toBe(150);
    expect(entry.session?.codexInputTokens).toBe(10);

    // 高水位之后再次增长：从高水位继续差额入账，不重复累加。
    applyAgentEvent(state, entry, usageEvent(160, 32, 192));
    expect(state.codexTotals).toMatchObject({ inputTokens: 160, outputTokens: 32, totalTokens: 192 });
  });

  it("rate limits 原样保存、不解释结构", () => {
    const state = createOrchestratorRuntimeState({ pollIntervalMs: 1, maxConcurrentAgents: 1 });
    const entry = makeEntry();
    const payload = { primary: { usedPercent: 40 }, secondary: null, extra: [1, "x"] };

    applyAgentEvent(state, entry, event({ event: "notification", rateLimits: payload }));

    expect(state.codexRateLimits).toBe(payload);
  });
});
