/**
 * Orchestrator poll loop：startup 编排、每 tick 顺序、per-tick 失败降级、live
 * config re-apply 与 stop lifecycle（SPEC §8.1 Poll Loop、§14.2 / §14.3 / §14.4、
 * §16.1 Service Startup、§16.2 Poll-and-Dispatch Tick，M5.5 / NEST-78）。
 *
 * 设计要点：
 *
 * - **单一 timer 链**：不使用 `setInterval`。每次 tick **结束后**才按当前 effective
 *   `polling.interval_ms` 安排下一次一次性 timer，因此慢 tick 不会重叠、降级出口不会
 *   注册重复 timer。首次 tick 用零延迟（§16.1 `schedule_tick(delay_ms=0)`）。
 * - **严格 tick 顺序**（§16.2）：`reconcile running → validate dispatch config →
 *   fetch active candidates → sort → dispatch until slots exhausted → schedule next`。
 *   reconciliation **总是先执行**，即使随后 validation / fetch 失败。
 * - **失败降级**（§14.2）：per-tick validation 失败 → 跳过本 tick dispatch、保留
 *   last-known-good、服务存活；candidate fetch 失败 → 跳过本 tick dispatch、下一次
 *   tick 重试；reconciliation refresh 失败由 authority 内部保留 worker（本 loop 只
 *   记录诊断）。
 * - **live config re-apply**（§6.2）：每次 tick 都经注入的 {@link DispatchPreflightSource}
 *   重新校验并取最新 effective（含 `pollIntervalMs` / `maxConcurrentAgents` / policy），
 *   经 `OrchestratorAuthority.applyEffectiveSchedulingConfig()` 原子应用。retry cap /
 *   stall timeout 由 authority 的 getter 从同一 effective 配置读取。普通并发上限下调
 *   不主动终止已运行 worker。
 * - **startup fail-fast**（§6.3 / §16.1）：初始 dispatch preflight 失败直接抛
 *   {@link OrchestratorStartupError}，不进入 scheduling loop、不安排 timer；成功后
 *   startup terminal sweep → immediate first tick。
 * - **stop 幂等**（§14.3）：取消 poll timer、等待在途 tick、再 `authority.shutdown()`
 *   停止 workers 与 retry timer；stop 后不再触发 tick / retry。实例 stop 后不可重启，
 *   重新运行创建新实例。
 *
 * 边界（根 `AGENTS.md`）：本模块不 fetch / spawn / cleanup —— 全部经 authority 与
 * 注入端口；不解释 agent / Codex 协议；diagnostic sink 异常被隔离。
 */
import type { Issue, TimerHandle } from "@symphony/domain";

import type { OrchestratorAuthority } from "./authority";
import type { DispatchPolicy } from "./eligibility";
import { createRetryScheduler, type RetryScheduler } from "./retry";
import { sortForDispatch } from "./sort";

/**
 * 一次 dispatch preflight 产出的 **effective 调度配置**（§6.4 中影响调度的子集）。
 *
 * retry cap / stall timeout 不在此：它们由 authority 的 getter 从同一 effective
 * 配置读取（保证新创建的 retry 与后续 reconciliation 使用最新值）。
 */
export interface EffectiveSchedulingConfig {
  /** `polling.interval_ms` 的 effective 值（§6.4）。 */
  readonly pollIntervalMs: number;
  /** `agent.max_concurrent_agents` 的 effective 值（§6.4）。 */
  readonly maxConcurrentAgents: number;
  /** active / terminal states、required labels、per-state 并发（§8.2 / §8.3）。 */
  readonly policy: DispatchPolicy;
}

/**
 * 一次 dispatch preflight 的结果（§6.3）：
 * - 成功携带最新 effective 调度配置；
 * - 失败携带 operator-visible 错误描述，且**不改变** last-known-good。
 */
export type DispatchPreflightResult =
  | { readonly ok: true; readonly effective: EffectiveSchedulingConfig }
  | { readonly ok: false; readonly error: string };

/**
 * dispatch preflight 端口（§6.3）：组合根用 `@symphony/config` 的
 * `loadEffectiveWorkflow` + tracker registry preflight 实现"每次调用返回显式成功 /
 * 失败结果"，而不是只调用 watcher 的 void `reload()`。
 *
 * 契约：
 * - 重新 read / parse / resolve workflow，校验 `tracker.kind` 受支持、selected adapter
 *   接受 `tracker.provider`、`codex.command` 非空；
 * - 成功时必须把新 effective 记为 last-known-good 并返回；
 * - 失败时必须保留旧 last-known-good 并返回可判别错误（**不得抛异常**；本 loop 仍会
 *   兜底 catch 并把抛出转为失败）。
 */
