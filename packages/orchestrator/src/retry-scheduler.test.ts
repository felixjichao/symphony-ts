/**
 * 默认 `RetryScheduler` 的分段 timer 回归（审查 blocker 2，SPEC §8.4）。
 *
 * Node `setTimeout` 会把超过 `2^31 - 1` ms 的延迟压成 `1` ms 并发出
 * `TimeoutOverflowWarning`。合法配置（如 `max_retry_backoff_ms = 3_000_000_000`）下
 * failure backoff 可超过该上限，默认 scheduler 必须用分段 timer 保持规定延迟，而不是
 * 静默提前触发形成快速重试。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { RETRY_MAX_TIMER_DELAY_MS, createRetryScheduler, failureRetryDelayMs } from "./index";

describe("createRetryScheduler — 分段 timer（审查 blocker 2）", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("超过 Node setTimeout 上限的延迟不被压缩为 1ms", async () => {
    vi.useFakeTimers();
    const scheduler = createRetryScheduler();
    const delay = failureRetryDelayMs(19, 3_000_000_000);
    expect(delay).toBe(2_621_440_000);
    expect(delay).toBeGreaterThan(RETRY_MAX_TIMER_DELAY_MS);

    let fired = false;
    scheduler.schedule(delay, () => {
      fired = true;
    });

    await vi.advanceTimersByTimeAsync(RETRY_MAX_TIMER_DELAY_MS);
    // 第一段（上限）结束仍不应触发——旧实现会在 ~1ms 内触发。
    expect(fired).toBe(false);

    await vi.advanceTimersByTimeAsync(delay - RETRY_MAX_TIMER_DELAY_MS);
    expect(fired).toBe(true);
  });

  it("分段期间 cancel 后不再触发", async () => {
    vi.useFakeTimers();
    const scheduler = createRetryScheduler();
    let fired = false;
    const handle = scheduler.schedule(2_621_440_000, () => {
      fired = true;
    });

    await vi.advanceTimersByTimeAsync(RETRY_MAX_TIMER_DELAY_MS);
    expect(fired).toBe(false); // 已进入第二段
    scheduler.cancel(handle);

    await vi.advanceTimersByTimeAsync(3_000_000_000);
    expect(fired).toBe(false);
  });

  it("上限以内的延迟仍按原值触发", async () => {
    vi.useFakeTimers();
    const scheduler = createRetryScheduler();
    let fired = false;
    scheduler.schedule(1_000, () => {
      fired = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(fired).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toBe(true);
  });
});
