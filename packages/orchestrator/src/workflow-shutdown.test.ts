/** SPEC §14.3: stop barriers with real file loading / workspace / worker lifecycle. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeIssue } from "./loop.test-helpers";
import { createWorkflowHarness, processAlive, waitFor } from "./workflow.test-helpers";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const target = makeIssue("NEST-79", "Todo", { labels: ["agent"] });
let h: Awaited<ReturnType<typeof createWorkflowHarness>>;
let gate: ReturnType<typeof barrier>;
afterEach(async () => { gate?.release(); if (h) await h.dispose(); });
async function running() {
  h = await createWorkflowHarness({ args: ["--silent-turn"] });
  h.tracker.activeIssues = [target]; h.tracker.track(target);
  await h.loop.start(); await h.tick();
  await waitFor(() => Boolean(h.state.running.get(target.id)?.session?.turnId));
}
function expectStopped() {
  expect(h.state.running.size + h.state.retryAttempts.size + h.poll.pendingCount + h.retry.pendingCount).toBe(0);
  const count = h.starts.length;
  h.poll.fire(); h.retry.fire();
  expect(h.starts).toHaveLength(count);
}

describe("full loop shutdown barriers", () => {
  it("candidate fetch in flight does not postpone real worker shutdown", async () => {
    await running(); gate = barrier();
    const pid = h.world(target).pid;
    let entered = false;
    h.tracker.candidateHandler = async () => { entered = true; await gate.promise; return [target]; };
    const tick = h.tick(); await waitFor(() => entered);
    let stopped = false;
    const stop = h.loop.stop().then(() => { stopped = true; });
    await waitFor(() => !processAlive(pid));
    expect(stopped).toBe(false);
    await h.authority.waitForIdle();
    expect(readFileSync(path.join(h.manager.resolveWorkspacePath(target.identifier), "lifecycle.txt"), "utf8")).toBe("after\n");
    gate.release(); await tick; await stop;
    expect(h.starts).toHaveLength(1); expectStopped();
  });

  it("retry refresh in flight cannot revive a naturally exited real worker after stop", async () => {
    h = await createWorkflowHarness();
    h.tracker.activeIssues = [target]; h.tracker.track(target);
    await h.loop.start(); await h.tick(); await h.authority.waitForIdle();
    expect(processAlive(h.world(target).pid)).toBe(false);
    gate = barrier(); let entered = false;
    h.tracker.refreshHandler = async () => { entered = true; await gate.promise; return [target]; };
    h.retry.fire(); await waitFor(() => entered);
    await h.loop.stop();
    gate.release();
    // Let the released asynchronous refresh finish; no production timeout or retry sleeps.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.starts).toHaveLength(1); expectStopped();
  });

  it("stop waits for an already started terminal cleanup after subprocess / hook completion", async () => {
    await running(); gate = barrier();
    const world = h.world(target); let entered = false;
    h.cleanupGate.beforeRemove = async () => { entered = true; await gate.promise; };
    h.tracker.track({ ...target, state: "Done" }); h.tracker.activeIssues = [];
    const tick = h.tick(); await waitFor(() => entered);
    expect(processAlive(world.pid)).toBe(false);
    expect(h.cleanupObservations).toEqual([{ identifier: target.identifier, alive: false, lifecycle: "after\n" }]);
    let stopped = false;
    const stop = h.loop.stop().then(() => { stopped = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false); expect(existsSync(world.cwd)).toBe(true);
    gate.release(); await tick; await stop;
    expect(existsSync(world.cwd)).toBe(false); expectStopped();
  });

  it("stop waits for startup cleanup but prevents later sweep entries from opening new deletes", async () => {
    h = await createWorkflowHarness(); gate = barrier();
    const first = { ...target, state: "Done" };
    const second = makeIssue("SECOND", "Done");
    const firstPath = (await h.manager.createWorkspace(first.identifier)).path;
    const secondPath = (await h.manager.createWorkspace(second.identifier)).path;
    h.tracker.activeIssues = [first, second]; let entered = false;
    h.cleanupGate.beforeRemove = async () => { entered = true; await gate.promise; };
    const startup = h.loop.start(); await waitFor(() => entered);
    let stopped = false;
    const stop = h.loop.stop().then(() => { stopped = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); expect(stopped).toBe(false);
    gate.release(); await startup; await stop;
    expect(existsSync(firstPath)).toBe(false); expect(existsSync(secondPath)).toBe(true);
    expect(h.starts).toHaveLength(0); expectStopped();
  });
});
