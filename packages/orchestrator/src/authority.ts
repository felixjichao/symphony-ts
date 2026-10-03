/**
 * Orchestrator runtime authority：dispatch、worker lifecycle、outcome 归约，以及
 * retry 队列 / timer 所有权（SPEC §7.3 / §7.4、§8.4、§14.2、§16.4 / §16.5 / §16.6、
 * §17.4）。
 *
 * 单一写入者：所有状态变更经本类串行化为显式 transition。worker 只通过带 attempt
 * token 的回调（事件 / 阶段 / outcome）回报，永不直接修改 state；tracker / workspace /
 * agent 也不反向持有调度状态。retry timer 回调同样只能提交"带 issueId + retry token
 * 的到期事件"，ownership 校验后才允许刷新 / 重新派发。
 *
 * 边界（根 `AGENTS.md`）：
 * - 本类**不接触** Codex `ChildProcess`，也**不解析** raw Codex JSON；
 * - 取消经 `WorkerControl.signal` 传给 `runAgentAttempt()`；
 * - terminal refresh 的破坏性清理只经注入的 `cleanupWorkspace` 端口（workspace 包），
 *   本类不做删除 fallback；
 * - reconciliation / stall（M5.4）、poll loop / reload（M5.5）不在此实现，但本类提供
 *   它们需要的 `stopWorker` / `getWorker` / `cancelScheduledRetry` 控制契约。
 */
import type {
  AgentAttemptOptions,
  AgentAttemptResult,
  AgentEvent,
  ContinuationDecider,
} from "@symphony/agent";
import type {
  Issue,
  MonotonicTimestampMs,
  OrchestratorRuntimeState,
  RetryEntry,
  RunAttempt,
  RunAttemptStatus,
  RunningEntry,
  UtcTimestampMs,
} from "@symphony/domain";

import { applyAgentEvent, createAgentTelemetryState, type AgentTelemetryState } from "./agent-events";
import { continuationRetryDelayMs, failureRetryDelayMs } from "./backoff";
import {
  createTrackerRefreshContinuationDecider,
  type TrackerRefreshSource,
} from "./continuation-policy";
import {
  globalAvailableSlots,
  isDispatchEligible,
  isRetryDispatchAllowed,
  isTerminalState,
  perStateAvailableSlots,
  type DispatchPolicy,
} from "./eligibility";
import { classifyError, classifySuccess } from "./outcome";
import {
  createRetryScheduler,
  type RetryDelayKind,
  type RetryDiagnostic,
  type RetryOptions,
  type RetryScheduler,
} from "./retry";
import { WorkerControl, type WorkerHandle, type WorkerStopReason, type WorkerTerminalOutcome } from "./worker";

/** 默认 runner：orchestrator 只依赖这个注入面，不直接 import agent 的私有实现。 */
export type AgentAttemptRunner = (options: AgentAttemptOptions) => Promise<AgentAttemptResult>;

/** 一次 attempt 的编排上下文：authority 拥有 token 与 signal，factory 补齐 workflow / config。 */
export interface AttemptContext {
  readonly issue: Issue;
  readonly attempt: number | null;
  readonly attemptToken: string;
  readonly signal: AbortSignal;
  readonly onEvent: (event: AgentEvent) => void;
  readonly onPhase: (phase: RunAttemptStatus) => void;
  readonly continuationDecider: ContinuationDecider;
}

/** composition 层提供的 attempt options 工厂（注入 workflow / config / env 等）。 */
export type AttemptOptionsFactory = (context: AttemptContext) => AgentAttemptOptions;

/** {@link OrchestratorAuthority.scheduleRetry} 的入参（SPEC §16.6 `schedule_retry`）。 */
export interface RetryScheduleRequest {
  readonly issueId: string;
  readonly identifier: string | null;
  /** retry 队列内 **1-based** attempt（§4.1.7；与 `RunAttempt.attempt` 语义不同）。 */
  readonly attempt: number;
  /** 触发本次 retry 的失败原因；continuation 为 `null`。 */
  readonly error: string | null;
  /** 延迟口径：continuation 固定 1s；failure `min(10000 * 2^(attempt-1), cap)`。 */
  readonly kind: RetryDelayKind;
}

