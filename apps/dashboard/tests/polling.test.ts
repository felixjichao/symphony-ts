// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { poll, type Observation } from "../src/polling";
import { snapshot } from "./fixtures";
beforeEach(() => { vi.useFakeTimers(); Object.defineProperty(document, "hidden", { configurable: true, value: false }); });
afterEach(() => vi.useRealTimers());
it("polls 15 seconds after completion, retains data on failure and recovers", async () => {
  const data = snapshot(); const read = vi.fn().mockResolvedValueOnce(data).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(data);
  const render = vi.fn(); const stop = poll(read, render);
  await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(14999); expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(render).toHaveBeenLastCalledWith(expect.objectContaining({ snapshot: data, error: "offline" }));
  await vi.advanceTimersByTimeAsync(15000); expect(render.mock.lastCall?.[0].error).toBeUndefined(); stop(); expect(vi.getTimerCount()).toBe(0);
});
it("has one in-flight request, times out and aborts", async () => {
  let signal: AbortSignal | undefined; const read = vi.fn((s: AbortSignal) => { signal = s; return new Promise<ReturnType<typeof snapshot>>(() => {}); }); const render = vi.fn(); const stop = poll(read, render);
  await vi.advanceTimersByTimeAsync(9999); expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(signal?.aborted).toBe(true); expect(render.mock.lastCall?.[0].error).toContain("超时"); stop();
});
it("pauses hidden pages, ignores late responses, resumes, and disposes", async () => {
  let resolveFirst: ((s: ReturnType<typeof snapshot>) => void) | undefined;
  const states: Observation[] = []; const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; })).mockResolvedValue(snapshot({ health: "degraded" }));
  const stop = poll(read, s => states.push(s));
  Object.defineProperty(document, "hidden", { value: true }); document.dispatchEvent(new Event("visibilitychange"));
  resolveFirst?.(snapshot()); await vi.advanceTimersByTimeAsync(60000); expect(states).toHaveLength(1); expect(read).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "hidden", { value: false }); document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)?.snapshot?.health).toBe("degraded"); stop(); await vi.advanceTimersByTimeAsync(60000); expect(read).toHaveBeenCalledTimes(2);
});

it("clears request deadline and aborts immediately on disposal", () => {
  let signal: AbortSignal | undefined;
  const stop = poll(s => { signal = s; return new Promise(() => {}); }, () => {});
  expect(vi.getTimerCount()).toBe(1); stop(); expect(signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
