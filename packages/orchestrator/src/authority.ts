/**
 * Orchestrator runtime authority：dispatch、worker lifecycle、outcome 归约，
 * retry 队列 / timer 所有权，以及 active-run reconciliation / stall / terminal
 * cleanup（SPEC §7.3 / §7.4、§8.4 / §8.5 / §8.6、§14.2 / §14.3、§16.3 / §16.4 /
 * §16.5 / §16.6、§17.4）。
 *
 * 单一写入者：所有状态变更经本类串行化为显式 transition。worker 只通过带 attempt
 * token 的回调（事件 / 阶段 / outcome）回报，永不直接修改 state；tracker / workspace /
 * agent 也不反向持有调度状态。retry timer 回调同样只能提交"带 issueId + retry token
 * 的到期事件"，ownership 校验后才允许刷新 / 重新派发。
 *
 * 边界（根 `AGENTS.md`）：
 * - 本类**不接触** Codex `ChildProcess`，也**不解析** raw Codex JSON；
 * - 取消经 `WorkerControl.signal` 传给 `runAgentAttempt()`；
 * - terminal refresh / reconciliation / startup sweep 的破坏性清理只经注入的
 *   `cleanupWorkspace` 端口（workspace 包），本类不做删除 fallback；
 * - poll loop 的编排（startup / tick 顺序 / per-tick 降级）在 `loop.ts`；本类为它
 *   提供 `reconcileRunningIssues` / `runStartupTerminalCleanup` / `dispatchIssue` /
 *   `applyEffectiveSchedulingConfig`（live config re-apply）与 `shutdown`（全局关停）
 *   控制契约。
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
  isActiveState,
  isRetryDispatchAllowed,
  isTerminalState,
  perStateAvailableSlots,
  type DispatchPolicy,
} from "./eligibility";
import type { OrchestratorEvent, RetryEventReason } from "./events";
import { classifyError, classifySuccess } from "./outcome";
import {
  decideReconciliationAction,
  isStallDetectionEnabled,
  isWorkerStalled,
  type ReconciliationResult,
  type StartupCleanupResult,
} from "./reconciliation";
import {
  createRetryScheduler,
  type RetryDelayKind,
  type RetryDiagnostic,
  type RetryOptions,
  type RetryScheduler,
  type RetryWorkspaceCleanup,
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
  readonly issueUrl?: string | null;
  /** retry 队列内 **1-based** attempt（§4.1.7；与 `RunAttempt.attempt` 语义不同）。 */
  readonly attempt: number;
  /** 触发本次 retry 的失败原因；continuation 为 `null`。 */
  readonly error: string | null;
  /** 延迟口径：continuation 固定 1s；failure `min(10000 * 2^(attempt-1), cap)`。 */
  readonly kind: RetryDelayKind;
  readonly reason?: RetryEventReason;
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
  /** Isolated, read-only committed facts; never a scheduling input. */
  readonly onEvent?: ((event: OrchestratorEvent) => void) | undefined;
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
  /**
   * 当前 effective `codex.stall_timeout_ms`（M5.4，getter）。每次 reconciliation 读取
   * 现值；`<= 0` / 非有限值禁用整个 stall 检测（§8.5 Part A / §6.2 reload 语义）。
   * 缺省视为禁用。
   */
  readonly stallTimeoutMs?: (() => number) | undefined;
  /**
   * terminal workspace 安全清理端口（M5.4）。从 `RetryOptions` 提升为 authority 顶层
   * 能力：reconciliation、retry refresh 与 startup terminal sweep 共用同一个端口，
   * 因此 **cleanup 不再依赖是否启用 retry**。未提供时回退 `retry.cleanupWorkspace`
   * （向后兼容 M5.3 接线）；两者都缺省时 cleanup 为 no-op 且 startup sweep 报
   * `unavailable`。
   */
  readonly cleanupWorkspace?: RetryWorkspaceCleanup | undefined;
  /**
   * cleanup / startup 诊断出口（M5.4）。未提供时回退 `retry.onDiagnostic`（向后兼容）。
   * 异常被隔离，不破坏 authority 状态权威。
   */
  readonly onCleanupDiagnostic?: ((diagnostic: RetryDiagnostic) => void) | undefined;
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

/**
 * 同 issue 收尾互斥屏障：覆盖从"请求 stop"到"workspace 删除完成"的整个异步窗口。
 *
 * `promise` 供同 issue 的后续 refresh / launch 等待；`release()` 在收尾结束（含异常）
 * 后解除。晚到的收尾会**串行排队**在既有屏障之后，而不是覆盖前一个 promise 并提前
 * 解除互斥。
 */
