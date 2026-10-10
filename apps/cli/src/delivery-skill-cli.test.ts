import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runDeliverySkill, type DeliveryGitGhRunner, type DeliverySubprocessResult } from "@symphony/agent";
import {
  formatPrBody,
  type DecisionReviewTarget,
  type DeliveryReviewGate,
} from "@symphony/domain";

import { FileDeliveryStateStorage, parseDeliverySkillArgs, runDeliverySkillCli } from "./delivery-skill-cli";

class MockCliRunner implements DeliveryGitGhRunner {
  readonly gitCalls: Array<{ args: readonly string[]; cwd: string }> = [];
  readonly ghCalls: Array<{ args: readonly string[]; cwd: string }> = [];
  readonly execCalls: Array<{ command: string; cwd: string }> = [];

  gitResponses: DeliverySubprocessResult[] = [];
  ghResponses: DeliverySubprocessResult[] = [];
  execResponses: DeliverySubprocessResult[] = [];

  async git(args: readonly string[], cwd: string): Promise<DeliverySubprocessResult> {
    this.gitCalls.push({ args, cwd });
    if (args[0] === "diff" && args.some((a) => typeof a === "string" && a.includes("..."))) {
      return {
        stdout: "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n",
        stderr: "",
        exitCode: 0,
      };
    }
    return this.gitResponses.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
  }

  async gh(args: readonly string[], cwd: string): Promise<DeliverySubprocessResult> {
    this.ghCalls.push({ args, cwd });
    if (args[0] === "api" && args[1]?.includes("rules/branches")) {
      return { stdout: "[]", stderr: "", exitCode: 0 };
    }
    if (args[0] === "api" && typeof args[1] === "string" && args[1].includes("required_status_checks")) {
      return { stdout: "{}", stderr: "404 Branch not protected", exitCode: 1 };
    }
    if (args[0] === "run") {
      return { stdout: "[]", stderr: "", exitCode: 0 };
    }
    if (args[0] === "issue" && args[1] === "view" && args.some((a) => a.includes("title,body"))) {
      return { stdout: JSON.stringify({ title: "issue 80", body: "body 80" }), stderr: "", exitCode: 0 };
    }
    if (args[0] === "pr" && args[1] === "view" && args.some((a) => a.includes("title,body"))) {
      return {
        stdout: JSON.stringify({
          title: "feat: delivery",
          body: "pr body",
          headRefOid: "sha123",
          baseRefOid: "basesha123",
          baseRefName: "main",
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    if (args[0] === "pr" && args[1] === "diff") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("headRefOid") && !args.includes("statusCheckRollup")) {
      return { stdout: JSON.stringify({ headRefOid: "sha123" }), stderr: "", exitCode: 0 };
    }
    if (args[0] === "pr" && args[1] === "view" && args.some((a) => a.includes("mergeable") && a.includes("statusCheckRollup"))) {
      if (args.some((a) => a.includes("body"))) {
        const next = this.ghResponses.shift();
        const parsed = typeof next === "object" && next !== null ? JSON.parse(next.stdout || "{}") : {};
        return {
          stdout: JSON.stringify({
            headRefOid: parsed.headRefOid ?? "sha123",
            state: parsed.state ?? "OPEN",
            isDraft: parsed.isDraft ?? false,
            mergeable: parsed.mergeable ?? "MERGEABLE",
            body: parsed.body ?? "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
            statusCheckRollup: parsed.statusCheckRollup ?? [
              { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" },
            ],
            ...parsed,
          }),
          stderr: next?.stderr ?? "",
          exitCode: next?.exitCode ?? 0,
        };
      }
    }
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
      "--bridge-url",
      "http://127.0.0.1:4040",
      "--bridge-token",
      "secret-token",
      "--session-id",
      "github:owner/repo#80",
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
    expect(parsed.bridgeUrl).toBe("http://127.0.0.1:4040");
    expect(parsed.bridgeToken).toBe("secret-token");
    expect(parsed.sessionId).toBe("github:owner/repo#80");
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
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
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
    let stderr = "";
    const io = {
      stdout: { write: (t: string) => { stdout += t; } },
      stderr: { write: (t: string) => { stderr += t; } },
    };

    const mockReviewGate: DeliveryReviewGate = {
      ensureReviewTask: async (_sid: string, target: DecisionReviewTarget) => ({
        schemaVersion: 1,
        id: "task-1",
        sessionId: "github:felixjichao/symphony-ts#80",
        kind: "review",
        revision: 1,
        status: "completed",
        lease: null,
        claimGeneration: 1,
        lastClaimToken: "token-1",
        createdAtMs: 1_000_000,
        updatedAtMs: 1_000_000,
        target,
      }),
      getReviewStatus: async (taskId: string) => ({
        taskId,
        status: "completed",
        result: {
          schemaVersion: 1,
          taskId,
          sessionId: "github:felixjichao/symphony-ts#80",
          kind: "review",
          revision: 1,
          createdAtMs: 1_000_000,
          verdict: "approve",
          target: {
            repository: "felixjichao/symphony-ts",
            prNumber: 80,
            headSha: "sha123",
          },
          findings: [],
        },
      }),
      verifyReviewApproval: async (target: DecisionReviewTarget) => ({
        approved: true,
        reason: "Approved in mock",
        taskId: "task-1",
        headSha: target.headSha,
        verdict: "approve",
      }),
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
      mockReviewGate,
    );

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("successfully completed and landed PR #80");
  });

  it("fails closed when --opt-in is passed without review gate or bridge URL", async () => {
    const tempDir = createTempDir();
    const runner = new MockCliRunner();
    runner.gitResponses.push({ stdout: "symphony/GH-80\n", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "https://github.com/felixjichao/symphony-ts.git\n", stderr: "", exitCode: 0 });
    runner.ghResponses.push({ stdout: JSON.stringify({ state: "OPEN" }), stderr: "", exitCode: 0 });

    runner.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 80,
          url: "https://github.com/felixjichao/symphony-ts/pull/80",
          title: "feat: delivery",
          state: "OPEN",
          headRefOid: "sha123",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });

    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "sha123\n", stderr: "", exitCode: 0 });

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

    // halt calls: edit, view labels, pr comment
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.ghResponses.push({ stdout: JSON.stringify({ labels: [] }), stderr: "", exitCode: 0 });
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });

    let stderr = "";
    const io = {
      stdout: { write: () => {} },
      stderr: { write: (t: string) => { stderr += t; } },
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

    expect(code).toBe(1);
    expect(stderr).toContain("blocked (manual_intervention_required)");
  });

  describe("FileDeliveryStateStorage", () => {
    it("writes atomically and reads state correctly", () => {
      const tempDir = createTempDir();
      const storageFile = path.join(tempDir, ".symphony", "delivery-state.json");
      const storage = new FileDeliveryStateStorage(storageFile);

      expect(storage.readState()).toBeNull();

      const state = {
        repo: "owner/repo",
        issueNumber: 80,
        workspaceKey: "GH-80",
        spentRepairs: 2,
        spentWaitSeconds: 45,
        deadlineTimestampMs: 1700000000,
        isPaused: true,
        pauseReason: "budget_exhausted",
        lastUpdated: new Date().toISOString(),
      };

      storage.writeState(state);
      const read = storage.readState();
      expect(read).toEqual(state);
    });

    it("throws on corrupted JSON or invalid schema", () => {
      const tempDir = createTempDir();
      const storageFile = path.join(tempDir, "corrupted.json");
      fs.writeFileSync(storageFile, "{ bad json", "utf8");

      const storage = new FileDeliveryStateStorage(storageFile);
      expect(() => storage.readState()).toThrow("invalid JSON");

      fs.writeFileSync(storageFile, JSON.stringify({ repo: "a", spentRepairs: -1 }), "utf8");
      expect(() => storage.readState()).toThrow("invalid state schema");
    });
  });

  describe("DefaultDeliveryGitGhRunner process group bounded timeout", () => {
    it("terminates process group within timeout and does not hang on background sleep", async () => {
      const { DefaultDeliveryGitGhRunner } = await import("./git-gh-runner");
      const runner = new DefaultDeliveryGitGhRunner();
      const start = Date.now();
      const res = await runner.exec("sleep 1.2 & wait", process.cwd(), 80);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(500); // Definitely terminated before 1200ms
      expect(res.exitCode).toBe(124);
      expect(res.stderr).toContain("Timed out");
    });
  });
});