/** {@link OrchestratorAuthority} 构造参数。 */
export interface OrchestratorAuthorityOptions {
  /** 单一权威 runtime state（由 {@link createOrchestratorRuntimeState} 初始化）。 */
  readonly state: OrchestratorRuntimeState;
  /** 当前 effective 调度策略（active / terminal states、required labels、per-state 并发）。 */
  readonly policy: DispatchPolicy;
  /** attempt 执行器；组合根传 `runAgentAttempt`，测试可注入受控 fake。 */
  readonly runner: AgentAttemptRunner;
  /** 由 authority 注入 signal / token / decider 后补齐其余 options 的工厂。 */
  readonly createAttemptOptions: AttemptOptionsFactory;
  /** tracker refresh 能力（同线程 continuation 判定 + retry refresh）。 */
  readonly tracker: TrackerRefreshSource;
  /** 同步解析 issue 的绝对 workspace 路径（`WorkspaceManager.resolveWorkspacePath`）。 */
  readonly resolveWorkspacePath: (issue: Issue) => string;
  /** UTC 墙上时钟（可注入确定性时钟）。 */
  readonly now?: (() => UtcTimestampMs) | undefined;
  /**
   * 单调时钟（可注入确定性时钟）：运行时长核算与 retry `dueAtMs`（§4.1.7 使用单调
   * 时钟域）。
   */
  readonly monotonicNow?: (() => MonotonicTimestampMs) | undefined;
  /**
   * worker 终态归约完成后的回调（外部观察 / 兼容接线点）。调用时 running 已删除、
   * success 已计入 `completed`，但 claim 尚未释放。
   */
  readonly onOutcome?: ((outcome: WorkerTerminalOutcome) => void) | undefined;
  /**
   * 同 issue retry entry 的 timer 取消接线点（M5.2 外部钩子）。dispatch 提交段同步
   * 调用，用于在删除 `retryAttempts` 条目的同时取消其 timer。
   */
  readonly cancelRetry?: ((issueId: string) => void) | undefined;
  /**
   * retry 队列控制面（M5.3）。提供后 authority 拥有 retry scheduling：worker 终态按
   * `retryKind` 建立 entry / timer，timer 到期执行 §16.6 `on_retry_timer` 刷新与重派。
   */
  readonly retry?: RetryOptions | undefined;
}

/** {@link OrchestratorAuthority.dispatchIssue} 的返回值。 */
export interface DispatchResult {
  readonly kind: "dispatched" | "skipped" | "not_eligible" | "failed";
  readonly issueId: string;
  /** 仅 `dispatched` 时非 `null`。 */
  readonly attemptToken: string | null;
  /** 仅 `failed` 时非 `null`：dispatch 前置失败原因（如 timer 取消失败）。 */
  readonly error?: string | undefined;
}

interface ActiveWorkerRecord {
  readonly token: string;
  readonly worker: WorkerControl;
  readonly entry: RunningEntry;
  readonly telemetry: AgentTelemetryState;
}

interface DispatchOptions {
  /** `RunAttempt.attempt`：首跑 `null`，retry / continuation `>= 1`（§4.1.5）。 */
  readonly attempt?: number | null | undefined;
}

/**
 * 单一权威的 dispatch + worker lifecycle + retry queue 实现。
 *
 * 提交段（`running` + `claimed` 写入、retry 清除、worker 注册）**同步**完成，
 * 中间没有 `await`：因此不会出现"已写入一半就被并发 dispatch 看到"的窗口，早到的
 * worker 事件 / 结果也只能在提交之后被处理。
 */
