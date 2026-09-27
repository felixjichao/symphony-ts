/**
 * SPEC §4.1.6 Live Session / §4.2 Session ID 的纯逻辑与类型契约测试。
 */
import { describe, expect, it } from "vitest";

import {
  composeSessionId,
  type CodexEventName,
  type LiveSession,
} from "./index";

describe("composeSessionId (SPEC §4.2 Session ID)", () => {
  it("composes <thread_id>-<turn_id>", () => {
    expect(composeSessionId("thread-abc", "turn-1")).toBe("thread-abc-turn-1");
    expect(composeSessionId("t", "u")).toBe("t-u");
  });
});

describe("LiveSession contract (SPEC §4.1.6)", () => {
  const threadId = "thread-abc";
  const turnId = "turn-1";

  function makeSession(): LiveSession {
    return {
      sessionId: composeSessionId(threadId, turnId),
      threadId,
      turnId,
      codexAppServerPid: null,
      lastCodexEvent: null,
      lastCodexTimestamp: null,
      lastCodexMessage: null,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
      lastReportedInputTokens: 0,
      lastReportedOutputTokens: 0,
      lastReportedTotalTokens: 0,
      turnCount: 0,
    };
  }

  it("models a freshly started session with all fields present (nullable → null)", () => {
    const session = makeSession();
    expect(session.sessionId).toBe("thread-abc-turn-1");
    expect(Object.keys(session).sort()).toEqual([
      "codexAppServerPid",
      "codexInputTokens",
      "codexOutputTokens",
      "codexTotalTokens",
      "lastCodexEvent",
      "lastCodexMessage",
      "lastCodexTimestamp",
      "lastReportedInputTokens",
      "lastReportedOutputTokens",
      "lastReportedTotalTokens",
      "sessionId",
      "threadId",
      "turnCount",
      "turnId",
    ]);
    expect(session.lastCodexEvent).toBeNull();
    expect(session.turnCount).toBe(0);
  });

  it("is a mutable runtime record updated in place on codex events (§7.3)", () => {
    const session = makeSession();
    const eventName: CodexEventName = "session_started";
    session.lastCodexEvent = eventName;
    session.lastCodexTimestamp = Date.UTC(2026, 8, 27, 4, 0, 0);
    session.codexAppServerPid = "4242";
    session.turnCount = 1;
    // §13.5：绝对累计更新后，按 delta 入账并同步 lastReported*。
    session.codexInputTokens = 120;
    session.codexOutputTokens = 30;
    session.codexTotalTokens = 150;
    session.lastReportedInputTokens = 120;
    session.lastReportedOutputTokens = 30;
    session.lastReportedTotalTokens = 150;

    expect(session.lastCodexEvent).toBe("session_started");
    expect(session.codexAppServerPid).toBe("4242");
    expect(session.codexTotalTokens).toBe(
      session.lastReportedTotalTokens,
    );
  });
});
