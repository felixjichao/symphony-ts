import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(cliRoot, "package.json"), "utf8")) as { version: string; bin: { symphony: string } };
const binPath = path.resolve(cliRoot, pkg.bin.symphony);
const repoRoot = path.resolve(cliRoot, "../..");
const nodeModulesBin = path.join(repoRoot, "node_modules", ".bin", "symphony");

beforeAll(() => {
  if (!existsSync(binPath) || !existsSync(nodeModulesBin)) {
    execSync("npm run build", { cwd: cliRoot, stdio: "inherit" });
  }
  expect(existsSync(binPath)).toBe(true);
  expect(existsSync(nodeModulesBin)).toBe(true);
});

function runToExit(args: string[], options: { cwd?: string } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(binPath, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function runUntilStartupAndStop(args: string[], options: { cwd?: string; signal?: "SIGINT" | "SIGTERM" } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stopped = false;

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (!stopped && stderr.includes('event="startup"') && stderr.includes('outcome="completed"')) {
        stopped = true;
        child.kill(options.signal ?? "SIGINT");
      }
    });

    const timeout = setTimeout(() => {
      if (!stopped) {
        child.kill("SIGKILL");
        reject(new Error(`Timed out waiting for startup. Stderr: ${stderr}`));
      }
    }, 10000);

    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

function createSampleWorkflow(root: string, overrides: string = ""): string {
  return `---\ntracker:\n  kind: github\n  provider:\n    repo: acme/widget\n    token: test-token\nworkspace:\n  root: ${root}\npolling:\n  interval_ms: 100000\ncodex:\n  command: "echo test"\n${overrides}---\nHandle {{ issue.identifier }}\n`;
}

describe("CLI binary child process execution (§17.7 / §18.1)", () => {
  it("verifies package.json bin contract points to an executable with shebang", () => {
    expect(pkg.bin.symphony).toBe("./dist/bin/symphony.js");
    const content = readFileSync(binPath, "utf8");
    expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("prints help and exits with 0 on --help", async () => {
    const { code, stdout } = await runToExit(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: symphony");
    expect(stdout).toContain("--help");
  });

  it("prints version and exits with 0 on --version", async () => {
    const { code, stdout } = await runToExit(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  it("executes through canonical node_modules/.bin/symphony link", () => {
    expect(existsSync(nodeModulesBin)).toBe(true);
    const output = execSync(`${nodeModulesBin} --version`, { encoding: "utf8" });
    expect(output.trim()).toBe(pkg.version);
  });

  it("launches and stops gracefully with explicit workflow path", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "sym-bin-explicit-"));
    const workflowPath = path.join(temp, "custom-WORKFLOW.md");

    try {
      await writeFile(workflowPath, createSampleWorkflow(temp));
      const { code, stderr } = await runUntilStartupAndStop([workflowPath]);
      expect(code).toBe(0);
      expect(stderr).toContain('event="startup" outcome="started"');
      expect(stderr).toContain('event="startup" outcome="completed"');
      expect(stderr).toContain('event="shutdown" outcome="completed"');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("discovers default ./WORKFLOW.md in cwd and stops gracefully", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "sym-bin-cwd-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");

    try {
      await writeFile(workflowPath, createSampleWorkflow(temp));
      const { code, stderr } = await runUntilStartupAndStop([], { cwd: temp });
      expect(code).toBe(0);
      expect(stderr).toContain('event="startup" outcome="completed"');
      expect(stderr).toContain('event="shutdown" outcome="completed"');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("fails with exit code 1 when explicit workflow file is missing", async () => {
    const nonExistent = path.join(os.tmpdir(), "does-not-exist-WORKFLOW.md");
    const { code, stderr } = await runToExit([nonExistent]);
    expect(code).toBe(1);
    expect(stderr).toContain("missing_workflow_file");
  });

  it("fails with exit code 1 when default WORKFLOW.md is missing in cwd", async () => {
    const emptyTemp = await mkdtemp(path.join(os.tmpdir(), "sym-bin-empty-"));
    try {
      const { code, stderr } = await runToExit([], { cwd: emptyTemp });
      expect(code).toBe(1);
      expect(stderr).toContain("missing_workflow_file");
    } finally {
      await rm(emptyTemp, { recursive: true, force: true });
    }
  });

  it("fails with exit code 1 on unsupported tracker kind", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "sym-bin-badtracker-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");

    try {
      await writeFile(workflowPath, `---\ntracker:\n  kind: unknown_tracker\nworkspace:\n  root: ${temp}\ncodex:\n  command: "echo test"\n---\nPrompt\n`);
      const { code, stderr } = await runToExit([workflowPath]);
      expect(code).toBe(1);
      expect(stderr).toContain("unsupported_tracker_kind");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("fails with exit code 1 on invalid workflow config syntax", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "sym-bin-badconfig-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");

    try {
      await writeFile(workflowPath, `---\n[invalid-yaml-structure\n---\nPrompt\n`);
      const { code, stderr } = await runToExit([workflowPath]);
      expect(code).toBe(1);
      expect(stderr).toContain("config_validation");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("stops gracefully on SIGTERM signal", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "sym-bin-sigterm-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");

    try {
      await writeFile(workflowPath, createSampleWorkflow(temp));
      const { code, stderr } = await runUntilStartupAndStop([workflowPath], { signal: "SIGTERM" });
      expect(code).toBe(0);
      expect(stderr).toContain('event="shutdown" outcome="completed"');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
