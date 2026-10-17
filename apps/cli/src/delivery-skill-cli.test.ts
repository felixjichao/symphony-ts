import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runDeliverySkill, recoverDeliveryHandoff, type DeliveryGitGhRunner, type DeliverySubprocessResult } from "@symphony/agent";
import {
  formatPrBody,
  type DecisionReviewTarget,
  type DeliveryReviewGate,
} from "@symphony/domain";

import { FileDeliveryLock, FileDeliveryStateStorage, getOrCreateDeliveryLock, parseDeliverySkillArgs, runDeliverySkillCli } from "./delivery-skill-cli";

class MockCliRunner implements DeliveryGitGhRunner {
  readonly gitCalls: Array<{ args: readonly string[]; cwd: string }> = [];
  readonly ghCalls: Array<{ args: readonly string[]; cwd: string }> = [];
  readonly execCalls: Array<{ command: string; cwd: string }> = [];

  gitResponses: DeliverySubprocessResult[] = [];
  ghResponses: DeliverySubprocessResult[] = [];
  execResponses: DeliverySubprocessResult[] = [];

  // Simulates an unreadable Issue for the planning gate's requirement read.
  issueViewFailure = false;

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
      if (this.issueViewFailure) {
        return { stdout: "", stderr: "simulated issue view failure", exitCode: 1 };
      }
      return { stdout: JSON.stringify({ title: "issue 80", body: "body 80" }), stderr: "", exitCode: 0 };
    }
    if (args[0] === "api" && typeof args[1] === "string" && args[1].includes("pulls/")) {
      return {
        stdout: JSON.stringify({
          title: "feat: delivery",
          body: "pr body",
          base: {
            sha: "basesha123",
            ref: "main",
          },
          head: {
            sha: "sha123",
            ref: "symphony/GH-80",
          },
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    if (args[0] === "pr" && args[1] === "view" && args.some((a) => a.includes("title,body"))) {
      return {
        stdout: JSON.stringify({
          title: "feat: delivery",
          body: "pr body",
          headRefOid: "sha123",
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

  it("fails closed when current Issue requirements cannot be read for the planning gate", async () => {
    const tempDir = createTempDir();
    const runner = new MockCliRunner();
    runner.issueViewFailure = true;

    let stderr = "";
    const io = {
      stdout: { write: () => {} },
      stderr: { write: (t: string) => { stderr += t; } },
    };

    const code = await runDeliverySkillCli(
      [
        "run",
        "--repo", "owner/repo",
        "--issue", "80",
        "--bridge-url", "http://127.0.0.1:9",
        "--cwd", tempDir,
      ],
      io,
      runner,
    );

    expect(code).toBe(1);
    expect(stderr).toContain("failed to read current Issue #80 requirements");
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

  describe("recover-handoff action", () => {
    it("fails when delivery state file does not exist", async () => {
      const tempDir = createTempDir();
      const runner = new MockCliRunner();
      let stderr = "";
      const io = {
        stdout: { write: () => {} },
        stderr: { write: (t: string) => { stderr += t; } },
      };

      const code = await runDeliverySkillCli(
        ["recover-handoff", "--repo", "owner/repo", "--issue", "80", "--cwd", tempDir],
        io,
        runner,
      );

      expect(code).toBe(1);
      expect(stderr).toContain("no persisted delivery state found");
    });

    it("does nothing and returns 0 if state is not paused", async () => {
      const tempDir = createTempDir();
      const stateFile = path.join(tempDir, ".symphony", "delivery-state.json");
      const storage = new FileDeliveryStateStorage(stateFile);
      storage.writeState({
        repo: "owner/repo",
        issueNumber: 80,
        workspaceKey: "GH-80",
        spentRepairs: 1,
        spentWaitSeconds: 10,
        deadlineTimestampMs: 1700000000,
        isPaused: false,
        lastUpdated: new Date().toISOString(),
      });

      const runner = new MockCliRunner();
      let stderr = "";
      const io = {
        stdout: { write: () => {} },
        stderr: { write: (t: string) => { stderr += t; } },
      };

      const code = await runDeliverySkillCli(
        ["recover-handoff", "--repo", "owner/repo", "--issue", "80", "--cwd", tempDir],
        io,
        runner,
      );

      expect(code).toBe(0);
      expect(stderr).toContain("delivery state is not paused");
      expect(runner.ghCalls.length).toBe(0);
    });

    it("completes unposted handoff comment and preserves budget and paused state", async () => {
      const tempDir = createTempDir();
      const stateFile = path.join(tempDir, ".symphony", "delivery-state.json");
      const storage = new FileDeliveryStateStorage(stateFile);
      storage.writeState({
        repo: "owner/repo",
        issueNumber: 80,
        workspaceKey: "GH-80",
        spentRepairs: 3,
        spentWaitSeconds: 120,
        deadlineTimestampMs: 1700000000,
        isPaused: true,
        pauseReason: "budget_exhausted",
        readyLabelRemoved: true,
        commentPosted: false,
        pendingCompensation: true,
        lastUpdated: new Date().toISOString(),
      });

      const runner = new MockCliRunner();
      // 1. gh issue view --json comments (empty comments)
      runner.ghResponses.push({ stdout: JSON.stringify({ comments: [] }), stderr: "", exitCode: 0 });
      // 2. gh issue comment
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });

      let stdout = "";
      const io = {
        stdout: { write: (t: string) => { stdout += t; } },
        stderr: { write: () => {} },
      };

      const code = await runDeliverySkillCli(
        ["recover-handoff", "--repo", "owner/repo", "--issue", "80", "--cwd", tempDir],
        io,
        runner,
      );

      expect(code).toBe(0);
      expect(stdout).toContain("handoff recovery completed successfully");

      const commentCall = runner.ghCalls.find((c) => c.args[0] === "issue" && c.args[1] === "comment");
      expect(commentCall).toBeDefined();

      const updated = storage.readState();
      expect(updated?.commentPosted).toBe(true);
      expect(updated?.pendingCompensation).toBe(false);
      expect(updated?.spentRepairs).toBe(3);
      expect(updated?.spentWaitSeconds).toBe(120);
      expect(updated?.isPaused).toBe(true);
    });

    it("deduplicates remote comments and avoids double-posting when comment already exists", async () => {
      const tempDir = createTempDir();
      const stateFile = path.join(tempDir, ".symphony", "delivery-state.json");
      const storage = new FileDeliveryStateStorage(stateFile);
      storage.writeState({
        repo: "owner/repo",
        issueNumber: 80,
        workspaceKey: "GH-80",
        spentRepairs: 2,
        spentWaitSeconds: 50,
        deadlineTimestampMs: 1700000000,
        isPaused: true,
        pauseReason: "budget_exhausted",
        readyLabelRemoved: true,
        commentPosted: false,
        pendingCompensation: true,
        lastUpdated: new Date().toISOString(),
        handoff: {
          repo: "owner/repo",
          issueNumber: 80,
          headBranch: "symphony/GH-80",
          prNumber: null,
          prUrl: null,
          headSha: null,
          reason: "budget_exhausted",
          details: "Delivery paused for manual intervention.",
          spentRepairs: 2,
          maxRepairs: 3,
          spentWaitSeconds: 50,
          maxWaitSeconds: 300,
          readyLabel: "symphony-ready",
          readyLabelRemoved: true,
          handoffId: "handoff-owner-repo-80-test-dedup",
        },
      });

      const runner = new MockCliRunner();
      // 1. gh issue view --json comments returns existing handoff report with matching handoffId
      runner.ghResponses.push({
        stdout: JSON.stringify({
          comments: [
            { body: "Some prior comment" },
            { body: "## 🚨 Symphony Delivery Handoff Report\n\n<!-- symphony-delivery-handoff: {\"handoffId\":\"handoff-owner-repo-80-test-dedup\"} -->\nDelivery paused for manual intervention." },
          ],
        }),
        stderr: "",
        exitCode: 0,
      });

      let stdout = "";
      const io = {
        stdout: { write: (t: string) => { stdout += t; } },
        stderr: { write: () => {} },
      };

      const code = await runDeliverySkillCli(
        ["recover-handoff", "--repo", "owner/repo", "--issue", "80", "--cwd", tempDir],
        io,
        runner,
      );

      expect(code).toBe(0);
      expect(stdout).toContain("handoff recovery completed successfully");

      const commentCall = runner.ghCalls.find((c) => c.args[0] === "issue" && c.args[1] === "comment");
      expect(commentCall).toBeUndefined(); // Deduplicated!

      const updated = storage.readState();
      expect(updated?.commentPosted).toBe(true);
      expect(updated?.pendingCompensation).toBe(false);
      expect(updated?.spentRepairs).toBe(2);
      expect(updated?.isPaused).toBe(true);
    });

    it("leaves legacy state without ID/SHA unverified and pending compensation when remote has existing generic report", async () => {
      const tempDir = createTempDir();
      const stateFile = path.join(tempDir, ".symphony", "delivery-state.json");
      const storage = new FileDeliveryStateStorage(stateFile);
      storage.writeState({
        repo: "owner/repo",
        issueNumber: 80,
        workspaceKey: "GH-80",
        spentRepairs: 2,
        spentWaitSeconds: 50,
        deadlineTimestampMs: 1700000000,
        isPaused: true,
        pauseReason: "budget_exhausted",
        readyLabelRemoved: true,
        commentPosted: false,
        pendingCompensation: true,
        lastUpdated: new Date().toISOString(),
      });

      const runner = new MockCliRunner();
      runner.ghResponses.push({
        stdout: JSON.stringify({
          comments: [
            { body: "## 🚨 Symphony Delivery Handoff Report\n\nSome old generic report." },
          ],
        }),
        stderr: "",
        exitCode: 0,
      });

      let stderr = "";
      const io = {
        stdout: { write: () => {} },
        stderr: { write: (t: string) => { stderr += t; } },
      };

      const code = await runDeliverySkillCli(
        ["recover-handoff", "--repo", "owner/repo", "--issue", "80", "--cwd", tempDir],
        io,
        runner,
      );

      expect(code).toBe(1);
      expect(stderr).toContain("legacy handoff lacks unique identifier");
      const commentCall = runner.ghCalls.find((c) => c.args[0] === "issue" && c.args[1] === "comment");
      expect(commentCall).toBeUndefined();

      const updated = storage.readState();
      expect(updated?.commentPosted).toBe(false);
      expect(updated?.commentVerifyStatus).toBe("unverified");
      expect(updated?.pendingCompensation).toBe(true);
    });

    it("fails fast before any remote action when argv issue or repo does not match persisted state", async () => {
      const tempDir = createTempDir();
      const stateFile = path.join(tempDir, ".symphony", "delivery-state.json");
      const storage = new FileDeliveryStateStorage(stateFile);
      storage.writeState({
        repo: "owner/repo",
        issueNumber: 80,
        workspaceKey: "GH-80",
        spentRepairs: 2,
        spentWaitSeconds: 45,
        isPaused: true,
        pauseReason: "manual_intervention_required",
        lastUpdated: new Date().toISOString(),
      });

      const runner = new MockCliRunner();
      let stderr = "";
      const io = {
        stdout: { write: () => {} },
        stderr: { write: (t: string) => { stderr += t; } },
      };

      const code = await runDeliverySkillCli(
        ["recover-handoff", "--repo", "owner/repo", "--issue", "81", "--cwd", tempDir],
        io,
        runner,
      );

      expect(code).toBe(1);
      expect(stderr).toContain("issue number mismatch");
      expect(runner.ghCalls.length).toBe(0); // No remote actions performed!
    });

    it("queries and comments on PR instead of issue when handoff has prNumber", async () => {
      const tempDir = createTempDir();
      const stateFile = path.join(tempDir, ".symphony", "delivery-state.json");
      const storage = new FileDeliveryStateStorage(stateFile);
      storage.writeState({
        repo: "owner/repo",
        issueNumber: 80,
        workspaceKey: "GH-80",
        spentRepairs: 2,
        spentWaitSeconds: 45,
        isPaused: true,
        pauseReason: "manual_intervention_required",
        readyLabelRemoved: true,
        commentPosted: false,
        pendingCompensation: true,
        lastUpdated: new Date().toISOString(),
        handoff: {
          repo: "owner/repo",
          issueNumber: 80,
          headBranch: "symphony/GH-80",
          prNumber: 142,
          prUrl: "https://github.com/owner/repo/pull/142",
          headSha: "head123",
          reason: "manual_intervention_required",
          details: "test halt",
          spentRepairs: 2,
          maxRepairs: 3,
          spentWaitSeconds: 45,
          maxWaitSeconds: 300,
          readyLabel: "symphony-ready",
          readyLabelRemoved: true,
        },
      });

      const runner = new MockCliRunner();
      // pr view --json comments returns empty comments
      runner.ghResponses.push({ stdout: JSON.stringify({ comments: [] }), stderr: "", exitCode: 0 });
      // pr comment returns success
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });

      let stdout = "";
      const io = {
        stdout: { write: (t: string) => { stdout += t; } },
        stderr: { write: () => {} },
      };

      const code = await runDeliverySkillCli(
        ["recover-handoff", "--repo", "owner/repo", "--issue", "80", "--cwd", tempDir],
        io,
        runner,
      );

      expect(code).toBe(0);
      expect(stdout).toContain("handoff recovery completed successfully");

      const viewCall = runner.ghCalls.find((c) => c.args[0] === "pr" && c.args[1] === "view");
      expect(viewCall).toBeDefined();
      expect(viewCall?.args[2]).toBe("142");

      const commentCall = runner.ghCalls.find((c) => c.args[0] === "pr" && c.args[1] === "comment");
      expect(commentCall).toBeDefined();
      expect(commentCall?.args[2]).toBe("142");
    });

    it("does not mistake old reports with different head/details as a match and completes unposted report", async () => {
      const tempDir = createTempDir();
      const stateFile = path.join(tempDir, ".symphony", "delivery-state.json");
      const storage = new FileDeliveryStateStorage(stateFile);
      storage.writeState({
        repo: "owner/repo",
        issueNumber: 80,
        workspaceKey: "GH-80",
        spentRepairs: 2,
        spentWaitSeconds: 45,
        isPaused: true,
        pauseReason: "manual_intervention_required",
        readyLabelRemoved: true,
        commentPosted: false,
        pendingCompensation: true,
        lastUpdated: new Date().toISOString(),
        handoff: {
          repo: "owner/repo",
          issueNumber: 80,
          headBranch: "symphony/GH-80",
          prNumber: null,
          prUrl: null,
          headSha: "new-head-sha",
          reason: "manual_intervention_required",
          details: "current pause",
          spentRepairs: 2,
          maxRepairs: 3,
          spentWaitSeconds: 45,
          maxWaitSeconds: 300,
          readyLabel: "symphony-ready",
          readyLabelRemoved: true,
        },
      });

      const runner = new MockCliRunner();
      // issue view returns an old report from a previous commit
      runner.ghResponses.push({
        stdout: JSON.stringify({
          comments: [
            { body: "## 🚨 Symphony Delivery Handoff Report\n\n- **Head SHA**: `old-head-s`\n**详细信息**：previous halt" },
          ],
        }),
        stderr: "",
        exitCode: 0,
      });
      // issue comment succeeds
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });

      const io = {
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      };

      const code = await runDeliverySkillCli(
        ["recover-handoff", "--repo", "owner/repo", "--issue", "80", "--cwd", tempDir],
        io,
        runner,
      );

      expect(code).toBe(0);
      const commentCall = runner.ghCalls.find((c) => c.args[0] === "issue" && c.args[1] === "comment");
      expect(commentCall).toBeDefined(); // Correctly posted for new head!
    });

    it("keeps status unverified and pendingCompensation true when remote comment query fails", async () => {
      const tempDir = createTempDir();
      const stateFile = path.join(tempDir, ".symphony", "delivery-state.json");
      const storage = new FileDeliveryStateStorage(stateFile);
      storage.writeState({
        repo: "owner/repo",
        issueNumber: 80,
        workspaceKey: "GH-80",
        spentRepairs: 2,
        spentWaitSeconds: 45,
        isPaused: true,
        pauseReason: "manual_intervention_required",
        readyLabelRemoved: true,
        commentPosted: false,
        pendingCompensation: true,
        lastUpdated: new Date().toISOString(),
      });

      const runner = new MockCliRunner();
      // issue view fails with exit 1
      runner.ghResponses.push({ stdout: "", stderr: "network failure", exitCode: 1 });

      let stderr = "";
      const io = {
        stdout: { write: () => {} },
        stderr: { write: (t: string) => { stderr += t; } },
      };

      const code = await runDeliverySkillCli(
        ["recover-handoff", "--repo", "owner/repo", "--issue", "80", "--cwd", tempDir],
        io,
        runner,
      );

      expect(code).toBe(1);
      expect(stderr).toContain("error querying remote comments");

      const commentCall = runner.ghCalls.find((c) => c.args[0] === "issue" && c.args[1] === "comment");
      expect(commentCall).toBeUndefined(); // Never blindly post when query failed!

      const updated = storage.readState();
      expect(updated?.commentVerifyStatus).toBe("unverified");
      expect(updated?.pendingCompensation).toBe(true);
    });

    it("migrating legacy handoff persists generated ID before remote comment and recovers cleanly after connection lost", async () => {
      const tempDir = createTempDir();
      const stateFile = path.join(tempDir, ".symphony", "delivery-state.json");
      const storage = new FileDeliveryStateStorage(stateFile);
      // Legacy state: has handoff but without handoffId, no headSha
      storage.writeState({
        repo: "owner/repo",
        issueNumber: 80,
        workspaceKey: "GH-80",
        spentRepairs: 2,
        spentWaitSeconds: 45,
        isPaused: true,
        pauseReason: "ci_failed_max_repairs",
        readyLabelRemoved: true,
        commentPosted: false,
        pendingCompensation: true,
        lastUpdated: new Date().toISOString(),
        handoff: {
          repo: "owner/repo",
          issueNumber: 80,
          headBranch: "symphony/GH-80",
          prNumber: null,
          prUrl: null,
          headSha: null,
          reason: "ci_failed_max_repairs",
          details: "legacy handoff without ID",
          spentRepairs: 2,
          maxRepairs: 3,
          spentWaitSeconds: 45,
          maxWaitSeconds: 300,
          readyLabel: "symphony-ready",
          readyLabelRemoved: true,
          commentPosted: false,
        },
      });

      const runner = new MockCliRunner();
      // 1. First recover attempt: remote has no comments
      runner.ghResponses.push({
        stdout: JSON.stringify({ comments: [] }),
        stderr: "",
        exitCode: 0,
      });
      // Remote comment post attempt fails with network error / connection lost
      runner.ghResponses.push({
        stdout: "",
        stderr: "network timeout connecting to api.github.com",
        exitCode: 1,
      });

      const io = {
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      };

      const code1 = await runDeliverySkillCli(
        ["recover-handoff", "--repo", "owner/repo", "--issue", "80", "--cwd", tempDir],
        io,
        runner,
      );

      // Fails because remote comment post failed
      expect(code1).toBe(1);

      // Critical assertion (Blocker 1): handoffId was saved to disk BEFORE the remote call!
      const diskStateAfterFailedPost = storage.readState();
      expect(diskStateAfterFailedPost).not.toBeNull();
      const generatedId = diskStateAfterFailedPost?.handoff?.handoffId;
      expect(generatedId).toBeDefined();
      expect(typeof generatedId).toBe("string");
      expect(generatedId).toMatch(/^handoff-owner-repo-80-/);
      expect(diskStateAfterFailedPost?.commentPosted).toBe(false);
      expect(diskStateAfterFailedPost?.commentVerifyStatus).toBe("unverified");
      expect(diskStateAfterFailedPost?.pendingCompensation).toBe(true);

      // 2. Second recover attempt: GitHub actually received the comment (or it's queryable with generatedId)
      const secondRunner = new MockCliRunner();
      secondRunner.ghResponses.push({
        stdout: JSON.stringify({
          comments: [
            {
              body: `## 🚨 Symphony Delivery Handoff Report\n\n- **Handoff ID**: \`${generatedId}\`\n<!-- symphony:handoff-id:${generatedId} -->`,
            },
          ],
        }),
        stderr: "",
        exitCode: 0,
      });

      const code2 = await runDeliverySkillCli(
        ["recover-handoff", "--repo", "owner/repo", "--issue", "80", "--cwd", tempDir],
        io,
        secondRunner,
      );

      // Clean recovery: deduplicated by handoffId without re-posting!
      expect(code2).toBe(0);
      const secondCommentCall = secondRunner.ghCalls.find((c) => c.args[0] === "issue" && c.args[1] === "comment");
      expect(secondCommentCall).toBeUndefined();

      const finalState = storage.readState();
      expect(finalState?.handoff?.handoffId).toBe(generatedId);
      expect(finalState?.commentPosted).toBe(true);
      expect(finalState?.commentVerifyStatus).toBe("posted");
      expect(finalState?.pendingCompensation).toBe(false);
    });

    it("does not treat arbitrary commit comments as handoff reports during SHA-based legacy recovery", async () => {
      const tempDir = createTempDir();
      const stateFile = path.join(tempDir, ".symphony", "delivery-state.json");
      const storage = new FileDeliveryStateStorage(stateFile);
      const headSha = "1234567890abcdef1234567890abcdef12345678";

      // Legacy state with headSha but no handoffId
      storage.writeState({
        repo: "owner/repo",
        issueNumber: 80,
        workspaceKey: "GH-80",
        spentRepairs: 1,
        spentWaitSeconds: 30,
        isPaused: true,
        pauseReason: "manual_intervention_required",
        readyLabelRemoved: true,
        commentPosted: false,
        pendingCompensation: true,
        lastUpdated: new Date().toISOString(),
        handoff: {
          repo: "owner/repo",
          issueNumber: 80,
          headBranch: "symphony/GH-80",
          prNumber: null,
          prUrl: null,
          headSha,
          reason: "manual_intervention_required",
          details: "Please test this commit",
          spentRepairs: 1,
          maxRepairs: 3,
          spentWaitSeconds: 30,
          maxWaitSeconds: 300,
          readyLabel: "symphony-ready",
          readyLabelRemoved: true,
          commentPosted: false,
        },
      });

      const runner = new MockCliRunner();
      // Remote only has a regular discussion comment mentioning the short SHA, NOT a handoff report
      runner.ghResponses.push({
        stdout: JSON.stringify({
          comments: [
            { body: "Please test commit 1234567890 before merging." },
          ],
        }),
        stderr: "",
        exitCode: 0,
      });
      // Comment post succeeds
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });

      const io = {
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      };

      const code = await runDeliverySkillCli(
        ["recover-handoff", "--repo", "owner/repo", "--issue", "80", "--cwd", tempDir],
        io,
        runner,
      );

      // Must succeed and actually post the handoff report, not mistakenly skip it
      expect(code).toBe(0);
      const commentCall = runner.ghCalls.find((c) => c.args[0] === "issue" && c.args[1] === "comment");
      expect(commentCall).toBeDefined();

      const updated = storage.readState();
      expect(updated?.commentPosted).toBe(true);
      expect(updated?.commentVerifyStatus).toBe("posted");
      expect(updated?.pendingCompensation).toBe(false);
      expect(updated?.handoff?.handoffId).toBeDefined();
    });

    it("keeps legacy state with matching SHA report unverified rather than falsely declaring success or duplicate posting", async () => {
      const tempDir = createTempDir();
      const stateFile = path.join(tempDir, ".symphony", "delivery-state.json");
      const storage = new FileDeliveryStateStorage(stateFile);
      const headSha = "abcdef1234567890abcdef1234567890abcdef12";

      // Legacy state with headSha but no handoffId
      storage.writeState({
        repo: "owner/repo",
        issueNumber: 80,
        workspaceKey: "GH-80",
        spentRepairs: 1,
        spentWaitSeconds: 30,
        isPaused: true,
        pauseReason: "manual_intervention_required",
        readyLabelRemoved: true,
        commentPosted: false,
        pendingCompensation: true,
        lastUpdated: new Date().toISOString(),
        handoff: {
          repo: "owner/repo",
          issueNumber: 80,
          headBranch: "symphony/GH-80",
          prNumber: null,
          prUrl: null,
          headSha,
          reason: "manual_intervention_required",
          details: "halt details",
          spentRepairs: 1,
          maxRepairs: 3,
          spentWaitSeconds: 30,
          maxWaitSeconds: 300,
          readyLabel: "symphony-ready",
          readyLabelRemoved: true,
          commentPosted: false,
        },
      });

      const runner = new MockCliRunner();
      // Remote already contains a genuine handoff report with this short SHA, but legacy state has no unique handoffId
      runner.ghResponses.push({
        stdout: JSON.stringify({
          comments: [
            {
              body: `## 🚨 Symphony Delivery Handoff Report\n\n- **Head SHA**: \`abcdef1234\`\n<!-- symphony-delivery-handoff -->`,
            },
          ],
        }),
        stderr: "",
        exitCode: 0,
      });

      const io = {
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      };

      const code = await runDeliverySkillCli(
        ["recover-handoff", "--repo", "owner/repo", "--issue", "80", "--cwd", tempDir],
        io,
        runner,
      );

      // Ambiguous legacy report without handoffId cannot be verified as belonging to this halt; exit 1, do not post duplicate
      expect(code).toBe(1);
      const commentCall = runner.ghCalls.find((c) => c.args[0] === "issue" && c.args[1] === "comment");
      expect(commentCall).toBeUndefined();

      const updated = storage.readState();
      expect(updated?.commentVerifyStatus).toBe("unverified");
      expect(updated?.pendingCompensation).toBe(true);
    });
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

it("Blocker 5: concurrent recoverDeliveryHandoff calls serialize via FileDeliveryStateStorage lock and post only one comment", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-"));
  try {
    const stateFile = path.join(dir, "delivery.json");
    const stateStorage = new FileDeliveryStateStorage(stateFile);
    stateStorage.writeState({
      repo: "acme/repo",
      issueNumber: 1,
      workspaceKey: "GH-1",
      spentRepairs: 0,
      spentWaitSeconds: 0,
      isPaused: true,
      pendingCompensation: true,
      readyLabelRemoved: true,
      commentPosted: false,
      lastUpdated: "v1",
      handoff: {
        handoffId: "h1",
        reason: "manual_intervention_required",
        details: "manual",
        repo: "acme/repo",
        issueNumber: 1,
        headBranch: "symphony/GH-1",
        prNumber: 2,
        prUrl: null,
        headSha: "head",
        spentRepairs: 0,
        maxRepairs: 3,
        spentWaitSeconds: 0,
        maxWaitSeconds: 300,
        readyLabel: "ready",
        readyLabelRemoved: true,
      },
    });

    let queries = 0;
    let posts = 0;
    const runner: DeliveryGitGhRunner = {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      git: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      gh: async (args) => {
        if (args[1] === "view") {
          queries++;
          return { exitCode: 0, stdout: JSON.stringify({ comments: [] }), stderr: "" };
        }
        if (args[1] === "comment") {
          posts++;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const options = {
      cwd: dir,
      repo: "acme/repo",
      issueNumber: 1,
      stateStorage,
      runner,
      expectedHandoffId: "h1",
      expectedLastUpdated: "v1",
    };

    const results = await Promise.all([
      recoverDeliveryHandoff(options),
      recoverDeliveryHandoff(options),
    ]);
    expect(results.every((r) => r.success)).toBe(true);
    expect(queries).toBeGreaterThanOrEqual(1);
    expect(posts).toBe(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("FileDeliveryLock: resolves canonical alias paths to share in-process mutex and protects living locks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-alias-"));
  const physical = path.join(dir, "physical");
  const alias = path.join(dir, "alias");
  fs.mkdirSync(physical);
  fs.symlinkSync(physical, alias);
  const file = path.join(physical, "delivery.json");
  const first = new FileDeliveryLock(file);
  const second = new FileDeliveryLock(path.join(alias, "delivery.json"));

  try {
    await first.acquire();
    expect(fs.existsSync(`${file}.lock`)).toBe(true);

    let secondAcquired = false;
    const secondPromise = second.acquire().then(() => {
      secondAcquired = true;
    });

    // Verify second lock acquisition is blocked by in-process mutex
    await new Promise((r) => setTimeout(r, 100));
    expect(secondAcquired).toBe(false);

    // Release first lock; second acquisition can now proceed
    await first.release();
    await secondPromise;
    expect(secondAcquired).toBe(true);

    // Now release second
    await second.release();
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  } finally {
    await first.release();
    await second.release();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("FileDeliveryLock: release only deletes the lock if token matches", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-token-"));
  const file = path.join(dir, "delivery.json");
  const lock = new FileDeliveryLock(file);

  try {
    await lock.acquire();
    const lockFile = `${file}.lock`;
    expect(fs.existsSync(lockFile)).toBe(true);

    // Overwrite the lock file with a different token from another entity
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: "other-token", time: Date.now() }));

    // Releasing the original lock should NOT delete the lock belonging to other-token
    await lock.release();
    expect(fs.existsSync(lockFile)).toBe(true);

    const content = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    expect(content.token).toBe("other-token");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("Delivery halt side effects are serialized with recoverDeliveryHandoff under shared lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-halt-serial-"));
  const stateStorage = new FileDeliveryStateStorage(path.join(dir, "delivery.json"));
  let recovering = false;
  let posts = 0;
  const runner = {
    git: async () => ({ exitCode: 0, stdout: "wrong-branch", stderr: "" }),
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    gh: async (args: readonly string[]) => {
      if (args[1] === "edit" && !recovering) {
        recovering = true;
        const recovered = await recoverDeliveryHandoff({
          cwd: dir,
          repo: "acme/repo",
          issueNumber: 1,
          stateStorage,
          runner,
        });
        expect(recovered.success).toBe(true);
      }
      if (args[1] === "comment") posts++;
      return { exitCode: 0, stdout: JSON.stringify({ comments: [], labels: [] }), stderr: "" };
    },
  };

  try {
    const result = await runDeliverySkill({
      cwd: dir,
      repo: "acme/repo",
      issueNumber: 1,
      workspaceKey: "GH-1",
      headBranch: "symphony/GH-1",
      baseBranch: "main",
      runner,
      stateStorage,
    });
    expect(result.status).toBe("blocked");
    // Verify only exactly 1 comment was posted despite concurrent recovery during halt
    expect(posts).toBe(1);

    const finalState = stateStorage.readState();
    expect(finalState?.commentPosted).toBe(true);
    expect(finalState?.pendingCompensation).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("failed file lock acquisition cleanly releases in-process mutex", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-fail-"));
  const parent = path.join(dir, "blocker");
  fs.writeFileSync(parent, "not a directory");
  const first = new FileDeliveryLock(path.join(parent, "delivery.json"));
  let second: FileDeliveryLock | undefined;
  try {
    await expect(first.acquire()).rejects.toMatchObject({ code: "ENOTDIR" });
    fs.unlinkSync(parent);
    fs.mkdirSync(parent);
    second = new FileDeliveryLock(path.join(parent, "delivery.json"));
    const acquired = await Promise.race([
      second.acquire().then(() => "acquired"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 200)),
    ]);
    expect(acquired).toBe("acquired");
  } finally {
    await second?.release();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("getOrCreateDeliveryLock and new FileDeliveryLock share canonical lock path and mutex", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-canonical-"));
  const statePath = path.join(dir, "delivery.json");
  const lock1 = getOrCreateDeliveryLock(statePath);
  const lock2 = new FileDeliveryLock(statePath);
  try {
    await lock1.acquire();
    const acquirePromise = lock2.acquire();
    const probe = await Promise.race([
      acquirePromise.then(() => "acquired"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);
    expect(probe).toBe("blocked");
    await lock1.release();
    const result = await Promise.race([
      acquirePromise.then(() => "acquired"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    expect(result).toBe("acquired");
    await lock2.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("delivery records comment receipt under lock preventing duplicate comment from concurrent recovery", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-comment-receipt-race-"));
  const stateStorage = new FileDeliveryStateStorage(path.join(dir, "delivery.json"));
  let recovery: Promise<{ success: boolean }> | undefined;
  let posts = 0;
  const runner = {
    git: async () => ({ exitCode: 0, stdout: "wrong-branch", stderr: "" }),
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    gh: async (args: readonly string[]) => {
      if (args[1] === "comment") {
        posts++;
        if (posts === 1) {
          recovery = recoverDeliveryHandoff({
            cwd: dir,
            repo: "acme/repo",
            issueNumber: 1,
            stateStorage,
            runner,
          });
        }
      }
      return { exitCode: 0, stdout: JSON.stringify({ comments: [], labels: [] }), stderr: "" };
    },
  };
  try {
    const result = await runDeliverySkill({
      cwd: dir,
      repo: "acme/repo",
      issueNumber: 1,
      workspaceKey: "GH-1",
      headBranch: "symphony/GH-1",
      baseBranch: "main",
      runner,
      stateStorage,
    });
    expect(result.status).toBe("blocked");
    expect((await recovery!)?.success).toBe(true);
    expect(posts).toBe(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("FileDeliveryLock: metadata write failure (ENOSPC) cleans up created lock file and permits subsequent acquire", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-enospc-"));
  const file = path.join(dir, "delivery.json");
  const lock = new FileDeliveryLock(file);

  const originalWriteFileSync = fs.writeFileSync;
  let writeInjected = false;
  const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
    const target = args[0];
    if (typeof target === "number" && !writeInjected) {
      writeInjected = true;
      const err = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
      err.code = "ENOSPC";
      throw err;
    }
    return originalWriteFileSync(...args);
  });

  try {
    await expect(lock.acquire()).rejects.toThrow("ENOSPC");
    // Verify .lock file was unlinked and does not remain on disk
    expect(fs.existsSync(`${file}.lock`)).toBe(false);

    // Subsequent acquire succeeds without being blocked by an abandoned empty lock
    writeSpy.mockRestore();
    await lock.acquire();
    expect(fs.existsSync(`${file}.lock`)).toBe(true);
    await lock.release();
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  } finally {
    writeSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("FileDeliveryLock: stale unparseable or empty lock file (>60s) is safely reclaimed by subsequent acquire", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-stale-"));
  const file = path.join(dir, "delivery.json");
  const lockFile = `${file}.lock`;
  const lock = new FileDeliveryLock(file);

  try {
    // Create an empty lock file with mtime > 60s in the past
    fs.writeFileSync(lockFile, "", "utf8");
    const pastTime = (Date.now() - 70000) / 1000;
    fs.utimesSync(lockFile, pastTime, pastTime);

    // Acquire should detect the stale empty lock, reclaim it, and succeed
    await lock.acquire();
    expect(fs.existsSync(lockFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: number; token?: string };
    expect(content.pid).toBe(process.pid);
    expect(typeof content.token).toBe("string");

    await lock.release();
    expect(fs.existsSync(lockFile)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("FileDeliveryLock: interleaved acquisition by another live owner prevents stale reclamation from deleting the new lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-interleaved-"));
  const statePath = path.join(dir, "delivery.json");
  const lockPath = `${statePath}.lock`;
  const actorA = new FileDeliveryLock(statePath, { timeoutMs: 150 });
  let actorBFd: number | undefined;

  fs.writeFileSync(lockPath, "", "utf8");
  const old = (Date.now() - 70000) / 1000;
  fs.utimesSync(lockPath, old, old);

  const originalReadFileSync = fs.readFileSync;
  let injected = false;
  const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(
    (path: fs.PathOrFileDescriptor, options?: (fs.ObjectEncodingOptions & { flag?: string | undefined }) | BufferEncoding | null | undefined) => {
      const observed = originalReadFileSync(path, options);
      if (!injected && path === lockPath) {
        injected = true;
        // B unlinks stale lock and establishes a new live lock
        fs.unlinkSync(lockPath);
        actorBFd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR);
        fs.writeFileSync(actorBFd, JSON.stringify({ pid: process.pid, token: "live-owner-B", time: Date.now() }), "utf8");
      }
      return observed;
    },
  );

  try {
    // A attempts to acquire, but because B established a live lock, A cannot acquire and times out safely
    await expect(actorA.acquire()).rejects.toThrow("Timed out waiting for delivery lock");
    readSpy.mockRestore();

    expect(injected).toBe(true);
    // Critical assertion: B's live lock was NOT deleted by A's stale observation!
    expect(fs.fstatSync(actorBFd!).nlink).toBe(1);
    const diskContent = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token?: string };
    expect(diskContent.token).toBe("live-owner-B");
  } finally {
    readSpy.mockRestore();
    if (actorBFd !== undefined) {
      try {
        fs.closeSync(actorBFd);
      } catch {
        // ignore
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("FileDeliveryLock: concurrent reclaimers arbitrate safely with only one winner taking over the stale lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-concurrent-reclaim-"));
  const statePath = path.join(dir, "delivery.json");
  const lockPath = `${statePath}.lock`;
  const lockA = new FileDeliveryLock(statePath, { inProcessMutex: false });
  const lockB = new FileDeliveryLock(statePath, { inProcessMutex: false });

  try {
    // Stale lock file (>60s)
    fs.writeFileSync(lockPath, "", "utf8");
    const old = (Date.now() - 70000) / 1000;
    fs.utimesSync(lockPath, old, old);

    // Both re-acquire concurrently
    let winner = "";
    const pA = lockA.acquire().then(() => {
      winner = winner || "A";
    });
    const pB = lockB.acquire().then(() => {
      winner = winner || "B";
    });

    await Promise.race([pA, pB]);
    expect(["A", "B"]).toContain(winner);

    // Release the winner's lock so the second actor can acquire
    if (winner === "A") {
      await lockA.release();
      await pB;
      await lockB.release();
    } else {
      await lockB.release();
      await pA;
      await lockA.release();
    }
    expect(fs.existsSync(lockPath)).toBe(false);
  } finally {
    await lockA.release().catch(() => {});
    await lockB.release().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("FileDeliveryLock: failed arbitration times out cleanly without synchronous spinning or bypassing yield", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-timeout-yield-"));
  const statePath = path.join(dir, "delivery.json");
  const lockPath = `${statePath}.lock`;
  const lock = new FileDeliveryLock(statePath, { timeoutMs: 150 });
  let openSpy: { mockRestore: () => void } | undefined;
  let attempts = 0;
  try {
    fs.writeFileSync(lockPath, "", "utf8");
    const old = (Date.now() - 70000) / 1000;
    fs.utimesSync(lockPath, old, old);

    const origOpenSync = fs.openSync;
    openSpy = vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).startsWith(`${lockPath}.reclaim.candidate-`)) {
        attempts++;
        throw Object.assign(new Error("injected reclaim permission failure"), { code: "EACCES" });
      }
      return origOpenSync(...args);
    });

    const start = Date.now();
    await expect(lock.acquire()).rejects.toThrow(/Timed out waiting for delivery lock/);
    const duration = Date.now() - start;
    expect(duration).toBeGreaterThanOrEqual(140);
    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(attempts).toBeLessThan(20);
  } finally {
    openSpy?.mockRestore();
    await lock.release().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("FileDeliveryLock: reclamation arbitration held by a living owner is never stolen after five seconds", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-live-owner-"));
  const statePath = path.join(dir, "delivery.json");
  const lockPath = `${statePath}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  const contender = new FileDeliveryLock(statePath, { timeoutMs: 150, inProcessMutex: false });
  let liveFd: number | undefined;
  try {
    fs.writeFileSync(lockPath, "", "utf8");
    const old = (Date.now() - 70000) / 1000;
    fs.utimesSync(lockPath, old, old);

    liveFd = fs.openSync(reclaimPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR);
    fs.writeFileSync(liveFd, JSON.stringify({ pid: process.pid, time: Date.now() - 6000 }), "utf8");
    const guardAge = (Date.now() - 6000) / 1000;
    fs.utimesSync(reclaimPath, guardAge, guardAge);

    await expect(contender.acquire()).rejects.toThrow(/Timed out waiting for delivery lock/);
    expect(fs.fstatSync(liveFd).nlink).toBe(1);
  } finally {
    await contender.release().catch(() => {});
    if (liveFd !== undefined) {
      try {
        fs.closeSync(liveFd);
      } catch {
        // ignore
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("FileDeliveryLock: token-bound release does not delete a successor's reclaim file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-token-bound-"));
  const statePath = path.join(dir, "delivery.json");
  const lockPath = `${statePath}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  let successorFd: number | undefined;
  let successorIno: number | undefined;

  const lock = new FileDeliveryLock(statePath, {
    timeoutMs: 150,
    _beforeReclaimRelease: () => {
      // Barrier before release: another process takes over reclaimPath with successor-token
      try {
        fs.unlinkSync(reclaimPath);
      } catch {
        // ignore
      }
      successorFd = fs.openSync(reclaimPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR);
      fs.writeFileSync(successorFd, JSON.stringify({ pid: process.pid, token: "successor-token", time: Date.now() }), "utf8");
      successorIno = fs.fstatSync(successorFd).ino;
    },
  });

  try {
    fs.writeFileSync(lockPath, "", "utf8");
    const old = (Date.now() - 70000) / 1000;
    fs.utimesSync(lockPath, old, old);

    // Acquire will execute tryReclaimAndAcquire and trigger _beforeReclaimRelease in finally
    await lock.acquire();

    expect(successorFd).toBeDefined();
    expect(fs.existsSync(reclaimPath)).toBe(true);
    expect(fs.fstatSync(successorFd!).nlink).toBe(1);
    expect(fs.fstatSync(successorFd!).ino).toBe(successorIno);
    const content = JSON.parse(fs.readFileSync(reclaimPath, "utf8")) as { token?: string };
    expect(content.token).toBe("successor-token");
  } finally {
    if (successorFd !== undefined) {
      try {
        fs.closeSync(successorFd);
      } catch {
        // ignore
      }
    }
    await lock.release().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("FileDeliveryLock: stale arbitration retirement does not delete a newly established living successor", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-stale-retire-race-"));
  const statePath = path.join(dir, "delivery.json");
  const lockPath = `${statePath}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  let successorFd: number | undefined;
  let successorIno: number | undefined;
  let hookFired = false;

  const contender = new FileDeliveryLock(statePath, {
    timeoutMs: 150,
    inProcessMutex: false,
    _beforeStaleReclaimRetire: () => {
      // Barrier before stale retirement: another cleaner removes the old guard
      // and a new living arbitrator establishes its own lock before contender unlinks.
      hookFired = true;
      try {
        fs.unlinkSync(reclaimPath);
      } catch {
        // ignore
      }
      successorFd = fs.openSync(reclaimPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR);
      fs.writeFileSync(successorFd, JSON.stringify({ pid: process.pid, token: "living-successor", time: Date.now() }), "utf8");
      successorIno = fs.fstatSync(successorFd).ino;
    },
  });

  try {
    fs.writeFileSync(lockPath, "", "utf8");
    const old = (Date.now() - 70000) / 1000;
    fs.utimesSync(lockPath, old, old);
    fs.writeFileSync(reclaimPath, "", "utf8");
    fs.utimesSync(reclaimPath, old, old);

    // Contender attempts to acquire. Because the living successor took over reclaimPath,
    // contender must NOT delete the successor and must time out safely.
    await expect(contender.acquire()).rejects.toThrow("Timed out waiting for delivery lock");

    expect(hookFired).toBe(true);
    expect(successorFd).toBeDefined();
    // Critical assertion: successor's nlink remains 1 and is NOT deleted!
    expect(fs.fstatSync(successorFd!).nlink).toBe(1);
    expect(fs.fstatSync(successorFd!).ino).toBe(successorIno);
    const content = JSON.parse(fs.readFileSync(reclaimPath, "utf8")) as { token?: string };
    expect(content.token).toBe("living-successor");
  } finally {
    if (successorFd !== undefined) {
      try {
        fs.closeSync(successorFd);
      } catch {
        // ignore
      }
    }
    await contender.release().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("FileDeliveryLock: crashed retirement authority directory is safely recovered and permits subsequent acquire", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-retire-crash-"));
  const statePath = path.join(dir, "delivery.json");
  const lockPath = `${statePath}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  const locks: FileDeliveryLock[] = [];

  try {
    const old = (Date.now() - 70000) / 1000;
    fs.writeFileSync(lockPath, "", "utf8");
    fs.utimesSync(lockPath, old, old);
    fs.writeFileSync(reclaimPath, "", "utf8");
    fs.utimesSync(reclaimPath, old, old);

    // Exact on-disk state after previous cleaner crashed after mkdirSync(authDir)
    // without writing owner metadata or finishing finally.
    const authority = `${reclaimPath}.retire-${fs.statSync(reclaimPath).ino}`;
    fs.mkdirSync(authority);
    fs.utimesSync(authority, old, old);

    // New lock instance attempts acquire. It must recover the crashed authority directory,
    // retire the stale reclaim file, and acquire the lock without timing out!
    const lock = new FileDeliveryLock(statePath, { timeoutMs: 300 });
    locks.push(lock);
    await lock.acquire();

    expect(fs.existsSync(lockPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: number };
    expect(content.pid).toBe(process.pid);
    expect(fs.readdirSync(authority).some((name) => name.endsWith(".done"))).toBe(true);
  } finally {
    for (const l of locks) {
      await l.release().catch(() => {});
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("FileDeliveryLock: retirement authority with dead process PID is safely recovered and permits subsequent acquire", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-retire-dead-pid-"));
  const statePath = path.join(dir, "delivery.json");
  const lockPath = `${statePath}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  const locks: FileDeliveryLock[] = [];

  try {
    const old = (Date.now() - 70000) / 1000;
    fs.writeFileSync(lockPath, "", "utf8");
    fs.utimesSync(lockPath, old, old);
    fs.writeFileSync(reclaimPath, "", "utf8");
    fs.utimesSync(reclaimPath, old, old);

    const authority = `${reclaimPath}.retire-${fs.statSync(reclaimPath).ino}`;
    fs.mkdirSync(authority);
    // Dead PID that does not exist in the OS process table
    const deadPid = 9999999;
    fs.writeFileSync(
      path.join(authority, "owner.json"),
      JSON.stringify({ pid: deadPid, createdAt: Date.now() - 10000 }),
      "utf8"
    );
    fs.utimesSync(authority, old, old);

    const lock = new FileDeliveryLock(statePath, { timeoutMs: 300 });
    locks.push(lock);
    await lock.acquire();

    expect(fs.existsSync(lockPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: number };
    expect(content.pid).toBe(process.pid);
    expect(fs.readdirSync(authority).some((name) => name.endsWith(".done"))).toBe(true);
  } finally {
    for (const l of locks) {
      await l.release().catch(() => {});
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("FileDeliveryLock: living retirement authority directory is not preempted and contender times out safely", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-retire-living-"));
  const statePath = path.join(dir, "delivery.json");
  const lockPath = `${statePath}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  const locks: FileDeliveryLock[] = [];

  try {
    const old = (Date.now() - 70000) / 1000;
    fs.writeFileSync(lockPath, "", "utf8");
    fs.utimesSync(lockPath, old, old);
    fs.writeFileSync(reclaimPath, "", "utf8");
    fs.utimesSync(reclaimPath, old, old);

    const authority = `${reclaimPath}.retire-${fs.statSync(reclaimPath).ino}`;
    fs.mkdirSync(authority);
    // Living process PID (process.pid) created just now
    fs.writeFileSync(
      path.join(authority, "owner.json"),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
      "utf8"
    );

    const lock = new FileDeliveryLock(statePath, { timeoutMs: 100 });
    locks.push(lock);
    // Because owner is alive, contender MUST NOT preempt and must time out
    await expect(lock.acquire()).rejects.toThrow("Timed out waiting for delivery lock");
    expect(fs.existsSync(authority)).toBe(true);
  } finally {
    for (const l of locks) {
      await l.release().catch(() => {});
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("FileDeliveryLock: living retirement authority is not preempted even when older than 60s", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-retire-living-60s-"));
  const statePath = path.join(dir, "delivery.json");
  const lockPath = `${statePath}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  const locks: FileDeliveryLock[] = [];
  let ownerFd: number | undefined;

  try {
    const old = (Date.now() - 70000) / 1000;
    fs.writeFileSync(lockPath, "", "utf8");
    fs.utimesSync(lockPath, old, old);
    fs.writeFileSync(reclaimPath, "", "utf8");
    fs.utimesSync(reclaimPath, old, old);

    const authority = `${reclaimPath}.retire-${fs.statSync(reclaimPath).ino}`;
    fs.mkdirSync(authority);
    const ownerFile = path.join(authority, "owner.json");
    ownerFd = fs.openSync(ownerFile, "wx");
    fs.writeFileSync(
      ownerFd,
      JSON.stringify({ pid: process.pid, token: "still-living", createdAt: Date.now() - 70000 }),
      "utf8"
    );
    fs.utimesSync(authority, old, old);

    const lock = new FileDeliveryLock(statePath, { timeoutMs: 150 });
    locks.push(lock);
    // Because owner is alive, contender MUST NOT preempt even when older than 60s
    await expect(lock.acquire()).rejects.toThrow("Timed out waiting for delivery lock");
    expect(fs.existsSync(authority)).toBe(true);
    expect(fs.fstatSync(ownerFd).nlink).toBe(1);
  } finally {
    if (ownerFd !== undefined) {
      try {
        fs.closeSync(ownerFd);
      } catch {
        // ignore
      }
    }
    for (const l of locks) {
      await l.release().catch(() => {});
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Round 11 reproductions adapted to the publication protocol. Every intercepted
// system call still executes; a winning successor keeps its real inode linked.
it("FileDeliveryLock: actual publication conflict preserves a fresh living successor", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-publish-race-"));
  const statePath = path.join(dir, "delivery.json");
  const guard = `${statePath}.lock.reclaim`;
  const old = new Date(Date.now() - 70000);
  for (const file of [`${statePath}.lock`, guard]) {
    fs.writeFileSync(file, "");
    fs.utimesSync(file, old, old);
  }
  const authority = `${guard}.retire-${fs.statSync(guard).ino}`;
  fs.mkdirSync(authority);
  const predecessor = path.join(authority, "owner.json");
  const deadContent = JSON.stringify({ pid: 99999999, token: "dead" });
  fs.writeFileSync(predecessor, deadContent);
  let successorFd: number | undefined;
  let successorPath = "";
  let actualConflict = false;
  const link = fs.linkSync;
  const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation((source, target) => {
    if (!successorPath && String(target).startsWith(authority)) {
      successorPath = String(target);
      const candidate = path.join(authority, "winner");
      successorFd = fs.openSync(candidate, "wx");
      fs.writeFileSync(successorFd, JSON.stringify({ pid: process.pid, token: "C-live" }));
      link(candidate, target);
      fs.unlinkSync(candidate);
    }
    try {
      return link(source, target); // Resume A's real syscall; it MUST lose with EEXIST.
    } catch (err) {
      actualConflict = (err as NodeJS.ErrnoException).code === "EEXIST";
      throw err;
    }
  });
  const unlink = fs.unlinkSync;
  const ownerUnlinks: string[] = [];
  const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
    if (target === predecessor || target === successorPath) ownerUnlinks.push(String(target));
    return unlink(target);
  });
  const lock = new FileDeliveryLock(statePath, { timeoutMs: 60, inProcessMutex: false });
  try {
    await expect(lock.acquire()).rejects.toThrow("Timed out waiting for delivery lock");
    expect(actualConflict).toBe(true);
    expect(successorFd).toBeDefined();
    expect(fs.fstatSync(successorFd!).nlink).toBe(1);
    expect(JSON.parse(fs.readFileSync(successorPath, "utf8")).token).toBe("C-live");
    expect(fs.readFileSync(predecessor, "utf8")).toBe(deadContent);
    expect(ownerUnlinks).toEqual([]);
    expect(fs.readFileSync(guard, "utf8")).toBe("");
  } finally {
    linkSpy.mockRestore();
    unlinkSpy.mockRestore();
    await lock.release();
    if (successorFd !== undefined) fs.closeSync(successorFd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it.each([
  ["absent", "ENOSPC"],
  ["dead", "EIO"],
  ["corrupt", "ENOSPC"],
])("FileDeliveryLock: %s owner publication failure (%s) closes every fd and can retry", async (initial, code) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-publish-fd-"));
  const statePath = path.join(dir, "delivery.json");
  const guard = `${statePath}.lock.reclaim`;
  const old = new Date(Date.now() - 70000);
  for (const file of [`${statePath}.lock`, guard]) {
    fs.writeFileSync(file, "");
    fs.utimesSync(file, old, old);
  }
  const authority = `${guard}.retire-${fs.statSync(guard).ino}`;
  fs.mkdirSync(authority);
  const ownerPath = path.join(authority, "owner.json");
  if (initial !== "absent") {
    fs.writeFileSync(ownerPath, initial === "dead" ? JSON.stringify({ pid: 99999999 }) : "{");
    fs.utimesSync(ownerPath, old, old);
  }
  const captured: number[] = [];
  const active = new Set<number>();
  const open = fs.openSync;
  const close = fs.closeSync;
  const write = fs.writeFileSync;
  const openSpy = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
    const fd = open(...args);
    if (String(args[0]).startsWith(path.join(authority, "candidate-"))) {
      captured.push(fd);
      active.add(fd);
    }
    return fd;
  });
  const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
    close(fd);
    active.delete(fd);
  });
  const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
    if (typeof args[0] === "number" && active.has(args[0])) {
      write(args[0], "{"); // Also exercise partially written metadata.
      throw Object.assign(new Error(`injected ${code}`), { code });
    }
    return write(...args);
  });
  const lock = new FileDeliveryLock(statePath, { timeoutMs: 60, inProcessMutex: false });
  try {
    await expect(lock.acquire()).rejects.toThrow("Timed out waiting for delivery lock");
    await lock.release();
    expect(captured.length).toBeGreaterThan(1); // Repeated polling, not just one failed write.
    expect(active.size).toBe(0);
    for (const fd of captured) expect(() => fs.fstatSync(fd)).toThrow(/EBADF/);
    expect(fs.readdirSync(authority).filter((name) => name.startsWith("candidate-"))).toEqual([]);
    expect(fs.existsSync(ownerPath)).toBe(initial !== "absent");
    writeSpy.mockRestore();
    await lock.acquire();
    expect(JSON.parse(fs.readFileSync(`${statePath}.lock`, "utf8")).pid).toBe(process.pid);
  } finally {
    writeSpy.mockRestore();
    openSpy.mockRestore();
    closeSpy.mockRestore();
    await lock.release();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("FileDeliveryLock: corrupt owner.json in authority directory is safely recovered and permits acquire", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-retire-corrupt-"));
  const statePath = path.join(dir, "delivery.json");
  const lockPath = `${statePath}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  const locks: FileDeliveryLock[] = [];

  try {
    const old = (Date.now() - 70000) / 1000;
    fs.writeFileSync(lockPath, "", "utf8");
    fs.utimesSync(lockPath, old, old);
    fs.writeFileSync(reclaimPath, "", "utf8");
    fs.utimesSync(reclaimPath, old, old);

    const authority = `${reclaimPath}.retire-${fs.statSync(reclaimPath).ino}`;
    fs.mkdirSync(authority);
    fs.writeFileSync(path.join(authority, "owner.json"), "{", "utf8");
    fs.utimesSync(path.join(authority, "owner.json"), old, old);
    fs.utimesSync(authority, old, old);

    const lock = new FileDeliveryLock(statePath, { timeoutMs: 300 });
    locks.push(lock);
    await lock.acquire();

    expect(fs.existsSync(lockPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: number };
    expect(content.pid).toBe(process.pid);
    expect(fs.readdirSync(authority).some((name) => name.endsWith(".done"))).toBe(true);
  } finally {
    for (const l of locks) {
      await l.release().catch(() => {});
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


it.each(["published", "action"])("FileDeliveryLock: a real process crash at %s recovers through a successor", async (phase) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-crash-process-"));
  const statePath = path.join(dir, "delivery.json");
  const guard = `${statePath}.lock.reclaim`;
  const old = new Date(Date.now() - 70000);
  for (const file of [`${statePath}.lock`, guard]) {
    fs.writeFileSync(file, "");
    fs.utimesSync(file, old, old);
  }
  const authority = `${guard}.retire-${fs.statSync(guard).ino}`;
  const lock = new FileDeliveryLock(statePath, { timeoutMs: 100, inProcessMutex: false });
  try {
    const child = spawnSync(process.execPath, [
      path.resolve("../../node_modules/vite-node/vite-node.mjs"),
      "test-fixtures/delivery-lock-crash.ts",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, DELIVERY_LOCK_CRASH_STATE: statePath, DELIVERY_LOCK_CRASH_PHASE: phase },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(23);
    const original = fs.readFileSync(path.join(authority, "owner.json"), "utf8");
    expect(JSON.parse(original).pid).toBe(child.pid);
    expect(fs.readdirSync(authority).some((name) => name.endsWith(".done"))).toBe(false);
    await lock.acquire();
    expect(fs.readFileSync(path.join(authority, "owner.json"), "utf8")).toBe(original);
    expect(fs.readdirSync(authority).some((name) => name.endsWith(".done"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(`${statePath}.lock`, "utf8")).pid).toBe(process.pid);
  } finally {
    await lock.release();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

it("FileDeliveryLock: actual live retirement claim survives aging and competing acquire", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-live-published-"));
  const statePath = path.join(dir, "delivery.json");
  const guard = `${statePath}.lock.reclaim`;
  const old = new Date(Date.now() - 70000);
  for (const file of [`${statePath}.lock`, guard]) {
    fs.writeFileSync(file, "");
    fs.utimesSync(file, old, old);
  }
  const authority = `${guard}.retire-${fs.statSync(guard).ino}`;
  const contender = new FileDeliveryLock(statePath, { timeoutMs: 60, inProcessMutex: false });
  let competing: Promise<unknown> | undefined;
  let before: string | undefined;
  const lock = new FileDeliveryLock(statePath, {
    inProcessMutex: false,
    _beforeStaleReclaimRetire: () => {
      const owner = path.join(authority, "owner.json");
      before = fs.readFileSync(owner, "utf8");
      fs.utimesSync(owner, old, old);
      fs.utimesSync(authority, old, old);
      // Starts while A is inside the protected action, without the process mutex.
      competing = contender.acquire().then(() => "unexpected owner", (err: Error) => err.message);
      expect(fs.readFileSync(owner, "utf8")).toBe(before);
      expect(fs.existsSync(guard)).toBe(true);
    },
  });
  try {
    await lock.acquire();
    expect(before).toBeDefined();
    expect(await competing).toMatch(/Timed out waiting for delivery lock/);
    expect(fs.readFileSync(path.join(authority, "owner.json"), "utf8")).toBe(before);
    expect(fs.readdirSync(authority).some((name) => name.endsWith(".done"))).toBe(true);
    // A second real acquisition works once A releases the main lock.
    await lock.release();
    await contender.acquire();
  } finally {
    await lock.release();
    await competing;
    await contender.release();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("FileDeliveryLock: publication I/O failure leaves no owner and closes its fd", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-link-failure-"));
  const statePath = path.join(dir, "delivery.json");
  const guard = `${statePath}.lock.reclaim`;
  const old = new Date(Date.now() - 70000);
  for (const file of [`${statePath}.lock`, guard]) {
    fs.writeFileSync(file, "");
    fs.utimesSync(file, old, old);
  }
  const authority = `${guard}.retire-${fs.statSync(guard).ino}`;
  const link = fs.linkSync;
  let failures = 0;
  const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation((source, target) => {
    if (String(target).startsWith(authority)) {
      failures++;
      throw Object.assign(new Error("injected link EIO"), { code: "EIO" });
    }
    return link(source, target);
  });
  const lock = new FileDeliveryLock(statePath, { timeoutMs: 60, inProcessMutex: false });
  try {
    await expect(lock.acquire()).rejects.toThrow("Timed out waiting for delivery lock");
    expect(failures).toBeGreaterThan(0);
    expect(fs.readdirSync(authority)).toEqual([]);
    expect(fs.readFileSync(guard, "utf8")).toBe("");
    linkSpy.mockRestore();
    await lock.acquire();
    expect(JSON.parse(fs.readFileSync(`${statePath}.lock`, "utf8")).pid).toBe(process.pid);
  } finally {
    linkSpy.mockRestore();
    await lock.release();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


it("FileDeliveryLock: rejected action cannot mark changed owner metadata completed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-owner-fence-"));
  const statePath = path.join(dir, "delivery.json");
  const guard = `${statePath}.lock.reclaim`;
  const old = new Date(Date.now() - 70000);
  for (const file of [`${statePath}.lock`, guard]) {
    fs.writeFileSync(file, "");
    fs.utimesSync(file, old, old);
  }
  const authority = `${guard}.retire-${fs.statSync(guard).ino}`;
  const replacement = JSON.stringify({ pid: process.pid, token: "changed-live-owner" });
  let hookCount = 0;
  const lock = new FileDeliveryLock(statePath, {
    timeoutMs: 60,
    inProcessMutex: false,
    _beforeStaleReclaimRetire: () => {
      hookCount++;
      fs.writeFileSync(path.join(authority, "owner.json"), replacement);
    },
  });
  try {
    await expect(lock.acquire()).rejects.toThrow("Timed out waiting for delivery lock");
    expect(hookCount).toBe(1); // Completion for the rejected token must not release the new owner.
    expect(fs.readFileSync(path.join(authority, "owner.json"), "utf8")).toBe(replacement);
    expect(fs.readFileSync(guard, "utf8")).toBe("");
    expect(fs.readFileSync(`${statePath}.lock`, "utf8")).toBe("");
  } finally {
    await lock.release();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it.each([false, true])("FileDeliveryLock: paused initial writer loses to a complete successor, write failure=%s", async (failWrite) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-initial-publication-"));
  const state = path.join(dir, "delivery.json");
  const primary = `${state}.lock`;
  const first = new FileDeliveryLock(state, { timeoutMs: 60, inProcessMutex: false });
  const second = new FileDeliveryLock(state, { timeoutMs: 60, inProcessMutex: false });
  let firstFd: number | undefined;
  let firstPath = "";
  let competing: Promise<void> | undefined;
  let interleaved = false;
  const open = fs.openSync;
  const write = fs.writeFileSync;
  const openSpy = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
    const fd = open(...args);
    if (firstFd === undefined && (args[0] === primary || String(args[0]).startsWith(`${primary}.candidate-`))) {
      firstFd = fd;
      firstPath = String(args[0]);
    }
    return fd;
  });
  const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
    if (args[0] === firstFd && !interleaved) {
      interleaved = true;
      const old = new Date(Date.now() - 70000);
      fs.utimesSync(firstPath, old, old);
      competing = second.acquire();
      if (failWrite) {
        write(...args); // Also exercise a partially/completely written candidate before EIO.
        throw Object.assign(new Error("injected late write EIO"), { code: "EIO" });
      }
    }
    return write(...args); // Resume the real write; do not suppress the losing syscall.
  });
  try {
    await expect(first.acquire()).rejects.toThrow(failWrite ? /EIO/ : /Timed out waiting/);
    expect(interleaved).toBe(true);
    expect(competing).toBeDefined();
    await competing;
    expect(() => fs.fstatSync(firstFd!)).toThrow(/EBADF/);
    const owner = fs.readFileSync(primary, "utf8");
    expect(JSON.parse(owner).pid).toBe(process.pid);
    await first.release();
    expect(fs.readFileSync(primary, "utf8")).toBe(owner);
    expect(fs.statSync(primary).nlink).toBe(1);
    expect(fs.readdirSync(dir).some((name) => name.includes(".candidate-"))).toBe(false);
    await second.release();
    expect(fs.existsSync(primary)).toBe(false);
  } finally {
    writeSpy.mockRestore();
    openSpy.mockRestore();
    await competing?.catch(() => {});
    await first.release();
    await second.release();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


it.each([
  ["recovered-main", false], ["recovered-main", true],
  ["new-reclaim", false], ["new-reclaim", true],
  ["recovered-reclaim", false], ["recovered-reclaim", true],
] as const)(
  "FileDeliveryLock: paused %s publication preserves the winner, write failure=%s",
  async (phase, failWrite) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lock-recovery-publication-"));
    const state = path.join(dir, "delivery.json");
    const primary = `${state}.lock`;
    const guard = `${primary}.reclaim`;
    const old = new Date(Date.now() - 70000);
    fs.writeFileSync(primary, "");
    fs.utimesSync(primary, old, old);
    if (phase === "recovered-reclaim") {
      fs.writeFileSync(guard, "");
      fs.utimesSync(guard, old, old);
    }
    const first = new FileDeliveryLock(state, { timeoutMs: 60, inProcessMutex: false });
    const second = new FileDeliveryLock(state, { timeoutMs: 60, inProcessMutex: false });
    const prefix = `${phase === "recovered-main" ? primary : guard}.candidate-`;
    const targetAttempt = phase === "new-reclaim" ? 1 : 2;
    let attempts = 0;
    let pausedFd: number | undefined;
    let pausedPath = "";
    let interleaved = false;
    let competing: Promise<void> | undefined;
    const open = fs.openSync;
    const write = fs.writeFileSync;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      const fd = open(...args);
      if (String(args[0]).startsWith(prefix) && ++attempts === targetAttempt) {
        pausedFd = fd;
        pausedPath = String(args[0]);
      }
      return fd;
    });
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
      if (args[0] === pausedFd && !interleaved) {
        interleaved = true;
        fs.utimesSync(pausedPath, old, old);
        competing = second.acquire();
      }
      if (args[0] === pausedFd && failWrite && fs.existsSync(pausedPath)) {
        write(...args);
        throw Object.assign(new Error("injected recovery write EIO"), { code: "EIO" });
      }
      return write(...args);
    });
    try {
      await expect(first.acquire()).rejects.toThrow(/Timed out waiting/);
      expect(interleaved).toBe(true);
      expect(competing).toBeDefined();
      await competing;
      const winner = fs.readFileSync(primary, "utf8");
      expect(JSON.parse(winner).pid).toBe(process.pid);
      expect(() => fs.fstatSync(pausedFd!)).toThrow(/EBADF/);
      await first.release();
      expect(fs.readFileSync(primary, "utf8")).toBe(winner);
      expect(fs.statSync(primary).nlink).toBe(1);
      expect(fs.existsSync(guard)).toBe(false);
      expect(fs.readdirSync(dir).some((name) => name.includes(".candidate-"))).toBe(false);
      await second.release();
      expect(fs.existsSync(primary)).toBe(false);
    } finally {
      writeSpy.mockRestore();
      openSpy.mockRestore();
      await competing?.catch(() => {});
      await first.release();
      await second.release();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
