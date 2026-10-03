/**
 * Orchestrator runtime authority：dispatch、worker lifecycle、outcome 归约
 * （SPEC §7.3 / §7.4、§16.4 / §16.5、§17.4，M5.2 / #51）。
 *
 * 单一写入者：所有状态变更经本类串行化为显式 transition。worker 只通过带
 * attempt token 的回调（事件 / 阶段 / outcome）回报，永不直接修改 state；tracker /
 * workspace / agent 也不反向持有调度状态。
 *
 * 边界（根 `AGENTS.md`）：
 * - 本类**不接触** Codex `ChildProcess`，也**不解析** raw Codex JSON；
 * - 取消经 `WorkerControl.signal` 传给 `runAgentAttempt()`；
 * - retry 队列 / backoff（M5.3）、reconciliation / stall（M5.4）、poll loop（M5.5）
 *   不在此实现，但本类提供它们需要的控制与结果契约。
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
  RunAttempt,
  RunAttemptStatus,
  RunningEntry,
  UtcTimestampMs,
} from "@symphony/domain";

import { applyAgentEvent } from "./agent-events";
import {
  createTrackerRefreshContinuationDecider,
  type TrackerRefreshSource,
} from "./continuation-policy";
import { isDispatchEligible, type DispatchPolicy } from "./eligibility";
import { classifyError, classifySuccess } from "./outcome";
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
  /** tracker refresh 能力（同线程 continuation 判定用）。 */
  readonly tracker: TrackerRefreshSource;
  /** 同步解析 issue 的绝对 workspace 路径（`WorkspaceManager.resolveWorkspacePath`）。 */
  readonly resolveWorkspacePath: (issue: Issue) => string;
  /** UTC 墙上时钟（可注入确定性时钟）。 */
  readonly now?: (() => UtcTimestampMs) | undefined;
  /** 单调时钟（可注入确定性时钟，用于运行秒数核算）。 */
  readonly monotonicNow?: (() => MonotonicTimestampMs) | undefined;
  /**
   * worker 终态归约完成后的回调（M5.3 retry 决策接入点）。调用时 running 已删除、
   * success 已计入 `completed`，但 claim 尚未释放——若回调为本 issue 建立
   * `retryAttempts` 条目，则 claim 被保留；否则 claim 被释放。
   */
  readonly onOutcome?: ((outcome: WorkerTerminalOutcome) => void) | undefined;
  /**
   * 同 issue retry entry 的 timer 取消接线点（M5.3 完整所有权）。dispatch 提交段
   * 同步调用，用于在删除 `retryAttempts` 条目的同时取消其 timer。
   */
  readonly cancelRetry?: ((issueId: string) => void) | undefined;
}

/** {@link OrchestratorAuthority.dispatchIssue} 的返回值。 */
export interface DispatchResult {
  readonly kind: "dispatched" | "skipped" | "not_eligible";
  readonly issueId: string;
  /** 仅 `dispatched` 时非 `null`。 */
  readonly attemptToken: string | null;
}

interface ActiveWorkerRecord {
  readonly token: string;
  readonly worker: WorkerControl;
  readonly entry: RunningEntry;
}

interface DispatchOptions {
  /** `RunAttempt.attempt`：首跑 `null`，retry / continuation `>= 1`（§4.1.5）。 */
  readonly attempt?: number | null | undefined;
}

/**
 * 单一权威的 dispatch + worker lifecycle 实现。
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

  private readonly active = new Map<string, ActiveWorkerRecord>();
  private tokenCounter = 0;

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
  }

  /** 当前是否有活跃 worker（供 poll loop / 测试观察）。 */
  public get activeWorkerCount(): number {
    return this.active.size;
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

    // 3. 同步构造（任何抛出都发生在 state 变更之前）。
    const attemptNumber = options.attempt ?? null;
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

    // 4. 提交段（无 await）：running + claimed 原子进入，retry 条目 + timer 清除。
    this.state.running.set(issue.id, entry);
    this.state.claimed.add(issue.id);
    const hadRetry = this.state.retryAttempts.delete(issue.id);
    if (hadRetry) {
      this.cancelRetry?.(issue.id);
    }
    this.active.set(issue.id, { token, worker, entry });

    // 5. 启动 runner（同步返回 Promise；结果异步归约）。
    this.startWorker(issue, attemptNumber, token, worker, entry);

    return { kind: "dispatched", issueId: issue.id, attemptToken: token };
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
      if (!isCurrent()) {
        return;
      }
      applyAgentEvent(this.state, entry, event);
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

    // M5.3 接入点：回调可在归约后为 issue 建立 retry entry（从而保留 claim）。
    try {
      this.onOutcome?.(terminal);
    } catch {
      /* 外部 sink 异常隔离，不破坏 authority */
    }

    // claim 默认释放；若 onOutcome 已建立 retry entry，则保留 claim 供 retry。
    if (!this.state.retryAttempts.has(issueId)) {
      this.state.claimed.delete(issueId);
    }
  }
}
