/**
 * M5.5 poll loop 测试支撑（非测试文件，不进入 vitest 用例）。
 *
 * 提供可注入的 manual timer、fake tracker、可控 runner、可变 preflight 与
 * `OrchestratorLoop` harness，让布局确定复跑且不依赖真实等待。
 */
import type {
  AgentAttemptOptions,
  AgentAttemptResult,
  ContinuationDecider,
} from "@symphony/agent";
import type { Issue, OrchestratorRuntimeState, TimerHandle } from "@symphony/domain";

import {
  OrchestratorAuthority,
  OrchestratorLoop,
  createOrchestratorRuntimeState,
  type AgentAttemptRunner,
  type DispatchPolicy,
  type DispatchPreflightResult,
  type DispatchPreflightSource,
  type EffectiveSchedulingConfig,
  type LoopDiagnostic,
  type PollScheduler,
  type RetryDiagnostic,
  type RetryWorkspaceCleanup,
  type TrackerRefreshSource,
} from "./index";

export const ACTIVE_STATES = ["Todo", "In Progress"] as const;

export function defaultPolicy(overrides: Partial<DispatchPolicy> = {}): DispatchPolicy {
  return {
    activeStates: [...ACTIVE_STATES],
    terminalStates: ["Done", "Cancelled"],
    requiredLabels: [],
    maxConcurrentAgentsByState: {},
    ...overrides,
  };
}

