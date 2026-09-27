import type { Issue } from "./issue";
import type { RetryEntry } from "./retry";
import type { RunAttempt } from "./run";
import type { LiveSession } from "./session";
import type { MonotonicTimestampMs } from "./time";

/**
 * 聚合 token / 运行时长（SPEC §4.1.8 `codex_totals`，口径见 §13.3 / §13.5）。
 * 可变运行时记录：session 结束或快照核算时由 orchestrator 更新。
 */
export interface CodexTotals {
  /** 绝对累计输入 token（§13.5：只入账 absolute thread totals，忽略 delta payload）。 */
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /**
   * 聚合运行秒数：已结束 session 的累计 + 快照时刻活跃 session 的 elapsed
   * （§13.3 / §13.5 live aggregate 口径；不要求后台持续累计）。
   */
  secondsRunning: number;
}

/**
 * 最近一次 agent 事件携带的 rate-limit 载荷（SPEC §4.1.8 `codex_rate_limits`、
 * §13.5）。payload 形状由 coding agent 决定：原样保留、不解释、不 schema 化。
 */
export type CodexRateLimits = Readonly<Record<string, unknown>>;

/**
 * `OrchestratorRuntimeState.running` 的值类型：一个正在运行的 worker 及其 live
 * session（SPEC §4.1.8 "running entry"）。§4.1.8 未逐字段列举 running entry，本
 * 契约按 §7.3（worker exit 核算）、§13.3（快照行：turn_count、issue url）、
 * §13.5（elapsed 核算）的消费方需求定型。可变运行时记录。
 */
export interface RunningEntry {
  /** 派发时的归一化 issue：identifier / url / state 供日志、快照行与 reconciliation 使用。 */
  issue: Issue;
  /** 当前进行中的执行尝试记录（§4.1.5）。 */
  attempt: RunAttempt;
  /** coding-agent session 元数据；子进程 session 建立前为 `null`（§4.1.6）。 */
  session: LiveSession | null;
  /** 绝对 workspace 路径（§7.3 / §13.5）。 */
  workspacePath: string;
  /** 单调时钟启动读数，用于活跃 session 的 elapsed 核算（§13.5）。 */
  startedAtMs: MonotonicTimestampMs;
  /**
   * runtime-specific worker / task 引用（与 {@link RetryEntry.timerHandle} 同类
   * 不透明句柄）：领域层只存不解释。
   */
  workerHandle: unknown;
}

/**
 * orchestrator 独占的单一权威内存状态（SPEC §4.1.8、§7.4：所有状态变更经
 * orchestrator 单点串行化）。M5 落地行为；observability 只消费其只读 snapshot
 * 投影（§13.3，行类型随 M6 落地）。`running` / `claimed` / `retryAttempts` /
 * `completed` 的 key 一律是 `Issue.id`（§4.2）。
 */
export interface OrchestratorRuntimeState {
  /** SPEC `poll_interval_ms`：当前**生效** poll 间隔（reload 后更新，§6.2）。 */
  pollIntervalMs: number;
  /** SPEC `max_concurrent_agents`：当前生效的全局并发上限（§8.3）。 */
  maxConcurrentAgents: number;
  /** SPEC `running`：issue_id -> running entry。 */
  running: Map<string, RunningEntry>;
  /**
   * SPEC `claimed`：已预留（reserved / running / retrying）的 issue id 集合，
   * 防重复派发；launch 前 MUST 检查（§7.4）。
   */
  claimed: Set<string>;
  /** SPEC `retry_attempts`：issue_id -> {@link RetryEntry}。 */
  retryAttempts: Map<string, RetryEntry>;
  /**
   * SPEC `completed`：已完成 issue id 集合；**仅记账**，不参与 dispatch gating
   * （§4.1.8——成功退出不代表 issue 永远完成，§7.1）。
   */
  completed: Set<string>;
  /** SPEC `codex_totals`。 */
  codexTotals: CodexTotals;
  /** SPEC `codex_rate_limits`：最近 rate-limit 快照；尚无则 `null`。 */
  codexRateLimits: CodexRateLimits | null;
}