interface CleanupBarrier {
  readonly promise: Promise<void>;
  readonly release: () => void;
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
  /**
   * 当前 effective 调度策略。M5.5 起经 {@link applyEffectiveSchedulingConfig} 在
   * 每次 tick 更新（workflow reload 后生效）；dispatch / retry / reconciliation /
   * startup sweep / continuation 每次都读取现值，不缓存构造时快照。
   */
  private policy: DispatchPolicy;
  private readonly runner: AgentAttemptRunner;
  private readonly createAttemptOptions: AttemptOptionsFactory;
  private readonly tracker: TrackerRefreshSource;
  private readonly resolveWorkspacePath: (issue: Issue) => string;
  private readonly now: () => UtcTimestampMs;
  private readonly monotonicNow: () => MonotonicTimestampMs;
  private readonly onEvent: ((event: OrchestratorEvent) => void) | undefined;
  private readonly onOutcome: ((outcome: WorkerTerminalOutcome) => void) | undefined;
  private readonly cancelRetry: ((issueId: string) => void) | undefined;
  private readonly retry: RetryOptions | undefined;
  private readonly scheduler: RetryScheduler | undefined;
  private readonly stallTimeoutMs: () => number;
  private readonly cleanupPort: RetryWorkspaceCleanup | undefined;
  private readonly cleanupDiagnostic: ((diagnostic: RetryDiagnostic) => void) | undefined;

  private readonly active = new Map<string, ActiveWorkerRecord>();
  /**
   * 每个 issue 当前 retry ownership token：排队 timer 与在途 refresh 共用。旧 token
   * 的迟到回调（stale / canceled timer、被替换的 refresh）一律被拒绝。
   */
  private readonly retryOwners = new Map<string, string>();
  /**
   * 每个 issue 进行中的 terminal 收尾屏障。用于把 cleanup（以及从 stop 开始的整个
   * 收尾窗口）与后续同 issue 的 refresh / launch **串行化**：ownership token 只能
   * 保护内存状态，无法撤销已经发生的目录删除，因此新 retry / 新 dispatch 必须等旧
   * 收尾真正结束后才能启动 worker。
   */
  private readonly cleanupInFlight = new Map<string, CleanupBarrier>();
  /**
   * 每个 issue 已派发的生命周期**代数**：每次 `commitDispatch()`（首跑或 retry / continuation
   * 重派）递增，并跨 worker 退出 / retry 排队持续保留。reconciliation 在 fetch 前捕获
   * 代数，结果返回后若发现代数已变，说明该 issue 已被更新的生命周期接管——即使新
   * attempt 也已经退出并留下了自己的 retry，也必须整条丢弃旧结果，绝不能把后来
   * 生命周期的 retry / claim 当作旧生命周期处理。
   */
  private readonly lifecycleGeneration = new Map<string, number>();
  /**
   * 每个 issue 最近的 reconciliation claim epoch：`reconcileRunningIssues()` 在**同步**
   * 捕获 running 集合时为每个 issue 分配一个递增 epoch，覆盖更早调用在该 issue 上的
   * 写入权。异步 refresh 返回后只有仍持有该 issue 最新 epoch 的调用才允许更新 snapshot /
   * stop / cleanup——这样重叠调用按**发起顺序**决胜，较晚发起的调用结果永不被较早调用
   * 的迟到结果回退（无论两者 fetch 完成顺序如何）。
   */
  private readonly reconcileEpoch = new Map<string, number>();
  private tokenCounter = 0;
  private retryTokenCounter = 0;
  private reconcileEpochCounter = 0;
  /**
   * 全局关停标记（M5.5 shutdown）：同步置位后拒绝新 dispatch / retry，使在途
   * retry refresh 的迟到结果失效，并停止全部 worker。幂等由 {@link shutdownPromise}
   * 保证。
   */
  private stopping = false;
  private shutdownPromise: Promise<void> | null = null;
  /**
   * 已开始的 workspace 删除（startup sweep / reconciliation / retry terminal cleanup）
   * 的全局在途登记。`shutdown()` 等待它们真正结束，避免调用方以为已关停后旧生命周期
   * 仍迟到删除目录；`removeWorkspaceFor` 在 stopping 后拒绝**开启**新的删除。
   */
  private readonly inFlightCleanups = new Set<Promise<unknown>>();

