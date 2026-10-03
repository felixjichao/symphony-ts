/**
 * M5.2 dispatch + worker lifecycle 测试（SPEC §7.3 / §7.4、§16.4 / §16.5、§17.4）。
 *
 * 从包公共面 import；runner 用受控 fake 注入，从而可以确定性地驱动"启动中 /
 * 握手失败 / 正常完成 / 停止竞争"等时序，并断言真实 state 与 worker 世界结果
 * （running / claimed / retry / completed / outcome 次数）。
 */
import { AgentError, type AgentAttemptOptions, type AgentAttemptResult, type AgentEvent } from "@symphony/agent";
import type { Issue, OrchestratorRuntimeState } from "@symphony/domain";
import { describe, expect, it } from "vitest";

import {
  OrchestratorAuthority,
  createOrchestratorRuntimeState,
  type AgentAttemptRunner,
  type AttemptContext,
  type AttemptOptionsFactory,
  type DispatchPolicy,
  type WorkerTerminalOutcome,
} from "./index";

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
    title: "Dispatch me",
    description: null,
    priority: 1,
    state: "Todo",
    branchName: null,
    url: null,
    assigneeId: null,
    labels: [],
    blockedBy: [],
    dispatchable: true,
    createdAt: 1000,
    updatedAt: null,
    ...overrides,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeRunner {
  public readonly contexts: AttemptContext[] = [];
  public readonly options: AgentAttemptOptions[] = [];
  private readonly deferreds: Deferred<AgentAttemptResult>[] = [];

  public readonly run: AgentAttemptRunner = (options) => {
    this.options.push(options);
    const d = deferred<AgentAttemptResult>();
    this.deferreds.push(d);
    return d.promise;
  };

  public get last(): Deferred<AgentAttemptResult> {
    const d = this.deferreds.at(-1);
    if (d === undefined) {
      throw new Error("runner has not been invoked");
    }
    return d;
  }

  public successResult(issue: Issue): AgentAttemptResult {
    return {
      workspace: { path: "/tmp/ws/ABC-1", workspaceKey: "ABC-1", createdNow: false },
      issue,
      threadId: "thread-1",
      turnCount: 1,
      lastTurn: { turnId: "turn-1", sessionId: "thread-1-turn-1" },
      stopReason: "decider_stop",
    };
  }
}

interface Harness {
  readonly authority: OrchestratorAuthority;
  readonly state: OrchestratorRuntimeState;
  readonly runner: FakeRunner;
  readonly outcomes: WorkerTerminalOutcome[];
  readonly cancelledRetries: string[];
  readonly contexts: AttemptContext[];
}

function makeHarness(
  overrides: Partial<{
    policy: DispatchPolicy;
    onOutcome: (outcome: WorkerTerminalOutcome) => void;
    runner: AgentAttemptRunner;
    createAttemptOptions: AttemptOptionsFactory;
    cancelRetry: (issueId: string) => void;
  }> = {},
): Harness {
  const state = createOrchestratorRuntimeState({ pollIntervalMs: 30_000, maxConcurrentAgents: 10 });
  const runner = new FakeRunner();
  const outcomes: WorkerTerminalOutcome[] = [];
  const cancelledRetries: string[] = [];
  const contexts: AttemptContext[] = [];
  let clock = 1_000;
  const monotonic = 5_000;

  const createAttemptOptions: AttemptOptionsFactory = (context) => {
    contexts.push(context);
    return { issue: context.issue, attempt: context.attempt } as unknown as AgentAttemptOptions;
  };

  const authority = new OrchestratorAuthority({
    state,
    policy: overrides.policy ?? POLICY,
    runner: overrides.runner ?? runner.run,
    createAttemptOptions: overrides.createAttemptOptions ?? createAttemptOptions,
    tracker: { fetchIssuesByIds: async () => [] },
    resolveWorkspacePath: (issue) => `/tmp/ws/${issue.identifier}`,
    now: () => clock++,
    monotonicNow: () => monotonic,
    cancelRetry: overrides.cancelRetry ?? ((issueId) => cancelledRetries.push(issueId)),
    onOutcome: (outcome) => {
      outcomes.push(outcome);
      overrides.onOutcome?.(outcome);
    },
  });

  return { authority, state, runner, outcomes, cancelledRetries, contexts };
}

