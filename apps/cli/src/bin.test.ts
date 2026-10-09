import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { appServer, binPath, cliRoot, httpsTracker, startProcess, workflow } from "./process.test-helpers";

// Cleanup must reach every resource even when the process result rejected.
async function closeFixture(proc: ReturnType<typeof startProcess>, tracker: Awaited<ReturnType<typeof httpsTracker>>, dir: string) {
  try { await proc.close(); }
  finally {
    try { await tracker.close(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
}

const pkg = JSON.parse(readFileSync(path.join(cliRoot, "package.json"), "utf8")) as { version: string; bin: { symphony: string } };
const link = path.resolve(cliRoot, "../../node_modules/.bin/symphony");
let harnessDir: string;
let harness: string;
beforeAll(async () => {
  execFileSync("npm", ["run", "build"], { cwd: cliRoot, stdio: "pipe" });
  harnessDir = await mkdtemp(path.join(os.tmpdir(), "sym-shell-harness-"));
  harness = path.join(harnessDir, "harness.mjs");
  await build({ configFile: false, logLevel: "silent", ssr: { noExternal: true }, build: {
    ssr: fileURLToPath(new URL("../test-fixtures/lifecycle-harness.ts", import.meta.url)),
    outDir: harnessDir, target: "node20", rollupOptions: { output: { entryFileNames: "harness.mjs" } },
  } });
}, 30000);
afterAll(async () => { if (harnessDir) await rm(harnessDir, { recursive: true, force: true }); });

describe("CLI binary child process execution (§17.7 / §18.1)", () => {
  it("verifies executable shebang and canonical package bin link", () => {
    expect(pkg.bin.symphony).toBe("./dist/bin/symphony.js");
    expect(readFileSync(binPath, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
    expect(existsSync(link)).toBe(true);
    expect(execFileSync(link, ["--version"], { encoding: "utf8" }).trim()).toBe(pkg.version);
  });
  it.each(["--help", "--version"])("prints %s and exits naturally with zero", async (arg) => {
    const proc = startProcess([arg]);
    const result = await proc.result;
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain(arg === "--help" ? "Usage: symphony" : pkg.version);
  });
  it("prints decision bridge help through real child process", async () => {
    const proc = startProcess(["decision", "bridge", "--help"]);
    const result = await proc.result;
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("Usage: symphony decision bridge --store <dir>");
  });
  it.each([
    ["absolute", "SIGINT"], ["relative", "SIGTERM"], ["default", "SIGINT"],
  ] as const)("loads %s path and gracefully stops on %s", async (mode, signal) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sym-bin-"));
    const tracker = await httpsTracker();
    const filename = mode === "default" ? "WORKFLOW.md" : "custom.md";
    await writeFile(path.join(dir, filename), workflow(path.join(dir, "work"), tracker.url));
    const proc = startProcess(mode === "default" ? [] : [mode === "absolute" ? path.join(dir, filename) : filename], dir);
    try {
      await proc.waitForOutput('event="startup" outcome="completed"');
      await tracker.waitForRequest((url) => url.searchParams.get("state") === "open");
      proc.child.kill(signal);
      const result = await proc.result;
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stderr).toContain('event="shutdown" outcome="completed"');
      expect(result.stderr).not.toContain("fixture-secret");
    } finally { await closeFixture(proc, tracker, dir); }
  });
  it.each(["explicit", "default"])("fails cleanly with missing %s workflow", async (mode) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sym-missing-"));
    try {
      const result = await startProcess(mode === "explicit" ? [path.join(dir, "missing.md")] : [], dir).result;
      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.stderr).toContain("missing_workflow_file");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it.each([
    ["syntax", "---\n[invalid-yaml\n---\nPrompt", "config_validation"],
    ["tracker", "---\ntracker:\n  kind: unknown\n---\nPrompt", "unsupported_tracker_kind"],
    ["secret", "---\ntracker:\n  kind: github\n  provider:\n    repo: acme/widget\n    token: $MISSING_CLI_FIXTURE_SECRET\n---\nPrompt", "missing_tracker_secret"],
    ["command", "---\ntracker:\n  kind: github\n  provider:\n    repo: acme/widget\n    token: fixture-secret\ncodex:\n  command: ' '\n---\nPrompt", "invalid_config"],
    ["HTTPS", "---\ntracker:\n  kind: github\n  provider:\n    repo: acme/widget\n    token: fixture-secret\n    api_url: http://127.0.0.1\n---\nPrompt", "invalid_tracker_config"],
  ])("rejects %s startup preflight with nonzero safe diagnostics", async (_name, content, diagnostic) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sym-invalid-"));
    try {
      await writeFile(path.join(dir, "WORKFLOW.md"), content!);
      const result = await startProcess([], dir).result;
      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.stderr).toContain(diagnostic);
      expect(result.stderr).not.toContain("fixture-secret");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

const checkStopped = fileURLToPath(new URL("../test-fixtures/check-stopped.mjs", import.meta.url));
const command = (flags = "") => `${process.execPath} ${appServer} --record-world world.json --record-transcript transcript.jsonl --record-prompt prompt.txt --silent-turn ${flags}`;
const hook = (release?: string) => `${process.execPath} ${checkStopped}${release ? ` ${release}` : ""}`;
function readJson<T>(filename: string): T { return JSON.parse(readFileSync(filename, "utf8")) as T; }
async function waitFile(filename: string) { await vi.waitFor(() => expect(existsSync(filename)).toBe(true), { timeout: 10000, interval: 10 }); }
function assertStopped(workspace: string) {
  const world = readJson<{ pid: number; cwd: string }>(path.join(workspace, "world.json"));
  const marker = readJson<{ pid: number; dead: boolean; cwd: string }>(path.join(workspace, "after-run.json"));
  expect(marker).toEqual({ pid: world.pid, cwd: world.cwd, dead: true });
  expect(() => process.kill(world.pid, 0)).toThrow();
}

describe("real executable resource/race evidence (§17.6 / §17.7)", () => {
  it("cleans HTTPS listener and temp directory after a real child timeout without hiding rejection", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sym-process-timeout-"));
    const tracker = await httpsTracker();
    // Only advance the parent's watchdog; child I/O and termination remain real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const proc = startProcess(["-e", 'process.stdout.write("timeout-ready\\n"); setInterval(() => {}, 1000);'], dir, process.execPath);
    let cleaned = false;
    try {
      await proc.waitForOutput("timeout-ready");
      vi.advanceTimersByTime(15000);
      await expect(proc.result).rejects.toThrow("Process timeout:");
      await expect(closeFixture(proc, tracker, dir)).rejects.toThrow("Process timeout:");
      cleaned = true;
      vi.useRealTimers();
      expect(proc.child.signalCode).toBe("SIGKILL");
      expect(() => process.kill(proc.child.pid!, 0)).toThrow();
      expect(existsSync(dir)).toBe(false);
      const address = new URL(tracker.url);
      const connectionError = await new Promise<Error>((resolve, reject) => {
        const socket = createConnection({ host: address.hostname, port: Number(address.port) });
        socket.once("error", (error) => { socket.destroy(); resolve(error); });
        socket.once("connect", () => { socket.destroy(); reject(new Error("Fixture HTTPS listener still accepts connections")); });
      });
      expect(connectionError).toMatchObject({ code: "ECONNREFUSED" });
    } finally {
      vi.useRealTimers();
      if (!cleaned) {
        try { await closeFixture(proc, tracker, dir); } catch { /* Expected timeout; cleanup still ran. */ }
      }
    }
  });

  it.each(["SIGINT", "SIGTERM"] as const)("waits for agent termination and after_run on %s, deduplicating mixed signals", async (signal) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sym-process-agent-"));
    const tracker = await httpsTracker(); tracker.enableIssue();
    const root = path.join(dir, "work");
    const workspace = path.join(root, "GH-1");
    const release = path.join(dir, "release-hook");
    await writeFile(path.join(dir, "WORKFLOW.md"), workflow(root, tracker.url, { command: command(signal === "SIGTERM" ? "--ignore-sigterm" : ""), afterRun: hook(release) }));
    const proc = startProcess([], dir);
    try {
      await proc.waitForOutput('event="session_started"');
      await waitFile(path.join(workspace, "world.json"));
      proc.child.kill(signal);
      await waitFile(path.join(workspace, "after-run-entered"));
      // Parent verifies the child died while host cleanup is still blocked.
      expect(proc.child.exitCode).toBeNull();
      expect(existsSync(path.join(workspace, "after-run.json"))).toBe(false);
      const world = readJson<{ pid: number }>(path.join(workspace, "world.json"));
      expect(() => process.kill(world.pid, 0)).toThrow();
      // The hook remains blocked, so this signal is delivered during cleanup.
      expect(proc.child.kill(signal === "SIGINT" ? "SIGTERM" : "SIGINT")).toBe(true);
      await proc.waitForOutput('event="shutdown" outcome="started"');
      await writeFile(release, "release");
      const result = await proc.result;
      expect(result.code).toBe(0); expect(result.signal).toBeNull();
      assertStopped(workspace);
      expect(result.stderr.match(/event="shutdown" outcome="started"/g)).toHaveLength(1);
      expect(result.stderr.match(/event="shutdown" outcome="completed"/g)).toHaveLength(1);
      expect(result.stderr).toContain('issue_id="1" issue_identifier="GH-1" session_id=');
      expect(result.stderr).not.toContain("fixture-secret");
      const transcript = readFileSync(path.join(workspace, "transcript.jsonl"), "utf8");
      expect(transcript).toContain('"method":"turn/start"');
    } finally {
      try { await writeFile(release, "release"); }
      finally { await closeFixture(proc, tracker, dir); }
    }
  }, 20000);

  it("interrupts startup at a real HTTPS request barrier without scheduling work", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sym-process-startup-"));
    const tracker = await httpsTracker(); tracker.holdStartup(); tracker.enableIssue();
    const root = path.join(dir, "work");
    await writeFile(path.join(dir, "WORKFLOW.md"), workflow(root, tracker.url, { command: command(), afterRun: hook() }));
    const proc = startProcess([], dir);
    try {
      await tracker.waitForRequest((url) => url.searchParams.get("state") === "closed");
      proc.child.kill("SIGTERM");
      await proc.waitForOutput('event="shutdown" outcome="started"');
      proc.child.kill("SIGINT"); tracker.releaseStartup();
      const result = await proc.result;
      expect(result.code).toBe(0); expect(result.signal).toBeNull();
      expect(result.stderr).not.toContain('event="startup" outcome="completed"');
      expect(tracker.requests.some((url) => url.searchParams.get("state") === "open")).toBe(false);
      expect(existsSync(path.join(root, "GH-1", "world.json"))).toBe(false);
    } finally {
      try { tracker.releaseStartup(); }
      finally { await closeFixture(proc, tracker, dir); }
    }
  });

  it("keeps live invalid reload recoverable, applies valid reload to a new real agent, and stops both roots", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sym-process-reload-"));
    const tracker = await httpsTracker(); tracker.enableIssue();
    const rootA = path.join(dir, "root-a"); const rootB = path.join(dir, "root-b");
    const file = path.join(dir, "WORKFLOW.md");
    await writeFile(file, workflow(rootA, tracker.url, { command: command(), afterRun: hook() }));
    const proc = startProcess([], dir);
    try {
      await proc.waitForOutput('event="session_started"');
      const worldA = readJson<{ pid: number; cwd: string }>(path.join(rootA, "GH-1", "world.json"));
      await writeFile(file, "---\n[invalid-yaml\n---\nRejected secret prompt");
      await proc.waitForOutput('event="workflow_reload" outcome="failed"');
      const previous = tracker.requests.length;
      await tracker.waitForRequest(() => true, previous);
      expect(proc.child.exitCode).toBeNull();
      expect(() => process.kill(worldA.pid, 0)).not.toThrow();
      await writeFile(file, workflow(rootB, tracker.url, { command: command(), prompt: "Reloaded {{ issue.identifier }}", afterRun: hook() }));
      tracker.enableIssue(2);
      await waitFile(path.join(rootB, "GH-2", "prompt.txt"));
      expect(readFileSync(path.join(rootB, "GH-2", "prompt.txt"), "utf8")).toContain("Reloaded GH-2");
      expect(() => process.kill(worldA.pid, 0)).not.toThrow();
      proc.child.kill("SIGTERM");
      const result = await proc.result;
      expect(result.code).toBe(0); expect(result.signal).toBeNull();
      assertStopped(path.join(rootA, "GH-1")); assertStopped(path.join(rootB, "GH-2"));
      expect(result.stderr).toContain('event="workflow_reload" outcome="completed"');
      expect(result.stderr).not.toContain("Rejected secret prompt");
    } finally { await closeFixture(proc, tracker, dir); }
  });

  it("classifies SIGKILL only as abnormal termination", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sym-process-kill-"));
    const tracker = await httpsTracker();
    await writeFile(path.join(dir, "WORKFLOW.md"), workflow(path.join(dir, "work"), tracker.url));
    const proc = startProcess([], dir);
    try {
      await proc.waitForOutput('event="startup" outcome="completed"');
      proc.child.kill("SIGKILL");
      const result = await proc.result;
      expect(result.code).toBeNull(); expect(result.signal).toBe("SIGKILL");
      expect(result.stderr).not.toContain('event="shutdown" outcome="completed"');
    } finally { await closeFixture(proc, tracker, dir); }
  });
});

describe("supplemental production runner shell fault harness", () => {
  it.each(["startup", "shutdown", "fatal", "uncaught", "rejection"])("naturally exits nonzero after %s failure", async (phase) => {
    const proc = startProcess([harness, phase], undefined, process.execPath);
    try {
      await proc.waitForOutput("harness-ready");
      if (phase === "shutdown") proc.child.kill("SIGTERM");
      const result = await proc.result;
      expect(result.code).toBe(1); expect(result.signal).toBeNull();
      expect(result.stderr).toContain("failed");
    } finally { await proc.close(); }
  });
});