  constructor(options: OrchestratorAuthorityOptions) {
    this.state = options.state;
    this.policy = options.policy;
    this.runner = options.runner;
    this.createAttemptOptions = options.createAttemptOptions;
    this.tracker = options.tracker;
    this.resolveWorkspacePath = options.resolveWorkspacePath;
    this.now = options.now ?? (() => Date.now());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.onEvent = options.onEvent;
    this.onOutcome = options.onOutcome;
    this.cancelRetry = options.cancelRetry;
    this.retry = options.retry;
    this.scheduler = options.retry !== undefined
      ? (options.retry.scheduler ?? createRetryScheduler())
      : undefined;
    this.stallTimeoutMs = options.stallTimeoutMs ?? (() => 0);
    this.cleanupPort = options.cleanupWorkspace ?? options.retry?.cleanupWorkspace;
    this.cleanupDiagnostic = options.onCleanupDiagnostic ?? options.retry?.onDiagnostic;
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

  /** 当前 effective poll interval（M5.5 loop 用它安排下一次 tick）。 */
  public get pollIntervalMs(): number {
    return this.state.pollIntervalMs;
  }

  /** 是否仍有全局 dispatch slot（M5.5 loop 的 dispatch-until-slots-exhausted）。 */
  public hasAvailableGlobalSlot(): boolean {
    return globalAvailableSlots(this.state) > 0;
  }

  /** 是否已进入全局关停（M5.5 诊断 / 测试观察）。 */
  public get isStopping(): boolean {
    return this.stopping;
  }

  /**
   * 原子应用一次 effective 调度配置（M5.5 live config re-apply，SPEC §6.2）。
   *
   * 只写入两个"当前生效"标量（`pollIntervalMs` / `maxConcurrentAgents`）与
   * `policy`；retry cap / stall timeout 继续由构造时注入的 getter 从同一 effective
   * 配置读取，因此本接口无需触碰它们。并发上限**下调不主动终止**已运行 worker：
   * 新值只影响之后的 slot 判定与 dispatch。
   */
  public applyEffectiveSchedulingConfig(update: {
    readonly pollIntervalMs: number;
    readonly maxConcurrentAgents: number;
    readonly policy: DispatchPolicy;
  }): void {
    this.state.pollIntervalMs = update.pollIntervalMs;
    this.state.maxConcurrentAgents = update.maxConcurrentAgents;
    this.policy = update.policy;
  }

  /**
   * **同步**关闭调度权限（M5.5 lifecycle，SPEC §14.3）：置 stopping、使全部 retry
   * ownership 失效（含已 pop entry、仍在 `fetchIssuesByIds` 的 refresh）、取消并清空
   * 排队 retry timer，并拒绝之后**开启**新的 workspace 删除。幂等。
   *
   * 调用方（loop.stop）必须在等待任何在途 tick / startup **之前**调用它，确保关停
   * 窗口内不再产生新 dispatch / retry / cleanup。
   */
  public beginShutdown(): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.retryOwners.clear();
    if (this.scheduler !== undefined) {
      for (const entry of this.state.retryAttempts.values()) {
        this.scheduler.cancel(entry.timerHandle);
      }
    }
    this.state.retryAttempts.clear();
  }

