import type { MonotonicTimestampMs } from "./time";

/**
 * runtime-specific timer 引用（SPEC §4.1.7 `timer_handle`）：如 `setTimeout`
 * 返回值或 supervisor task ref。领域契约只要求"存得下、取得回"，类型为 `unknown`
 * ——不透明，使用前由持有方（orchestrator）自行 narrow。
 */
export type TimerHandle = unknown;

/**
 * issue 的计划重试状态（SPEC §4.1.7）。retry 算法 / backoff（§8.4 / §16）与队列
 * 行为归 `@symphony/orchestrator`（M5）；本类型只是队列条目的共享契约。可变
 * 运行时记录（重排时更新），字段不加 readonly。
 */
export interface RetryEntry {
  /** SPEC `issue_id`：即 `Issue.id`。 */
  issueId: string;
  /**
   * SPEC `identifier`：best-effort 人类可读 ID，供 status surface / 日志；
   * 不可得为 `null`。
   */
  identifier: string | null;
  /**
   * SPEC `attempt`：retry 队列内 **1-based** 尝试号（永不为 null）；注意与
   * `RunAttempt.attempt`（首跑为 null）语义不同。
   */
  attempt: number;
  /** SPEC `due_at_ms`：到期时刻，**单调时钟**毫秒（§4.1.7）。 */
  dueAtMs: MonotonicTimestampMs;
  /** SPEC `timer_handle`：见 {@link TimerHandle}。 */
  timerHandle: TimerHandle;
  /** SPEC `error`：触发本次 retry 的失败原因；无则 `null`。 */
  error: string | null;
}
