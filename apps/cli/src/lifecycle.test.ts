import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createStructuredLogger } from "@symphony/observability";
import type { Issue } from "@symphony/domain";
import { appServer } from "./process.test-helpers";
import type { TrackerAdapterProfile } from "@symphony/tracker";
import { createHost, runCli } from "./index";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function timers(once = false) {
  const active = new Set<() => void>();
  const history: (() => void)[] = [];
  return {
    active, history,
    schedule(first: number | (() => void), second: number | (() => void)) {
      const callback = typeof first === "function" ? first : second as () => void;
      const run = () => { if (once) active.delete(run); callback(); };
      active.add(run); history.push(run); return run;
    },
    cancel(handle: unknown) { active.delete(handle as () => void); },
  };
}
function shell() {
  const events = new EventEmitter();
  const output: string[] = [];
  return Object.assign(events, { stdout: { write: (text: string) => output.push(text) }, stderr: { write: (text: string) => output.push(text) }, output });
}
async function setup(options: { startup?: ReturnType<typeof barrier>; closeFailure?: boolean; monitorFailure?: boolean; issue?: Issue; command?: string } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sym-lifecycle-"));
  const workflowPath = path.join(dir, "WORKFLOW.md");
  const content = `---\ntracker:\n  kind: fixture\nworkspace:\n  root: ${dir}/work\npolling:\n  interval_ms: 100\ncodex:\n  command: ${JSON.stringify(options.command ?? "echo test")}\n---\nPrompt\n`;
  await writeFile(workflowPath, content);
  const entered = barrier();
  const calls: string[] = [];
  const profile: TrackerAdapterProfile = {
    kind: "fixture", documentation: "docs/testing.md#fixture-tracker", secretProviderKeys: [], secretEnvVars: [], defaultActiveStates: ["open"], defaultTerminalStates: ["closed"],
    createAdapter: () => ({ kind: "fixture", fetchIssuesByIds: async () => [], fetchIssuesByStates: async (states) => {
      calls.push(states.join(","));
      if (states.includes("closed")) { entered.resolve(); await options.startup?.promise; }
      return options.issue && states.includes("open") ? [options.issue] : [];
    } }),
  };
  const poll = timers(true);
  const retry = timers(true);
  const watcher = timers();
  const lines: string[] = [];
  let closes = 0;
  const baseLogger = createStructuredLogger({ sinks: [{ write: (line) => { lines.push(line); } }] });
  const logger = { ...baseLogger, close() { closes++; baseLogger.close(); } };
  const host = await createHost({ workflowPath, trackerProfiles: [profile], scheduler: poll, retryScheduler: retry, logger, watcherScheduler: {
    schedule(callback, delay) { if (options.monitorFailure) throw new Error("monitoring unavailable"); return watcher.schedule(callback, delay); },
    cancel(handle) { watcher.cancel(handle); if (options.closeFailure) throw new Error("close failed after releasing timer"); },
  } });
  return { dir, workflowPath, content, host, entered, calls, poll, retry, watcher, lines, get closes() { return closes; }, async clean() { options.startup?.resolve(); try { await host.stop(); } catch { /* fault suite */ } await rm(dir, { recursive: true, force: true }); } };
}

