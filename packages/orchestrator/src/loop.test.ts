/**
 * M5.5 poll loop startup / tick ordering / per-tick 失败降级测试
 * （SPEC §8.1、§14.2、§16.1 / §16.2｜验收 01 / 02 / 03 / 04 / 05 / 16）。
 *
 * 用真实 `OrchestratorAuthority` + 注入 manual timer / fake tracker / 可控 runner，
 * 断言真实世界结果（running / retry / timer / dispatch），不依赖真实等待。
 */
import { describe, expect, it } from "vitest";

import { OrchestratorStartupError } from "./index";
import { createLoopHarness, flushMicrotasks, makeIssue } from "./loop.test-helpers";

describe("OrchestratorLoop startup（验收 01 / 02）", () => {
  it("startup preflight 失败：抛可识别错误、不 cleanup、不安排 timer", async () => {
    const h = createLoopHarness();
    h.preflight.result = { ok: false, error: "codex.command is empty" };

    await expect(h.loop.start()).rejects.toBeInstanceOf(OrchestratorStartupError);

    expect(h.loop.stopped).toBe(true);
    expect(h.loop.running).toBe(false);
    expect(h.pollScheduler.scheduledDelays).toEqual([]);
    expect(h.cleanupCalls).toEqual([]);
    // 未进入 startup sweep：零 tracker 请求。
    expect(h.tracker.candidateStateCalls).toEqual([]);
    expect(h.diagnostics.at(-1)).toMatchObject({ kind: "startup_validation_failed" });
  });

  it("startup 顺序 validate → terminal cleanup → immediate first tick；首次 tick 零延迟", async () => {
    const h = createLoopHarness();
    const active = makeIssue("A-1", "Todo");
    const terminal = makeIssue("T-1", "Done");
    h.tracker.activeIssues = [active, terminal];
    h.tracker.track(active);

    await h.loop.start();

    // startup sweep 已执行（按 terminal states 拉取并清理），但尚未 dispatch。
    expect(h.tracker.candidateStateCalls).toEqual([["Done", "Cancelled"]]);
    expect(h.cleanupCalls).toEqual(["T-1"]);
    expect(h.runner.started).toEqual([]);
    // 首次 tick 立即（零延迟）。
    expect(h.pollScheduler.scheduledDelays).toEqual([0]);

    h.pollScheduler.fire();
    await h.loop.settled();

    // 随后 tick 按 active states 拉取候选并 dispatch。
    expect(h.tracker.candidateStateCalls).toEqual([
      ["Done", "Cancelled"],
      ["Todo", "In Progress"],
    ]);
    expect(h.runner.started).toEqual([active.id]);
    // 下一次 tick 使用 effective poll interval。
    expect(h.pollScheduler.scheduledDelays).toEqual([0, 30_000]);
  });
});

describe("OrchestratorLoop tick 顺序（验收 03 / 04）", () => {
  it("reconciliation 总在 validation / fetch / dispatch 前；validation 失败跳过 fetch 与 dispatch", async () => {
    const h = createLoopHarness();
    const issue = makeIssue("A-1", "Todo");
    h.tracker.activeIssues = [issue];
    h.tracker.track(issue);

    await h.loop.start();
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.runner.started).toEqual([issue.id]);
    expect(h.authority.activeWorkerCount).toBe(1);

    const candidateCallsBefore = h.tracker.candidateStateCalls.length;
    const refreshCallsBefore = h.tracker.refreshIdCalls.length;
    const preflightCallsBefore = h.preflight.calls;

    // 让本 tick validation 失败。
    h.preflight.result = { ok: false, error: "workflow invalid" };
    h.pollScheduler.fire();
    await h.loop.settled();

    // reconciliation 已先执行（对 running issue 做了 refresh）。
    expect(h.tracker.refreshIdCalls.length).toBe(refreshCallsBefore + 1);
    expect(h.tracker.refreshIdCalls.at(-1)).toEqual([issue.id]);
    // preflight 被调用（在 reconciliation 之后）。
    expect(h.preflight.calls).toBe(preflightCallsBefore + 1);
    // 未 fetch 候选、未新增 dispatch；服务仍存活并有下一次 timer。
    expect(h.tracker.candidateStateCalls.length).toBe(candidateCallsBefore);
    expect(h.runner.started).toEqual([issue.id]);
    expect(h.loop.running).toBe(true);
    expect(h.pollScheduler.pendingCount).toBe(1);
    expect(h.diagnostics.some((d) => d.kind === "tick_validation_failed")).toBe(true);
  });
});

