/**
 * M5.3 retry 队列 / timer 所有权 / backoff 测试（SPEC §8.4、§14.2、§16.6、§17.4）。
 *
 * 从包公共面 import；runner 与 timer 都用受控 fake 注入，因此可以确定性驱动
 * "终态 → 入队 / 替换 / 取消 → timer 到期 → refresh → 重派 / requeue / release"
 * 全分支，断言真实 runtime state（retryAttempts / claimed / running）与延迟数值，
 * 不使用真实 10 秒 / 5 分钟 sleep。
 */
import { AgentError, type AgentAttemptOptions, type AgentAttemptResult } from "@symphony/agent";
import type { Issue, OrchestratorRuntimeState } from "@symphony/domain";
import { describe, expect, it } from "vitest";

import {
  OrchestratorAuthority,
  createOrchestratorRuntimeState,
  isRetryDispatchAllowed,
  type AgentAttemptRunner,
  type AttemptContext,
  type AttemptOptionsFactory,
  type DispatchPolicy,
  type OrchestratorAuthorityOptions,
  type RetryDiagnostic,
  type RetryScheduler,
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
    title: "Retry me",
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

/** 让已排队 microtask / 一帧 setTimeout 跑完，无需真实等待。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
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

  /** 正常触发：已取消 / 已触发则返回 false（模拟防重）。 */
  public fire(handle: unknown): boolean {
    const timer = this.timers.find((candidate) => candidate.id === handle);
    if (timer === undefined || timer.cancelled || timer.fired) {
      return false;
    }
    timer.fired = true;
    timer.callback();
    return true;
  }

  /** 强制再次调用回调（模拟 stale / duplicate 触发，绕过防重标志）。 */
  public fireRaw(handle: unknown): void {
    const timer = this.timers.find((candidate) => candidate.id === handle);
    if (timer !== undefined) {
      timer.callback();
    }
  }

  public get pending(): ScheduledTimer[] {
    return this.timers.filter((timer) => !timer.cancelled && !timer.fired);
  }

  public get lastPending(): ScheduledTimer {
    const timer = this.pending.at(-1);
    if (timer === undefined) {
      throw new Error("no pending timer");
    }
    return timer;
  }

  public timerFor(handle: unknown): ScheduledTimer | undefined {
    return this.timers.find((candidate) => candidate.id === handle);
  }
}

class FakeTracker {
  public fail = false;
  public nextFetch: Promise<readonly Issue[]> | null = null;
  public readonly issues = new Map<string, Issue>();
  public readonly calls: string[][] = [];

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
}

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
  setMaxBackoff(value: number): void;
}