export class OrchestratorAuthority {
  private readonly state: OrchestratorRuntimeState;
  private readonly policy: DispatchPolicy;
  private readonly runner: AgentAttemptRunner;
  private readonly createAttemptOptions: AttemptOptionsFactory;
  private readonly tracker: TrackerRefreshSource;
  private readonly resolveWorkspacePath: (issue: Issue) => string;
  private readonly now: () => UtcTimestampMs;
  private readonly monotonicNow: () => MonotonicTimestampMs;
  private readonly onOutcome: ((outcome: WorkerTerminalOutcome) => void) | undefined;
  private readonly cancelRetry: ((issueId: string) => void) | undefined;
  private readonly retry: RetryOptions | undefined;
  private readonly scheduler: RetryScheduler | undefined;

  private readonly active = new Map<string, ActiveWorkerRecord>();
  /**
   * 每个 issue 当前 retry ownership token：排队 timer 与在途 refresh 共用。旧 token
   * 的迟到回调（stale / canceled timer、被替换的 refresh）一律被拒绝。
   */
  private readonly retryOwners = new Map<string, string>();
  private tokenCounter = 0;
  private retryTokenCounter = 0;

  constructor(options: OrchestratorAuthorityOptions) {
    this.state = options.state;
    this.policy = options.policy;
    this.runner = options.runner;
    this.createAttemptOptions = options.createAttemptOptions;
    this.tracker = options.tracker;
    this.resolveWorkspacePath = options.resolveWorkspacePath;
    this.now = options.now ?? (() => Date.now());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.onOutcome = options.onOutcome;
    this.cancelRetry = options.cancelRetry;
    this.retry = options.retry;
    this.scheduler = options.retry !== undefined
      ? (options.retry.scheduler ?? createRetryScheduler())
      : undefined;
  }

  /** 当前是否有活跃 worker（供 poll loop / 测试观察）。 */
  public get activeWorkerCount(): number {
    return this.active.size;
  }

  /** 当前排队中的 retry 数量（供 poll loop / status surface / 测试观察）。 */
  public get pendingRetryCount(): number {
    return this.state.retryAttempts.size;
  }

  /** 取某 issue 的当前 worker handle（供 M5.4 stop）。 */
  public getWorker(issueId: string): WorkerHandle | undefined {
    return this.active.get(issueId)?.worker;
  }