describe("OrchestratorLoop 失败降级（验收 05 / 16）", () => {
  it("candidate fetch 失败：不 crash、跳过本 tick dispatch、下一 tick 恢复", async () => {
    const h = createLoopHarness();
    const issue = makeIssue("A-1", "Todo");
    h.tracker.activeIssues = [issue];
    h.tracker.track(issue);

    await h.loop.start();
    h.tracker.candidateFail = true;
    h.pollScheduler.fire();
    await h.loop.settled();

    expect(h.runner.started).toEqual([]);
    expect(h.loop.running).toBe(true);
    expect(h.pollScheduler.pendingCount).toBe(1);
    expect(h.diagnostics.some((d) => d.kind === "candidate_fetch_failed")).toBe(true);

    // 恢复后下一 tick 正常 dispatch。
    h.tracker.candidateFail = false;
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.runner.started).toEqual([issue.id]);
  });

  it("reconciliation refresh 失败：保留运行中的 worker（§14.2）", async () => {
    const h = createLoopHarness();
    const issue = makeIssue("A-1", "Todo");
    h.tracker.activeIssues = [issue];
    h.tracker.track(issue);

    await h.loop.start();
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.authority.activeWorkerCount).toBe(1);

    h.tracker.refreshFail = true;
    h.pollScheduler.fire();
    await h.loop.settled();

    expect(h.authority.activeWorkerCount).toBe(1);
    expect(h.runner.started).toEqual([issue.id]);
    expect(h.loop.running).toBe(true);
  });
});

describe("OrchestratorLoop 单 timer 链（验收 03 / 06 基础）", () => {
  it("慢 tick 不重叠：tick 在途时不排下一次 timer，结束后恰好排一个", async () => {
    const h = createLoopHarness();
    const issue = makeIssue("A-1", "Todo");
    h.tracker.activeIssues = [issue];

    await h.loop.start();
    let release: (issues: readonly (typeof issue)[]) => void = () => {};
    h.tracker.candidateHandler = () =>
      new Promise<readonly (typeof issue)[]>((resolve) => {
        release = resolve;
      });

    h.pollScheduler.fire(); // tick 开始，fetch 挂起
    await flushMicrotasks();
    // tick 在途时没有下一次 timer，避免慢 tick 重叠。
    expect(h.pollScheduler.pendingCount).toBe(0);

    release([]);
    await h.loop.settled();
    expect(h.pollScheduler.pendingCount).toBe(1);
    expect(h.pollScheduler.scheduledDelays).toEqual([0, 30_000]);
  });

  it("stop 取消 poll timer、停止 workers、幂等且不再触发 tick / retry（验收 11）", async () => {
    const h = createLoopHarness();
    const issue = makeIssue("A-1", "Todo");
    h.tracker.activeIssues = [issue];
    h.tracker.track(issue);

    await h.loop.start();
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.authority.activeWorkerCount).toBe(1);

    await h.loop.stop();

    expect(h.loop.stopped).toBe(true);
    expect(h.pollScheduler.pendingCount).toBe(0);
    expect(h.authority.activeWorkerCount).toBe(0);
    expect(h.state.retryAttempts.size).toBe(0);
    // shutdown stop reason 抑制 retry，且没有遗留 retry timer。
    expect(h.retryScheduler.pendingCount).toBe(0);

    // 已取消的 timer 不可再触发 tick / dispatch。
    h.pollScheduler.fire();
    await flushMicrotasks();
    expect(h.runner.started).toEqual([issue.id]);

    // stop 幂等：重复调用共享同一 Promise。
    expect(h.loop.stop()).toBe(h.loop.stop());
    // 关停后拒绝新 dispatch。
    expect(h.authority.dispatchIssue(makeIssue("B-1", "Todo"))).toMatchObject({
      kind: "skipped",
    });
  });
});
