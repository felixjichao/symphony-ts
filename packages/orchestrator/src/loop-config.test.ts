/**
 * M5.5 live config re-apply 测试（SPEC §6.2｜验收 06 / 07 / 08 / 09 / 10）。
 *
 * `OrchestratorLoop` 每个 tick 都经 preflight 取最新 effective 并原子应用；retry cap /
 * stall timeout 由 authority getter 从同一 effective store 读取。全部用注入 manual
 * timer / 可控 runner 确定性复跑。
 */
import { describe, expect, it } from "vitest";

import type { TurnCompletedContext } from "@symphony/agent";
import type { Issue } from "@symphony/domain";

import {
  createLoopHarness,
  defaultPolicy,
  flushMicrotasks,
  makeIssue,
  toEffective,
} from "./loop.test-helpers";

/** 构造一个只供 continuation decider 判定的最小 context（decider 只用 issue + signal）。 */
function turnContext(issue: Issue): TurnCompletedContext {
  return { issue } as unknown as TurnCompletedContext;
}

describe("live config re-apply（验收 06 interval）", () => {
  it("下一次 tick 使用 reload 后的 poll interval", async () => {
    const h = createLoopHarness({ pollIntervalMs: 1000 });
    const issue = makeIssue("A-1", "Todo");
    h.tracker.activeIssues = [issue];
    h.tracker.track(issue);

    await h.loop.start();
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.pollScheduler.scheduledDelays).toEqual([0, 1000]);

    // reload：interval 变为 5000。
    h.live.pollIntervalMs = 5000;
    h.preflight.result = { ok: true, effective: toEffective(h.live) };
    h.pollScheduler.fire();
    await h.loop.settled();

    expect(h.pollScheduler.scheduledDelays).toEqual([0, 1000, 5000]);
  });
});

describe("live config re-apply（验收 07 concurrency）", () => {
  it("并发上限下调不终止运行中的 worker，上调影响后续 dispatch", async () => {
    const h = createLoopHarness({ maxConcurrentAgents: 2 });
    const a = makeIssue("A-1", "Todo");
    const b = makeIssue("B-1", "Todo");
    const c = makeIssue("C-1", "Todo");
    h.tracker.activeIssues = [a, b, c];
    h.tracker.track(a);
    h.tracker.track(b);
    h.tracker.track(c);

    await h.loop.start();
    h.pollScheduler.fire();
    await h.loop.settled();
    // 稳定排序：priority → createdAt → identifier。
    expect(h.runner.started).toEqual([a.id, b.id]);
    expect(h.authority.activeWorkerCount).toBe(2);

    // 下调到 1：已有 worker 不被终止，只是没有新 slot。
    h.live.maxConcurrentAgents = 1;
    h.preflight.result = { ok: true, effective: toEffective(h.live) };
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.runner.started).toEqual([a.id, b.id]);
    expect(h.authority.activeWorkerCount).toBe(2);

    // 上调到 3：后续 dispatch 使用新上限。
    h.live.maxConcurrentAgents = 3;
    h.preflight.result = { ok: true, effective: toEffective(h.live) };
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.runner.started).toEqual([a.id, b.id, c.id]);
  });

  it("per-state concurrency override reload 影响后续 dispatch，下调不终止运行 worker（验收 07）", async () => {
    const h = createLoopHarness({
      maxConcurrentAgents: 3,
      policy: defaultPolicy({ maxConcurrentAgentsByState: { todo: 1 } }),
    });
    const a = makeIssue("A-1", "Todo");
    const b = makeIssue("B-1", "Todo");
    const c = makeIssue("C-1", "Todo");
    h.tracker.activeIssues = [a, b, c];
    h.tracker.track(a);
    h.tracker.track(b);
    h.tracker.track(c);

    await h.loop.start();
    h.pollScheduler.fire();
    await h.loop.settled();
    // 全局上限 3，但 per-state Todo = 1 → 只派发一个。
    expect(h.runner.started).toEqual([a.id]);
    expect(h.authority.activeWorkerCount).toBe(1);

    // 上调 per-state Todo = 2 → 后续 dispatch 使用新上限。
    h.live.policy = defaultPolicy({ maxConcurrentAgentsByState: { todo: 2 } });
    h.preflight.result = { ok: true, effective: toEffective(h.live) };
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.runner.started).toEqual([a.id, b.id]);

    // 下调 per-state Todo = 1 → 已运行 worker 不被终止，只是不再新增。
    h.live.policy = defaultPolicy({ maxConcurrentAgentsByState: { todo: 1 } });
    h.preflight.result = { ok: true, effective: toEffective(h.live) };
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.runner.started).toEqual([a.id, b.id]);
    expect(h.authority.activeWorkerCount).toBe(2);

    // 移除 override → fallback 全局上限 3，可派发第三个。
    h.live.policy = defaultPolicy();
    h.preflight.result = { ok: true, effective: toEffective(h.live) };
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.runner.started).toEqual([a.id, b.id, c.id]);
  });
});