  /**
   * 全局关停（M5.5 lifecycle，SPEC §14.3）：先同步 {@link beginShutdown}（拒绝新
   * dispatch / retry、失效 ownership、取消 retry timer），再以 `{ kind: "shutdown" }`
   * 停止全部 worker，并等待**全部收尾**真正结束——worker 生命周期以及已开始的
   * workspace cleanup。
   *
   * - **同步前缀**：`beginShutdown()` 在返回 Promise 前执行，因此调用方能立即阻止
   *   新工作，无需等待异步收尾；
   * - 幂等：重复调用共享同一完成 Promise；
   * - 不删除正常 workspace（cleanup 只处理 terminal 收尾，且停止后不再开启新删除）。
   */
  public shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) {
      return this.shutdownPromise;
    }
    this.beginShutdown();

    const records = [...this.active.values()];
    this.shutdownPromise = (async () => {
      await Promise.allSettled(
        records.map((record) => record.worker.stop({ kind: "shutdown" })),
      );
      await this.waitForIdle();
      await this.waitForCleanups();
    })();
    return this.shutdownPromise;
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
    // 0. 关停后拒绝新 dispatch（M5.5）。
    if (this.stopping) {
      return { kind: "skipped", issueId: issue.id, attemptToken: null };
    }
    // 1. 双检查：claimed / running 任一占用即跳过；同 issue cleanup 在途也跳过
    //    （cleanup 会删除 workspace，必须等它结束后由下一次 tick 重新评估）。
    if (
      this.cleanupInFlight.has(issue.id) ||
      this.state.claimed.has(issue.id) ||
      this.state.running.has(issue.id)
    ) {
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
      this.emitEvent(() => ({ event: "dispatch_failed", issueId: issue.id, issueIdentifier: issue.identifier, issueUrl: issue.url }));
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

  /** 等待所有已开始的 workspace 删除真正结束（含 shutdown 前已在途的删除）。 */
  public async waitForCleanups(): Promise<void> {
    while (this.inFlightCleanups.size > 0) {
      await Promise.allSettled([...this.inFlightCleanups]);
    }
  }

  /**
   * 入队 / 替换一次 retry（SPEC §8.4 / §16.6 `schedule_retry`）：先取消同 issue 旧
   * timer（若在排），写入完整 {@link RetryEntry} 并保留 claim。返回新 entry；未启用
   * retry 控制面时返回 `null`。
   */
  public scheduleRetry(request: RetryScheduleRequest): RetryEntry | null {
    // 关停后不再建立 / 替换 retry timer（M5.5）。
    if (this.stopping || this.retry === undefined || this.scheduler === undefined) {
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
      issueUrl: request.issueUrl ?? null,
      attempt: request.attempt,
      dueAtMs,
      timerHandle,
      error: request.error,
    };
    this.state.retryAttempts.set(request.issueId, entry);
    // RetryQueued 仍是 claimed（§7.1）：保留 / 补上 claim 以防重复派发。
    this.state.claimed.add(request.issueId);
    this.emitEvent(() => ({
      event: "retry_scheduled", issueId: request.issueId, issueIdentifier: request.identifier,
      issueUrl: entry.issueUrl ?? null, attempt: request.attempt, retryInMs: delayMs,
      retryKind: request.kind, reason: request.reason ?? "manual_retry",
    }));
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

  /**
   * 每个 tick 的 active-run reconciliation（SPEC §7.3 "Poll Tick" / "Reconciliation
   * State Refresh" / "Stall Timeout"、§8.5、§14.2、§16.3、§17.4）。
   *
   * 顺序严格按 SPEC：**先 stall 检测，再对剩余 running 做一次批量 refresh**。
   *
   * Part A（stall）：`stallTimeoutMs <= 0` 时整个跳过；否则用 UTC 墙上时钟计算
   * `max(now - (lastCodexTimestamp ?? pendingTimestamp ?? startedAt), 0)`，仅**严格大于**
   * 阈值才以 `{ kind: "stall" }` 停止 worker；终态经既有 outcome 归约为 `stalled` 并建立
   * 一次 failure retry（不手动排第二次）。
   *
   * Part B（refresh）：
   * - 在 Part A 完成后按**当前仍在 running** 的集合取“剩余”，任一 issue 只有仍持有写入权
   *   （epoch + generation）且其 worker 仍在 `active` 时才参与本次 fetch；stall 收尾期间
   *   自然退出的 worker 不参与；
   * - 剩余为空 → 立即返回，**零 tracker 请求**；
   * - fetch 前捕获每个 issue 的 attempt token，`fetchIssuesByIds(runningIds)` 失败 → 保留
   *   worker（§14.2），下一 tick 重试；
   * - 只处理本次请求中的 ID（额外返回记录忽略）；
   * - active + routable → 更新 running entry 的 issue snapshot；
   * - terminal → stop（`{ kind: "terminal" }`）+ 屏障内安全 cleanup；
   * - active 但 unroutable / 非 active 非 terminal / missing → stop（不 cleanup）。
   *
   * 刷新期间 worker 可能自然退出、被新 attempt 接管，或**同 issue 已被更新的生命周期
   * 派发过新 worker 并再次退出**。因此每个 issue 的结果都要同时回校验两个值：
   *
   * - **reconciliation epoch**：本次调用是否仍是最晚发起、持有该 issue 写入权的调用；
   * - **lifecycle generation**：本次捕获的 attempt 之后是否已有新的 `commitDispatch()`
   *   （含 retry / continuation 重派）。
   *
   * 任一不满足即整条丢弃该 issue 的结果——即使当前已无 active worker、且存在一个 retry，
   * 也不能把**后来生命周期**留下的 retry / claim 当作旧生命周期处理。只有两者都成立、
   * 且原 attempt 已自然退出、判定为 stop 时，才取消该旧生命周期的 retry 并释放 claim
   * （duplicate outcome 不产生 duplicate retry）；terminal 仍会 cleanup。
   *
   * 重叠调用**不串行阻塞**，而是按发起顺序决胜：较晚发起的调用在其 issue 上覆盖 epoch，
   * 较早调用的迟到结果因 epoch 失效而被丢弃，因此迟到 snapshot 不会回退较新结果，迟到
   * inactive / terminal 也不会错误 stop 已恢复 active 的 issue。所有 state 写入仍经本类
   * 串行 transition，不产生重复 dispatch。
   */
  public async reconcileRunningIssues(): Promise<ReconciliationResult> {
    // 同步捕获本轮 claim（任何 await 之前）：为当前每个 active issue 分配递增 epoch，
    // 并记录其生命周期代数与 attempt token。后续所有写入都要回校验这些值。
    const capturedEpoch = new Map<string, number>();
    const capturedGeneration = new Map<string, number>();
    const capturedTokens = new Map<string, string>();
    for (const [issueId, record] of this.active.entries()) {
      const epoch = ++this.reconcileEpochCounter;
      this.reconcileEpoch.set(issueId, epoch);
      capturedEpoch.set(issueId, epoch);
      capturedGeneration.set(issueId, this.lifecycleGeneration.get(issueId) ?? 0);
      capturedTokens.set(issueId, record.token);
    }
    return this.performReconciliation({ capturedEpoch, capturedGeneration, capturedTokens });
  }

  /**
   * {@link reconcileRunningIssues} 的实际执行体；全部写入都经 `stillOwns()` 回校验，
   * 以保证重叠调用与生命周期替换下只有最新结果生效。
   */
  private async performReconciliation(captured: {
    readonly capturedEpoch: ReadonlyMap<string, number>;
    readonly capturedGeneration: ReadonlyMap<string, number>;
    readonly capturedTokens: ReadonlyMap<string, string>;
  }): Promise<ReconciliationResult> {
    const { capturedEpoch, capturedGeneration, capturedTokens } = captured;
    const capturedIds = [...capturedTokens.keys()];
    const identities = new Map(capturedIds.map((id) => {
      const issue = this.active.get(id)?.entry.issue;
      return [id, { identifier: issue?.identifier ?? null, url: issue?.url ?? null }];
    }));
    const applied = (issueId: string, issue: Issue | undefined, action: "stop" | "retire_exited_lifecycle"): void => {
      const identity = issue ?? identities.get(issueId);
      const reason = issue === undefined ? "missing" : isTerminalState(issue.state, this.policy)
        ? "terminal" : isActiveState(issue.state, this.policy) ? "unroutable" : "inactive";
      this.emitEvent(() => ({ event: "reconciliation_applied", issueId,
        issueIdentifier: identity?.identifier ?? null, issueUrl: identity?.url ?? null, action, reason }));
    };
    const stalledIssueIds: string[] = [];

    const stillOwns = (issueId: string): boolean =>
      this.reconcileEpoch.get(issueId) === capturedEpoch.get(issueId) &&
      (this.lifecycleGeneration.get(issueId) ?? 0) === capturedGeneration.get(issueId);

    // Part A: stall detection（不依赖 tracker；tracker 后续失败不撤销已执行的 stall）。
    const stallTimeoutMs = this.stallTimeoutMs();
    if (isStallDetectionEnabled(stallTimeoutMs)) {
      const nowUtc = this.now();
      for (const issueId of capturedIds) {
        if (!stillOwns(issueId)) {
          continue; // 已被更晚的 reconciliation / 新生命周期接管。
        }
        const record = this.active.get(issueId);
        if (record === undefined) {
          continue;
        }
        if (!isWorkerStalled(record.entry, record.telemetry, nowUtc, stallTimeoutMs)) {
          continue;
        }
        stalledIssueIds.push(issueId);
        // stall stop → completeAttempt 归约 `stalled` + 建立一次 failure retry。
        await record.worker.stop({ kind: "stall" });
      }
    }

    // Part B: 只对 Part A 完成后**此刻仍在 running** 的剩余 issue 做一次批量 refresh。
    // stall 收尾（`await record.worker.stop`）以及其他 await 期间自然退出 / 被新生命周期
    // 替换的 worker **不参与本次 fetch**——它们的收尾由各自路径负责（自然退出已建立自己的
    // retry），既满足 SPEC §16.3 “stall 后再读取 running IDs”，也保证剩余为空时零请求。
    const stalled = new Set(stalledIssueIds);
    const scannedIssueIds = capturedIds.filter((issueId) => {
      if (stalled.has(issueId)) {
        return false;
      }
      if (!stillOwns(issueId)) {
        return false;
      }
      const record = this.active.get(issueId);
      return record !== undefined && record.token === capturedTokens.get(issueId);
    });
    const stoppedIssueIds: string[] = [];
    const cleanedIssueIds: string[] = [];
    const updatedIssueIds: string[] = [];
    const result = (refreshFailed: boolean): ReconciliationResult => ({
      scannedIssueIds,
      stalledIssueIds,
      stoppedIssueIds,
      cleanedIssueIds,
      updatedIssueIds,
      refreshFailed,
    });

    if (scannedIssueIds.length === 0) {
      return result(false); // no-op：零 tracker 请求。
    }

    let refreshed: readonly Issue[];
    try {
      refreshed = await this.tracker.fetchIssuesByIds(scannedIssueIds);
    } catch {
      return result(true); // §14.2：保留当前 worker，下一 tick 重试。
    }

    const byId = new Map<string, Issue>();
    for (const issue of refreshed) {
      // 只处理本次请求的 ID；额外返回记录忽略。
      if (capturedTokens.has(issue.id)) {
        byId.set(issue.id, issue);
      }
    }

    for (const issueId of scannedIssueIds) {
      // 迟到结果回校验：被更晚调用覆盖或被新生命周期替换时整条丢弃。
      if (!stillOwns(issueId)) {
        continue;
      }

      const record = this.active.get(issueId);
      if (record !== undefined && record.token !== capturedTokens.get(issueId)) {
        // 防御性：代数一致时 token 必一致；不一致则不作用于该 entry。
        continue;
      }

      const issue = byId.get(issueId);

      if (record === undefined) {
        // 捕获的 attempt 已在 refresh 期间自然退出，且此后没有新 dispatch（generation
        // 未变）。只有 stop 分支需要接管旧生命周期的 retry / claim；active 快照交给
        // 自然退出建立的 retry 流程。
        if (issue === undefined) {
          this.retireExitedLifecycle(issueId);
          applied(issueId, issue, "retire_exited_lifecycle");
          stoppedIssueIds.push(issueId);
          continue;
        }
        const decision = decideReconciliationAction(issue, this.policy);
        if (decision === "refresh_snapshot") {
          continue;
        }
        this.retireExitedLifecycle(issueId);
        applied(issueId, issue, "retire_exited_lifecycle");
        stoppedIssueIds.push(issueId);
        if (decision === "stop_and_cleanup") {
          await this.cleanupTerminalWorkspace(issue);
          cleanedIssueIds.push(issueId);
        }
        continue;
      }

      if (issue === undefined) {
        // missing → stop，不 cleanup（§8.5 Part B / §16.3）。
        await record.worker.stop({ kind: "reconciliation" });
        applied(issueId, issue, "stop");
        stoppedIssueIds.push(issueId);
        continue;
      }

      const decision = decideReconciliationAction(issue, this.policy);
      if (decision === "refresh_snapshot") {
        record.entry.issue = issue;
        updatedIssueIds.push(issueId);
        continue;
      }
      if (decision === "stop_and_cleanup") {
        await this.stopAndCleanupTerminal(issueId, issue);
        applied(issueId, issue, "stop");
        stoppedIssueIds.push(issueId);
        cleanedIssueIds.push(issueId);
        continue;
      }
      // active 但 unroutable / 非 active 非 terminal → stop，不 cleanup。
      await record.worker.stop({ kind: "reconciliation" });
      applied(issueId, issue, "stop");
      stoppedIssueIds.push(issueId);
    }

    return result(false);
  }

  /**
   * Startup terminal workspace sweep（SPEC §8.1 / §8.6 / §14.3 / §16.1）。
   *
   * 用 tracker 公共 `fetchIssuesByStates(policy.terminalStates)` 拉取 terminal issues，
   * 对每个 identifier 经真实 `cleanupWorkspace` 端口逐项 `removeWorkspace`：
   *
   * - 不做 required-label / dispatchable 筛选（§16.1 只按 terminal states）；
   * - fetch 失败 → 诊断后返回，**不阻止服务启动**（§8.6 / §14.2）；
   * - 单项 `refused` / `failed` / 异常 → 诊断后继续其余项，绝不做 `fs.rm` 等 fallback
   *   （安全边界归 workspace 包，§9.5）；
   * - `missing` 视为幂等成功；重复调用安全。
   *
   * 不复制 containment 逻辑；调用顺序（首个 dispatch 前）由 M5.5 编排保证。
   */
  public async runStartupTerminalCleanup(): Promise<StartupCleanupResult> {
    const removed: string[] = [];
    const missing: string[] = [];
    const refused: string[] = [];
    const failed: string[] = [];

    if (this.cleanupPort === undefined) {
      this.emitDiagnostic({
        kind: "cleanup_unavailable",
        issueId: null,
        identifier: null,
        message: "startup terminal cleanup skipped: no workspace cleanup port configured",
      });
      return { unavailable: true, fetchFailed: false, removed, missing, refused, failed };
    }
    const fetchByStates = this.tracker.fetchIssuesByStates;
    if (fetchByStates === undefined) {
      this.emitDiagnostic({
        kind: "cleanup_unavailable",
        issueId: null,
        identifier: null,
        message: "startup terminal cleanup skipped: tracker has no fetchIssuesByStates capability",
      });
      return { unavailable: true, fetchFailed: false, removed, missing, refused, failed };
    }
    if (this.policy.terminalStates.length === 0) {
      return { unavailable: false, fetchFailed: false, removed, missing, refused, failed };
    }

    let issues: readonly Issue[];
    try {
      issues = await fetchByStates.call(this.tracker, this.policy.terminalStates);
    } catch (error) {
      this.emitDiagnostic({
        kind: "cleanup_fetch_failed",
        issueId: null,
        identifier: null,
        message: error instanceof Error ? error.message : String(error),
      });
      // fetch 失败不阻止服务启动（§8.6）。
      return { unavailable: false, fetchFailed: true, removed, missing, refused, failed };
    }

    for (const issue of issues) {
      const status = await this.removeWorkspaceFor(issue.identifier, issue.id);
      switch (status) {
        case "removed":
          removed.push(issue.identifier);
          break;
        case "missing":
          missing.push(issue.identifier);
          break;
        case "refused":
          refused.push(issue.identifier);
          break;
        case "failed":
          failed.push(issue.identifier);
          break;
        case null:
          // cleanup 端口在上一次 await 期间被移除（不可变配置下不会发生）——保守返回。
          return { unavailable: true, fetchFailed: false, removed, missing, refused, failed };
      }
    }

    return { unavailable: false, fetchFailed: false, removed, missing, refused, failed };
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
      // getter：continuation 判定读取当前 effective policy，reload 后立即生效。
      policy: () => this.policy,
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

    this.emitEvent(() => ({ event: "worker_started", issueId: issue.id, issueIdentifier: issue.identifier, issueUrl: issue.url, attempt: attemptNumber }));
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
    // 生命周期代数只在真正提交后递增：任何在途 reconciliation 捕获的旧代数自此失效。
    this.lifecycleGeneration.set(issue.id, (this.lifecycleGeneration.get(issue.id) ?? 0) + 1);

    this.emitEvent(() => ({ event: "dispatch_committed", issueId: issue.id, issueIdentifier: issue.identifier, issueUrl: issue.url, attempt: attemptNumber }));
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
      issueUrl: entry.issue.url,
      sessionId: entry.session?.sessionId ?? null,
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
      this.scheduleOutcomeRetry(terminal, entry.issue.url);
    }

    // claim 默认释放；若已建立 retry entry（native 或外部 onOutcome），则保留 claim。
    if (!this.state.retryAttempts.has(issueId)) {
      this.state.claimed.delete(issueId);
    }
  }

  /** worker 终态按分类建立 retry entry：continuation 固定 attempt 1 / failure 递增。 */
  private scheduleOutcomeRetry(terminal: WorkerTerminalOutcome, issueUrl: string | null): void {
    // 关停期间自然退出的 worker 不得重建 retry / timer（M5.5）。
    if (this.stopping) {
      return;
    }
    if (terminal.retryKind === "continuation") {
      this.scheduleRetry({
        issueId: terminal.issueId,
        identifier: terminal.issueIdentifier,
        issueUrl,
        attempt: 1,
        kind: "continuation",
        reason: "continuation",
        error: null,
      });
      return;
    }
    if (terminal.retryKind === "failure") {
      this.scheduleRetry({
        issueId: terminal.issueId,
        identifier: terminal.issueIdentifier,
        issueUrl,
        attempt: (terminal.attempt ?? 0) + 1,
        kind: "failure",
        reason: "worker_failure",
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
    // 关停后不再处理到期 retry（同步校验；shutdown 已 clear ownership）。
    if (this.stopping || this.retry === undefined || this.scheduler === undefined) {
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

    // 2b. 若同 issue 仍有 terminal cleanup 在途（旧回调删目录），必须先等它结束再
    //     refresh / launch，否则新 worker 会写入随后被旧 cleanup 删除的 workspace。
    const pendingCleanup = this.cleanupInFlight.get(issueId);
    if (pendingCleanup !== undefined) {
      await pendingCleanup.promise;
      if (this.retryOwners.get(issueId) !== token) {
        return; // cleanup 期间被替换 / 取消。
      }
    }

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
        issueUrl: entry.issueUrl ?? null,
        attempt: entry.attempt + 1,
        kind: "failure",
        reason: "tracker_refresh_failed",
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
        issueUrl: issue.url,
        attempt: entry.attempt + 1,
        kind: "failure",
        reason: "no_available_slots",
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
        identifier: issue.identifier,
        issueUrl: issue.url,
        attempt: entry.attempt + 1,
        kind: "failure",
        reason: "dispatch_failed",
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
   * reconciliation 在 refresh 期间发现捕获的 attempt 已自然退出、且刷新结果要求 stop：
   * 取消该**旧生命周期**的 retry timer / 在途 ownership 并释放其 claim。
   *
   * **前置条件**：调用方已确认该 issue 的 lifecycle generation 自捕获以来未变
   * （`stillOwns()`）。仅凭"`active` 中无该 issue"**不足以**说明当前的 retry 属于捕获的
   * 旧 attempt——旧 attempt 退出后其 continuation retry 可能已经派发过新 worker，新
   * worker 再次退出后留下的是**新生命周期**的 retry（attempt 更大）。generation 校验保证
   * 这种情况被整条丢弃，不会误取消后来者的 retry / claim。terminal 分支随后仍会清理
   * workspace（调用方继续持有 epoch + generation）。
   */
  private retireExitedLifecycle(issueId: string): void {
    this.cancelScheduledRetry(issueId);
    this.state.claimed.delete(issueId);
  }

  /**
   * terminal cleanup：只经注入端口，**不做删除 fallback**（§9.5 / §8.4 note）。
   *
   * 整个异步窗口由 {@link withCleanupBarrier} 保护：同 issue 的后续 refresh / launch
   * 必须等删除真正结束，避免新 worker 写入随后被删的 workspace。
   */
  private async cleanupTerminalWorkspace(issue: Issue): Promise<void> {
    await this.withCleanupBarrier(issue.id, () => this.performTerminalCleanup(issue));
  }

  /**
   * reconciliation 的 terminal 收尾：**屏障先于 stop 建立**，随后在同一屏障内完成
   * `stop → outcome/after_run 收尾 → removeWorkspace`，保证"停止 + 删除"次序确定，
   * 且 stop 返回与 cleanup 登记之间没有新 worker 抢入的窗口（§7.4 / §8.5）。
   */
  private stopAndCleanupTerminal(issueId: string, issue: Issue): Promise<void> {
    return this.withCleanupBarrier(issueId, async () => {
      await this.stopWorker(issueId, { kind: "terminal" });
      await this.performTerminalCleanup(issue);
    });
  }

  /**
   * 同 issue 收尾互斥屏障：把 `action` 串行排队在既有 barrier 之后，并在 action 结束后
   * 释放。晚到的收尾不会覆盖前一个 promise 而提前解除互斥——`cleanupInFlight` 始终持有
   * "最近一个尚未结束的收尾"。
   */
  private async withCleanupBarrier<T>(issueId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.cleanupInFlight.get(issueId);
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier: CleanupBarrier = { promise, release };
    this.cleanupInFlight.set(issueId, barrier);
    try {
      // 串行化：前一个收尾（可能包含目录删除）结束后才轮到本次。
      if (previous !== undefined) {
        await previous.promise;
      }
      return await action();
    } finally {
      if (this.cleanupInFlight.get(issueId) === barrier) {
        this.cleanupInFlight.delete(issueId);
      }
      release();
    }
  }

  private performTerminalCleanup(issue: Issue): Promise<"removed" | "missing" | "refused" | "failed" | null> {
    return this.removeWorkspaceFor(issue.identifier, issue.id);
  }

  /**
   * 经注入端口删除一个 identifier 的 workspace，并把可判别结果映射为诊断。
   *
   * `removed` / `missing` 视为成功；`refused` / `failed` / 异常只记诊断并返回对应状态，
   * 绝不在本包内做 `fs.rm` 等 destructive fallback（containment 归 workspace 包）。
   */
  private async removeWorkspaceFor(
    identifier: string,
    issueId: string | null,
  ): Promise<"removed" | "missing" | "refused" | "failed" | null> {
    const cleanup = this.cleanupPort;
    if (cleanup === undefined) {
      return null;
    }
    // 关停后不再**开启**新的删除（§14.3）：已开始的删除由 inFlightCleanups 跟踪，
    // 并由 shutdown() 等待其真正结束。
    if (this.stopping) {
      return null;
    }
    try {
      const result = await this.trackCleanup(cleanup.removeWorkspace(identifier));
      if (result.status === "removed" || result.status === "missing") {
        this.emitDiagnostic({ kind: "cleanup_completed", issueId, identifier, message: result.status, cleanupStatus: result.status });
        return result.status;
      }
      if (result.status === "refused") {
        this.emitDiagnostic({
          kind: "cleanup_refused",
          issueId,
          identifier,
          message:
            result.message ??
            `terminal workspace cleanup refused (${result.reason ?? "unknown reason"})`,
        });
        return "refused";
      }
      this.emitDiagnostic({
        kind: "cleanup_failed",
        issueId,
        identifier,
        message: result.message ?? "terminal workspace cleanup failed",
      });
      return "failed";
    } catch (error) {
      this.emitDiagnostic({
        kind: "cleanup_error",
        issueId,
        identifier,
        message: error instanceof Error ? error.message : String(error),
      });
      return "failed";
    }
  }

  private emitEvent(create: () => OrchestratorEvent): void {
    try { this.onEvent?.(Object.freeze(create())); } catch { /* observation never changes scheduling */ }
  }

  private emitDiagnostic(diagnostic: RetryDiagnostic): void {
    try {
      this.cleanupDiagnostic?.(diagnostic);
    } catch {
      /* 诊断 sink 异常隔离，不破坏 authority */
    }
  }

  /** 登记一个已开始的删除，settle 后自动移除；供 shutdown 等待真实收尾。 */
  private trackCleanup<T>(operation: Promise<T>): Promise<T> {
    const tracked: Promise<T> = operation.finally(() => {
      this.inFlightCleanups.delete(tracked);
    });
    this.inFlightCleanups.add(tracked);
    return tracked;
  }
}