  /**
   * 派发一个 issue（§7.4 dispatch）。
   *
   * 1. 再次检查 `claimed` + `running`（防 duplicate dispatch）；
   * 2. 复用 M5.1 eligibility（active / terminal / routable / slot / claim / running）；
   * 3. 同步构造 `RunAttempt` + `RunningEntry` + worker handle；
   * 4. 在无 `await` 的提交段写入 `running` + `claimed`、清除同 issue retry、注册 worker；
   * 5. 启动 runner；成功仅表示 worker task 已被接纳，不要求 Codex 握手完成。
   *
   * 同步构造 / 启动阶段的失败不会留下 running 脏项：要么在提交前抛出（state 未变），
   * 要么作为异常 worker outcome 经 {@link completeAttempt} 归约。
   *
   * 普通候选 dispatch **不**豁免 claim：排队中的 retry 由 refresh 路径用
   * {@link dispatchRetry} 消费自己持有的 claim，普通 `dispatchIssue` 绝不抢占它。
   */
  public dispatchIssue(issue: Issue, options: DispatchOptions = {}): DispatchResult {
    // 1. 双检查：claimed 或 running 任一占用即跳过。
    if (this.state.claimed.has(issue.id) || this.state.running.has(issue.id)) {
      return { kind: "skipped", issueId: issue.id, attemptToken: null };
    }
    // 2. 完整 eligibility（含 state / label / slot）。
    if (!isDispatchEligible(issue, this.state, this.policy)) {
      return { kind: "not_eligible", issueId: issue.id, attemptToken: null };
    }

    try {
      const token = this.commitDispatch(issue, options.attempt ?? null);
      return { kind: "dispatched", issueId: issue.id, attemptToken: token };
    } catch (error) {
      return {
        kind: "failed",
        issueId: issue.id,
        attemptToken: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 主动停止某 issue 的 worker（幂等；M5.4 / M5.5 复用）。 */
  public async stopWorker(issueId: string, reason: WorkerStopReason): Promise<void> {
    const record = this.active.get(issueId);
    if (record === undefined) {
      return;
    }
    await record.worker.stop(reason);
  }

  /** 等待所有活跃 worker（含 stop 后的收尾）真正结束。 */
  public async waitForIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all([...this.active.values()].map((record) => record.worker.done));
    }
  }

  /**
   * 入队 / 替换一次 retry（SPEC §8.4 / §16.6 `schedule_retry`）：先取消同 issue 旧
   * timer（若在排），写入完整 {@link RetryEntry} 并保留 claim。返回新 entry；未启用
   * retry 控制面时返回 `null`。
   */
  public scheduleRetry(request: RetryScheduleRequest): RetryEntry | null {
    if (this.retry === undefined || this.scheduler === undefined) {
      return null;
    }

    // 1. 取消同 issue 旧 timer（策略：新 retry 替换旧 timer）。
    const existing = this.state.retryAttempts.get(request.issueId);
    if (existing !== undefined) {
      this.scheduler.cancel(existing.timerHandle);
    }

    // 2. 分配新 ownership token：同时使任何在途 refresh 的迟到结果失效。
    const token = `retry::${request.issueId}::${++this.retryTokenCounter}`;
    this.retryOwners.set(request.issueId, token);

    // 3. 计算延迟：每次新建都读取当前 effective cap（§8.4）。
    const delayMs =
      request.kind === "continuation"
        ? continuationRetryDelayMs()
        : failureRetryDelayMs(request.attempt, this.retry.maxRetryBackoffMs());
    const dueAtMs = this.monotonicNow() + delayMs;

    // 4. 注册 timer：回调只提交带 issueId + token 的到期事件。
    const timerHandle = this.scheduler.schedule(delayMs, () => {
      void this.handleRetryTimerFired(request.issueId, token).catch(() => {
        /* timer 回调异常隔离，不破坏 authority 状态权威 */
      });
    });

    const entry: RetryEntry = {
      issueId: request.issueId,
      identifier: request.identifier,
      attempt: request.attempt,
      dueAtMs,
      timerHandle,
      error: request.error,
    };
    this.state.retryAttempts.set(request.issueId, entry);
    // RetryQueued 仍是 claimed（§7.1）：保留 / 补上 claim 以防重复派发。
    this.state.claimed.add(request.issueId);
    return entry;
  }

  /**
   * 取消某 issue 的排队 timer 与在途 refresh ownership（幂等）。供 dispatch 提交前的
   * 替换、以及后续 M5.4 shutdown / M5.5 reload 复用；**不移除 claim**（调用方决定）。
   */
  public cancelScheduledRetry(issueId: string): void {
    const entry = this.state.retryAttempts.get(issueId);
    if (entry !== undefined) {
      this.scheduler?.cancel(entry.timerHandle);
      this.state.retryAttempts.delete(issueId);
    }
    this.retryOwners.delete(issueId);
  }

  private startWorker(
    issue: Issue,
    attemptNumber: number | null,
    token: string,
    worker: WorkerControl,
    entry: RunningEntry,
  ): void {
    const isCurrent = (): boolean => {
      const record = this.active.get(issue.id);
      return record !== undefined && record.token === token;
    };

    const onEvent = (event: AgentEvent): void => {
      // attempt token 隔离：已结束 / 被替换的旧 worker 不得更新新运行。
      const record = this.active.get(issue.id);
      if (record === undefined || record.token !== token) {
        return;
      }
      applyAgentEvent(this.state, entry, record.telemetry, event);
    };

    const onPhase = (phase: RunAttemptStatus): void => {
      if (!isCurrent()) {
        return;
      }
      entry.attempt.status = phase;
    };

    const continuationDecider = createTrackerRefreshContinuationDecider({
      tracker: this.tracker,
      policy: this.policy,
      isCurrent,
      onRefreshed: (refreshed) => {
        if (isCurrent()) {
          entry.issue = refreshed;
        }
      },
    });

    let runPromise: Promise<AgentAttemptResult>;
    try {
      const attemptOptions = this.createAttemptOptions({
        issue,
        attempt: attemptNumber,
        attemptToken: token,
        signal: worker.signal,
        onEvent,
        onPhase,
        continuationDecider,
      });
      runPromise = this.runner(attemptOptions);
    } catch (error) {
      // options 构造或 runner 同步抛出：立即作为异常 outcome 归约，绝不留下 running 脏项。
      this.completeAttempt(issue.id, token, { kind: "error", error });
      worker.markCompletion(Promise.resolve());
      return;
    }

    const handling = runPromise.then(
      (result) => {
        this.completeAttempt(issue.id, token, { kind: "success", result });
      },
      (error: unknown) => {
        this.completeAttempt(issue.id, token, { kind: "error", error });
      },
    );
    // stop() 等待 handling：保证 stop 返回时 running 已清理、outcome 已归约一次。
    worker.markCompletion(handling);
  }

  /**
   * 无 `await` 的 dispatch 提交段：构造 `RunAttempt` / `RunningEntry` / `WorkerControl`
   * 后原子写入 `running` + `claimed`、取消并删除同 issue retry、注册 worker 并启动。
   * 同步抛出（如外部 `cancelRetry` 失败）时 state 完全未变，由调用方转为 failed。
   */
  private commitDispatch(issue: Issue, attemptNumber: number | null): string {
    const workspacePath = this.resolveWorkspacePath(issue);
    const token = `${issue.id}::${++this.tokenCounter}`;
    const attempt: RunAttempt = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt: attemptNumber,
      workspacePath,
      startedAt: this.now(),
      status: "preparing_workspace",
    };
    const entry: RunningEntry = {
      issue,
      attempt,
      session: null,
      workspacePath,
      startedAtMs: this.monotonicNow(),
      workerHandle: null,
    };
    const worker = new WorkerControl({
      issueId: issue.id,
      attemptToken: token,
      attempt: attemptNumber,
    });
    entry.workerHandle = worker;

    // 提交前先取消同 issue retry timer：失败则不提交，保持 state 一致。
    // 取消失败时 retry 条目与 timer 所有权原样保留，下一次 tick 可重试；
    // 绝不出现"running/claimed 已写入但 timer 未取消 / worker 未注册"的孤立状态。
    const previousRetry = this.state.retryAttempts.get(issue.id);
    if (previousRetry !== undefined) {
      // 外部 M5.2 接线点：同步抛错则调用方以 failed 返回，state 未变。
      this.cancelRetry?.(issue.id);
      // authority 自有的 timer + 在途 refresh ownership。
      this.scheduler?.cancel(previousRetry.timerHandle);
      this.retryOwners.delete(issue.id);
    }

    // 提交段（无 await）：running + claimed 原子进入，retry 条目清除。
    this.state.running.set(issue.id, entry);
    this.state.claimed.add(issue.id);
    if (previousRetry !== undefined) {
      this.state.retryAttempts.delete(issue.id);
    }
    this.active.set(issue.id, { token, worker, entry, telemetry: createAgentTelemetryState() });

    // 启动 runner（同步返回 Promise；结果异步归约）。
    this.startWorker(issue, attemptNumber, token, worker, entry);
    return token;
  }

