/**
 * Orchestrator-owned worker control abstraction（SPEC §7.3 worker lifecycle、
 * §7.4、§16.15，M5.2 / #51）。
 *
 * 本模块是 orchestrator 与 `runAgentAttempt()` 之间的生命周期支点：
 *
 * - **幂等停止**：`stop(reason)` 保存第一次有效 stop reason，重复调用返回同一个
 *   Promise，共享同一段停止过程；
 * - **有界停止**：`stop()` 等待 runner 真正完成收尾（session 关停 + `after_run`
 *   hook），而不是用超时宣布退出却让 runner 继续跑；上界由 agent 层自身的
 *   `shutdownTimeoutMs` 与 hook effective timeout 提供；
 * - **outcome 只回报一次**：完成 Promise 由 authority 挂一次，迟到消息由
 *   attempt token 隔离；
 * - **取消可复用**：`signal` 同时服务 reconciliation / stall / shutdown（M5.4）。
 *
 * orchestrator 只处理本模块的 handle 与 signal，永不接触 Codex `ChildProcess`，
 * 也不解析 raw Codex 协议。
 */
import type { AgentAttemptResult } from "@symphony/agent";
import type { RunAttemptStatus } from "@symphony/domain";

/**
 * 主动停止 worker 的原因。它决定终态分类（见 `outcome.ts`），并与底层 cancel 引起的
 * `port_exit` 区分：分类以本 reason 为准，而不是以 agent 抛出的错误码为准。
 */
export type WorkerStopReasonKind = "reconciliation" | "terminal" | "stall" | "shutdown";

/** {@link WorkerStopReasonKind} 的判别式包装（保留未来携带细节的空间）。 */
export interface WorkerStopReason {
  readonly kind: WorkerStopReasonKind;
}

/** orchestrator 持有的 worker handle（M5.2 支点；M5.4 复用它做 stop）。 */
export interface WorkerHandle {
  readonly issueId: string;
  /** attempt 唯一标识：隔离旧 worker 的迟到事件 / 结果。 */
  readonly attemptToken: string;
  /** 是否已被主动 stop（第一次 stop 被调用后恒为 true）。 */
  readonly stopped: boolean;
  /** 第一次有效 stop reason；未 stop 为 `null`。 */
  readonly stopReason: WorkerStopReason | null;
  /** worker 真正完成收尾的 Promise（不触发 stop，只观察）。 */
  readonly done: Promise<void>;
  stop(reason: WorkerStopReason): Promise<void>;
}

/** worker 终态结果：统一回送 orchestrator authority，供 M5.3 决策 retry。 */
export interface WorkerTerminalOutcome {
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly attemptToken: string;
  /** 对应 `RunAttempt.attempt`（首跑 `null`，retry / continuation `>= 1`）。 */
  readonly attempt: number | null;
  /** 终态 `RunAttempt.status`（§7.2 的 5 个终态之一）。 */
  readonly status: RunAttemptStatus;
  /** 终态 error 描述；成功 / 无错误为 `null`。 */
  readonly error: string | null;
  /** worker 生命周期毫秒数（单调时钟差值）。 */
  readonly durationMs: number;
  readonly issueUrl?: string | null;
  readonly sessionId?: string | null;
  readonly stopReason: WorkerStopReason | null;
  /** 正常完成时的 attempt 产出；异常为 `null`。 */
  readonly result: AgentAttemptResult | null;
  /** 该 outcome 是否必须抑制 retry（reconciliation / terminal / shutdown）。 */
  readonly suppressRetry: boolean;
  /** retry 语义提示：成功 → continuation；失败 → failure；抑制 → none。M5.3 消费。 */
  readonly retryKind: "none" | "continuation" | "failure";
}

/** {@link WorkerControl} 构造参数。 */
export interface WorkerControlOptions {
  readonly issueId: string;
  readonly attemptToken: string;
  readonly attempt: number | null;
}

/**
 * authority 持有的 worker 控制实现。
 *
 * 状态机极简：`running → (stop 被调用一次) → stopping → done`。所有字段只在
 * authority 的同步提交段与单次 settle 路径上访问，无需额外锁。
 */
export class WorkerControl implements WorkerHandle {
  public readonly issueId: string;
  public readonly attemptToken: string;
  public readonly attempt: number | null;

  private readonly controller = new AbortController();
  private firstStopReason: WorkerStopReason | null = null;
  private stopPromise: Promise<void> | null = null;
  private completionSettled = false;
  private readonly completion: Promise<void>;
  private resolveCompletion!: () => void;

  constructor(options: WorkerControlOptions) {
    this.issueId = options.issueId;
    this.attemptToken = options.attemptToken;
    this.attempt = options.attempt;
    this.completion = new Promise<void>((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  /** attempt 级取消信号：传给 `runAgentAttempt()` 的 `signal`。 */
  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public get stopped(): boolean {
    return this.firstStopReason !== null;
  }

  public get stopReason(): WorkerStopReason | null {
    return this.firstStopReason;
  }

  public get done(): Promise<void> {
    return this.completion;
  }

  /**
   * authority 在启动 runner 后调用一次：`completion` 表示"runner 真正结束 + authority
   * 已归约 outcome"。`stop()` 等待它，因此 stop 返回时 running 已清理。
   */
  public markCompletion(completion: Promise<unknown>): void {
    const settle = (): void => {
      if (!this.completionSettled) {
        this.completionSettled = true;
        this.resolveCompletion();
      }
    };
    completion.then(settle, settle);
  }

  /**
   * 幂等停止：第一次调用确定 reason 并 abort signal；之后的调用共享同一 Promise。
   * 返回的 Promise 在 runner 真正完成收尾后 resolve。
   */
  public stop(reason: WorkerStopReason): Promise<void> {
    if (this.stopPromise !== null) {
      return this.stopPromise;
    }
    this.firstStopReason = reason;
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason);
    }
    this.stopPromise = this.completion;
    return this.stopPromise;
  }
}