describe("OrchestratorAuthority.dispatchIssue — 验收 01/02/03", () => {
  it("成功 dispatch 后原子进入 claimed+running，并清除同 issue retry entry + timer", () => {
    const { authority, state, cancelledRetries, contexts } = makeHarness();
    const issue = makeIssue();
    state.retryAttempts.set(issue.id, {
      issueId: issue.id,
      identifier: issue.identifier,
      attempt: 2,
      dueAtMs: 0,
      timerHandle: "timer",
      error: null,
    });

    const result = authority.dispatchIssue(issue);

    expect(result.kind).toBe("dispatched");
    expect(state.running.has(issue.id)).toBe(true);
    expect(state.claimed.has(issue.id)).toBe(true);
    expect(state.retryAttempts.has(issue.id)).toBe(false);
    expect(cancelledRetries).toEqual([issue.id]);
    expect(state.running.get(issue.id)?.attempt.status).toBe("preparing_workspace");
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.signal.aborted).toBe(false);
  });

  it("cancelRetry 同步抛错时进入一致的失败路径：不写入 running/claim、不丢 retry 所有权", () => {
    const { authority, state, runner } = makeHarness({
      cancelRetry: () => {
        throw new Error("timer cancel failed");
      },
    });
    const issue = makeIssue();
    const retryEntry = {
      issueId: issue.id,
      identifier: issue.identifier,
      attempt: 2,
      dueAtMs: 0,
      timerHandle: "timer",
      error: null,
    };
    state.retryAttempts.set(issue.id, retryEntry);

    const result = authority.dispatchIssue(issue);

    expect(result.kind).toBe("failed");
    expect(result.error).toBe("timer cancel failed");
    expect(state.running.size).toBe(0);
    expect(state.claimed.size).toBe(0);
    expect(authority.activeWorkerCount).toBe(0);
    // retry 条目与 timer 所有权原样保留，下一次 tick 可重试。
    expect(state.retryAttempts.get(issue.id)).toBe(retryEntry);
    // runner 从未被调用：FakeRunner.run 写入 options 数组。
    expect(runner.options).toHaveLength(0);
  });

  it("claimed 或 running 已占用时拒绝重复 dispatch", () => {
    const { authority, state } = makeHarness();
    const issue = makeIssue();

    expect(authority.dispatchIssue(issue).kind).toBe("dispatched");
    expect(authority.dispatchIssue(issue).kind).toBe("skipped");
    expect(authority.activeWorkerCount).toBe(1);

    // 先从 running 移除，claim 仍在 → 仍跳过。
    state.running.delete(issue.id);
    expect(authority.dispatchIssue(issue).kind).toBe("skipped");
  });

  it("不满足 eligibility 的 issue 不 dispatch、不改 state", () => {
    const { authority, state } = makeHarness();
    const issue = makeIssue({ state: "Done" });

    expect(authority.dispatchIssue(issue).kind).toBe("not_eligible");
    expect(state.running.size).toBe(0);
    expect(state.claimed.size).toBe(0);
    expect(authority.activeWorkerCount).toBe(0);
  });

  it("worker 启动失败不留 running 脏项，并统一归约为 failure outcome", async () => {
    const { authority, state, runner, outcomes } = makeHarness();
    const issue = makeIssue();

    authority.dispatchIssue(issue);
    runner.last.reject(new AgentError("launch_failed", "boom"));
    await authority.waitForIdle();

    expect(state.running.has(issue.id)).toBe(false);
    expect(state.claimed.has(issue.id)).toBe(false);
    expect(state.completed.has(issue.id)).toBe(false);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      status: "failed",
      error: "launch_failed",
      suppressRetry: false,
      retryKind: "failure",
    });
  });

  it("runner 同步抛出也不留 running 脏项", async () => {
    const throwSync = (() => {
      throw new Error("sync boom");
    }) as unknown as AgentAttemptRunner;
    const { authority, state, outcomes } = makeHarness({ runner: throwSync });
    const issue = makeIssue();

    expect(authority.dispatchIssue(issue).kind).toBe("dispatched");
    await authority.waitForIdle();

    expect(state.running.has(issue.id)).toBe(false);
    expect(state.claimed.has(issue.id)).toBe(false);
    expect(outcomes[0]?.status).toBe("failed");
  });

  it("attempt options 构造同步抛出也不留 running 脏项", async () => {
    const throwingFactory: AttemptOptionsFactory = () => {
      throw new Error("options boom");
    };
    const { authority, state, outcomes } = makeHarness({ createAttemptOptions: throwingFactory });
    const issue = makeIssue();

    // dispatch 仍报告 accepted（提交已完成），但同步失败被归约为异常 outcome。
    expect(() => authority.dispatchIssue(issue)).not.toThrow();
    await authority.waitForIdle();

    expect(state.running.has(issue.id)).toBe(false);
    expect(state.claimed.has(issue.id)).toBe(false);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("failed");
  });

  it("正常完成后完成记账、进入 completed 且可再次 dispatch（completed 不抑制）", async () => {
    const { authority, state, runner, outcomes } = makeHarness();
    const issue = makeIssue();

    authority.dispatchIssue(issue);
    runner.last.resolve(runner.successResult(issue));
    await authority.waitForIdle();

    expect(state.running.has(issue.id)).toBe(false);
    expect(state.claimed.has(issue.id)).toBe(false);
    expect(state.completed.has(issue.id)).toBe(true);
    expect(state.codexTotals.secondsRunning).toBe(0);
    expect(outcomes[0]).toMatchObject({ status: "succeeded", retryKind: "continuation" });

    // completed 仅记账：同一 issue 仍可再次 dispatch。
    expect(authority.dispatchIssue(issue).kind).toBe("dispatched");
  });
});