describe("host lifecycle resource contract (§17.7)", () => {
  it.each(["initial", "assembly"])("rolls back %s construction failure and preserves its original error", async (phase) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sym-construction-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    const original = new Error("assembly failed");
    let closes = 0;
    const watcher = timers();
    const baseLogger = createStructuredLogger({ sinks: [{ write() {} }] });
    try {
      if (phase === "assembly") await writeFile(workflowPath, `---\ntracker:\n  kind: github\n  provider:\n    repo: acme/widget\n    token: fixture-token\n---\nPrompt\n`);
      const result = createHost({ workflowPath, watcherScheduler: watcher,
        logger: { ...baseLogger, close() { closes++; baseLogger.close(); throw new Error("secondary close failure"); } },
        get now(): () => number { throw original; },
      });
      if (phase === "initial") await expect(result).rejects.toMatchObject({ code: "missing_workflow_file" });
      else await expect(result).rejects.toBe(original);
      expect(closes).toBe(1);
      expect(watcher.active.size).toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("constructs without monitoring, stops before start, and cannot resurrect", async () => {
    const test = await setup();
    try {
      expect(test.watcher.active.size).toBe(0);
      const stop = test.host.stop();
      expect(test.host.stop()).toBe(stop);
      await stop;
      await expect(test.host.start()).rejects.toThrow("stopped");
      expect(test.calls).toEqual([]);
      expect(test.poll.active.size + test.retry.active.size + test.watcher.active.size).toBe(0);
      expect(test.closes).toBe(1);
    } finally { await test.clean(); }
  });
  it("stops during startup before scheduling, waits for the external barrier, and deduplicates", async () => {
    const startup = barrier();
    const test = await setup({ startup });
    try {
      const start = test.host.start();
      expect(test.host.start()).toBe(start);
      await test.entered.promise;
      expect(test.watcher.active.size).toBe(1);
      let done = false;
      const stop = test.host.stop();
      void stop.then(() => { done = true; });
      expect(test.host.stop()).toBe(stop);
      await Promise.resolve();
      expect(done).toBe(false);
      expect(test.watcher.active.size).toBe(0);
      startup.resolve();
      await Promise.all([start, stop]);
      expect(test.poll.active.size + test.retry.active.size).toBe(0);
      expect(test.lines.join("\n")).not.toContain('event="startup" outcome="completed"');
      expect(test.closes).toBe(1);
    } finally { await test.clean(); }
  });
  it("reload/stop retains the final commit and ignores late watcher/poll callbacks", async () => {
    const test = await setup();
    try {
      await test.host.start();
      await writeFile(test.workflowPath, test.content.replace("interval_ms: 100", "interval_ms: 222"));
      test.watcher.history[0]!();
      expect(test.host.effective.serviceConfig.polling.intervalMs).toBe(222);
      await test.host.stop();
      const calls = [...test.calls];
      const effective = test.host.effective;
      await writeFile(test.workflowPath, test.content.replace("interval_ms: 100", "interval_ms: 333"));
      for (const callback of [...test.watcher.history, ...test.poll.history, ...test.retry.history]) callback();
      await test.host.loop.settled();
      expect(test.host.effective).toBe(effective);
      expect(test.calls).toEqual(calls);
      expect(test.host.state.running.size + test.host.state.retryAttempts.size).toBe(0);
      expect(test.poll.active.size + test.retry.active.size + test.watcher.active.size).toBe(0);
    } finally { await test.clean(); }
  });
  it("continues loop/logger cleanup after watcher close failure", async () => {
    const test = await setup({ closeFailure: true });
    try {
      await test.host.start();
      const stop = test.host.stop();
      expect(test.host.stop()).toBe(stop);
      await expect(stop).rejects.toThrow("Host shutdown failed");
      expect(test.poll.active.size + test.retry.active.size + test.watcher.active.size).toBe(0);
      expect(test.closes).toBe(1);
      expect(test.lines.join("\n")).toContain('event="shutdown" outcome="failed"');
    } finally { await test.clean(); }
  });
  it("cancels a real failed attempt retry and rejects late retry ownership", async () => {
    const issue: Issue = { id: "retry-1", identifier: "RETRY-1", nativeRef: null, title: "retry", description: null, state: "open", priority: null, branchName: null, url: null, assigneeId: null, labels: [], blockedBy: [], dispatchable: true, createdAt: null, updatedAt: null };
    const test = await setup({ issue, command: `${process.execPath} ${appServer} --turn-status failed` });
    try {
      await test.host.start();
      test.poll.history[0]!();
      await test.host.loop.settled();
      await vi.waitFor(() => expect(test.retry.active.size).toBe(1), { timeout: 10000 });
      expect(test.host.state.retryAttempts.has(issue.id)).toBe(true);
      expect(test.watcher.active.size).toBe(1);
      expect(test.poll.active.size).toBe(1);
      await test.host.stop();
      const requests = [...test.calls];
      for (const callback of test.retry.history) callback();
      await test.host.authority.waitForIdle();
      expect(test.calls).toEqual(requests);
      expect(test.poll.active.size + test.retry.active.size + test.watcher.active.size).toBe(0);
      expect(test.host.state.running.size + test.host.state.retryAttempts.size).toBe(0);
    } finally { await test.clean(); }
  });
  it("rolls back monitoring startup failure and closes all resources", async () => {
    const test = await setup({ monitorFailure: true });
    try {
      await expect(test.host.start()).rejects.toThrow("monitoring unavailable");
      await test.host.stop();
      expect(test.calls).toEqual([]);
      expect(test.poll.active.size + test.retry.active.size + test.watcher.active.size).toBe(0);
      expect(test.closes).toBe(1);
    } finally { await test.clean(); }
  });
});

describe("shell lifecycle (§17.7 exit matrix)", () => {
  it("installs signals before monitoring and retains handlers through duplicate shutdown", async () => {
    const startup = barrier();
    const test = await setup({ startup });
    const port = shell();
    const existing = () => {};
    port.on("SIGINT", existing);
    const run = runCli([test.workflowPath], { process: port, createHost: async () => {
      expect(test.watcher.active.size).toBe(0);
      return test.host;
    } });
    try {
      await test.entered.promise;
      expect(port.listenerCount("SIGINT")).toBe(2);
      port.emit("SIGINT"); port.emit("SIGTERM"); port.emit("SIGINT");
      expect(port.listenerCount("SIGTERM")).toBe(1);
      startup.resolve();
      expect(await run).toBe(0);
      expect(port.listeners("SIGINT")).toEqual([existing]);
      expect(port.listenerCount("SIGTERM")).toBe(0);
      expect(test.lines.filter((line) => line.includes('event="shutdown" outcome="started"'))).toHaveLength(1);
    } finally { await test.clean(); }
  });
  it.each(["startup", "shutdown", "fatal"])("preserves %s failure over concurrent graceful signals", async (phase) => {
    const port = shell();
    const entered = barrier();
    const release = barrier();
    let failFatal!: (error: unknown) => void;
    let stops = 0;
    const run = runCli([], { process: port, createHost: async () => ({
      failure: new Promise<unknown>((resolve) => { failFatal = resolve; }),
      async start() { entered.resolve(); if (phase === "startup") throw new Error("secret-token"); },
      async stop() { stops++; await release.promise; if (phase === "shutdown") throw new Error("secret-token"); },
    }) });
    await entered.promise;
    if (phase === "fatal") failFatal(new Error("secret-token"));
    port.emit("SIGINT"); port.emit("SIGTERM");
    release.resolve();
    expect(await run).toBe(1);
    expect(stops).toBe(1);
    expect(port.output.join("\n")).not.toContain("secret-token");
    for (const event of ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"]) expect(port.listenerCount(event)).toBe(0);
  });
  it.each(["uncaughtException", "unhandledRejection"])("uses %s as a fatal shell fallback", async (event) => {
    const port = shell();
    const ready = barrier();
    const run = runCli([], { process: port, createHost: async () => ({ failure: new Promise<unknown>(() => {}), async start() { ready.resolve(); }, async stop() {} }) });
    await ready.promise;
    port.emit(event, new Error("secret"));
    expect(await run).toBe(1);
    expect(port.listenerCount(event)).toBe(0);
  });
});
