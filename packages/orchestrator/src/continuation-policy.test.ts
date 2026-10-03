/**
 * 同线程 continuation decider 测试（SPEC §10.2 / §10.3、§8.2，M5.2 / #51）。
 *
 * 验证：active+routable 续跑、terminal / missing / inactive / unroutable 停止、
 * refresh 失败 / 超时分类、取消后迟到 refresh 不写状态，以及 agent 侧的
 * continuation 契约收敛。
 */
import {
  AgentError,
  executeContinuationDecider,
  type AgentEvent,
  type ContinuationDecider,
  type TurnCompletedContext,
} from "@symphony/agent";
import type { Issue } from "@symphony/domain";
import { describe, expect, it } from "vitest";

import { createTrackerRefreshContinuationDecider, type DispatchPolicy } from "./index";

const POLICY: DispatchPolicy = {
  activeStates: ["Todo", "In Progress"],
  terminalStates: ["Done", "Cancelled"],
  requiredLabels: [],
  maxConcurrentAgentsByState: {},
};

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    nativeRef: null,
    identifier: "ABC-1",
    title: "Continue?",
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
    ...overrides,
  };
}

const EVENT: AgentEvent = {
  event: "turn_completed",
  timestamp: 1,
  codexAppServerPid: "1",
  threadId: "t1",
  turnId: "u1",
};

function context(issue: Issue, signal?: AbortSignal): TurnCompletedContext {
  return {
    issue,
    threadId: "t1",
    turnId: "u1",
    turnCount: 1,
    event: EVENT,
    ...(signal !== undefined ? { signal } : {}),
  };
}

function makeDecider(
  fetch: (ids: readonly string[]) => Promise<readonly Issue[]>,
  onRefreshed: (issue: Issue) => void = () => {},
  policy: DispatchPolicy = POLICY,
): ContinuationDecider {
  return createTrackerRefreshContinuationDecider({
    tracker: { fetchIssuesByIds: (ids) => fetch(ids) },
    policy,
    isCurrent: () => true,
    onRefreshed,
  });
}

describe("createTrackerRefreshContinuationDecider — 验收 05", () => {
  it("active + routable → 回写快照并 continue", async () => {
    const refreshed = makeIssue({ state: "In Progress" });
    const seen: Issue[] = [];
    const decider = makeDecider(async () => [refreshed], (issue) => seen.push(issue));

    const decision = await decider(context(makeIssue()));

    expect(decision).toEqual({ kind: "continue", issue: refreshed });
    expect(seen).toEqual([refreshed]);
  });

  it("terminal / inactive / missing / unroutable → stop（仍回写有效快照）", async () => {
    for (const [name, issue] of [
      ["terminal", makeIssue({ state: "Done" })],
      ["inactive", makeIssue({ state: "Backlog" })],
      ["unroutable", makeIssue({ dispatchable: false })],
    ] as const) {
      const seen: Issue[] = [];
      const decider = makeDecider(async () => [issue], (i) => seen.push(i));
      const decision = await decider(context(makeIssue()));
      expect(decision, name).toEqual({ kind: "stop" });
      expect(seen, name).toEqual([issue]);
    }

    const missingDecider = makeDecider(async () => []);
    expect(await missingDecider(context(makeIssue()))).toEqual({ kind: "stop" });
  });

  it("refresh 失败经 executeContinuationDecider 收敛为 continuation_failed", async () => {
    const decider = makeDecider(async () => {
      throw new Error("network down");
    });

    await expect(
      executeContinuationDecider(decider, context(makeIssue()), 1000),
    ).rejects.toMatchObject({ code: "continuation_failed" });
  });

  it("refresh 超时收敛为 continuation_timeout", async () => {
    const decider = makeDecider(() => new Promise<readonly Issue[]>(() => {}));

    await expect(
      executeContinuationDecider(decider, context(makeIssue()), 20),
    ).rejects.toMatchObject({ code: "continuation_timeout" });
  });

  it("取消后迟到 refresh 不写状态并停止", async () => {
    const controller = new AbortController();
    const seen: Issue[] = [];
    const decider = makeDecider(async () => [makeIssue({ state: "In Progress" })], (i) => seen.push(i));
    controller.abort();

    const decision = await decider(context(makeIssue(), controller.signal));

    expect(decision).toEqual({ kind: "stop" });
    expect(seen).toEqual([]);
  });

  it("attempt 已过期（isCurrent=false）时不 fetch、不写状态", async () => {
    let fetched = 0;
    const seen: Issue[] = [];
    const decider = createTrackerRefreshContinuationDecider({
      tracker: {
        fetchIssuesByIds: async () => {
          fetched += 1;
          return [makeIssue()];
        },
      },
      policy: POLICY,
      isCurrent: () => false,
      onRefreshed: (issue) => seen.push(issue),
    });

    expect(await decider(context(makeIssue()))).toEqual({ kind: "stop" });
    expect(fetched).toBe(0);
    expect(seen).toEqual([]);
  });
});

describe("continuation 分层契约", () => {
  it("AgentError 取消码可用于区分主动取消", () => {
    const error = new AgentError("turn_cancelled", "cancelled");
    expect(error.code).toBe("turn_cancelled");
  });
});