describe("live config re-apply（验收 08 retry cap）", () => {
  it("reload 后新创建的 retry 使用新的 max_retry_backoff_ms", async () => {
    const h = createLoopHarness({ maxConcurrentAgents: 2, maxRetryBackoffMs: 1000 });
    const a = makeIssue("A-1", "Todo");
    const b = makeIssue("B-1", "Todo");
    h.tracker.activeIssues = [a, b];
    h.tracker.track(a);
    h.tracker.track(b);

    await h.loop.start();
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.runner.started).toEqual([a.id, b.id]);

    // 第一次 failure：cap = 1000 → delay = min(10000, 1000) = 1000。
    h.runner.reject(a.id);
    await flushMicrotasks();
    const firstEntry = h.state.retryAttempts.get(a.id);
    expect(firstEntry?.attempt).toBe(1);
    expect((firstEntry?.dueAtMs ?? 0) - h.monotonicNow()).toBe(1000);

    // reload：cap 变为 2000；之后创建的 retry 使用新 cap。
    h.live.maxRetryBackoffMs = 2000;
    h.runner.reject(b.id);
    await flushMicrotasks();
    const secondEntry = h.state.retryAttempts.get(b.id);
    expect(secondEntry?.attempt).toBe(1);
    expect((secondEntry?.dueAtMs ?? 0) - h.monotonicNow()).toBe(2000);
  });
});

describe("live config re-apply（验收 09 stall timeout）", () => {
  it("reload 后 stall timeout 影响后续 reconciliation", async () => {
    const h = createLoopHarness({ maxConcurrentAgents: 1, stallTimeoutMs: 0 });
    const issue = makeIssue("A-1", "Todo");
    h.tracker.activeIssues = [issue];
    h.tracker.track(issue);

    await h.loop.start();
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.authority.activeWorkerCount).toBe(1);

    // 时钟推进；起初 stall 检测禁用，worker 存活。
    h.advanceUtc(500);
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.authority.activeWorkerCount).toBe(1);

    // reload：启用 stall timeout 100ms → 后续 reconciliation 触发 stall。
    h.live.stallTimeoutMs = 100;
    h.preflight.result = { ok: true, effective: toEffective(h.live) };
    h.pollScheduler.fire();
    await h.loop.settled();

    expect(h.authority.activeWorkerCount).toBe(0);
    expect(h.state.retryAttempts.get(issue.id)?.attempt).toBe(1);
  });
});

