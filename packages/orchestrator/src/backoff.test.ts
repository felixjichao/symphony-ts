import { describe, expect, it } from "vitest";

import {
  CONTINUATION_RETRY_DELAY_MS,
  FAILURE_RETRY_BASE_DELAY_MS,
  continuationRetryDelayMs,
  failureRetryDelayMs,
} from "./index";

describe("continuationRetryDelayMs", () => {
  it("is the fixed short delay for a normal worker exit (SPEC §8.4)", () => {
    expect(continuationRetryDelayMs()).toBe(1000);
    expect(CONTINUATION_RETRY_DELAY_MS).toBe(1000);
  });
});

describe("failureRetryDelayMs", () => {
  it("uses 10000 * 2^(attempt - 1) (SPEC §8.4)", () => {
    const max = 300000;
    expect(FAILURE_RETRY_BASE_DELAY_MS).toBe(10000);
    expect(failureRetryDelayMs(1, max)).toBe(10000);
    expect(failureRetryDelayMs(2, max)).toBe(20000);
    expect(failureRetryDelayMs(3, max)).toBe(40000);
    expect(failureRetryDelayMs(4, max)).toBe(80000);
  });

  it("caps the power at maxRetryBackoffMs (acceptance: backoff cap)", () => {
    expect(failureRetryDelayMs(3, 30000)).toBe(30000);
    expect(failureRetryDelayMs(10, 300000)).toBe(300000);
  });

  it("caps below the base delay when the configured max is smaller", () => {
    expect(failureRetryDelayMs(1, 5000)).toBe(5000);
  });

  it("grows monotonically until the cap", () => {
    const max = 300000;
    let previous = 0;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const delay = failureRetryDelayMs(attempt, max);
      expect(delay).toBeGreaterThanOrEqual(previous);
      previous = delay;
    }
    expect(previous).toBe(max);
  });

  it("treats attempt <= 0 like the first attempt", () => {
    expect(failureRetryDelayMs(0, 300000)).toBe(10000);
    expect(failureRetryDelayMs(-3, 300000)).toBe(10000);
  });
});
