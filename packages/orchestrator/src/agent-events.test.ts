/**
 * AgentEvent → LiveSession / codex_totals / rate limits 映射测试（SPEC §7.3、
 * §10.4、§13.5，M5.2 / #51）。
 */
import type { AgentEvent } from "@symphony/agent";
import type { Issue, RunningEntry } from "@symphony/domain";
import { describe, expect, it } from "vitest";

import {
  applyAgentEvent,
  createAgentTelemetryState,
  createOrchestratorRuntimeState,
  type AgentTelemetryState,
} from "./index";

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

interface Ctx {
  readonly state: ReturnType<typeof createOrchestratorRuntimeState>;
  readonly entry: RunningEntry;
  readonly telemetry: AgentTelemetryState;
}

function makeCtx(): Ctx {
  return {
    state: createOrchestratorRuntimeState({ pollIntervalMs: 1, maxConcurrentAgents: 1 }),
    entry: makeEntry(),
    telemetry: createAgentTelemetryState(),
  };
}

function apply(ctx: Ctx, ev: AgentEvent): void {
  applyAgentEvent(ctx.state, ctx.entry, ctx.telemetry, ev);
}

describe("applyAgentEvent — 验收 06/07", () => {
  it("身份不完整时不伪造 session，但 account 级 rate limits 正常保存", () => {
    const ctx = makeCtx();

    apply(ctx, event({ event: "startup_failed", rateLimits: { primary: { remaining: 5 } } }));

    expect(ctx.entry.session).toBeNull();
    expect(ctx.state.codexRateLimits).toEqual({ primary: { remaining: 5 } });
  });

  it("首个带 thread+turn 身份的事件建立 LiveSession 并初始化 turnCount=1", () => {
    const ctx = makeCtx();

    apply(
      ctx,
      event({ event: "session_started", threadId: "t1", turnId: "u1", sessionId: "t1-u1", summary: "started" }),
    );

    expect(ctx.entry.session).toMatchObject({
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
    const ctx = makeCtx();

    apply(ctx, event({ event: "session_started", threadId: "t1" }));
    expect(ctx.entry.session).toBeNull();

    apply(ctx, event({ event: "session_started", threadId: "t1", turnId: "u1" }));
    expect(ctx.entry.session?.turnCount).toBe(1);

    apply(ctx, event({ event: "turn_completed", threadId: "t1", turnId: "u1" }));
    expect(ctx.entry.session?.turnCount).toBe(1);

    apply(ctx, event({ event: "session_started", threadId: "t1", turnId: "u2" }));
    expect(ctx.entry.session?.turnCount).toBe(2);
    expect(ctx.entry.session?.turnId).toBe("u2");
    expect(ctx.entry.session?.sessionId).toBe("t1-u2");
  });

  it("缺席字段不覆盖已有值，未知事件名可正常记录", () => {
    const ctx = makeCtx();

    apply(
      ctx,
      event({ event: "session_started", threadId: "t1", turnId: "u1", sessionId: "t1-u1", summary: "first" }),
    );
    apply(ctx, event({ event: "future_unknown_event", timestamp: 999, codexAppServerPid: null }));

    expect(ctx.entry.session?.lastCodexEvent).toBe("future_unknown_event");
    expect(ctx.entry.session?.lastCodexTimestamp).toBe(999);
    expect(ctx.entry.session?.lastCodexMessage).toBe("first");
    expect(ctx.entry.session?.codexAppServerPid).toBe("12");
  });

  it("usage 按绝对快照的正差额入账，重复不重复计、回退保留高水位", () => {
    const ctx = makeCtx();
    apply(ctx, event({ event: "session_started", threadId: "t1", turnId: "u1", sessionId: "t1-u1" }));

    const usageEvent = (inputTokens: number, outputTokens: number, totalTokens: number): AgentEvent =>
      event({
        event: "notification",
        threadId: "t1",
        turnId: "u1",
        usage: { inputTokens, outputTokens, totalTokens },
      });

    apply(ctx, usageEvent(100, 20, 120));
    expect(ctx.state.codexTotals).toMatchObject({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    expect(ctx.entry.session).toMatchObject({ codexInputTokens: 100, lastReportedInputTokens: 100 });

    apply(ctx, usageEvent(100, 20, 120));
    expect(ctx.state.codexTotals.inputTokens).toBe(100);

    apply(ctx, usageEvent(150, 30, 180));
    expect(ctx.state.codexTotals).toMatchObject({ inputTokens: 150, outputTokens: 30, totalTokens: 180 });

    apply(ctx, usageEvent(10, 2, 12));
    expect(ctx.state.codexTotals.inputTokens).toBe(150);
    expect(ctx.entry.session?.lastReportedInputTokens).toBe(150);
    expect(ctx.entry.session?.codexInputTokens).toBe(10);

    apply(ctx, usageEvent(160, 32, 192));
    expect(ctx.state.codexTotals).toMatchObject({ inputTokens: 160, outputTokens: 32, totalTokens: 192 });
  });

  it("rate limits 原样保存、不解释结构", () => {
    const ctx = makeCtx();
    const payload = { primary: { usedPercent: 40 }, secondary: null, extra: [1, "x"] };

    apply(ctx, event({ event: "notification", rateLimits: payload }));

    expect(ctx.state.codexRateLimits).toBe(payload);
  });
});

describe("applyAgentEvent — 审查 blocker 1：身份未齐的遥测缓存", () => {
  it("thread 绝对 usage 早于 turn 身份到达：仍入账并在 session 建立后回填", () => {
    const ctx = makeCtx();

    // 合法 thread 绝对 usage，尚无 turnId（turn/start 响应之前）。
    apply(
      ctx,
      event({
        event: "notification",
        threadId: "t1",
        usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 },
      }),
    );

    expect(ctx.entry.session).toBeNull();
    expect(ctx.state.codexTotals).toMatchObject({ inputTokens: 80, outputTokens: 40, totalTokens: 120 });
    expect(ctx.telemetry.pendingLastTimestamp).toBe(100);

    // 身份到位后回填 LiveSession，且不重复入账。
    apply(ctx, event({ event: "session_started", threadId: "t1", turnId: "u1", sessionId: "t1-u1", timestamp: 101 }));

    expect(ctx.entry.session).toMatchObject({
      sessionId: "t1-u1",
      threadId: "t1",
      turnId: "u1",
      codexInputTokens: 80,
      codexOutputTokens: 40,
      codexTotalTokens: 120,
      lastReportedInputTokens: 80,
      lastCodexTimestamp: 101,
      turnCount: 1,
    });
    expect(ctx.state.codexTotals).toMatchObject({ inputTokens: 80, outputTokens: 40, totalTokens: 120 });
  });

  it("身份始终未齐且最终启动失败：usage 不永久漏账", () => {
    const ctx = makeCtx();

    apply(
      ctx,
      event({
        event: "notification",
        threadId: "t1",
        usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 },
      }),
    );
    apply(ctx, event({ event: "startup_failed", timestamp: 200 }));

    expect(ctx.entry.session).toBeNull();
    expect(ctx.state.codexTotals).toMatchObject({ inputTokens: 80, outputTokens: 40, totalTokens: 120 });
  });
});

describe("applyAgentEvent — 审查 blocker 2：身份隔离与 turn 计数", () => {
  function established(): Ctx {
    const ctx = makeCtx();
    apply(ctx, event({ event: "session_started", threadId: "t1", turnId: "u1", sessionId: "t1-u1" }));
    return ctx;
  }

  it("异 thread 的 other_message 完全隔离：不改身份、不计数、不入账、不覆盖 last event", () => {
    const ctx = established();

    apply(
      ctx,
      event({
        event: "other_message",
        threadId: "different-thread",
        turnId: "u1",
        timestamp: 500,
        usage: { inputTokens: 9999, outputTokens: 9999, totalTokens: 9999 },
        summary: "foreign",
      }),
    );

    expect(ctx.entry.session?.threadId).toBe("t1");
    expect(ctx.entry.session?.turnId).toBe("u1");
    expect(ctx.entry.session?.turnCount).toBe(1);
    expect(ctx.entry.session?.lastCodexTimestamp).toBe(100);
    expect(ctx.state.codexTotals.inputTokens).toBe(0);
  });

  it("同 thread 异 turn 的 other_message 不推进身份 / 计数，也不重复计 token", () => {
    const ctx = established();

    apply(
      ctx,
      event({
        event: "other_message",
        threadId: "t1",
        turnId: "different-turn-id",
        timestamp: 500,
        usage: { inputTokens: 9999, outputTokens: 9999, totalTokens: 9999 },
      }),
    );

    expect(ctx.entry.session?.turnId).toBe("u1");
    expect(ctx.entry.session?.turnCount).toBe(1);
    // usage 属于当前 thread，正常入账并抬升高水位。
    expect(ctx.state.codexTotals.inputTokens).toBe(9999);
    expect(ctx.telemetry.baselines.get("t1")?.reportedInputTokens).toBe(9999);

    // 同一高水位下的重复快照不重复计。
    apply(
      ctx,
      event({
        event: "notification",
        threadId: "t1",
        turnId: "u1",
        usage: { inputTokens: 9999, outputTokens: 9999, totalTokens: 9999 },
      }),
    );
    expect(ctx.state.codexTotals.inputTokens).toBe(9999);
  });

  it("确认前夹入的异 thread completion（other_message）不得抢占 owner", () => {
    const ctx = makeCtx();

    // thread 身份尚未确认：异 thread completion 被 agent 映射为 other_message。
    apply(ctx, event({ event: "other_message", threadId: "foreign-thread-id", turnId: "foreign-turn-id" }));
    expect(ctx.telemetry.threadId).toBeNull();
    // 无任何遥测被写入（不抢占 owner、不建基线）。
    expect(ctx.telemetry.baselines.size).toBe(0);
    expect(ctx.entry.session).toBeNull();

    // 真实 thread 确认后一切正常，usage 正常入账。
    apply(ctx, event({ event: "session_started", threadId: "t1" }));
    apply(ctx, event({ event: "session_started", threadId: "t1", turnId: "u1", sessionId: "t1-u1" }));
    apply(
      ctx,
      event({
        event: "notification",
        threadId: "t1",
        turnId: "u1",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
    );

    expect(ctx.entry.session?.threadId).toBe("t1");
    expect(ctx.entry.session?.turnCount).toBe(1);
    expect(ctx.state.codexTotals).toMatchObject({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });

  it("候选 thread 与真实 thread 各自独立基线，不混用（候选额度保留）", () => {
    const ctx = makeCtx();

    // 确认前先到候选 thread 的 usage。
    apply(
      ctx,
      event({
        event: "notification",
        threadId: "candidate-thread",
        usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 },
      }),
    );
    expect(ctx.telemetry.baselines.get("candidate-thread")?.reportedTotalTokens).toBe(120);
    // 候选消耗已入账全局（保留，不反算）。
    expect(ctx.state.codexTotals.totalTokens).toBe(120);

    // 真实 thread 确认（与候选不同）：session 用真实 thread 自己的基线（缺失即 0）。
    apply(ctx, event({ event: "session_started", threadId: "real-thread", turnId: "u1", sessionId: "real-thread-u1" }));
    expect(ctx.telemetry.threadId).toBe("real-thread");
    expect(ctx.telemetry.baselines.get("real-thread")).toBeUndefined();
    expect(ctx.entry.session?.codexTotalTokens).toBe(0);

    // 真实 thread 的 usage 从自己的零基线计；候选额度不被混入。
    apply(
      ctx,
      event({
        event: "notification",
        threadId: "real-thread",
        turnId: "u1",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
    );
    expect(ctx.entry.session?.lastReportedTotalTokens).toBe(150);
    expect(ctx.telemetry.baselines.get("candidate-thread")?.reportedTotalTokens).toBe(120);
    // 120（候选）+ 150（真实增量）= 270。
    expect(ctx.state.codexTotals.totalTokens).toBe(270);
  });

  it("审查 blocker：A→B→A 交错候选快照不重复入账", () => {
    const ctx = makeCtx();

    const candidate = (threadId: string, total: number): AgentEvent =>
      event({
        event: "notification",
        threadId,
        usage: { inputTokens: total, outputTokens: 0, totalTokens: total },
      });

    apply(ctx, candidate("A", 100));
    apply(ctx, candidate("B", 20));
    // 切回 A 的相同绝对快照：A 自己的高水位已含 100，重复不计。
    apply(ctx, candidate("A", 100));
    expect(ctx.state.codexTotals.totalTokens).toBe(120);

    // 确认 owner=A 并继续上报 A=150：只入账 50 的增量。
    apply(ctx, event({ event: "session_started", threadId: "A", turnId: "u1", sessionId: "A-u1" }));
    expect(ctx.entry.session?.codexTotalTokens).toBe(100);
    apply(ctx, candidate("A", 150));

    expect(ctx.state.codexTotals.totalTokens).toBe(170);
    expect(ctx.state.codexTotals.inputTokens).toBe(170);
    expect(ctx.entry.session?.codexTotalTokens).toBe(150);
    expect(ctx.entry.session?.lastReportedTotalTokens).toBe(150);
  });

  it("复现 app-server fixture 的 interleaved-other-completed 序列：真实 turn 数保持 1", () => {
    const ctx = makeCtx();

    apply(ctx, event({ event: "session_started", threadId: "t1" }));
    apply(ctx, event({ event: "session_started", threadId: "t1", turnId: "u1", sessionId: "t1-u1" }));
    apply(ctx, event({ event: "other_message", threadId: "different-thread-id", turnId: "u1" }));
    apply(ctx, event({ event: "other_message", threadId: "t1", turnId: "different-turn-id" }));
    apply(ctx, event({ event: "turn_completed", threadId: "t1", turnId: "u1" }));

    expect(ctx.entry.session?.turnCount).toBe(1);
    expect(ctx.entry.session?.turnId).toBe("u1");
    expect(ctx.entry.session?.threadId).toBe("t1");
    expect(ctx.telemetry.turnCount).toBe(1);
  });
});
