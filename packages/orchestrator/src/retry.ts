/**
 * Retry 队列的注入面与默认 runtime 适配器（SPEC §8.4 Retry and Backoff、§14.2、
 * §16.6 `on_retry_timer`、§17.4，M5.3 / #52）。
 *
 * 本模块只定义**端口与默认实现**，不持有调度状态：retry entry 的写入、timer 所有权
 * token、刷新后的 transition 全部在 {@link OrchestratorAuthority} 内串行完成。timer
 * 回调只被允许提交"带 issueId 与 token 的到期事件"，迟到 / 已取消的回调由 authority
 * 用 token 隔离，绝不会绕过 ownership 直接改 state 或启动 worker。
 *
 * 关键约束（根 `AGENTS.md`）：orchestrator 是 retry policy 的唯一落点；timer / clock
 * 抽象可注入，测试不依赖真实 10 秒 / 5 分钟 sleep。
 */
import type { TimerHandle } from "@symphony/domain";

/** 单次 retry 的延迟口径：continuation 固定 / failure 指数退避（SPEC §8.4）。 */
export type RetryDelayKind = "continuation" | "failure";

/**
 * 可注入的 timer 端口。`schedule` 返回不透明 handle（写入 `RetryEntry.timerHandle`），
 * `cancel` 撤销尚未触发的调度。调用方（authority）负责在替换 / 取消时调用 `cancel`。
 */
export interface RetryScheduler {
  /** 在 `delayMs` 毫秒后触发 `callback`；返回可取消的 handle。 */
  schedule(delayMs: number, callback: () => void): TimerHandle;
  /** 取消一个尚未触发的 handle（幂等）。 */
  cancel(handle: TimerHandle): void;
}

/**
 * terminal retry refresh 触发的 workspace 安全清理端口（SPEC §8.4 note）。
 *
 * 结构上与 `@symphony/workspace` 的 `WorkspaceManager.removeWorkspace` 兼容：只消费
 * 可判别 `status`，`refused` / `failed` 不构成异常，由 authority 记为诊断并释放 claim。
 * **绝不**在本包内做 destructive delete fallback——安全边界归 workspace 包。
 */
export interface RetryWorkspaceCleanupResult {
  readonly status: "removed" | "missing" | "refused" | "failed";
  /** 仅 `refused` 时携带（对齐 `RemoveWorkspaceRefusalReason`）。 */
  readonly reason?: string | undefined;
  /** `refused` / `failed` 时的诊断描述。 */
  readonly message?: string | undefined;
}

/** terminal cleanup 端口。 */
export interface RetryWorkspaceCleanup {
  removeWorkspace(identifier: string): Promise<RetryWorkspaceCleanupResult>;
}

/** retry 生命周期里的 operator-visible 诊断（cleanup 拒绝 / 失败 / 异常）。 */
export interface RetryDiagnostic {
  readonly kind: "cleanup_refused" | "cleanup_failed" | "cleanup_error";
  readonly issueId: string;
  readonly identifier: string | null;
  readonly message: string;
}

/**
 * Node `setTimeout` 能表达的最大延迟（`2^31 - 1` ms ≈ 24.8 天）；超过它 Node 会把
 * 延迟压成 `1` ms 并发出 `TimeoutOverflowWarning`。默认 scheduler 用**分段 timer**
 * 保证更大的合法 backoff（如 `max_retry_backoff_ms = 3_000_000_000`）仍按指定延迟
 * 触发，而不是静默变成 1 ms。
 */
export const RETRY_MAX_TIMER_DELAY_MS = 2_147_483_647;

/** 默认 runtime scheduler 的内部状态（分段 timer 的可取消句柄）。 */
interface SystemTimerState {
  cancelled: boolean;
  handle: ReturnType<typeof setTimeout> | null;
}

/** 默认 runtime timer：用 `setTimeout` / `clearTimeout` 实现，超长延迟自动分段。
 *
 * 生产组合根不注入自定义 scheduler 时使用；测试注入手动 scheduler，因此不产生真实
 * 等待。超过 {@link RETRY_MAX_TIMER_DELAY_MS} 的延迟拆成连续多段，`cancel` 会同时
 * 取消当前段。
 */
export function createRetryScheduler(): RetryScheduler {
  return {
    schedule(delayMs: number, callback: () => void): TimerHandle {
      const state: SystemTimerState = { cancelled: false, handle: null };
      let remaining = Math.max(0, delayMs);
      const step = (): void => {
        if (state.cancelled) {
          return;
        }
        const segment = Math.min(remaining, RETRY_MAX_TIMER_DELAY_MS);
        remaining -= segment;
        if (remaining > 0) {
          state.handle = setTimeout(step, segment);
        } else {
          state.handle = setTimeout(() => {
            if (!state.cancelled) {
              callback();
            }
          }, segment);
        }
      };
      step();
      return state;
    },
    cancel(handle: TimerHandle): void {
      if (handle !== null && typeof handle === "object" && "cancelled" in handle) {
        const state = handle as SystemTimerState;
        state.cancelled = true;
        if (state.handle !== null) {
          clearTimeout(state.handle);
        }
      }
    },
  };
}

/**
 * {@link OrchestratorAuthority} 的 retry 控制面（M5.3）。提供后，authority 在 worker
 * 终态归约后按 `retryKind` 建立 retry entry 并在 timer 到期时执行 SPEC §16.6
 * `on_retry_timer` 的完整 refresh / re-dispatch 流程。
 */
export interface RetryOptions {
  /** timer 端口；缺省用 {@link createRetryScheduler}。 */
  readonly scheduler?: RetryScheduler | undefined;
  /**
   * 每次**新建** retry 时读取的当前 effective `agent.max_retry_backoff_ms`。
   * 已有 timer 不因 cap 变化自动改期（§8.4：变更影响**后续** retry 调度）。
   */
  readonly maxRetryBackoffMs: () => number;
  /** terminal refresh 的安全 workspace 清理端口。 */
  readonly cleanupWorkspace: RetryWorkspaceCleanup;
  /** cleanup 拒绝 / 失败 / 异常的诊断出口（可选；异常被隔离，不破坏 authority）。 */
  readonly onDiagnostic?: ((diagnostic: RetryDiagnostic) => void) | undefined;
}