export interface DispatchPreflightSource {
  preflight(): DispatchPreflightResult;
}

/** candidate issue 读取端口（§11.1.1 `fetch_issues_by_states`）。 */
export interface CandidateIssueSource {
  fetchIssuesByStates(stateNames: readonly string[]): Promise<readonly Issue[]>;
}

/**
 * 一次性 poll timer 端口（与 {@link RetryScheduler} 同形）。测试注入手动 scheduler，
 * 不依赖真实等待。
 */
export type PollScheduler = RetryScheduler;

/** loop 级 operator-visible 诊断（M5.5 只提供回调，不建设 logging sink）。 */
export interface LoopDiagnostic {
  readonly kind:
    | "startup_validation_failed"
    | "startup_cleanup_failed"
    | "tick_validation_failed"
    | "candidate_fetch_failed"
    | "reconciliation_failed"
    | "tick_failed";
  readonly message: string;
}

/** startup 初始 dispatch preflight 失败时抛出（fail-fast，§6.3 / §16.1）。 */
export class OrchestratorStartupError extends Error {
  /** 触发失败的 preflight 错误描述。 */
  public readonly reason: string;

  public constructor(reason: string) {
    super(`orchestrator startup validation failed: ${reason}`);
    this.name = "OrchestratorStartupError";
    this.reason = reason;
  }
}

/** {@link OrchestratorLoop} 构造参数。 */
export interface OrchestratorLoopOptions {
  /** 调度状态唯一写入者；loop 只调用其公开控制契约。 */
  readonly authority: OrchestratorAuthority;
  /** candidate issue 读取端口（active states 拉取）。 */
  readonly candidates: CandidateIssueSource;
  /** dispatch preflight 端口（§6.3；启动 + 每 tick 调用）。 */
  readonly preflight: DispatchPreflightSource;
  /**
   * 一次性 poll timer 端口；缺省用 `createRetryScheduler()`（分段 `setTimeout`）。
   * 注入手动实现即可确定性复跑，不产生真实等待。
   */
  readonly scheduler?: PollScheduler | undefined;
  /** operator-visible 诊断出口；异常被隔离。 */
  readonly onDiagnostic?: ((diagnostic: LoopDiagnostic) => void) | undefined;
}

type LoopStatus = "idle" | "running" | "stopping" | "stopped";

/**
 * 长运行 poll loop。
 *
 * 生命周期：`idle --start()--> running --stop()--> stopped`。`start()` 只可调用一次；
 * `stop()` 幂等。
 */
export class OrchestratorLoop {
  private readonly authority: OrchestratorAuthority;
  private readonly candidates: CandidateIssueSource;
  private readonly preflight: DispatchPreflightSource;
  private readonly scheduler: PollScheduler;
  private readonly onDiagnostic: ((diagnostic: LoopDiagnostic) => void) | undefined;

  private status: LoopStatus = "idle";
  private pollTimer: TimerHandle | null = null;
  private activeTick: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  public constructor(options: OrchestratorLoopOptions) {
    this.authority = options.authority;
    this.candidates = options.candidates;
    this.preflight = options.preflight;
    this.scheduler = options.scheduler ?? createRetryScheduler();
    this.onDiagnostic = options.onDiagnostic;
  }

  /** 是否正在调度（已通过 startup，且未 stop）。 */
  public get running(): boolean {
    return this.status === "running";
  }

  /** 是否已完全停止。 */
  public get stopped(): boolean {
    return this.status === "stopped";
  }

  /**
   * 启动服务（SPEC §16.1）：dispatch preflight → startup terminal cleanup → immediate
   * first tick（零延迟）。
   *
   * 初始 preflight 失败抛 {@link OrchestratorStartupError}，不安排任何 timer；startup
   * cleanup 失败只记诊断、不阻止启动（§8.6）。
   */
  public async start(): Promise<void> {
    if (this.status !== "idle") {
      throw new Error(`orchestrator loop cannot start from status "${this.status}"`);
    }

    const preflight = this.runPreflight();
    if (!preflight.ok) {
      this.status = "stopped";
      this.emit({ kind: "startup_validation_failed", message: preflight.error });
      throw new OrchestratorStartupError(preflight.error);
    }
    // 先应用初始 effective（cleanup 用 policy.terminalStates），再 startup sweep。
    this.authority.applyEffectiveSchedulingConfig(preflight.effective);

    try {
      await this.authority.runStartupTerminalCleanup();
    } catch (error) {
      this.emit({ kind: "startup_cleanup_failed", message: describeError(error) });
    }

    // startup cleanup 期间可能已被 stop：不得再进入调度。
    if (this.status !== "idle") {
      return;
    }
    this.status = "running";
    this.scheduleNext(0); // §16.1：immediate first tick
  }

