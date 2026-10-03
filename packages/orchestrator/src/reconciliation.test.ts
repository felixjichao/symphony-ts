/**
 * M5.4 active-run reconciliation / stall detection 测试（SPEC §7.3 / §7.4、§8.5、
 * §14.2、§16.3、§17.4｜验收 01–08、11）。
 *
 * 从包公共面 import；runner、timer、tracker、cleanup 端口全部用受控 fake 注入，
 * 因此可以确定性驱动 "stall → refresh → update / stop / cleanup / missing /
 * refresh-failure" 全分支，并覆盖自然退出与刷新结果的竞态。不使用真实 sleep。
 */
import { AgentError, type AgentAttemptOptions, type AgentAttemptResult } from "@symphony/agent";
import type { Issue, OrchestratorRuntimeState, RunningEntry } from "@symphony/domain";
import { describe, expect, it } from "vitest";

import {
  OrchestratorAuthority,
  createOrchestratorRuntimeState,
  decideReconciliationAction,
  isStallDetectionEnabled,
  isWorkerStalled,
  stallElapsedMs,
  type AgentAttemptRunner,
  type AttemptContext,
  type AttemptOptionsFactory,
  type DispatchPolicy,
  type ReconciliationResult,
  type RetryDiagnostic,
  type RetryScheduler,
  type WorkerTerminalOutcome,
} from "./index";
import type { AgentTelemetryState } from "./agent-events";

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
    title: "Reconcile me",
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

