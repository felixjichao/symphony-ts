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
  const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((...args: any[]) => {
    const target = args[0];
    if (typeof target === "number" && !writeInjected) {
      writeInjected = true;
      const err = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
      err.code = "ENOSPC";
      throw err;
    }
    return (originalWriteFileSync as any)(...args);
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
    const content = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    expect(content.pid).toBe(process.pid);
    expect(typeof content.token).toBe("string");

    await lock.release();
    expect(fs.existsSync(lockFile)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


