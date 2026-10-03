/**
 * `OrchestratorRuntimeState` 初始化（SPEC §7.4 Idempotency、§16.1 Service Startup）。
 *
 * M5 的 scheduler state 是 intentionally in-memory only（§14.3）：每次调用返回全新
 * 可变 state，不存在跨重启恢复的 durable 状态。
 */
import type { CodexTotals, OrchestratorRuntimeState } from "@symphony/domain";

/**
 * state 初始化参数：只取两个**当前生效**的调度标量（§4.1.8）。
 *
 * 其余调度参数（active / terminal states、required labels、per-state 并发、
 * `max_retry_backoff_ms`、`stall_timeout_ms`）不驻留在 state 上，由每 tick 的
 * effective config 以纯函数参数传入（§8.2 / §8.3 / §6.2 reload 语义）。
 */
export interface OrchestratorRuntimeStateInit {
  /** SPEC `poll_interval_ms`：`polling.interval_ms` 的 effective 值。 */
  readonly pollIntervalMs: number;
  /** SPEC `max_concurrent_agents`：`agent.max_concurrent_agents` 的 effective 值。 */
  readonly maxConcurrentAgents: number;
}

/** 初始 `codex_totals`（SPEC §16.1 的 state 初始化形状）。 */
export function createInitialCodexTotals(): CodexTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 };
}

/**
 * 初始化单一权威 orchestrator runtime state（SPEC §4.1.8 / §16.1）。
 *
 * 空 `running` / `claimed` / `retry_attempts` / `completed`，`codex_totals` 归零，
 * `codex_rate_limits` 为 `null`。
 */
export function createOrchestratorRuntimeState(
  init: OrchestratorRuntimeStateInit,
): OrchestratorRuntimeState {
  return {
    pollIntervalMs: init.pollIntervalMs,
    maxConcurrentAgents: init.maxConcurrentAgents,
    running: new Map(),
    claimed: new Set(),
    retryAttempts: new Map(),
    completed: new Set(),
    codexTotals: createInitialCodexTotals(),
    codexRateLimits: null,
  };
}