  private completeAttempt(
    issueId: string,
    token: string,
    outcome: { kind: "success"; result: AgentAttemptResult } | { kind: "error"; error: unknown },
  ): void {
    const record = this.active.get(issueId);
    // 只处理一次 / 忽略迟到：token 不匹配或已被移除即返回。
    if (record === undefined || record.token !== token) {
      return;
    }
    this.active.delete(issueId);

    const { entry, worker } = record;
    const stopReason = worker.stopReason;
    const classification =
      outcome.kind === "success"
        ? classifySuccess(stopReason)
        : classifyError(outcome.error, stopReason);

    entry.attempt.status = classification.status;
    if (classification.error !== null) {
      entry.attempt.error = classification.error;
    }

    const durationMs = Math.max(0, this.monotonicNow() - entry.startedAtMs);
    this.state.codexTotals.secondsRunning += durationMs / 1000;

    this.state.running.delete(issueId);
    if (classification.status === "succeeded") {
      this.state.completed.add(issueId);
    }

    const terminal: WorkerTerminalOutcome = {
      issueId,
      issueIdentifier: entry.attempt.issueIdentifier,
      attemptToken: token,
      attempt: entry.attempt.attempt,
      status: classification.status,
      error: classification.error,
      durationMs,
      stopReason,
      result: outcome.kind === "success" ? outcome.result : null,
      suppressRetry: classification.suppressRetry,
      retryKind: classification.retryKind,
    };

    // 外部观察接线点：异常隔离，不破坏 authority。
    try {
      this.onOutcome?.(terminal);
    } catch {
      /* 外部 sink 异常隔离，不破坏 authority */
    }

    // M5.3 retry 决策：按 outcome 的 retryKind 建立 entry（suppressRetry 时不排）。
    if (this.retry !== undefined && !terminal.suppressRetry) {
      this.scheduleOutcomeRetry(terminal);
    }

    // claim 默认释放；若已建立 retry entry（native 或外部 onOutcome），则保留 claim。
    if (!this.state.retryAttempts.has(issueId)) {
      this.state.claimed.delete(issueId);
    }
  }

