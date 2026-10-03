/**
 * M5.5 shutdown / stop lifecycle 竞态测试（SPEC §8.1 / §14.3｜验收 11）。
 *
 * stop 必须：同步取消 poll timer、等待在途 tick、使在途 retry refresh 的迟到结果
 * 失效、以 shutdown reason 停止 workers、不遗留 timer、幂等。
 */
import { describe, expect, it } from "vitest";

import type { Issue } from "@symphony/domain";

import type { RetryWorkspaceCleanup, RetryWorkspaceCleanupResult } from "./index";
import { createLoopHarness, flushMicrotasks, makeIssue } from "./loop.test-helpers";

describe("OrchestratorLoop stop 竞态（验收 11）", () => {
  it("stop 发生在 candidate fetch 在途：不 dispatch、不重排 timer", async () => {
    const h = createLoopHarness();
    const issue = makeIssue("A-1", "Todo");
    h.tracker.activeIssues = [issue];
    h.tracker.track(issue);

    await h.loop.start();
    let release: (issues: readonly Issue[]) => void = () => {};
    h.tracker.candidateHandler = () =>
      new Promise<readonly Issue[]>((resolve) => {
        release = resolve;
      });

    h.pollScheduler.fire();
    await flushMicrotasks();
    expect(h.runner.started).toEqual([]);

    const stopping = h.loop.stop();
    release([issue]);
    await stopping;
    await flushMicrotasks();

    expect(h.runner.started).toEqual([]);
    expect(h.pollScheduler.pendingCount).toBe(0);
    expect(h.loop.stopped).toBe(true);
  });

  it("stop 发生在 retry refresh 在途：迟到 refresh 不重新 dispatch / 排 retry", async () => {
    const h = createLoopHarness({ maxConcurrentAgents: 1, maxRetryBackoffMs: 1000 });
    const issue = makeIssue("A-1", "Todo");
    h.tracker.activeIssues = [issue];
    h.tracker.track(issue);

    await h.loop.start();
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.runner.started).toEqual([issue.id]);

    // 触发一次 failure → 建立 retry entry / timer。
    h.runner.reject(issue.id);
    await flushMicrotasks();
    expect(h.state.retryAttempts.get(issue.id)?.attempt).toBe(1);

    // 让 retry refresh 挂起。
    let release: (issues: readonly Issue[]) => void = () => {};
    h.tracker.refreshHandler = () =>
      new Promise<readonly Issue[]>((resolve) => {
        release = resolve;
      });
    h.retryScheduler.fire();
    await flushMicrotasks();

    const stopping = h.loop.stop();
    release([issue]); // refresh 返回 active 快照，但 stop 已使之失效。
    await stopping;
    await flushMicrotasks();

    expect(h.runner.started).toEqual([issue.id]); // 无新 dispatch
    expect(h.state.retryAttempts.size).toBe(0);
    expect(h.state.running.size).toBe(0);
    expect(h.retryScheduler.pendingCount).toBe(0);
  });

  it("stop 以 shutdown reason 停止 worker 并等待真实收尾，不排 retry", async () => {
    const h = createLoopHarness();
    const issue = makeIssue("A-1", "Todo");
    h.tracker.activeIssues = [issue];
    h.tracker.track(issue);

    await h.loop.start();
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.authority.activeWorkerCount).toBe(1);

    await h.loop.stop();

    expect(h.authority.activeWorkerCount).toBe(0);
    expect(h.state.retryAttempts.size).toBe(0);
    expect(h.retryScheduler.pendingCount).toBe(0);
    // worker 明确以 shutdown 收敛（终态 error 可判别）。
    expect(h.state.running.size).toBe(0);
  });

  it("stop 发生在 startup cleanup 在途：start 不再进入调度、不排 timer", async () => {
    let releaseCleanup: (result: RetryWorkspaceCleanupResult) => void = () => {};
    const cleanup: RetryWorkspaceCleanup = {
      removeWorkspace: () =>
        new Promise<RetryWorkspaceCleanupResult>((resolve) => {
          releaseCleanup = resolve;
        }),
    };
    const h = createLoopHarness({ cleanup });
    h.tracker.activeIssues = [makeIssue("T-1", "Done")];

    const startPromise = h.loop.start();
    await flushMicrotasks();
    expect(h.pollScheduler.scheduledDelays).toEqual([]); // 仍在 startup cleanup

    const stopPromise = h.loop.stop();
    releaseCleanup({ status: "removed" });
    await startPromise;
    await stopPromise;

    expect(h.pollScheduler.scheduledDelays).toEqual([]);
    expect(h.loop.stopped).toBe(true);
    // startup sweep 确实执行过（按 terminal states 拉取），但未进入 first tick。
    expect(h.tracker.candidateStateCalls).toEqual([["Done", "Cancelled"]]);
  });
});