describe("WorkerControl — 验收 04/09", () => {
  it("stop 幂等、abort signal、outcome 只处理一次，并等待真实收尾", async () => {
    const { authority, state, runner, outcomes, contexts } = makeHarness();
    const issue = makeIssue();
    authority.dispatchIssue(issue);
    const handle = authority.getWorker(issue.id);
    expect(handle).toBeDefined();
    const context = contexts[0]!;
    expect(context.signal.aborted).toBe(false);

    const first = handle!.stop({ kind: "reconciliation" });
    const second = handle!.stop({ kind: "reconciliation" });
    expect(first).toBe(second);
    expect(context.signal.aborted).toBe(true);
    expect(handle!.stopped).toBe(true);

    // runner 尚未完成收尾：stop 不应提前 resolve。
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    // 模拟取消后 runner 正常收尾（agent 会抛取消错误）。
    runner.last.reject(new AgentError("turn_cancelled", "cancelled"));
    await first;

    expect(state.running.has(issue.id)).toBe(false);
    expect(state.claimed.has(issue.id)).toBe(false);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      status: "canceled_by_reconciliation",
      suppressRetry: true,
      retryKind: "none",
    });
  });

  it("stall stop 映射为 stalled 且 retryKind=failure", async () => {
    const { authority, state, runner, outcomes } = makeHarness();
    const issue = makeIssue();
    authority.dispatchIssue(issue);
    const handle = authority.getWorker(issue.id)!;

    const stopped = handle.stop({ kind: "stall" });
    runner.last.reject(new AgentError("turn_cancelled", "cancelled"));
    await stopped;
    await authority.waitForIdle();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: "stalled", retryKind: "failure", suppressRetry: false });
    expect(state.running.has(issue.id)).toBe(false);
  });

  it("shutdown stop 通过 outcome 抑制 retry，不新增 domain 状态", async () => {
    const { authority, runner, outcomes } = makeHarness();
    const issue = makeIssue();
    authority.dispatchIssue(issue);
    const handle = authority.getWorker(issue.id)!;

    const stopped = handle.stop({ kind: "shutdown" });
    runner.last.reject(new AgentError("turn_cancelled", "cancelled"));
    await stopped;
    await authority.waitForIdle();

    expect(outcomes[0]).toMatchObject({ status: "failed", suppressRetry: true, retryKind: "none" });
  });

  it("onOutcome 建立 retry entry 时保留 claim（M5.3 契约）", async () => {
    const { authority, state, runner } = makeHarness({
      onOutcome: (outcome) => {
        state.retryAttempts.set(outcome.issueId, {
          issueId: outcome.issueId,
          identifier: outcome.issueIdentifier,
          attempt: (outcome.attempt ?? 0) + 1,
          dueAtMs: 0,
          timerHandle: null,
          error: outcome.error,
        });
      },
    });
    const issue = makeIssue();
    authority.dispatchIssue(issue);
    runner.last.reject(new AgentError("port_exit", "exited"));
    await authority.waitForIdle();

    expect(state.claimed.has(issue.id)).toBe(true);
    expect(state.retryAttempts.has(issue.id)).toBe(true);
  });
});

describe("attempt token 隔离 — 验收 06 前置", () => {
  it("已结束 worker 的迟到事件不污染新 attempt", async () => {
    const { authority, state, runner, contexts } = makeHarness();
    const issue = makeIssue();

    authority.dispatchIssue(issue);
    const firstContext = contexts[0]!;
    runner.last.resolve(runner.successResult(issue));
    await authority.waitForIdle();

    authority.dispatchIssue(issue);
    const secondContext = contexts[1]!;

    const secondEvent: AgentEvent = {
      event: "session_started",
      timestamp: 10,
      codexAppServerPid: "42",
      threadId: "thread-B",
      turnId: "turn-B",
      sessionId: "thread-B-turn-B",
      summary: "B started",
    };
    secondContext.onEvent(secondEvent);
    expect(state.running.get(issue.id)?.session?.threadId).toBe("thread-B");

    // 旧 attempt 的迟到事件被 token 隔离丢弃。
    firstContext.onEvent({
      event: "session_started",
      timestamp: 11,
      codexAppServerPid: "7",
      threadId: "thread-A",
      turnId: "turn-A",
      sessionId: "thread-A-turn-A",
      summary: "A late",
    });
    expect(state.running.get(issue.id)?.session?.threadId).toBe("thread-B");
  });
});
