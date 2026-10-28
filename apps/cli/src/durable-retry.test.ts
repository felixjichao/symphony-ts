import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeRetryHarness, retryIssue } from "../test-fixtures/durable-retry-harness";

let bundleDir: string;
let bundle: string;
const dirs: string[] = [];
beforeAll(async () => {
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "retry-bundle-"));
  bundle = path.join(bundleDir, "fixture.mjs");
  await build({ configFile: false, logLevel: "silent", ssr: { noExternal: true }, build: {
    ssr: fileURLToPath(new URL("../test-fixtures/durable-retry-harness.ts", import.meta.url)), outDir: bundleDir,
    target: "node20", rollupOptions: { output: { entryFileNames: "fixture.mjs" } },
  } });
}, 30000);
afterAll(() => fs.rmSync(bundleDir, { recursive: true, force: true }));
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-retry-")); dirs.push(dir); return path.join(dir, "retries.json"); }
function crash(file: string, launch = false) {
  const child = spawnSync(process.execPath, [bundle], { timeout: 10000, encoding: "utf8",
    env: { ...process.env, RETRY_FIXTURE_FILE: file, RETRY_FIXTURE_LAUNCH: launch ? "1" : "0" } });
  expect(child.signal, child.stderr).toBe("SIGKILL");
}
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
describe("native retry restart protocol", () => {
  it("restores UTC due time and attempt after SIGKILL despite a new monotonic clock", async () => {
    const file = fixture(); crash(file);
    const h = makeRetryHarness(file, 30000, 2);
    h.authority.restoreRetries();
    expect(h.timers[0]?.delay).toBe(60000); // 10k + failure attempt 4 (80k) - 30k
    expect(h.state.retryAttempts.get("1")).toMatchObject({ attempt: 4, dueAtMs: 60002 });
    h.authority.restoreRetries();
    expect(h.timers).toHaveLength(1);
    await h.authority.shutdown();
    expect(h.store.load()[0]).toMatchObject({ phase: "scheduled", attempt: 4 });
  });
  it("blocks a killed launch intent rather than starting a possible orphan twice", async () => {
    const file = fixture(); crash(file, true);
    const h = makeRetryHarness(file);
    h.authority.restoreRetries();
    expect(h.authority.continuityBlock("1")).toContain("worker_launch_unverified");
    expect(h.authority.dispatchIssue(retryIssue).kind).not.toBe("dispatched");
    expect(h.launches).toBe(0);
    expect(h.timers).toHaveLength(0);
    expect(h.store.load()[0]?.phase).toBe("blocked");
    await h.authority.shutdown();
  });
  it("records launch intent before invoking the executor and settles clean shutdown to a reservation", async () => {
    const file = fixture();
    const h = makeRetryHarness(file, 10000, 50, () => {
      expect(h.store.load()[0]?.phase).toBe("launch_pending");
    });
    expect(h.authority.dispatchIssue(retryIssue).kind).toBe("dispatched");
    await h.authority.shutdown();
    expect(h.store.load()[0]?.phase).toBe("scheduled");
  });
  it.each(["missing", "inactive", "stage_changed"])("refreshes an overdue reservation before dispatch: %s", async reason => {
    const file = fixture(); crash(file);
    const h = makeRetryHarness(file, 1000000);
    h.authority.restoreRetries();
    if (reason === "missing") h.setVisible([]);
    if (reason === "inactive") h.setVisible([{ ...retryIssue, state: "paused" }]);
    if (reason === "stage_changed") h.setAdmission(null);
    h.timers[0]!.callback(); await flush();
    expect(h.launches).toBe(0);
    expect(h.store.load()).toEqual([]);
    await h.authority.shutdown();
  });
  it("preserves bounded retry after unavailable facts and fences callbacks from an old incarnation", async () => {
    const file = fixture(); crash(file);
    const old = makeRetryHarness(file, 1000000);
    old.authority.restoreRetries();
    const current = makeRetryHarness(file, 1000000);
    current.authority.restoreRetries();
    old.timers[0]!.callback(); await flush();
    expect(old.launches).toBe(0);
    current.setUnavailable();
    current.timers[0]!.callback(); await flush();
    expect(current.launches).toBe(0);
    expect(current.store.load()[0]).toMatchObject({ phase: "scheduled", attempt: 5 });
    await old.authority.shutdown(); await current.authority.shutdown();
  });
  it("fences a live old executor's completion after another incarnation blocks its launch", async () => {
    const file = fixture();
    const old = makeRetryHarness(file);
    expect(old.authority.dispatchIssue(retryIssue).kind).toBe("dispatched");
    const oldToken = old.store.load()[0]?.token;
    const current = makeRetryHarness(file);
    current.authority.restoreRetries();
    const currentToken = current.store.load()[0]?.token;
    expect(currentToken).not.toBe(oldToken);
    await old.authority.shutdown();
    expect(current.store.load()[0]).toMatchObject({ phase: "blocked", token: currentToken });
    expect(current.launches).toBe(0);
    await current.authority.shutdown();
  });
  it.each(["scheduled", "launch_pending"])("does not clean a terminal workspace with a durable %s record before restoration", async phase => {
    const file = fixture(); crash(file, phase === "launch_pending");
    const h = makeRetryHarness(file);
    h.setVisible([{ ...retryIssue, state: "closed" }]);
    const cleanup = await h.authority.runStartupTerminalCleanup();
    expect(cleanup.refused).toEqual(["GH-1"]);
    expect(h.cleanupCalls).toBe(0);
    expect(h.store.load()[0]?.phase).toBe(phase);
    h.authority.restoreRetries();
    expect(h.launches).toBe(0);
    await h.authority.shutdown();
  });
  it("refuses terminal cleanup when another incarnation owns the durable reservation", async () => {
    const file = fixture();
    const old = makeRetryHarness(file);
    old.authority.scheduleRetry({ issueId: "1", identifier: "GH-1", attempt: 1, kind: "continuation", error: null });
    const current = makeRetryHarness(file);
    current.authority.restoreRetries();
    const currentRecord = current.store.load()[0];
    old.setVisible([{ ...retryIssue, state: "closed" }]);
    old.timers[0]!.callback(); await flush();
    expect(old.cleanupCalls).toBe(0);
    expect(old.authority.continuityBlock("1")).toContain("retry_recovery_unverified");
    expect(current.store.load()[0]).toEqual(currentRecord);
    await old.authority.shutdown(); await current.authority.shutdown();
  });
  it("settles its durable terminal reservation before cleanup while retaining the claim", async () => {
    const file = fixture();
    const workspace = path.join(path.dirname(file), "workspace");
    fs.mkdirSync(workspace);
    const sentinel = path.join(path.dirname(file), "sentinel");
    fs.writeFileSync(sentinel, "keep");
    let finishCleanup!: () => void;
    const pending = new Promise<void>(resolve => { finishCleanup = resolve; });
    const h = makeRetryHarness(file, 10000, 500, undefined, async () => {
      expect(h.store.load()).toEqual([]);
      expect(h.state.claimed.has("1")).toBe(true);
      await pending;
      fs.rmSync(workspace, { recursive: true });
    });
    h.authority.scheduleRetry({ issueId: "1", identifier: "GH-1", attempt: 1, kind: "continuation", error: null });
    h.setVisible([{ ...retryIssue, state: "closed" }]);
    h.timers[0]!.callback(); await flush();
    expect(h.cleanupCalls).toBe(1);
    expect(h.state.claimed.has("1")).toBe(true);
    expect(fs.existsSync(workspace)).toBe(true);
    finishCleanup(); await flush();
    expect(fs.existsSync(workspace)).toBe(false);
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(h.state.claimed.has("1")).toBe(false);
    expect(h.store.load()).toEqual([]);
    await h.authority.shutdown();
  });
  it("does not register a timer after persistence fails, and rejects stale cancellation", async () => {
    const file = fixture();
    const h = makeRetryHarness(file);
    fs.mkdirSync(`${file}.lock`);
    expect(() => h.authority.scheduleRetry({ issueId: "1", identifier: "GH-1", attempt: 1,
      kind: "failure", error: "failure" })).toThrow();
    expect(h.timers).toHaveLength(0);
    fs.rmdirSync(`${file}.lock`);
    h.authority.scheduleRetry({ issueId: "1", identifier: "GH-1", attempt: 1, kind: "failure", error: "failure" });
    const replacement = makeRetryHarness(file);
    replacement.authority.restoreRetries();
    expect(() => h.authority.cancelScheduledRetry("1")).toThrow("Stale");
    expect(replacement.store.load()).toHaveLength(1);
    await h.authority.shutdown(); await replacement.authority.shutdown();
  });
});