describe("live config re-apply（验收 10 active / terminal / labels）", () => {
  it("required labels reload 影响后续 eligibility", async () => {
    const h = createLoopHarness({ maxConcurrentAgents: 3 });
    const a = makeIssue("A-1", "Todo");
    const b = makeIssue("B-1", "Todo");
    h.tracker.activeIssues = [a, b];
    h.tracker.track(a);
    h.tracker.track(b);

    await h.loop.start();
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.runner.started).toEqual([a.id, b.id]);

    // reload：要求 label "bug"；新候选无 label → 不派发。
    const c = makeIssue("C-1", "Todo");
    h.tracker.activeIssues = [a, b, c];
    h.tracker.track(c);
    h.live.policy = defaultPolicy({ requiredLabels: ["bug"] });
    h.preflight.result = { ok: true, effective: toEffective(h.live) };
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.runner.started).toEqual([a.id, b.id]);

    // 候选带上（大小写不同的）label 后按新 policy 可派发。
    const cTagged = makeIssue("C-1", "Todo", { labels: ["BUG"] });
    h.tracker.activeIssues = [a, b, cTagged];
    h.tracker.track(cTagged);
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.runner.started).toEqual([a.id, b.id, cTagged.id]);
  });

  it("active / terminal states reload 影响后续 fetch 与 reconciliation", async () => {
    const h = createLoopHarness({ maxConcurrentAgents: 2 });
    const a = makeIssue("A-1", "Todo");
    const b = makeIssue("B-1", "In Progress");
    h.tracker.activeIssues = [a, b];
    h.tracker.track(a);
    h.tracker.track(b);

    await h.loop.start();
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.runner.started).toEqual([a.id, b.id]);

    // reload：active states 只保留 "In Progress"；fetch 使用新 active states。
    h.live.policy = defaultPolicy({ activeStates: ["In Progress"] });
    h.preflight.result = { ok: true, effective: toEffective(h.live) };
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.tracker.candidateStateCalls.at(-1)).toEqual(["In Progress"]);
    expect(h.runner.started).toEqual([a.id, b.id]); // A-1 不再被 fetch / 派发

    // reload：A-1 当前 state 变为 terminal → 后续 reconciliation stop + cleanup。
    const aTerminal = makeIssue("A-1", "Done");
    h.tracker.activeIssues = [aTerminal, b];
    h.tracker.track(aTerminal);
    h.tracker.track(b);
    h.live.policy = defaultPolicy({
      activeStates: ["In Progress"],
      terminalStates: ["Done"],
    });
    h.preflight.result = { ok: true, effective: toEffective(h.live) };
    h.pollScheduler.fire();
    await h.loop.settled();

    expect(h.cleanupCalls).toContain(aTerminal.identifier);
    expect(h.authority.activeWorkerCount).toBe(1);
  });
});

describe("live config re-apply（现有 worker continuation 动态 policy）", () => {
  it("reload 后运行中 worker 的 continuation 判定读取新 policy → 按新 required labels stop", async () => {
    const h = createLoopHarness({ maxConcurrentAgents: 1 });
    const issue = makeIssue("A-1", "Todo");
    h.tracker.activeIssues = [issue];
    h.tracker.track(issue);

    await h.loop.start();
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.runner.started).toEqual([issue.id]);

    const decider = h.runner.continuationDeciders.get(issue.id);
    expect(decider).toBeDefined();

    // reload 前：required labels 为空 → 仍然 routable → continue（同一 live thread）。
    await expect(decider!(turnContext(issue))).resolves.toMatchObject({ kind: "continue" });

    // reload：要求 label "bug"；经一次 tick 应用新 policy（本次 reconciliation 仍用旧 policy）。
    h.live.policy = defaultPolicy({ requiredLabels: ["bug"] });
    h.preflight.result = { ok: true, effective: toEffective(h.live) };
    h.pollScheduler.fire();
    await h.loop.settled();
    expect(h.authority.activeWorkerCount).toBe(1); // 现有 worker 未被终止

    // reload 后：运行中 worker 的 continuation 读取最新 policy → 不再 routable → stop。
    await expect(decider!(turnContext(issue))).resolves.toEqual({ kind: "stop" });
  });
});
