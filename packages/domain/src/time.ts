/**
 * 时间戳契约（SPEC §4.1.1 / §4.1.7 / §11.3 / §13.5）。
 *
 * 领域模型区分两个时钟域，二者不可互换：
 *
 * - {@link UtcTimestampMs} — 墙上时钟（UTC epoch 毫秒）：日志、快照、provider 时间；
 * - {@link MonotonicTimestampMs} — 单调时钟毫秒读数：调度到期与运行时长核算，
 *   只有差值有意义。
 *
 * §11.3 允许 in-memory 时间戳类型 implementation-defined；本实现统一采用 epoch
 * 毫秒数（adapter 负责从 RFC 3339 解析）。
 */

/** UTC 墙上时钟时间戳：自 Unix epoch 起的毫秒数（如 `Date.now()` 读数）。 */
export type UtcTimestampMs = number;

/**
 * 单调时钟毫秒读数（如 Node `performance.now()`）。仅差值有意义，不可与
 * {@link UtcTimestampMs} 混用；SPEC §4.1.7 的 `due_at_ms` 与 §13.5 的活跃 session
 * elapsed 核算使用本时钟域。
 */
export type MonotonicTimestampMs = number;
