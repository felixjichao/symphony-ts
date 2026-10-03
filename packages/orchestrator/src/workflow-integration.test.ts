/** SPEC §7 / §8 / §14 / §16 / §17.4: full public-entry Core Conformance. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeIssue } from "./loop.test-helpers";
import { createWorkflowHarness, processAlive, waitFor } from "./workflow.test-helpers";

const issue = (identifier = "NEST-79", overrides: Parameters<typeof makeIssue>[2] = {}) =>
  makeIssue(identifier, "Todo", { labels: ["agent"], ...overrides });
type Harness = Awaited<ReturnType<typeof createWorkflowHarness>>;
let h: Harness;
afterEach(async () => { if (h) await h.dispose(); });
async function start(settings: Parameters<typeof createWorkflowHarness>[0] = {}, candidates = [issue()]) {
  h = await createWorkflowHarness(settings);
  h.tracker.activeIssues = candidates;
  for (const candidate of candidates) h.tracker.track(candidate);
  await h.loop.start();
  await h.tick();
}
async function sessionReady(target = issue()) {
  await waitFor(() => h.state.running.get(target.id)?.session?.turnId !== null &&
    h.state.running.get(target.id)?.session?.turnId !== undefined);
}

describe("WORKFLOW → registry / tracker → loop → real workspace / agent subprocess", () => {
  it("dispatch order, adapter dispatchability, labels and duplicate guard reach real workers", async () => {
    const candidates = [
      issue("Z", { priority: 2, createdAt: 1 }), issue("B", { priority: 1, createdAt: 2 }),
      issue("A", { priority: 1, createdAt: 2 }), issue("OLD", { priority: 1, createdAt: 1 }),
      issue("DISABLED", { priority: 1, dispatchable: false }), issue("LABEL", { labels: [] }),
    ];
    await start({ args: ["--silent-turn"], concurrency: 4 }, candidates);
    expect(h.starts.map((entry) => entry.issue.identifier)).toEqual(["OLD", "A", "B", "Z"]);
    for (const candidate of candidates.slice(0, 4)) await sessionReady(candidate);
    const pids = h.starts.map((entry) => h.world(entry.issue).pid);
    await h.tick();
    expect(h.starts).toHaveLength(4);
    expect(h.state.claimed.size).toBe(4);
    for (const candidate of candidates.slice(4)) expect(existsSync(h.manager.resolveWorkspacePath(candidate.identifier))).toBe(false);
    await h.loop.stop();
    for (const pid of pids) expect(processAlive(pid)).toBe(false);
    expect(h.state.running.size).toBe(0);
    expect(h.state.retryAttempts.size).toBe(0);
    expect(h.poll.pendingCount + h.retry.pendingCount).toBe(0);
  });

  it("normal exit → complete RetryEntry → continuation attempt 1 with a new process and preserved workspace", async () => {
    await start({ args: ["--send-usage", "--send-rate-limits"] });
    await h.authority.waitForIdle();
    const target = issue();
    const world = h.world(target);
    expect(world.cwd).toBe(h.manager.resolveWorkspacePath(target.identifier));
    expect(processAlive(world.pid)).toBe(false);
    expect(h.results[0]?.workspace.createdNow).toBe(true);
    expect(h.state.completed.has(target.id)).toBe(true);
    expect(h.state.codexTotals).toMatchObject({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    expect(h.state.codexRateLimits).toMatchObject({ limitId: "lim-1" });
    expect(h.events.length).toBeGreaterThan(0);
    expect(h.state.retryAttempts.get(target.id)).toEqual({ issueId: target.id, identifier: target.identifier,
      attempt: 1, dueAtMs: 6000, timerHandle: expect.any(Number), error: null, issueUrl: target.url });
    expect(h.retry.pendingDelays()).toEqual([1000]);
    const refreshCount = h.tracker.refreshIdCalls.length;
    await h.tick(); // claimed retry prevents duplicate candidate dispatch; no running ID refresh.
    expect(h.starts).toHaveLength(1);
    expect(h.tracker.refreshIdCalls).toHaveLength(refreshCount);
    const marker = path.join(world.cwd, "marker");
    writeFileSync(marker, "preserve");
    await h.retryAndIdle(2);
    expect(h.starts[1]?.attempt).toBe(1);
    expect(h.world(target).pid).not.toBe(world.pid);
    expect(processAlive(h.world(target).pid)).toBe(false);
    expect(h.results[1]?.workspace.createdNow).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe("preserve");
    expect(h.state.retryAttempts.get(target.id)?.attempt).toBe(1);
    // Release retry, then poll again: completed is bookkeeping, not permanent gating.
    h.tracker.snapshots.delete(target.id);
    h.retry.fire();
    await waitFor(() => !h.state.claimed.has(target.id));
    h.tracker.track(target);
    await h.tick();
    await h.authority.waitForIdle();
    expect(h.starts).toHaveLength(3);
  });

  it("real abnormal exit backs off exponentially and file reload applies the current cap / prompt", async () => {
    await start({ args: ["--turn-status", "failed"] });
    await h.authority.waitForIdle();
    expect(h.retry.pendingDelays()).toEqual([10000]);
    expect(h.state.retryAttempts.get(issue().id)).toMatchObject({ attempt: 1, error: expect.any(String) });
    await h.retryAndIdle(2);
    expect(h.retry.pendingDelays()).toEqual([20000]);
    h.writeWorkflow({ args: ["--turn-status", "failed"], cap: 12000, interval: 17,
      prompt: "Recovered {{ issue.identifier }} attempt={{ attempt }}" });
    await h.tick();
    expect(h.state.pollIntervalMs).toBe(17);
    // Already scheduled timers keep their due time; next failure uses new cap.
    expect(h.retry.pendingDelays()).toEqual([20000]);
    await h.retryAndIdle(3);
    expect(h.retry.pendingDelays()).toEqual([12000]);
    expect(h.state.retryAttempts.get(issue().id)).toMatchObject({ attempt: 3, dueAtMs: 17000 });
    const transcript = readFileSync(path.join(h.world(issue()).cwd, "transcript.ndjson"), "utf8");
    expect(transcript).toContain("Recovered NEST-79 attempt=2");
  });

  it.each(["Review", "Done"])("refresh %s stops the real process; only terminal deletes after after_run", async (state) => {
    await start({ args: ["--silent-turn"] });
    await sessionReady();
    const world = h.world(issue());
    const updated = issue("NEST-79", { state: "In Progress", title: "refreshed", priority: 4 });
    h.tracker.track(updated);
    await h.tick();
    expect(h.state.running.get(updated.id)?.issue).toEqual(updated);
    h.tracker.track({ ...updated, state });
    h.tracker.activeIssues = [];
    await h.tick();
    expect(processAlive(world.pid)).toBe(false);
    expect(h.state.running.size + h.state.retryAttempts.size + h.state.claimed.size).toBe(0);
    expect(existsSync(world.cwd)).toBe(state === "Review");
    if (state === "Done") expect(h.cleanupObservations).toEqual([
      { identifier: updated.identifier, alive: false, lifecycle: "after\n" },
    ]);
    else expect(readFileSync(path.join(world.cwd, "lifecycle.txt"), "utf8")).toBe("after\n");
  });

  it("stall uses the event UTC clock and creates exactly one failure retry after real process shutdown", async () => {
    await start({ args: ["--silent-turn"], stall: 1000 });
    await sessionReady();
    const target = issue();
    const world = h.world(target);
    const timestamp = h.state.running.get(target.id)!.session!.lastCodexTimestamp!;
    h.clocks.utc = timestamp + 1001;
    await h.tick();
    expect(processAlive(world.pid)).toBe(false);
    expect(existsSync(world.cwd)).toBe(true);
    expect(h.state.retryAttempts.get(target.id)).toMatchObject({ attempt: 1, error: expect.stringContaining("stall") });
    expect(h.retry.pendingDelays()).toEqual([10000]);
  });

  it("startup sweeps terminal directories and an idle tick performs no ID refresh", async () => {
    h = await createWorkflowHarness();
    const terminal = issue("TERMINAL", { state: "Done", labels: [] });
    const active = issue("ACTIVE");
    const removed = await h.manager.createWorkspace(terminal.identifier);
    const kept = await h.manager.createWorkspace(active.identifier);
    h.tracker.activeIssues = [terminal];
    await h.loop.start();
    expect(existsSync(removed.path)).toBe(false);
    expect(existsSync(kept.path)).toBe(true);
    await h.tick();
    expect(h.starts).toHaveLength(0);
    expect(h.tracker.refreshIdCalls).toHaveLength(0);
  });

  it.each(["missing", "inactive", "unroutable"])("retry refresh %s releases its claim without deleting the workspace", async (kind) => {
    await start();
    await h.authority.waitForIdle();
    const target = issue();
    if (kind === "missing") h.tracker.snapshots.delete(target.id);
    else h.tracker.track({ ...target, ...(kind === "inactive" ? { state: "Review" } : { dispatchable: false }) });
    h.retry.fire();
    await waitFor(() => !h.state.claimed.has(target.id));
    expect(h.starts).toHaveLength(1);
    expect(h.state.retryAttempts.size).toBe(0);
    expect(existsSync(h.manager.resolveWorkspacePath(target.identifier))).toBe(true);
  });

  it("slot exhaustion requeues with the explicit reason after config downshift", async () => {
    await start();
    await h.authority.waitForIdle();
    const occupant = issue("OCCUPANT");
    h.tracker.track(occupant);
    h.tracker.activeIssues = [occupant];
    h.writeWorkflow({ concurrency: 1, args: ["--silent-turn"] });
    await h.tick();
    await sessionReady(occupant);
    h.retry.fire();
    await waitFor(() => h.state.retryAttempts.has(issue().id));
    expect(h.starts).toHaveLength(2);
    expect(h.state.retryAttempts.get(issue().id)?.error).toBe("no available orchestrator slots");
  });

  it("invalid file keeps one effective version; recovery changes scheduling and subsequent attempt options", async () => {
    await start({ args: ["--silent-turn"] });
    await sessionReady();
    const old = h.effective();
    writeFileSync(h.workflowPath, "---\ntracker: [broken\n---\n");
    await h.tick();
    expect(h.effective()).toBe(old);
    expect(h.diagnostics.at(-1)?.kind).toBe("tick_validation_failed");
    expect(h.state.running.size).toBe(1);
    expect(h.poll.pendingDelays()).toEqual([30000]);
    h.writeWorkflow({ args: ["--silent-turn"], interval: 19, concurrency: 1,
      perState: { Todo: 0 }, cap: 12345, stall: 45678, labels: ["next"],
      active: ["Doing"], terminal: ["Closed"], prompt: "New {{ issue.identifier }}" });
    await h.tick(); // reconciliation uses old policy before successful preflight.
    expect(h.state.running.size).toBe(1);
    expect(h.state.maxConcurrentAgents).toBe(1);
    expect(h.poll.pendingDelays()).toEqual([19]);
    expect(h.effective().serviceConfig).toMatchObject({ agent: { maxRetryBackoffMs: 12345 }, codex: { stallTimeoutMs: 45678 } });
    const next = issue("NEXT", { state: "Doing", labels: ["next"] });
    h.tracker.track(next);
    h.tracker.activeIssues = [next];
    await h.tick(); // old issue now inactive, next launches from the same effective.
    await sessionReady(next);
    expect(h.starts.map((entry) => entry.issue.identifier)).toEqual(["NEST-79", "NEXT"]);
    expect(readFileSync(path.join(h.world(next).cwd, "transcript.ndjson"), "utf8")).toContain("New NEXT");
    const world = h.world(next);
    h.tracker.track({ ...next, state: "Closed" });
    h.tracker.activeIssues = [];
    await h.tick();
    expect(processAlive(world.pid)).toBe(false);
    expect(h.cleanupObservations).toEqual([
      { identifier: next.identifier, alive: false, lifecycle: "after\n" },
    ]);
    expect(existsSync(world.cwd)).toBe(false);
    expect(h.state.running.size + h.state.retryAttempts.size + h.state.claimed.size).toBe(0);
  });

  it("tracker failures degrade, then recover without losing a running process or its claim", async () => {
    await start({ args: ["--silent-turn"] });
    await sessionReady();
    const pid = h.world(issue()).pid;
    h.tracker.refreshFail = h.tracker.candidateFail = true;
    await h.tick();
    expect(processAlive(pid)).toBe(true);
    expect(h.state.running.size).toBe(1);
    expect(h.diagnostics.at(-1)?.kind).toBe("candidate_fetch_failed");
    h.tracker.refreshFail = h.tracker.candidateFail = false;
    h.tracker.track(issue("NEST-79", { state: "Done" }));
    h.tracker.activeIssues = [];
    await h.tick();
    expect(processAlive(pid)).toBe(false);
    expect(existsSync(h.manager.resolveWorkspacePath(issue().identifier))).toBe(false);
  });

  it("file per-state override reload changes dispatch while global downshift preserves current workers", async () => {
    const a = issue("A"); const b = issue("B");
    await start({ args: ["--silent-turn"], concurrency: 3, perState: { " todo ": 1 } }, [b, a]);
    await sessionReady(a);
    expect(h.starts.map((entry) => entry.issue.identifier)).toEqual(["A"]);
    h.writeWorkflow({ args: ["--silent-turn"], concurrency: 3, perState: { TODO: 2 } });
    await h.tick(); await sessionReady(b);
    expect(h.starts.map((entry) => entry.issue.identifier)).toEqual(["A", "B"]);
    h.writeWorkflow({ args: ["--silent-turn"], concurrency: 1, perState: { Todo: 1 } });
    await h.tick();
    expect(h.state.running.size).toBe(2);
    expect(processAlive(h.world(a).pid) && processAlive(h.world(b).pid)).toBe(true);
  });

  it("file reload changes the running worker continuation policy and subsequent stall getter", async () => {
    h = await createWorkflowHarness({ maxTurns: 2 });
    const target = issue(); h.tracker.activeIssues = [target]; h.tracker.track(target);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    h.tracker.refreshHandler = async () => {
      if (!entered) { entered = true; await gate; }
      return [target];
    };
    try {
      await h.loop.start(); await h.tick(); await waitFor(() => entered);
      h.writeWorkflow({ maxTurns: 2, labels: ["next"], stall: 1000 });
      await h.tick(); // reconcile under old policy, then commit new file policy.
      expect(h.state.running.size).toBe(1);
      release(); await h.authority.waitForIdle();
      expect(h.results[0]?.turnCount).toBe(1); // new label policy declines another turn.
      const next = issue("NEXT", { labels: ["next"] });
      h.tracker.refreshHandler = null; h.tracker.track(next); h.tracker.activeIssues = [next];
      h.writeWorkflow({ args: ["--silent-turn"], labels: ["next"], stall: 1000 });
      await h.tick(); await sessionReady(next);
      const pid = h.world(next).pid;
      h.clocks.utc = h.state.running.get(next.id)!.session!.lastCodexTimestamp! + 1001;
      await h.tick();
      expect(processAlive(pid)).toBe(false);
      expect(h.state.retryAttempts.get(next.id)?.error).toContain("stall");
    } finally { release(); }
  });

  it.each(["unsupported tracker", "empty codex command"])("startup dispatch preflight rejects %s before tracker reads", async (kind) => {
    h = await createWorkflowHarness();
    const content = readFileSync(h.workflowPath, "utf8");
    const frontMatter = JSON.parse(content.split("---")[1]!) as {
      tracker: { kind: string }; codex: { command: string };
    };
    if (kind === "unsupported tracker") frontMatter.tracker.kind = "unknown";
    else frontMatter.codex.command = " ";
    writeFileSync(h.workflowPath, `---\n${JSON.stringify(frontMatter)}\n---\nPrompt\n`);
    await expect(h.loop.start()).rejects.toThrow();
    expect(h.tracker.candidateStateCalls).toHaveLength(0);
    expect(h.starts).toHaveLength(0);
    expect(h.poll.pendingCount + h.retry.pendingCount).toBe(0);
  });

});