export function makeIssue(
  identifier: string,
  state: string,
  overrides: Partial<Issue> = {},
): Issue {
  return {
    id: `id-${identifier}`,
    nativeRef: null,
    identifier,
    title: identifier,
    description: null,
    priority: 1,
    state,
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

/** 手动一次性 timer：`fire()` 触发调用时刻已存在的 timer（新排的不触发）。 */
export class ManualScheduler implements PollScheduler {
  public readonly scheduledDelays: number[] = [];
  private readonly pending = new Map<number, { delayMs: number; callback: () => void }>();
  private nextId = 1;

  public schedule(delayMs: number, callback: () => void): TimerHandle {
    const handle = this.nextId++;
    this.pending.set(handle, { delayMs, callback });
    this.scheduledDelays.push(delayMs);
    return handle;
  }

  public cancel(handle: TimerHandle): void {
    if (typeof handle === "number") {
      this.pending.delete(handle);
    }
  }

  public get pendingCount(): number {
    return this.pending.size;
  }

  public pendingDelays(): number[] {
    return [...this.pending.values()].map((entry) => entry.delayMs);
  }

  public fire(): void {
    const due = [...this.pending.entries()];
    this.pending.clear();
    for (const [, entry] of due) {
      entry.callback();
    }
  }
}

/** fake tracker：candidate（by states）与 refresh（by ids）都可控。 */
export class FakeTracker {
  public activeIssues: readonly Issue[] = [];
  public readonly snapshots = new Map<string, Issue>();
  public candidateFail = false;
  public refreshFail = false;
  public candidateHandler: (() => Promise<readonly Issue[]>) | null = null;
  public refreshHandler: ((issueIds: readonly string[]) => Promise<readonly Issue[]>) | null = null;
  public readonly candidateStateCalls: string[][] = [];
  public readonly refreshIdCalls: string[][] = [];

  public async fetchIssuesByStates(stateNames: readonly string[]): Promise<readonly Issue[]> {
    this.candidateStateCalls.push([...stateNames]);
    if (this.candidateHandler !== null) {
      return this.candidateHandler();
    }
    if (this.candidateFail) {
      throw new Error("candidate fetch down");
    }
    const wanted = stateNames.map((name) => name.toLowerCase());
    return this.activeIssues.filter((issue) => wanted.includes(issue.state.toLowerCase()));
  }

  public async fetchIssuesByIds(issueIds: readonly string[]): Promise<readonly Issue[]> {
    this.refreshIdCalls.push([...issueIds]);
    if (this.refreshHandler !== null) {
      return this.refreshHandler(issueIds);
    }
    if (this.refreshFail) {
      throw new Error("refresh down");
    }
    return issueIds
      .map((id) => this.snapshots.get(id))
      .filter((issue): issue is Issue => issue !== undefined);
  }

  /** 让某 running issue 的 refresh 命中其当前快照（否则会被视为 missing → stop）。 */
  public track(issue: Issue): void {
    this.snapshots.set(issue.id, issue);
  }
}

/** 可控 runner：默认在 abort 时 reject，模拟真实 attempt 取消收敛。 */
export interface RunnerControl {
  readonly runner: AgentAttemptRunner;
  readonly started: string[];
  /** 每次 attempt 由 authority 注入的 continuation decider（供动态 policy 回归）。 */
  readonly continuationDeciders: Map<string, ContinuationDecider>;
  resolve(issueId: string): void;
  reject(issueId: string, error?: unknown): void;
}

export function createRunnerControl(options: { autoRejectOnAbort?: boolean } = {}): RunnerControl {
  const autoReject = options.autoRejectOnAbort ?? true;
  const pending = new Map<
    string,
    { resolve: (result: AgentAttemptResult) => void; reject: (error: unknown) => void }
  >();
  const started: string[] = [];
  const continuationDeciders = new Map<string, ContinuationDecider>();

  const runner: AgentAttemptRunner = (attemptOptions) => {
    started.push(attemptOptions.issue.id);
    if (attemptOptions.continuationDecider !== undefined) {
      continuationDeciders.set(attemptOptions.issue.id, attemptOptions.continuationDecider);
    }
    return new Promise<AgentAttemptResult>((resolve, reject) => {
      pending.set(attemptOptions.issue.id, { resolve, reject });
      if (autoReject && attemptOptions.signal !== undefined) {
        attemptOptions.signal.addEventListener(
          "abort",
          () => {
            if (pending.delete(attemptOptions.issue.id)) {
              reject(new Error("attempt aborted"));
            }
          },
          { once: true },
        );
      }
    });
  };

  return {
    runner,
    started,
    continuationDeciders,
    resolve: (issueId) => {
      const entry = pending.get(issueId);
      if (entry !== undefined) {
        pending.delete(issueId);
        entry.resolve({} as AgentAttemptResult);
      }
    },
    reject: (issueId, error = new Error("attempt failed")) => {
      const entry = pending.get(issueId);
      if (entry !== undefined) {
        pending.delete(issueId);
        entry.reject(error);
      }
    },
  };
}

/** 可变 preflight：测试直接改 `result` 模拟 reload / 坏配置。 */
export class MutablePreflight implements DispatchPreflightSource {
  public calls = 0;
  public result: DispatchPreflightResult;

  public constructor(result: DispatchPreflightResult) {
    this.result = result;
  }

  public preflight(): DispatchPreflightResult {
    this.calls += 1;
    return this.result;
  }
}

/** 可变的"当前 effective 配置"（模拟 config 层的 last-known-good store）。 */
export interface LiveConfig {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  maxRetryBackoffMs: number;
  stallTimeoutMs: number;
  policy: DispatchPolicy;
}

export function toEffective(live: LiveConfig): EffectiveSchedulingConfig {
  return {
    pollIntervalMs: live.pollIntervalMs,
    maxConcurrentAgents: live.maxConcurrentAgents,
    policy: live.policy,
  };
}

/** 默认 preflight：成功，返回 `live` 的最新快照。 */
export function livePreflight(live: LiveConfig): MutablePreflight {
  return new MutablePreflight({ ok: true, effective: toEffective(live) });
}

export interface LoopHarness {
  readonly loop: OrchestratorLoop;
  readonly authority: OrchestratorAuthority;
  readonly state: OrchestratorRuntimeState;
  readonly tracker: FakeTracker;
  readonly runner: RunnerControl;
  readonly pollScheduler: ManualScheduler;
  readonly retryScheduler: ManualScheduler;
  readonly preflight: MutablePreflight;
  readonly live: LiveConfig;
  readonly diagnostics: LoopDiagnostic[];
  readonly retryDiagnostics: RetryDiagnostic[];
  readonly cleanupCalls: string[];
  utcNow(): number;
  monotonicNow(): number;
  advanceUtc(ms: number): void;
  advanceMonotonic(ms: number): void;
}

export interface LoopHarnessOptions {
  readonly policy?: DispatchPolicy;
  readonly pollIntervalMs?: number;
  readonly maxConcurrentAgents?: number;
  readonly maxRetryBackoffMs?: number;
  readonly stallTimeoutMs?: number;
  readonly cleanup?: RetryWorkspaceCleanup;
  readonly runnerControl?: RunnerControl;
  /** 是否注入 cleanup 端口（默认 true）；false 用于验证 startup 能力缺失 fail-fast。 */
  readonly withCleanup?: boolean;
  /** tracker 是否具备 `fetchIssuesByStates`（默认 true）；false 同样触发能力缺失。 */
  readonly withTrackerStates?: boolean;
}

/**
 * 组装一个真实的 `OrchestratorAuthority` + `OrchestratorLoop`。
 *
 * 默认提供可用 cleanup 端口（真实行为：startup terminal sweep 会按 terminal states
 * 调一次 `fetchIssuesByStates`，因此 `candidateStateCalls[0]` 是 sweep）。
 */
export function createLoopHarness(options: LoopHarnessOptions = {}): LoopHarness {
  const live: LiveConfig = {
    pollIntervalMs: options.pollIntervalMs ?? 30_000,
    maxConcurrentAgents: options.maxConcurrentAgents ?? 2,
    maxRetryBackoffMs: options.maxRetryBackoffMs ?? 300_000,
    stallTimeoutMs: options.stallTimeoutMs ?? 0,
    policy: options.policy ?? defaultPolicy(),
  };

  const clocks = { utc: 1_000_000, monotonic: 5_000 };
  const state = createOrchestratorRuntimeState({
    pollIntervalMs: live.pollIntervalMs,
    maxConcurrentAgents: live.maxConcurrentAgents,
  });
  const tracker = new FakeTracker();
  const runner = options.runnerControl ?? createRunnerControl();
  const pollScheduler = new ManualScheduler();
  const retryScheduler = new ManualScheduler();
  const diagnostics: LoopDiagnostic[] = [];
  const retryDiagnostics: RetryDiagnostic[] = [];
  const cleanupCalls: string[] = [];
  const withCleanup = options.withCleanup ?? true;
  const withTrackerStates = options.withTrackerStates ?? true;

  const cleanup: RetryWorkspaceCleanup =
    options.cleanup ??
    {
      removeWorkspace: async (identifier: string) => {
        cleanupCalls.push(identifier);
        return { status: "removed" as const };
      },
    };

  // 能力缺失用：tracker facade 省略 `fetchIssuesByStates`（authority 的 startup sweep
  // 因此报 unavailable），但保留 `fetchIssuesByIds` 供 reconciliation 使用。
  const authorityTracker: TrackerRefreshSource = withTrackerStates
    ? tracker
    : { fetchIssuesByIds: (issueIds) => tracker.fetchIssuesByIds(issueIds) };

  const authority = new OrchestratorAuthority({
    state,
    policy: live.policy,
    runner: runner.runner,
    createAttemptOptions: (context) =>
      ({
        issue: context.issue,
        attempt: context.attempt,
        signal: context.signal,
        continuationDecider: context.continuationDecider,
      }) as unknown as AgentAttemptOptions,
    tracker: authorityTracker,
    resolveWorkspacePath: (issue) => `/tmp/symphony-loop-test/${issue.identifier}`,
    now: () => clocks.utc,
    monotonicNow: () => clocks.monotonic,
    stallTimeoutMs: () => live.stallTimeoutMs,
    ...(withCleanup
      ? {
          retry: {
            scheduler: retryScheduler,
            maxRetryBackoffMs: () => live.maxRetryBackoffMs,
            cleanupWorkspace: cleanup,
            onDiagnostic: (diagnostic: RetryDiagnostic) => retryDiagnostics.push(diagnostic),
          },
          cleanupWorkspace: cleanup,
          onCleanupDiagnostic: (diagnostic: RetryDiagnostic) => retryDiagnostics.push(diagnostic),
        }
      : {}),
  });

  const preflight = livePreflight(live);
  const loop = new OrchestratorLoop({
    authority,
    candidates: tracker,
    preflight,
    scheduler: pollScheduler,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  return {
    loop,
    authority,
    state,
    tracker,
    runner,
    pollScheduler,
    retryScheduler,
    preflight,
    live,
    diagnostics,
    retryDiagnostics,
    cleanupCalls,
    utcNow: () => clocks.utc,
    monotonicNow: () => clocks.monotonic,
    advanceUtc: (ms) => {
      clocks.utc += ms;
    },
    advanceMonotonic: (ms) => {
      clocks.monotonic += ms;
    },
  };
}

/** 让 authority 内部的 promise 续体（`.then`）跑完。 */
export async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