function makeHarness(
  overrides: Partial<Pick<OrchestratorAuthorityOptions, "policy">> = {},
): Harness {
  const state = createOrchestratorRuntimeState({ pollIntervalMs: 30_000, maxConcurrentAgents: 10 });
  const runner = new FakeRunner();
  const scheduler = new ManualScheduler();
  const tracker = new FakeTracker();
  const outcomes: WorkerTerminalOutcome[] = [];
  const diagnostics: RetryDiagnostic[] = [];
  const cleanupCalls: string[] = [];
  const contexts: AttemptContext[] = [];
  let maxBackoff = 300_000;
  let clock = 1_000;
  const monotonic = 5_000;

  const createAttemptOptions: AttemptOptionsFactory = (context) => {
    contexts.push(context);
    return { issue: context.issue, attempt: context.attempt } as unknown as AgentAttemptOptions;
  };

  const authority = new OrchestratorAuthority({
    state,
    policy: overrides.policy ?? POLICY,
    runner: runner.run,
    createAttemptOptions,
    tracker,
    resolveWorkspacePath: (issue) => `/tmp/ws/${issue.identifier}`,
    now: () => clock++,
    monotonicNow: () => monotonic,
    onOutcome: (outcome) => outcomes.push(outcome),
    retry: {
      scheduler,
      maxRetryBackoffMs: () => maxBackoff,
      cleanupWorkspace: {
        removeWorkspace: async (identifier: string) => {
          cleanupCalls.push(identifier);
          return { status: "removed" as const };
        },
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
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
    setMaxBackoff: (value) => {
      maxBackoff = value;
    },
  };
}

/** dispatch → 触发异常终态 → 返回排队的 retry entry。 */
async function enqueueFailureRetry(h: Harness, issue: Issue): Promise<{
  entry: NonNullable<ReturnType<OrchestratorRuntimeState["retryAttempts"]["get"]>>;
  timer: ScheduledTimer;
}> {
  h.tracker.issues.set(issue.id, issue);
  h.authority.dispatchIssue(issue);
  h.runner.last.reject(new AgentError("port_exit", "worker died"));
  await h.authority.waitForIdle();
  const entry = h.state.retryAttempts.get(issue.id);
  if (entry === undefined) {
    throw new Error("no retry entry queued");
  }
  const timer = h.scheduler.timerFor(entry.timerHandle);
  if (timer === undefined) {
    throw new Error("no timer for retry entry");
  }
  return { entry, timer };
}

describe("retry 入队 — 验收 01 / 02 / 03 / 04 / 05", () => {
  it("验收 01：normal exit 固定 1s、attempt 1、error null、claim 保留", async () => {
    const h = makeHarness();
    const issue = makeIssue();
    h.tracker.issues.set(issue.id, issue);

    h.authority.dispatchIssue(issue);
    h.runner.last.resolve(h.runner.successResult(issue));
    await h.authority.waitForIdle();

    const entry = h.state.retryAttempts.get(issue.id)!;
    expect(entry).toMatchObject({
      issueId: issue.id,
      identifier: "ABC-1",
      attempt: 1,
      error: null,
    });
    expect(entry.dueAtMs).toBe(5_000 + 1_000);
    expect(h.scheduler.timers).toHaveLength(1);
    expect(h.scheduler.timers[0]?.delayMs).toBe(1_000);
    expect(entry.timerHandle).toBe(h.scheduler.timers[0]?.id);
    expect(h.state.claimed.has(issue.id)).toBe(true);
    expect(h.state.running.has(issue.id)).toBe(false);
  });

  it("验收 02：failure backoff 首次 10s 并指数增长（10 / 20 / 40s）", async () => {
    const h = makeHarness();
    const issue = makeIssue();
    const first = await enqueueFailureRetry(h, issue);
    expect(first.entry.attempt).toBe(1);
    expect(first.entry.error).toBe("port_exit");
    expect(first.timer.delayMs).toBe(10_000);

    h.scheduler.fire(first.entry.timerHandle);
    await flush();
    expect(h.contexts.at(-1)?.attempt).toBe(1);
    h.runner.last.reject(new AgentError("port_exit", "boom again"));
    await h.authority.waitForIdle();
    const second = h.state.retryAttempts.get(issue.id)!;
    expect(second.attempt).toBe(2);
    expect(h.scheduler.lastPending.delayMs).toBe(20_000);

    h.scheduler.fire(second.timerHandle);
    await flush();
    h.runner.last.reject(new AgentError("port_exit", "boom three"));
    await h.authority.waitForIdle();
    const third = h.state.retryAttempts.get(issue.id)!;
    expect(third.attempt).toBe(3);
    expect(h.scheduler.lastPending.delayMs).toBe(40_000);
  });

  it("验收 03：cap 使用当前 effective maxRetryBackoffMs（含低于基数与运行时换值）", () => {
    const h = makeHarness();
    h.setMaxBackoff(5_000);
    h.authority.scheduleRetry({ issueId: "i1", identifier: "ABC-1", attempt: 1, kind: "failure", error: "x" });
    expect(h.scheduler.lastPending.delayMs).toBe(5_000); // 低于基数时被 cap 到配置值

    h.setMaxBackoff(15_000);
    h.authority.scheduleRetry({ issueId: "i1", identifier: "ABC-1", attempt: 2, kind: "failure", error: "x" });
    expect(h.scheduler.lastPending.delayMs).toBe(15_000); // min(20000, 15000)

    h.setMaxBackoff(7_000);
    h.authority.scheduleRetry({ issueId: "i1", identifier: "ABC-1", attempt: 2, kind: "failure", error: "x" });
    expect(h.scheduler.lastPending.delayMs).toBe(7_000); // 运行时换值影响后续调度

    // continuation 不受 cap 影响，恒为 1s。
    h.authority.scheduleRetry({ issueId: "i1", identifier: "ABC-1", attempt: 1, kind: "continuation", error: null });
    expect(h.scheduler.lastPending.delayMs).toBe(1_000);
  });

  it("验收 04：RetryEntry 六个字段完整且 dueAtMs 用单调时钟", () => {
    const h = makeHarness();
    const entry = h.authority.scheduleRetry({
      issueId: "issue-9",
      identifier: "ABC-9",
      attempt: 4,
      kind: "failure",
      error: "boom",
    })!;

    expect(Object.keys(entry).sort()).toEqual(
      ["attempt", "dueAtMs", "error", "identifier", "issueId", "timerHandle"].sort(),
    );
    expect(entry.issueId).toBe("issue-9");
    expect(entry.identifier).toBe("ABC-9");
    expect(entry.attempt).toBe(4);
    expect(entry.dueAtMs).toBe(5_000 + 80_000);
    expect(entry.error).toBe("boom");
    expect(h.scheduler.timerFor(entry.timerHandle)?.delayMs).toBe(80_000);
    expect(h.state.claimed.has("issue-9")).toBe(true);
  });

  it("验收 05：同 issue 新 retry 取消 / 替换旧 timer", () => {
    const h = makeHarness();
    const first = h.authority.scheduleRetry({
      issueId: "i1",
      identifier: "ABC-1",
      attempt: 1,
      kind: "failure",
      error: "first",
    })!;
    const firstHandle = first.timerHandle;

    const second = h.authority.scheduleRetry({
      issueId: "i1",
      identifier: "ABC-1",
      attempt: 2,
      kind: "failure",
      error: "second",
    })!;

    expect(h.scheduler.timerFor(firstHandle)?.cancelled).toBe(true);
    expect(second.timerHandle).not.toBe(firstHandle);
    expect(second.attempt).toBe(2);
    expect(second.error).toBe("second");
    // 旧 timer 即使已进入事件队列也不再拥有调度权。
    expect(h.scheduler.fire(firstHandle)).toBe(false);
    expect(h.state.retryAttempts.get("i1")).toBe(second);
  });
});

describe("retry timer fired — 验收 06 / 07 / 08 / 09 / 10", () => {
  it("验收 06：stale / canceled timer 不产生 duplicate dispatch", async () => {
    const h = makeHarness();
    const issue = makeIssue();
    const { entry } = await enqueueFailureRetry(h, issue);
    expect(h.runner.options).toHaveLength(1);

    // 首次触发 → 重派一个 worker。
    h.scheduler.fire(entry.timerHandle);
    await flush();
    expect(h.runner.options).toHaveLength(2);
    expect(h.state.running.has(issue.id)).toBe(true);
    const attemptAfter = h.state.running.get(issue.id)?.attempt.attempt;

    // 同一回调再次触发（stale）→ 无额外 worker、不破坏当前运行。
    h.scheduler.fireRaw(entry.timerHandle);
    await flush();
    expect(h.runner.options).toHaveLength(2);
    expect(h.state.running.get(issue.id)?.attempt.attempt).toBe(attemptAfter);
  });

  it("验收 06：取消后触发 → 不 dispatch、retry ownership 失效", async () => {
    const h = makeHarness();
    const issue = makeIssue();
    const { entry } = await enqueueFailureRetry(h, issue);

    h.authority.cancelScheduledRetry(issue.id);
    expect(h.state.retryAttempts.has(issue.id)).toBe(false);
    expect(h.scheduler.timerFor(entry.timerHandle)?.cancelled).toBe(true);

    h.scheduler.fireRaw(entry.timerHandle);
    await flush();
    expect(h.runner.options).toHaveLength(1);
    expect(h.state.running.has(issue.id)).toBe(false);
  });

  it("验收 06：替换后旧 timer 迟到触发不 dispatch", async () => {
    const h = makeHarness();
    const issue = makeIssue();
    const { entry } = await enqueueFailureRetry(h, issue);
    const staleTimer = entry.timerHandle;

    // refresh 尚未发生时用一个新 retry 替换 ownership。
    h.authority.scheduleRetry({
      issueId: issue.id,
      identifier: issue.identifier,
      attempt: 7,
      kind: "failure",
      error: "replaced",
    });

    h.scheduler.fireRaw(staleTimer);
    await flush();
    expect(h.runner.options).toHaveLength(1);
    expect(h.state.retryAttempts.get(issue.id)?.attempt).toBe(7);
  });

  it("验收 07：refresh missing → 释放 claim 且不清理 workspace", async () => {
    const h = makeHarness();
    const issue = makeIssue();
    const { entry } = await enqueueFailureRetry(h, issue);
    h.tracker.issues.delete(issue.id);

    h.scheduler.fire(entry.timerHandle);
    await flush();

    expect(h.state.retryAttempts.has(issue.id)).toBe(false);
    expect(h.state.claimed.has(issue.id)).toBe(false);
    expect(h.state.running.has(issue.id)).toBe(false);
    expect(h.cleanupCalls).toHaveLength(0);
    expect(h.runner.options).toHaveLength(1);
  });

  it("验收 07：refresh inactive → 释放 claim、不 dispatch、不 cleanup", async () => {
    const h = makeHarness();
    const issue = makeIssue();
    const { entry } = await enqueueFailureRetry(h, issue);
    h.tracker.issues.set(issue.id, { ...issue, state: "Backlog" });

    h.scheduler.fire(entry.timerHandle);
    await flush();

    expect(h.state.claimed.has(issue.id)).toBe(false);
    expect(h.state.retryAttempts.has(issue.id)).toBe(false);
    expect(h.cleanupCalls).toHaveLength(0);
    expect(h.runner.options).toHaveLength(1);
  });

  it("验收 07：refresh unroutable → 释放 claim、不 dispatch、不 cleanup", async () => {
    const h = makeHarness();
    const issue = makeIssue();
    const { entry } = await enqueueFailureRetry(h, issue);
    h.tracker.issues.set(issue.id, { ...issue, dispatchable: false });

    h.scheduler.fire(entry.timerHandle);
    await flush();

    expect(h.state.claimed.has(issue.id)).toBe(false);
    expect(h.state.retryAttempts.has(issue.id)).toBe(false);
    expect(h.cleanupCalls).toHaveLength(0);
    expect(h.runner.options).toHaveLength(1);
  });

  it("验收 08：refresh terminal → 调用安全 cleanup 并释放 claim", async () => {
    const h = makeHarness();
    const issue = makeIssue();
    const { entry } = await enqueueFailureRetry(h, issue);
    h.tracker.issues.set(issue.id, { ...issue, state: "Done" });

    h.scheduler.fire(entry.timerHandle);
    await flush();

    expect(h.cleanupCalls).toEqual([issue.identifier]);
    expect(h.state.claimed.has(issue.id)).toBe(false);
    expect(h.state.retryAttempts.has(issue.id)).toBe(false);
    expect(h.runner.options).toHaveLength(1);
  });

  it("验收 08：cleanup refused / 异常只记诊断，仍释放 claim 且不 dispatch", async () => {
    // refused 分支：cleanup 端口返回 refused。
    const h2 = makeHarnessWithCleanup(async (identifier) => ({
      status: "refused" as const,
      reason: "workspace_outside_root",
      message: `refused ${identifier}`,
    }));
    const issue2 = makeIssue({ id: "issue-refused", identifier: "ABC-R" });
    const { entry: entry2 } = await enqueueFailureRetry(h2, issue2);
    h2.tracker.issues.set(issue2.id, { ...issue2, state: "Cancelled" });

    h2.scheduler.fire(entry2.timerHandle);
    await flush();

    expect(h2.state.claimed.has(issue2.id)).toBe(false);
    expect(h2.diagnostics).toHaveLength(1);
    expect(h2.diagnostics[0]).toMatchObject({ kind: "cleanup_refused", issueId: issue2.id });

    const h3 = makeHarnessWithCleanup(async () => {
      throw new Error("rm exploded");
    });
    const issue3 = makeIssue({ id: "issue-throw", identifier: "ABC-T" });
    const { entry: entry3 } = await enqueueFailureRetry(h3, issue3);
    h3.tracker.issues.set(issue3.id, { ...issue3, state: "Done" });
    h3.scheduler.fire(entry3.timerHandle);
    await flush();
    expect(h3.state.claimed.has(issue3.id)).toBe(false);
    expect(h3.diagnostics[0]).toMatchObject({ kind: "cleanup_error" });
  });

  it("验收 09：slot 不足 → 保留 claim 并以精确 error 重排", async () => {
    const h = makeHarness();
    const issue = makeIssue();
    const { entry } = await enqueueFailureRetry(h, issue);
    h.state.maxConcurrentAgents = 0;

    h.scheduler.fire(entry.timerHandle);
    await flush();

    const requeued = h.state.retryAttempts.get(issue.id)!;
    expect(requeued.error).toBe("no available orchestrator slots");
    expect(requeued.attempt).toBe(2);
    expect(h.state.claimed.has(issue.id)).toBe(true);
    expect(h.state.running.has(issue.id)).toBe(false);
    expect(h.runner.options).toHaveLength(1);
    expect(h.scheduler.lastPending.delayMs).toBe(20_000);
  });

  it("验收 09：per-state slot 不足同样记录 no available orchestrator slots", async () => {
    const h = makeHarness({
      policy: { ...POLICY, maxConcurrentAgentsByState: { todo: 1 } },
    });
    const issue = makeIssue();
    const { entry } = await enqueueFailureRetry(h, issue);

    // 另一个同 state worker 占满 per-state slot（重排的 issue 仍持有自己的 claim）。
    const other = makeIssue({ id: "issue-other", identifier: "ABC-O" });
    expect(h.authority.dispatchIssue(other).kind).toBe("dispatched");

    h.scheduler.fire(entry.timerHandle);
    await flush();

    expect(h.state.retryAttempts.get(issue.id)?.error).toBe("no available orchestrator slots");
    expect(h.state.retryAttempts.get(issue.id)?.attempt).toBe(2);
    expect(h.runner.options).toHaveLength(2);
    expect(h.scheduler.lastPending.delayMs).toBe(20_000);
  });

  it("验收 10：fetch 失败不丢 claim 并重新安排 retry", async () => {
    const h = makeHarness();
    const issue = makeIssue();
    const { entry } = await enqueueFailureRetry(h, issue);
    h.tracker.fail = true;

    h.scheduler.fire(entry.timerHandle);
    await flush();

    const requeued = h.state.retryAttempts.get(issue.id)!;
    expect(requeued.error).toBe("retry refresh failed");
    expect(requeued.attempt).toBe(2);
    expect(h.state.claimed.has(issue.id)).toBe(true);
    expect(h.state.running.has(issue.id)).toBe(false);
    expect(h.runner.options).toHaveLength(1);
    expect(h.scheduler.lastPending.delayMs).toBe(20_000);
  });

  it("refresh 成功 → 用当前 retry attempt 重派新 worker", async () => {
    const h = makeHarness();
    const issue = makeIssue();
    const { entry } = await enqueueFailureRetry(h, issue);

    h.scheduler.fire(entry.timerHandle);
    await flush();

    expect(h.state.retryAttempts.has(issue.id)).toBe(false);
    expect(h.state.claimed.has(issue.id)).toBe(true);
    expect(h.state.running.get(issue.id)?.attempt.attempt).toBe(1);
    expect(h.contexts.at(-1)?.attempt).toBe(1);
    expect(h.runner.options).toHaveLength(2);
  });

  it("normal continuation retry 后失败递增到 attempt 2", async () => {
    const h = makeHarness();
    const issue = makeIssue();
    h.tracker.issues.set(issue.id, issue);
    h.authority.dispatchIssue(issue);
    h.runner.last.resolve(h.runner.successResult(issue));
    await h.authority.waitForIdle();
    const continuation = h.state.retryAttempts.get(issue.id)!;
    expect(continuation.attempt).toBe(1);

    h.scheduler.fire(continuation.timerHandle);
    await flush();
    expect(h.state.running.get(issue.id)?.attempt.attempt).toBe(1);
    h.runner.last.reject(new AgentError("port_exit", "died after continuation retry"));
    await h.authority.waitForIdle();

    const next = h.state.retryAttempts.get(issue.id)!;
    expect(next.attempt).toBe(2);
    expect(h.scheduler.lastPending.delayMs).toBe(20_000);
  });

  it("await 期间被新 retry 替换 → 迟到 refresh 结果被丢弃", async () => {
    const h = makeHarness();
    const issue = makeIssue();
    const { entry } = await enqueueFailureRetry(h, issue);

    const pending = deferred<readonly Issue[]>();
    h.tracker.nextFetch = pending.promise;
    h.scheduler.fire(entry.timerHandle);
    await flush(); // fetch 已发起，尚未 resolve

    h.authority.scheduleRetry({
      issueId: issue.id,
      identifier: issue.identifier,
      attempt: 9,
      kind: "failure",
      error: "replaced during refresh",
    });
    pending.resolve([issue]);
    await flush();

    expect(h.runner.options).toHaveLength(1);
    expect(h.state.running.has(issue.id)).toBe(false);
    expect(h.state.retryAttempts.get(issue.id)?.attempt).toBe(9);
  });

  it("worker 终态 suppressRetry（reconciliation）时不入队 retry 并释放 claim", async () => {
    const h = makeHarness();
    const issue = makeIssue();
    h.tracker.issues.set(issue.id, issue);
    h.authority.dispatchIssue(issue);
    const handle = h.authority.getWorker(issue.id)!;
    const stopped = handle.stop({ kind: "reconciliation" });
    h.runner.last.reject(new AgentError("turn_cancelled", "cancelled"));
    await stopped;
    await h.authority.waitForIdle();

    expect(h.state.retryAttempts.has(issue.id)).toBe(false);
    expect(h.state.claimed.has(issue.id)).toBe(false);
    expect(h.scheduler.timers).toHaveLength(0);
  });
});

describe("isRetryDispatchAllowed — SPEC §16.6 ignore_existing_claim", () => {
  it("忽略该 issue 自己的 claim，但仍拒绝其他 claim / running / terminal / unroutable", () => {
    const state = createOrchestratorRuntimeState({ pollIntervalMs: 1, maxConcurrentAgents: 5 });
    const issue = makeIssue();
    state.claimed.add(issue.id);
    expect(isRetryDispatchAllowed(issue, state, POLICY, issue.id)).toBe(true);

    const other = makeIssue({ id: "other" });
    state.claimed.add(other.id);
    expect(isRetryDispatchAllowed(other, state, POLICY, issue.id)).toBe(false);

    const terminal = makeIssue({ id: "t", state: "Done" });
    expect(isRetryDispatchAllowed(terminal, state, POLICY, "t")).toBe(false);

    const unroutable = makeIssue({ id: "u", dispatchable: false });
    expect(isRetryDispatchAllowed(unroutable, state, POLICY, "u")).toBe(false);
  });
});

/** 用自定义 cleanup 端口重建一个 harness（用于 refused / 抛异常分支）。 */
function makeHarnessWithCleanup(
  removeWorkspace: (identifier: string) => Promise<{
    status: "removed" | "missing" | "refused" | "failed";
    reason?: string;
    message?: string;
  }>,
): Harness {
  const state = createOrchestratorRuntimeState({ pollIntervalMs: 30_000, maxConcurrentAgents: 10 });
  const runner = new FakeRunner();
  const scheduler = new ManualScheduler();
  const tracker = new FakeTracker();
  const outcomes: WorkerTerminalOutcome[] = [];
  const diagnostics: RetryDiagnostic[] = [];
  const cleanupCalls: string[] = [];
  const contexts: AttemptContext[] = [];
  let maxBackoff = 300_000;
  let clock = 1_000;

  const authority = new OrchestratorAuthority({
    state,
    policy: POLICY,
    runner: runner.run,
    createAttemptOptions: (context) => {
      contexts.push(context);
      return { issue: context.issue, attempt: context.attempt } as unknown as AgentAttemptOptions;
    },
    tracker,
    resolveWorkspacePath: (issue) => `/tmp/ws/${issue.identifier}`,
    now: () => clock++,
    monotonicNow: () => 5_000,
    onOutcome: (outcome) => outcomes.push(outcome),
    retry: {
      scheduler,
      maxRetryBackoffMs: () => maxBackoff,
      cleanupWorkspace: { removeWorkspace },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
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
    setMaxBackoff: (value) => {
      maxBackoff = value;
    },
  };
}