/** 让已排队 microtask / 一帧 setTimeout 跑完。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

class FakeRunner {
  public readonly options: AgentAttemptOptions[] = [];
  public readonly signals: Array<AbortSignal | undefined> = [];
  private readonly deferreds: Deferred<AgentAttemptResult>[] = [];

  public readonly run: AgentAttemptRunner = (options) => {
    this.options.push(options);
    this.signals.push(options.signal);
    const d = deferred<AgentAttemptResult>();
    this.deferreds.push(d);
    // 收到取消信号即像真实 runner 一样收尾失败（底层 port_exit），authority 依
    // 主动 stop reason 分类。
    const signal = options.signal;
    const onAbort = (): void => {
      d.reject(new AgentError("port_exit", "worker aborted"));
    };
    if (signal?.aborted === true) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    return d.promise;
  };

  public get last(): Deferred<AgentAttemptResult> {
    const d = this.deferreds.at(-1);
    if (d === undefined) {
      throw new Error("runner has not been invoked");
    }
    return d;
  }

  public at(index: number): Deferred<AgentAttemptResult> {
    const d = this.deferreds[index];
    if (d === undefined) {
      throw new Error(`runner attempt ${index} has not been invoked`);
    }
    return d;
  }

  public successResult(issue: Issue): AgentAttemptResult {
    return {
      workspace: { path: `/tmp/ws/${issue.identifier}`, workspaceKey: issue.identifier, createdNow: false },
      issue,
      threadId: "thread-1",
      turnCount: 1,
      lastTurn: { turnId: "turn-1", sessionId: "thread-1-turn-1" },
      stopReason: "decider_stop",
    };
  }
}

interface ScheduledTimer {
  readonly id: number;
  readonly delayMs: number;
  readonly callback: () => void;
  cancelled: boolean;
  fired: boolean;
}

class ManualScheduler implements RetryScheduler {
  public readonly timers: ScheduledTimer[] = [];
  private next = 0;

  public schedule(delayMs: number, callback: () => void): unknown {
    const id = ++this.next;
    this.timers.push({ id, delayMs, callback, cancelled: false, fired: false });
    return id;
  }

  public cancel(handle: unknown): void {
    const timer = this.timers.find((candidate) => candidate.id === handle);
    if (timer !== undefined) {
      timer.cancelled = true;
    }
  }

  public fire(handle: unknown): boolean {
    const timer = this.timers.find((candidate) => candidate.id === handle);
    if (timer === undefined || timer.cancelled || timer.fired) {
      return false;
    }
    timer.fired = true;
    timer.callback();
    return true;
  }

  public fireRaw(handle: unknown): void {
    const timer = this.timers.find((candidate) => candidate.id === handle);
    if (timer !== undefined) {
      timer.callback();
    }
  }

  public timerFor(handle: unknown): ScheduledTimer | undefined {
    return this.timers.find((candidate) => candidate.id === handle);
  }
}

class FakeTracker {
  public fail = false;
  public nextFetch: Promise<readonly Issue[]> | null = null;
  public terminalFail = false;
  public terminalIssues: readonly Issue[] = [];
  public readonly issues = new Map<string, Issue>();
  public readonly calls: string[][] = [];
  public readonly terminalCalls: string[][] = [];

  public async fetchIssuesByIds(ids: readonly string[]): Promise<readonly Issue[]> {
    this.calls.push([...ids]);
    if (this.nextFetch !== null) {
      const pending = this.nextFetch;
      this.nextFetch = null;
      return pending;
    }
    if (this.fail) {
      throw new Error("tracker down");
    }
    return ids
      .map((id) => this.issues.get(id))
      .filter((issue): issue is Issue => issue !== undefined);
  }

  public async fetchIssuesByStates(stateNames: readonly string[]): Promise<readonly Issue[]> {
    this.terminalCalls.push([...stateNames]);
    if (this.terminalFail) {
      throw new Error("terminal fetch down");
    }
    return this.terminalIssues;
  }
}

type CleanupStatus = "removed" | "missing" | "refused" | "failed";

interface Harness {
  readonly authority: OrchestratorAuthority;
  readonly state: OrchestratorRuntimeState;
  readonly runner: FakeRunner;
  readonly scheduler: ManualScheduler;
  readonly tracker: FakeTracker;
  readonly outcomes: WorkerTerminalOutcome[];
  readonly diagnostics: RetryDiagnostic[];
  readonly cleanupCalls: string[];
  readonly contexts: AttemptContext[];
  setUtc(value: number): void;
  setStall(value: number): void;
  setCleanupStatus(status: CleanupStatus): void;
}

function makeHarness(): Harness {
  const state = createOrchestratorRuntimeState({ pollIntervalMs: 30_000, maxConcurrentAgents: 10 });
  const runner = new FakeRunner();
  const scheduler = new ManualScheduler();
  const tracker = new FakeTracker();
  const outcomes: WorkerTerminalOutcome[] = [];
  const diagnostics: RetryDiagnostic[] = [];
  const cleanupCalls: string[] = [];
  const contexts: AttemptContext[] = [];
  let utc = 1_000_000;
  let stall = 0;
  let cleanupStatus: CleanupStatus = "removed";

  const createAttemptOptions: AttemptOptionsFactory = (context) => {
    contexts.push(context);
    return {
      issue: context.issue,
      attempt: context.attempt,
      signal: context.signal,
    } as unknown as AgentAttemptOptions;
  };

  const cleanupWorkspace = {
    removeWorkspace: async (identifier: string): Promise<{ status: CleanupStatus }> => {
      cleanupCalls.push(identifier);
      return { status: cleanupStatus };
    },
  };

  const authority = new OrchestratorAuthority({
    state,
    policy: POLICY,
    runner: runner.run,
    createAttemptOptions,
    tracker,
    resolveWorkspacePath: (issue) => `/tmp/ws/${issue.identifier}`,
    now: () => utc,
    monotonicNow: () => 5_000,
    onOutcome: (outcome) => outcomes.push(outcome),
    stallTimeoutMs: () => stall,
    cleanupWorkspace,
    onCleanupDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    retry: {
      scheduler,
      maxRetryBackoffMs: () => 300_000,
      // 顶层 cleanup 端口应优先；此端口故意用不同 marker，若被使用会被断言暴露。
      cleanupWorkspace: {
        removeWorkspace: async () => {
          cleanupCalls.push("used-retry-port");
          return { status: "removed" as const };
        },
      },
    },
  });

  return {
    authority,
    state,
    runner,
    scheduler,
    tracker,
    outcomes,
    diagnostics,
    cleanupCalls,
    contexts,
    setUtc: (value) => {
      utc = value;
    },
    setStall: (value) => {
      stall = value;
    },
    setCleanupStatus: (status) => {
      cleanupStatus = status;
    },
  };
}

function runningEntry(h: Harness, issueId: string): RunningEntry {
  const entry = h.state.running.get(issueId);
  if (entry === undefined) {
    throw new Error(`no running entry for ${issueId}`);
  }
  return entry;
}

const UNKNOWN_TELEMETRY: AgentTelemetryState = {
  threadId: null,
  turnId: null,
  turnCount: 0,
  baselines: new Map(),
  pendingLastEvent: null,
  pendingLastTimestamp: null,
  pendingLastMessage: null,
  pendingPid: null,
};

function entryWithStartedAt(startedAt: number): RunningEntry {
  return {
    issue: makeIssue(),
    attempt: {
      issueId: "issue-1",
      issueIdentifier: "ABC-1",
      attempt: null,
      workspacePath: "/tmp/ws/ABC-1",
      startedAt,
      status: "streaming_turn",
    },
    session: null,
    workspacePath: "/tmp/ws/ABC-1",
    startedAtMs: 5_000,
    workerHandle: null,
  };
}

describe("reconciliation 纯判定", () => {
  it("decideReconciliationAction：terminal 优先、active+routable refresh、其余 stop", () => {
    expect(decideReconciliationAction(makeIssue({ state: "Done" }), POLICY)).toBe("stop_and_cleanup");
    expect(decideReconciliationAction(makeIssue({ state: "in progress" }), POLICY)).toBe("refresh_snapshot");
    expect(decideReconciliationAction(makeIssue({ state: "Paused" }), POLICY)).toBe("stop");
    expect(decideReconciliationAction(makeIssue({ state: "Todo", dispatchable: false }), POLICY)).toBe("stop");
  });

  it("stall 边界：禁用、elapsed == timeout 不触发、严格大于才触发", () => {
    const entry = entryWithStartedAt(1_000);
    expect(isStallDetectionEnabled(0)).toBe(false);
    expect(isStallDetectionEnabled(-1)).toBe(false);
    expect(isStallDetectionEnabled(Number.NaN)).toBe(false);
    expect(isStallDetectionEnabled(500)).toBe(true);

    expect(stallElapsedMs(entry, UNKNOWN_TELEMETRY, 900)).toBe(0); // 负差值按 0
    expect(stallElapsedMs(entry, UNKNOWN_TELEMETRY, 1_500)).toBe(500);
    expect(isWorkerStalled(entry, UNKNOWN_TELEMETRY, 1_500, 500)).toBe(false); // 等于阈值不触发
    expect(isWorkerStalled(entry, UNKNOWN_TELEMETRY, 1_501, 500)).toBe(true);
    expect(isWorkerStalled(entry, UNKNOWN_TELEMETRY, 1_501, 0)).toBe(false); // 禁用
  });

  it("有 agent event 时以最近事件时间戳为基准（含身份未齐的暂存时间戳）", () => {
    const entry = entryWithStartedAt(1_000);
    const telemetry: AgentTelemetryState = { ...UNKNOWN_TELEMETRY, pendingLastTimestamp: 1_900 };
    // startedAt 距今 1000ms，但事件时间戳距今 100ms → 不 stall。
    expect(stallElapsedMs(entry, telemetry, 2_000)).toBe(100);
    expect(isWorkerStalled(entry, telemetry, 2_000, 500)).toBe(false);

    const withSession: RunningEntry = {
      ...entry,
      session: {
        sessionId: "t-u",
        threadId: "t",
        turnId: "u",
        codexAppServerPid: null,
        lastCodexEvent: "turn_started",
        lastCodexTimestamp: 1_990,
        lastCodexMessage: null,
        codexInputTokens: 0,
        codexOutputTokens: 0,
        codexTotalTokens: 0,
        lastReportedInputTokens: 0,
        lastReportedOutputTokens: 0,
        lastReportedTotalTokens: 0,
        turnCount: 1,
      },
    };
    expect(stallElapsedMs(withSession, UNKNOWN_TELEMETRY, 2_000)).toBe(10);
  });
});

describe("reconcileRunningIssues — 验收 01 / 02 / 03 / 04 / 05 / 06", () => {
  it("验收 01：无 running 时 no-op 且零 tracker 请求", async () => {
    const h = makeHarness();
    const result: ReconciliationResult = await h.authority.reconcileRunningIssues();
    expect(result.scannedIssueIds).toEqual([]);
    expect(result.refreshFailed).toBe(false);
    expect(h.tracker.calls).toHaveLength(0);
    expect(h.cleanupCalls).toHaveLength(0);
  });

  it("验收 02：active + routable 更新 running entry 的完整 issue snapshot", async () => {
    const h = makeHarness();
    const issue = makeIssue({ state: "Todo" });
    h.tracker.issues.set(issue.id, issue);
    h.authority.dispatchIssue(issue);

    const refreshed = makeIssue({ state: "In Progress", title: "new title", labels: ["x"] });
    h.tracker.issues.set(issue.id, refreshed);

    const result = await h.authority.reconcileRunningIssues();
    expect(h.tracker.calls).toEqual([[issue.id]]);
    expect(result.updatedIssueIds).toEqual([issue.id]);
    const entry = runningEntry(h, issue.id);
    expect(entry.issue).toBe(refreshed);
    expect(h.authority.activeWorkerCount).toBe(1);
    expect(h.outcomes).toHaveLength(0);
  });

  it("验收 03：non-active 停止 worker 且保留 workspace / claim 释放、无 retry", async () => {
    const h = makeHarness();
    const issue = makeIssue({ state: "Todo" });
    h.tracker.issues.set(issue.id, issue);
    h.authority.dispatchIssue(issue);

    h.tracker.issues.set(issue.id, makeIssue({ state: "Paused" }));
    const result = await h.authority.reconcileRunningIssues();

    expect(result.stoppedIssueIds).toEqual([issue.id]);
    expect(result.cleanedIssueIds).toEqual([]);
    expect(h.cleanupCalls).toHaveLength(0);
    expect(h.state.running.has(issue.id)).toBe(false);
    expect(h.state.claimed.has(issue.id)).toBe(false);
    expect(h.state.retryAttempts.has(issue.id)).toBe(false);
    expect(h.outcomes[0]?.status).toBe("canceled_by_reconciliation");
    expect(h.outcomes[0]?.stopReason).toEqual({ kind: "reconciliation" });
  });

  it("验收 04：terminal 停止 worker 并安全删除 workspace", async () => {
    const h = makeHarness();
    const issue = makeIssue({ state: "Todo" });
    h.tracker.issues.set(issue.id, issue);
    h.authority.dispatchIssue(issue);

    h.tracker.issues.set(issue.id, makeIssue({ state: "Done" }));
    const result = await h.authority.reconcileRunningIssues();

    expect(result.stoppedIssueIds).toEqual([issue.id]);
    expect(result.cleanedIssueIds).toEqual([issue.id]);
    expect(h.cleanupCalls).toEqual(["ABC-1"]);
    expect(h.state.running.has(issue.id)).toBe(false);
    expect(h.state.claimed.has(issue.id)).toBe(false);
    expect(h.state.retryAttempts.has(issue.id)).toBe(false);
    expect(h.outcomes[0]?.status).toBe("canceled_by_reconciliation");
    expect(h.outcomes[0]?.stopReason).toEqual({ kind: "terminal" });
    // 顶层 cleanup 端口被使用，而不是 retry 内嵌端口。
    expect(h.cleanupCalls).not.toContain("used-retry-port");
  });

  it("验收 05：refresh 缺少 running ID → stop 且不 cleanup", async () => {
    const h = makeHarness();
    const issue = makeIssue({ state: "Todo" });
    h.tracker.issues.set(issue.id, issue);
    h.authority.dispatchIssue(issue);
    h.tracker.issues.delete(issue.id); // refresh 省略该 ID

    const result = await h.authority.reconcileRunningIssues();
    expect(result.stoppedIssueIds).toEqual([issue.id]);
    expect(result.cleanedIssueIds).toEqual([]);
    expect(h.cleanupCalls).toHaveLength(0);
    expect(h.state.running.has(issue.id)).toBe(false);
    expect(h.state.claimed.has(issue.id)).toBe(false);
  });

  it("验收 06：refresh 失败保留 worker 且 state 不变", async () => {
    const h = makeHarness();
    const issue = makeIssue({ state: "Todo" });
    h.tracker.issues.set(issue.id, issue);
    h.authority.dispatchIssue(issue);
    h.tracker.fail = true;

    const result = await h.authority.reconcileRunningIssues();
    expect(result.refreshFailed).toBe(true);
    expect(result.stoppedIssueIds).toEqual([]);
    expect(h.state.running.has(issue.id)).toBe(true);
    expect(h.state.claimed.has(issue.id)).toBe(true);
    expect(h.authority.activeWorkerCount).toBe(1);
    expect(h.cleanupCalls).toHaveLength(0);
  });
});

describe("stall detection — 验收 07 / 08", () => {
  it("验收 07：stall_timeout_ms <= 0 禁用，超长静默也不终止", async () => {
    const h = makeHarness();
    h.setStall(0);
    const issue = makeIssue({ state: "Todo" });
    h.tracker.issues.set(issue.id, issue);
    h.authority.dispatchIssue(issue);
    h.setUtc(10_000_000); // 远超任何阈值

    const result = await h.authority.reconcileRunningIssues();
    expect(result.stalledIssueIds).toEqual([]);
    expect(h.state.running.has(issue.id)).toBe(true);
    expect(h.outcomes).toHaveLength(0);
    expect(h.state.retryAttempts.has(issue.id)).toBe(false);
  });

  it("验收 08：elapsed 严格超过阈值 → stop worker 并排一次 failure retry", async () => {
    const h = makeHarness();
    h.setStall(10_000);
    const issue = makeIssue({ state: "Todo" });
    h.tracker.issues.set(issue.id, issue);
    h.authority.dispatchIssue(issue);

    // 等于阈值：不触发。
    h.setUtc(1_000_000 + 10_000);
    const boundary = await h.authority.reconcileRunningIssues();
    expect(boundary.stalledIssueIds).toEqual([]);
    expect(h.state.running.has(issue.id)).toBe(true);

    // 严格超过阈值：触发。
    h.setUtc(1_000_000 + 10_001);
    const result = await h.authority.reconcileRunningIssues();
    expect(result.stalledIssueIds).toEqual([issue.id]);
    expect(h.outcomes[0]?.status).toBe("stalled");
    expect(h.outcomes[0]?.stopReason).toEqual({ kind: "stall" });
    expect(h.state.running.has(issue.id)).toBe(false);

    const entry = h.state.retryAttempts.get(issue.id);
    expect(entry).toBeDefined();
    expect(entry?.attempt).toBe(1);
    expect(entry?.error).toBe("worker stopped: stall");
    expect(h.scheduler.timers).toHaveLength(1);
    expect(h.scheduler.timers[0]?.delayMs).toBe(10_000);
    expect(h.state.claimed.has(issue.id)).toBe(true);
  });

  it("stall 基准用 agent event 时间戳（含身份未齐的暂存时间戳）", async () => {
    const h = makeHarness();
    h.setStall(500);
    const issue = makeIssue({ state: "Todo" });
    h.tracker.issues.set(issue.id, issue);
    h.authority.dispatchIssue(issue); // attempt.startedAt = 1_000_000

    // 身份未齐事件也推进活动时间：事件时间戳距 now 仅 100ms，虽 startedAt 已过 1s，
    // 仍不 stall。
    h.contexts[0]?.onEvent({
      event: "notification",
      timestamp: 1_999_900,
      codexAppServerPid: null,
    });
    h.setUtc(2_000_000);
    const result = await h.authority.reconcileRunningIssues();
    expect(result.stalledIssueIds).toEqual([]);
    expect(h.state.running.has(issue.id)).toBe(true);
  });
});

describe("race / 重复 outcome — 验收 11", () => {
  it("refresh 期间自然退出并排 continuation retry：terminal 结果取消旧 retry、cleanup 且不重复排", async () => {
    const h = makeHarness();
    const issue = makeIssue({ state: "Todo" });
    h.tracker.issues.set(issue.id, issue);
    h.authority.dispatchIssue(issue);

    const fetchGate = deferred<readonly Issue[]>();
    h.tracker.nextFetch = fetchGate.promise;
    const reconcile = h.authority.reconcileRunningIssues();
    await flush(); // reconcile 现在阻塞在 fetch

    // 自然成功退出 → completeAttempt 排 continuation retry（attempt 1 / 1s）。
    h.runner.last.resolve(h.runner.successResult(issue));
    await h.authority.waitForIdle();
    const retryEntry = h.state.retryAttempts.get(issue.id);
    expect(retryEntry?.attempt).toBe(1);
    expect(h.scheduler.timers).toHaveLength(1);
    const timerHandle = retryEntry?.timerHandle;

    // 迟到的 terminal 刷新结果返回。
    fetchGate.resolve([makeIssue({ state: "Done" })]);
    const result = await reconcile;

    // 旧生命周期 retry 被取消、claim 释放、workspace 清理一次。
    expect(result.stoppedIssueIds).toEqual([issue.id]);
    expect(result.cleanedIssueIds).toEqual([issue.id]);
    expect(h.cleanupCalls).toEqual(["ABC-1"]);
    expect(h.state.retryAttempts.has(issue.id)).toBe(false);
    expect(h.state.claimed.has(issue.id)).toBe(false);
    // 只有一个 timer（来自自然退出），且已被取消；stale 触发不再 dispatch。
    expect(h.scheduler.timers).toHaveLength(1);
    expect(h.scheduler.timerFor(timerHandle as number)?.cancelled).toBe(true);
    h.scheduler.fireRaw(timerHandle);
    await flush();
    expect(h.runner.options).toHaveLength(1);
    expect(h.state.running.has(issue.id)).toBe(false);
  });

  it("refresh 期间自然失败退出：terminal 结果取消旧 failure retry 且不产生第二个 retry", async () => {
    const h = makeHarness();
    const issue = makeIssue({ state: "Todo" });
    h.tracker.issues.set(issue.id, issue);
    h.authority.dispatchIssue(issue);

    const fetchGate = deferred<readonly Issue[]>();
    h.tracker.nextFetch = fetchGate.promise;
    const reconcile = h.authority.reconcileRunningIssues();
    await flush();

    h.runner.last.reject(new AgentError("port_exit", "boom"));
    await h.authority.waitForIdle();
    expect(h.state.retryAttempts.get(issue.id)?.attempt).toBe(1);
    expect(h.scheduler.timers).toHaveLength(1);

    fetchGate.resolve([makeIssue({ state: "Done" })]);
    await reconcile;

    expect(h.state.retryAttempts.has(issue.id)).toBe(false);
    expect(h.scheduler.timers).toHaveLength(1);
    expect(h.scheduler.timers[0]?.cancelled).toBe(true);
    expect(h.cleanupCalls).toEqual(["ABC-1"]);
    expect(h.outcomes).toHaveLength(1);
  });

  it("stop 已结束的 worker 安全 no-op：重复 reconciliation 不重复 cleanup / retry", async () => {
    const h = makeHarness();
    const issue = makeIssue({ state: "Todo" });
    h.tracker.issues.set(issue.id, issue);
    h.authority.dispatchIssue(issue);
    h.setUtc(1_000_000); // 时间保持不动
    h.tracker.issues.set(issue.id, makeIssue({ state: "Done" }));

    const first = await h.authority.reconcileRunningIssues();
    expect(first.cleanedIssueIds).toEqual([issue.id]);
    const second = await h.authority.reconcileRunningIssues();
    expect(second.scannedIssueIds).toEqual([]);
    expect(h.cleanupCalls).toEqual(["ABC-1"]);
    expect(h.state.retryAttempts.has(issue.id)).toBe(false);
  });

  it("审查 blocker 1：refresh 期间新生命周期已派发并退出时，保留其 retry（不误取消后来者）", async () => {
    const h = makeHarness();
    const issue = makeIssue({ state: "Todo" });
    h.tracker.issues.set(issue.id, issue);
    h.authority.dispatchIssue(issue); // 生命周期 A（generation 1）

    const staleGate = deferred<readonly Issue[]>();
    h.tracker.nextFetch = staleGate.promise;
    const stale = h.authority.reconcileRunningIssues(); // 捕获 A
    await flush();

    // A 自然退出 → continuation retry（attempt 1）。
    h.runner.last.resolve(h.runner.successResult(issue));
    await h.authority.waitForIdle();
    const continuation = h.state.retryAttempts.get(issue.id)!;
    expect(continuation.attempt).toBe(1);

    // continuation timer 到期 → refresh（active）→ 派发新生命周期 B（attempt 1）。
    h.tracker.issues.set(issue.id, issue);
    h.scheduler.fire(continuation.timerHandle);
    await flush();
    expect(h.runner.options).toHaveLength(2);
    expect(h.state.running.has(issue.id)).toBe(true);

    // B 失败 → 建立属于 B（generation 2）的 failure retry（attempt 2）。
    h.runner.last.reject(new AgentError("port_exit", "B failed"));
    await h.authority.waitForIdle();
    expect(h.state.retryAttempts.get(issue.id)?.attempt).toBe(2);

    // A 的迟到 terminal 结果返回：generation 已变，必须整条丢弃。
    staleGate.resolve([makeIssue({ state: "Done" })]);
    const result = await stale;

    expect(result.stoppedIssueIds).toEqual([]);
    expect(result.cleanedIssueIds).toEqual([]);
    expect(h.cleanupCalls).toHaveLength(0);
    // B 的 retry（attempt 2）与 claim 均保留，绝不能被当作 A 的旧生命周期取消。
    expect(h.state.retryAttempts.get(issue.id)?.attempt).toBe(2);
    expect(h.state.claimed.has(issue.id)).toBe(true);
    expect(h.state.running.has(issue.id)).toBe(false);
  });

  it("审查 blocker 2：重叠 reconciliation 按发起顺序决胜，迟到旧快照不回退较新结果", async () => {
    const h = makeHarness();
    const issue = makeIssue({ state: "Todo", title: "older" });
    h.tracker.issues.set(issue.id, issue);
    h.authority.dispatchIssue(issue);

    const r1Gate = deferred<readonly Issue[]>();
    h.tracker.nextFetch = r1Gate.promise;
    const r1 = h.authority.reconcileRunningIssues(); // epoch 1
    await flush();

    // R2 在 R1 挂起时发起并返回较新快照。
    h.tracker.issues.set(issue.id, makeIssue({ state: "In Progress", title: "newer" }));
    const r2 = h.authority.reconcileRunningIssues(); // epoch 2，覆盖 R1 的写入权
    const r2Result = await r2;
    expect(r2Result.updatedIssueIds).toEqual([issue.id]);
    expect(runningEntry(h, issue.id).issue.title).toBe("newer");

    // R1 迟到并返回更旧快照 → epoch 失效，整条丢弃。
    r1Gate.resolve([makeIssue({ state: "Todo", title: "older" })]);
    const r1Result = await r1;
    expect(r1Result.updatedIssueIds).toEqual([]);
    expect(runningEntry(h, issue.id).issue.title).toBe("newer");
    expect(h.state.running.has(issue.id)).toBe(true);
  });

  it("审查 blocker 2：迟到 terminal 不停止已由较新结果确认 active 的 issue", async () => {
    const h = makeHarness();
    const issue = makeIssue({ state: "Todo" });
    h.tracker.issues.set(issue.id, issue);
    h.authority.dispatchIssue(issue);

    const r1Gate = deferred<readonly Issue[]>();
    h.tracker.nextFetch = r1Gate.promise;
    const r1 = h.authority.reconcileRunningIssues();
    await flush();

    h.tracker.issues.set(issue.id, makeIssue({ state: "In Progress", title: "recovered" }));
    await h.authority.reconcileRunningIssues(); // 较新调用确认 active
    expect(h.state.running.has(issue.id)).toBe(true);

    // 较早调用的迟到 terminal 结果不得 stop / cleanup。
    r1Gate.resolve([makeIssue({ state: "Done" })]);
    const r1Result = await r1;
    expect(r1Result.stoppedIssueIds).toEqual([]);
    expect(r1Result.cleanedIssueIds).toEqual([]);
    expect(h.cleanupCalls).toHaveLength(0);
    expect(h.state.running.has(issue.id)).toBe(true);
    expect(h.authority.activeWorkerCount).toBe(1);
    expect(runningEntry(h, issue.id).issue.title).toBe("recovered");
  });

  it("审查 blocker 3：stall 收尾期间其他 worker 自然退出时，Part B 不再请求已退出者", async () => {
    const h = makeHarness();
    const issueA = makeIssue({ id: "issue-a", identifier: "ABC-A", state: "Todo" });
    const issueB = makeIssue({ id: "issue-b", identifier: "ABC-B", state: "Todo" });

    h.setUtc(1_000_000);
    h.authority.dispatchIssue(issueA);
    h.setUtc(1_100_000);
    h.authority.dispatchIssue(issueB);
    h.setStall(10_000); // A elapsed 100s → stall；B elapsed 0 → 不 stall

    // A 被 stall abort 的那一刻，让 B 自然成功退出（B 建立 continuation retry）。
    const bDeferred = h.runner.at(1);
    h.runner.signals[0]?.addEventListener("abort", () => {
      bDeferred.resolve(h.runner.successResult(issueB));
    });

    const result = await h.authority.reconcileRunningIssues();

    expect(result.stalledIssueIds).toEqual([issueA.id]);
    // Part B 开始时 running 已空 → 零 tracker 请求，绝不请求已自然退出的 B。
    expect(result.scannedIssueIds).toEqual([]);
    expect(h.tracker.calls).toHaveLength(0);
    // A 的 stall failure retry 与 B 的 continuation retry 均保留，claim 都在。
    expect(h.state.retryAttempts.get(issueA.id)?.attempt).toBe(1);
    expect(h.state.retryAttempts.get(issueB.id)?.attempt).toBe(1);
    expect(h.state.claimed.has(issueA.id)).toBe(true);
    expect(h.state.claimed.has(issueB.id)).toBe(true);
  });
});
