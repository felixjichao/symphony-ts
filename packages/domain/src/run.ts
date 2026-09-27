import type { UtcTimestampMs } from "./time";

/**
 * §7.2 的全部生命周期阶段（声明顺序即 SPEC 顺序）：前 6 个为进行中阶段，后 5 个
 * 为终态。终态之间必须可区分——retry 逻辑与日志对不同失败原因处理不同（§7.2）。
 *
 * 本常量是 {@link RunAttemptStatus} 的单一来源；状态**转移**逻辑归
 * `@symphony/orchestrator`（§7，M5），本包只定义状态集合。
 */
export const RUN_ATTEMPT_STATUSES = [
  "preparing_workspace",
  "building_prompt",
  "launching_agent_process",
  "initializing_session",
  "streaming_turn",
  "finishing",
  "succeeded",
  "failed",
  "timed_out",
  "stalled",
  "canceled_by_reconciliation",
] as const;

/** Run attempt 生命周期状态（SPEC §7.2），取值见 {@link RUN_ATTEMPT_STATUSES}。 */
export type RunAttemptStatus = (typeof RUN_ATTEMPT_STATUSES)[number];

/**
 * 单个 issue 的一次执行尝试（SPEC §4.1.5）。可变运行时记录：status / error 随
 * 生命周期推进由 orchestrator 更新，字段不加 readonly。
 */
export interface RunAttempt {
  /** SPEC `issue_id`：即 `Issue.id`（§4.2 dispatch identity）。 */
  issueId: string;
  /** SPEC `issue_identifier`：即 `Issue.identifier`，面向日志 / status surface（§13.1）。 */
  issueIdentifier: string;
  /**
   * SPEC `attempt`：首次运行为 `null`，retry / continuation 为 `>= 1`（§4.1.5）。
   * 注意与 `RetryEntry.attempt`（retry 队列内 1-based、永不为 null）语义不同。
   */
  attempt: number | null;
  /** SPEC `workspace_path`：本次尝试使用的绝对 workspace 路径。 */
  workspacePath: string;
  /**
   * SPEC `started_at`：墙上时钟启动时刻（日志 / 快照口径）。活跃 session 的
   * elapsed 核算使用 running entry 上的单调时钟读数（§13.5）。
   */
  startedAt: UtcTimestampMs;
  /** SPEC `status`：当前生命周期阶段（§7.2）。 */
  status: RunAttemptStatus;
  /**
   * SPEC `error`：OPTIONAL 失败原因。`exactOptionalPropertyTypes` 语义：要么缺席，
   * 要么 string——不接受显式 `undefined`。
   */
  error?: string;
}
