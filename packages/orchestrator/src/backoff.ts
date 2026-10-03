/**
 * Retry / backoff 纯数学 helper（SPEC §8.4 Retry and Backoff、§16.6）。
 *
 * 只做数值计算：不创建 timer、不读写 runtime state、不做调度决策。retry 队列与
 * timer 归属由后续 M5 子任务落地（§16.6 `on_retry_timer`）。
 *
 * 口径（§8.4）：
 *
 * - normal worker exit → continuation retry，固定 `1000` ms；
 * - failure-driven retry → `min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`。
 */

/** normal worker exit 后的 continuation retry 固定延迟（SPEC §7.1 "about 1 second"）。 */
export const CONTINUATION_RETRY_DELAY_MS = 1000;

/** failure retry 指数退避的基数（SPEC §8.4：`10000` ms）。 */
export const FAILURE_RETRY_BASE_DELAY_MS = 10000;

/** continuation retry 延迟（SPEC §8.4：正常退出的固定 `1000` ms）。 */
export function continuationRetryDelayMs(): number {
  return CONTINUATION_RETRY_DELAY_MS;
}

/**
 * failure-driven retry 的退避延迟（SPEC §8.4）：
 * `min(10000 * 2^(attempt - 1), maxRetryBackoffMs)`。
 *
 * `attempt` 是 retry 队列内 1-based 尝试号（§4.1.7），`attempt = 1` → `10000` ms。
 * `maxRetryBackoffMs` 由 effective `agent.max_retry_backoff_ms` 提供，是退避上限。
 */
export function failureRetryDelayMs(attempt: number, maxRetryBackoffMs: number): number {
  const exponent = Math.max(attempt - 1, 0);
  const uncapped = FAILURE_RETRY_BASE_DELAY_MS * 2 ** exponent;
  return Math.min(uncapped, maxRetryBackoffMs);
}