it("restores the pending deadline from a real state file after interrupted waiting", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-restart-"));
  try {
    const context = { repo: "owner/repo", issueNumber: 80, workspaceKey: "GH-80", headBranch: "symphony/GH-80", baseBranch: "main" };
    const stateFile = path.join(dir, ".symphony/delivery-state.json");
    let clock = 100_000;
    let pushes = 0;
    const runner: DeliveryGitGhRunner = {
      async exec() { return { stdout: "", stderr: "", exitCode: 0 }; },
      async git(args) {
        if (args[0] === "push") pushes++;
        return { stdout: args[0] === "branch" ? context.headBranch : args[0] === "remote" ? "https://github.com/owner/repo.git" : args[0] === "rev-parse" ? "sha" : "", stderr: "", exitCode: 0 };
      },
      async gh(args) {
        const payload = args[0] === "issue" ? { state: "OPEN", labels: [] }
          : args[1] === "list" ? [{ number: 86, url: "https://github.com/owner/repo/pull/86", state: "OPEN", body: formatPrBody({ body: "fixture", context }), headRefOid: "sha" }]
          : { state: "OPEN", headRefOid: "sha", statusCheckRollup: [{ name: "gate", status: "IN_PROGRESS" }] };
        return { stdout: JSON.stringify(payload), stderr: "", exitCode: 0 };
      },
    };
    const options = { ...context, cwd: dir, runner, requiredChecks: [], maxWaitSeconds: 5, nowFn: () => clock };
    await expect(runDeliverySkill({ ...options, stateStorage: new FileDeliveryStateStorage(stateFile), sleepFn: async () => { clock += 4000; throw new Error("interrupt"); } })).rejects.toThrow("interrupt");
    const restartedStorage = new FileDeliveryStateStorage(stateFile);
    expect(restartedStorage.readState()?.deadlineTimestampMs).toBe(105_000);
    clock += 24_000;
    const result = await runDeliverySkill({ ...options, stateStorage: restartedStorage });
    expect(result.reason).toBe("ci_wait_timeout");
    expect(result.spentRepairs).toBe(0);
    expect(restartedStorage.readState()?.deadlineTimestampMs).toBe(105_000);
    expect(restartedStorage.readState()?.isPaused).toBe(true);
    expect(pushes).toBeGreaterThan(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