  /** worker 终态按分类建立 retry entry：continuation 固定 attempt 1 / failure 递增。 */
  private scheduleOutcomeRetry(terminal: WorkerTerminalOutcome): void {
    if (terminal.retryKind === "continuation") {
      this.scheduleRetry({
        issueId: terminal.issueId,
        identifier: terminal.issueIdentifier,
        attempt: 1,
        kind: "continuation",
        error: null,
      });
      return;
    }
    if (terminal.retryKind === "failure") {
      this.scheduleRetry({
        issueId: terminal.issueId,
        identifier: terminal.issueIdentifier,
        attempt: (terminal.attempt ?? 0) + 1,
        kind: "failure",
        error: terminal.error ?? `worker exited: ${terminal.status}`,
      });
    }
  }

  /**
   * retry timer 到期（SPEC §16.6 `on_retry_timer`）：
   *
   * 1. 校验 ownership token（stale / canceled timer 直接忽略）；
   * 2. pop retry entry，**保留 claim 与 refresh ownership**；
   * 3. `fetch_issues_by_ids([issueId])` refresh；
   * 4. fetch 失败 → 保持 claim，attempt+1 failure backoff，error=`retry refresh failed`；
   * 5. missing → 释放 claim（不清理 workspace）；
   * 6. terminal → 安全清理 workspace 并释放 claim；
   * 7. inactive / unroutable / 缺必填字段 → 释放 claim，不 dispatch、不 cleanup；
   * 8. active+routable 但 slot 不足 → 保持 claim，attempt+1，error=`no available
   *    orchestrator slots`；
   * 9. active+routable 且有 slot → 用当前 retry attempt 重新 dispatch。
   *
   * await 期间发生替换 / 取消 / 新 lifecycle 后，迟到结果必须丢弃——不能只在入口校验
   * 一次。
   */
  private async handleRetryTimerFired(issueId: string, token: string): Promise<void> {
    if (this.retry === undefined || this.scheduler === undefined) {
      return;
    }
    // 1. stale / canceled timer：token 已被替换或删除。
    if (this.retryOwners.get(issueId) !== token) {
      return;
    }
    const entry = this.state.retryAttempts.get(issueId);
    if (entry === undefined) {
      return;
    }
    // 2. pop：保留 claim 与 refresh ownership（token 留在 retryOwners）。
    this.state.retryAttempts.delete(issueId);

    // 3. refresh by id。
    let refreshed: readonly Issue[];
    try {
      refreshed = await this.tracker.fetchIssuesByIds([issueId]);
    } catch {
      if (this.retryOwners.get(issueId) !== token) {
        return; // 已在刷新期间被替换 / 取消。
      }
      this.scheduleRetry({
        issueId,
        identifier: entry.identifier,
        attempt: entry.attempt + 1,
        kind: "failure",
        error: "retry refresh failed",
      });
      return;
    }
    if (this.retryOwners.get(issueId) !== token) {
      return; // 迟到结果：ownership 已变。
    }

    const issue = refreshed.find((candidate) => candidate.id === issueId);
    if (issue === undefined) {
      // 5. missing → 只释放 claim，不清理 workspace。
      this.releaseRetry(issueId);
      return;
    }

    if (isTerminalState(issue.state, this.policy)) {
      // 6. terminal → 安全清理 workspace；清理期间仍持有 claim（普通 dispatch 不会
      //    抢到同一 issue），清理完成且 ownership 未被替换后再释放。
      await this.cleanupTerminalWorkspace(issue);
      if (this.retryOwners.get(issueId) !== token) {
        return; // 清理期间被替换 / 取消：不得 clobber 新 entry。
      }
      this.releaseRetry(issueId);
      return;
    }

    if (!isRetryDispatchAllowed(issue, this.state, this.policy, issueId)) {
      // 7. inactive / unroutable / 缺字段 → 释放 claim，不 dispatch、不 cleanup。
      this.releaseRetry(issueId);
      return;
    }

    if (
      globalAvailableSlots(this.state) <= 0 ||
      perStateAvailableSlots(this.state, issue.state, this.policy) <= 0
    ) {
      // 8. slot 不足 → 保持 claim，failure backoff 重排。
      this.scheduleRetry({
        issueId,
        identifier: issue.identifier,
        attempt: entry.attempt + 1,
        kind: "failure",
        error: "no available orchestrator slots",
      });
      return;
    }

    // 9. 有 slot：消费本次 ownership 后原子重新 dispatch（仍保留 claim）。
    if (this.state.running.has(issueId)) {
      this.releaseRetry(issueId);
      return;
    }
    this.retryOwners.delete(issueId);
    this.state.retryAttempts.delete(issueId);
    try {
      this.commitDispatch(issue, entry.attempt);
    } catch (error) {
      // 同步构造失败：不丢 claim，按 failure 重排（SPEC §16.4 "failed to spawn agent"）。
      this.scheduleRetry({
        issueId,
        identifier: entry.identifier,
        attempt: entry.attempt + 1,
        kind: "failure",
        error: `failed to dispatch retry: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /** 释放 retry ownership：清 token + entry + claim（refresh 后不可派发路径）。 */
  private releaseRetry(issueId: string): void {
    this.retryOwners.delete(issueId);
    this.state.retryAttempts.delete(issueId);
    this.state.claimed.delete(issueId);
  }

  /**
   * terminal refresh 的安全 workspace 清理：只经注入端口，**不做删除 fallback**。
   * `refused` / `failed` / 异常都记为诊断，release 已在上游完成，不启动 worker。
   */
  private async cleanupTerminalWorkspace(issue: Issue): Promise<void> {
    const cleanup = this.retry?.cleanupWorkspace;
    if (cleanup === undefined) {
      return;
    }
    try {
      const result = await cleanup.removeWorkspace(issue.identifier);
      if (result.status === "removed" || result.status === "missing") {
        return;
      }
      if (result.status === "refused") {
        this.emitDiagnostic({
          kind: "cleanup_refused",
          issueId: issue.id,
          identifier: issue.identifier,
          message:
            result.message ??
            `terminal workspace cleanup refused (${result.reason ?? "unknown reason"})`,
        });
        return;
      }
      this.emitDiagnostic({
        kind: "cleanup_failed",
        issueId: issue.id,
        identifier: issue.identifier,
        message: result.message ?? "terminal workspace cleanup failed",
      });
    } catch (error) {
      this.emitDiagnostic({
        kind: "cleanup_error",
        issueId: issue.id,
        identifier: issue.identifier,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private emitDiagnostic(diagnostic: RetryDiagnostic): void {
    try {
      this.retry?.onDiagnostic?.(diagnostic);
    } catch {
      /* 诊断 sink 异常隔离 */
    }
  }
}
