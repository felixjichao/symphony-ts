import type { OperationalSnapshot } from "@symphony/operations";
export interface Observation { snapshot?: OperationalSnapshot; receivedAt?: number; error?: string }
export function poll(read: (signal: AbortSignal) => Promise<OperationalSnapshot>, render: (state: Observation) => void, visibility: Document = document): () => void {
  let state: Observation = {};
  let stopped = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let requestTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { generation++; clearTimeout(timer); clearTimeout(requestTimer); controller?.abort(); };
  const run = async () => {
    if (stopped || visibility.hidden) return;
    const own = ++generation;
    controller = new AbortController();
    const current = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const expiry = new Promise<never>((_, reject) => { timeout = requestTimer = setTimeout(() => { current.abort(); reject(new Error("请求超时")); }, 10_000); });
      const snapshot = await Promise.race([read(current.signal), expiry]);
      if (own === generation) { state = { snapshot, receivedAt: Date.now() }; render(state); }
    } catch (error) {
      if (own === generation) { state = { ...state, error: error instanceof Error ? error.message : "观察失败" }; render(state); }
    } finally {
      clearTimeout(timeout);
      if (own === generation && !stopped && !visibility.hidden) timer = setTimeout(() => { void run(); }, 15_000);
    }
  };
  const changed = () => { cancel(); if (!visibility.hidden) void run(); };
  visibility.addEventListener("visibilitychange", changed);
  render(state);
  void run();
  return () => { stopped = true; cancel(); visibility.removeEventListener("visibilitychange", changed); };
}