  /**
   * 停止服务（SPEC §14.3）。**同步**取消 poll timer，随后等待在途 tick 结束，再经
   * `authority.shutdown()` 停止全部 worker 与 retry timer。幂等：重复调用共享同一
   * 完成 Promise。stop 后不再触发 tick / retry。
   */
  public stop(): Promise<void> {
    if (this.stopPromise !== null) {
      return this.stopPromise;
    }
    this.status = "stopping";
    this.cancelPollTimer();
    this.stopPromise = (async () => {
      const tick = this.activeTick;
      if (tick !== null) {
        try {
          await tick;
        } catch {
          /* tick 内部已隔离异常，这里只等待收尾。 */
        }
      }
      await this.authority.shutdown();
      this.status = "stopped";
    })();
    return this.stopPromise;
  }

  /**
   * 等待当前在途 tick（含其收尾调度）完成；无在途 tick 时立即返回。供组合根 /
   * 测试观察 loop 前进，不改变调度语义。
   */
  public async settled(): Promise<void> {
    const tick = this.activeTick;
    if (tick !== null) {
      await tick;
    }
  }

  /** 安排下一次一次性 tick；仅 `running` 状态有效。 */
  private scheduleNext(delayMs: number): void {
    if (this.status !== "running") {
      return;
    }
    this.pollTimer = this.scheduler.schedule(Math.max(0, delayMs), () => {
      this.pollTimer = null;
      this.onPollTimerFired();
    });
  }

  private onPollTimerFired(): void {
    if (this.status !== "running") {
      return;
    }
    const tick = this.runTick();
    this.activeTick = tick;
    void tick.finally(() => {
      if (this.activeTick === tick) {
        this.activeTick = null;
      }
    });
  }

  /**
   * 一个 poll-and-dispatch tick（SPEC §16.2）。所有出口都经 `finally` **恰好安排一次**
   * 下一次 tick；stop 后 `reschedule()` 为 no-op。
   */
  private async runTick(): Promise<void> {
    try {
      // 1. reconcile running（总是先执行，validation / fetch 失败不撤销）。
      try {
        await this.authority.reconcileRunningIssues();
      } catch (error) {
        this.emit({ kind: "reconciliation_failed", message: describeError(error) });
      }
      if (this.status !== "running") {
        return;
      }

      // 2. per-tick dispatch preflight（§6.3）；失败跳过本 tick dispatch。
      const preflight = this.runPreflight();
      if (!preflight.ok) {
        this.emit({ kind: "tick_validation_failed", message: preflight.error });
        return;
      }
      // 3. live config re-apply（§6.2）：应用最新 effective。
      this.authority.applyEffectiveSchedulingConfig(preflight.effective);

      // 4. fetch active candidates（§16.2）；失败跳过本 tick、下一次 tick 重试。
      let candidates: readonly Issue[];
      try {
        candidates = await this.candidates.fetchIssuesByStates(
          preflight.effective.policy.activeStates,
        );
      } catch (error) {
        this.emit({ kind: "candidate_fetch_failed", message: describeError(error) });
        return;
      }
      if (this.status !== "running") {
        return;
      }

      // 5. sort + dispatch until global slots exhausted（per-state / claim 由 authority
      //    的 eligibility 复核；某 state 满额时跳过该候选继续扫描其他 state）。
      for (const issue of sortForDispatch(candidates)) {
        if (!this.authority.hasAvailableGlobalSlot()) {
          break;
        }
        this.authority.dispatchIssue(issue);
      }
    } catch (error) {
      // 兜底：任何未预期异常都不得让 tick 链断裂。
      this.emit({ kind: "tick_failed", message: describeError(error) });
    } finally {
      this.reschedule();
    }
  }

  /** 用当前 effective interval 安排下一次 tick（已挂出的 timer 不因 reload 立即改期）。 */
  private reschedule(): void {
    if (this.status !== "running") {
      return;
    }
    this.scheduleNext(this.authority.pollIntervalMs);
  }

  private cancelPollTimer(): void {
    if (this.pollTimer !== null) {
      this.scheduler.cancel(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private runPreflight(): DispatchPreflightResult {
    try {
      return this.preflight.preflight();
    } catch (error) {
      // 端口契约要求返回结果；非契约抛出（组合根缺陷）收敛为一次 preflight 失败。
      return { ok: false, error: describeError(error) };
    }
  }

  private emit(diagnostic: LoopDiagnostic): void {
    try {
      this.onDiagnostic?.(diagnostic);
    } catch {
      /* 诊断 sink 异常隔离，不破坏 loop。 */
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
