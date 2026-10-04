import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { DeliveryGitGhRunner, DeliverySubprocessResult } from "@symphony/agent";

import { parseDeliverySkillArgs, runDeliverySkillCli } from "./delivery-skill-cli";

class MockCliRunner implements DeliveryGitGhRunner {
  readonly gitCalls: Array<{ args: readonly string[]; cwd: string }> = [];
  readonly ghCalls: Array<{ args: readonly string[]; cwd: string }> = [];
  readonly execCalls: Array<{ command: string; cwd: string }> = [];

  gitResponses: DeliverySubprocessResult[] = [];
  ghResponses: DeliverySubprocessResult[] = [];
  execResponses: DeliverySubprocessResult[] = [];

  async git(args: readonly string[], cwd: string): Promise<DeliverySubprocessResult> {
    this.gitCalls.push({ args, cwd });
    return this.gitResponses.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
  }

  async gh(args: readonly string[], cwd: string): Promise<DeliverySubprocessResult> {
    this.ghCalls.push({ args, cwd });
    return this.ghResponses.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
  }

  async exec(command: string, cwd: string): Promise<DeliverySubprocessResult> {
    this.execCalls.push({ command, cwd });
    return this.execResponses.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
  }
}

describe("delivery-skill CLI", () => {
  const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "delivery-cli-test-"));

  it("parses CLI flags accurately", () => {
    const parsed = parseDeliverySkillArgs([
      "run",
      "--repo",
      "owner/repo",
      "--issue",
      "80",
      "--workspace-key",
      "GH-80",
      "--head",
      "symphony/GH-80",
      "--base",
      "main",
      "--repair-cmd",
      "npm run fix",
      "--max-repairs",
      "5",
      "--max-wait",
      "120",
      "--ready-label",
      "custom-ready",
      "--opt-in",
      "--resume",
      "--required-checks",
      "gate,lint",
    ]);

    expect(parsed.action).toBe("run");
    expect(parsed.repo).toBe("owner/repo");
    expect(parsed.issueNumber).toBe(80);
    expect(parsed.workspaceKey).toBe("GH-80");
    expect(parsed.headBranch).toBe("symphony/GH-80");
    expect(parsed.baseBranch).toBe("main");
    expect(parsed.repairCommand).toBe("npm run fix");
    expect(parsed.maxRepairs).toBe(5);
    expect(parsed.maxWait).toBe(120);
    expect(parsed.readyLabel).toBe("custom-ready");
    expect(parsed.optInLand).toBe(true);
    expect(parsed.resume).toBe(true);
    expect(parsed.requiredChecks).toEqual(["gate", "lint"]);
  });

  it("rejects non-integer or negative numeric values", () => {
    expect(() => parseDeliverySkillArgs(["run", "--repo", "o/r", "--issue", "not-a-number"])).toThrow(
      "must be a non-negative integer",
    );
    expect(() => parseDeliverySkillArgs(["run", "--repo", "o/r", "--issue", "80", "--max-wait", "-5"])).toThrow(
      "must be a non-negative integer",
    );
  });

  it("fails fast with non-zero exit code when required flags are missing", async () => {
    const tempDir = createTempDir();
    let stderr = "";
    const io = {
      stdout: { write: () => {} },
      stderr: { write: (t: string) => { stderr += t; } },
    };

    const code = await runDeliverySkillCli(["run", "--repo", "owner/repo", "--cwd", tempDir], io);
    expect(code).toBe(1);
    expect(stderr).toContain("missing required");
  });

  it("executes halt action: removes symphony-ready label and posts handoff comment", async () => {
    const tempDir = createTempDir();
    const runner = new MockCliRunner();
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // edit label
    runner.ghResponses.push({ stdout: JSON.stringify({ labels: [] }), stderr: "", exitCode: 0 }); // check label
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // comment

    let stdout = "";
    const io = {
      stdout: { write: (t: string) => { stdout += t; } },
      stderr: { write: () => {} },
    };

    const code = await runDeliverySkillCli(
      [
        "halt",
        "--repo",
        "felixjichao/symphony-ts",
        "--issue",
        "80",
        "--reason",
        "budget_exhausted",
        "--details",
        "Max repair budget reached on test suite",
        "--cwd",
        tempDir,
      ],
      io,
      runner,
    );

    expect(code).toBe(0);
    expect(stdout).toContain("Symphony Delivery Handoff Report");
    expect(stdout).toContain("移除 `symphony-ready` 标签");

    // 检查调用了 gh issue edit --remove-label symphony-ready
    const editCall = runner.ghCalls.find((c) => c.args[0] === "issue" && c.args[1] === "edit");
    expect(editCall).toBeDefined();
    expect(editCall?.args).toContain("--remove-label");
    expect(editCall?.args).toContain("symphony-ready");
  });

  it("halt action returns non-zero exit code when label removal fails", async () => {
    const tempDir = createTempDir();
    const runner = new MockCliRunner();
    runner.ghResponses.push({ stdout: "", stderr: "Permission denied", exitCode: 1 }); // edit label fails
    runner.ghResponses.push({ stdout: JSON.stringify({ labels: [{ name: "symphony-ready" }] }), stderr: "", exitCode: 0 }); // label still present
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // comment

    let stderr = "";
    let stdout = "";
    const io = {
      stdout: { write: (t: string) => { stdout += t; } },
      stderr: { write: (t: string) => { stderr += t; } },
    };

    const code = await runDeliverySkillCli(
      [
        "halt",
        "--repo",
        "felixjichao/symphony-ts",
        "--issue",
        "80",
        "--cwd",
        tempDir,
      ],
      io,
      runner,
    );

    expect(code).toBe(1);
    expect(stderr).toContain("halt failed: could not remove label");
    expect(stdout).toContain("移除 `symphony-ready` 标签失败");
  });

  it("executes run action successfully when checks are green and --opt-in is passed", async () => {
    const tempDir = createTempDir();
    const runner = new MockCliRunner();
    runner.gitResponses.push({ stdout: "symphony/GH-80\n", stderr: "", exitCode: 0 }); // branch
    runner.gitResponses.push({ stdout: "https://github.com/felixjichao/symphony-ts.git\n", stderr: "", exitCode: 0 }); // origin
    runner.ghResponses.push({ stdout: JSON.stringify({ state: "OPEN" }), stderr: "", exitCode: 0 }); // issue view

    // gh pr list returns existing PR
    runner.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 80,
          url: "https://github.com/felixjichao/symphony-ts/pull/80",
          title: "feat: delivery",
          state: "OPEN",
          headRefOid: "sha123",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });

    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // push
    runner.gitResponses.push({ stdout: "sha123\n", stderr: "", exitCode: 0 }); // rev-parse

    // gh pr view checks green
    runner.ghResponses.push({
      stdout: JSON.stringify({
        headRefOid: "sha123",
        mergeable: "MERGEABLE",
        state: "OPEN",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" },
        ],
      }),
      stderr: "",
      exitCode: 0,
    });
    // gh pr view mergeable
    runner.ghResponses.push({ stdout: JSON.stringify({ mergeable: "MERGEABLE", state: "OPEN" }), stderr: "", exitCode: 0 });
    // gh pr merge
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    // gh pr view verify
    runner.ghResponses.push({
      stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "mergedsha123" } }),
      stderr: "",
      exitCode: 0,
    });
    // gh issue view
    runner.ghResponses.push({ stdout: JSON.stringify({ state: "CLOSED" }), stderr: "", exitCode: 0 });

    let stdout = "";
    const io = {
      stdout: { write: (t: string) => { stdout += t; } },
      stderr: { write: () => {} },
    };

    const code = await runDeliverySkillCli(
      [
        "run",
        "--repo",
        "felixjichao/symphony-ts",
        "--issue",
        "80",
        "--opt-in",
        "--cwd",
        tempDir,
      ],
      io,
      runner,
    );

    expect(code).toBe(0);
    expect(stdout).toContain("successfully completed and landed PR #80");
  });
});
