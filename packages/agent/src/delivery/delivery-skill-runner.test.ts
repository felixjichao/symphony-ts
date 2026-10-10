import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type {
  DecisionContextBundle,
  DecisionReviewTarget,
  DecisionTask,
  DeliveryReviewApprovalResult,
  DeliveryReviewGate,
  DeliveryReviewStatusResult,
  PersistedDeliveryState,
  UtcTimestampMs,
} from "@symphony/domain";
import { runDeliverySkill, type RunDeliverySkillOptions } from "./delivery-skill-runner";
import type { DeliveryGitGhRunner, DeliverySubprocessResult } from "./git-gh-runner";

class MockDeliveryRunner implements DeliveryGitGhRunner {
  readonly gitCalls: Array<{ args: readonly string[]; cwd: string }> = [];
  readonly ghCalls: Array<{ args: readonly string[]; cwd: string }> = [];
  readonly execCalls: Array<{ command: string; cwd: string }> = [];

  gitResponses: Array<DeliverySubprocessResult | ((args: readonly string[]) => DeliverySubprocessResult)> = [];
  ghResponses: Array<DeliverySubprocessResult | ((args: readonly string[]) => DeliverySubprocessResult)> = [];
  execResponses: Array<DeliverySubprocessResult | ((command: string) => DeliverySubprocessResult)> = [];

  lastRevParseSha: string | null = null;
  currentPrHead: string | null = null;
  headRefOidResponses: Array<DeliverySubprocessResult | ((args: readonly string[]) => DeliverySubprocessResult)> = [];

  async git(args: readonly string[], cwd: string): Promise<DeliverySubprocessResult> {
    this.gitCalls.push({ args, cwd });
    if (args[0] === "show" && typeof args[1] === "string" && (args[1] === "HEAD:AGENTS.md" || args[1].endsWith(":AGENTS.md"))) {
      return { stdout: "# Symphony Workspace Rules", stderr: "", exitCode: 0 };
    }
    if (args[0] === "diff" && args.some((a) => typeof a === "string" && a.includes("..."))) {
      const commitRange = args.find((a) => typeof a === "string" && a.includes("..."))!;
      const [_baseSha, headSha] = commitRange.split("...");
      return {
        stdout: `diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new in ${headSha}\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    if (args[0] === "cat-file" && args[1] === "-e") {
      const ref = args[2] ?? "";
      if (ref.includes("b-only.ts") && !ref.startsWith("b".repeat(40))) {
        return { stdout: "", stderr: "fatal: path 'b-only.ts' does not exist in commit", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    const next = this.gitResponses.shift();
    let res: DeliverySubprocessResult;
    if (typeof next === "function") {
      res = next(args);
    } else {
      res = next ?? { stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "rev-parse") {
      this.lastRevParseSha = res.stdout.trim();
      this.currentPrHead = this.lastRevParseSha;
    }
    return res;
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
      return args[1] === "list"
        ? { stdout: JSON.stringify([{ databaseId: 12345, name: "CI", conclusion: "FAILURE", detailsUrl: "https://github.com/felixjichao/symphony-ts/actions/runs/12345" }]), stderr: "", exitCode: 0 }
        : { stdout: "test: assertion failed", stderr: "", exitCode: 0 };
    }
    if (args[0] === "issue" && args[1] === "view" && args.some((a) => a.includes("title,body"))) {
      return { stdout: JSON.stringify({ title: "issue 80", body: "body 80" }), stderr: "", exitCode: 0 };
    }
    if (args[0] === "api" && typeof args[1] === "string" && args[1].includes("pulls/")) {
      return {
        stdout: JSON.stringify({
          title: "feat: delivery",
          body: "pr body",
          base: {
            sha: "73f055c6a2d07ddd45a120bd29915b94d5346663",
            ref: "main",
          },
          head: {
            sha: this.currentPrHead ?? this.lastRevParseSha ?? "1234567890abcdef1234567890abcdef12345678",
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
          headRefOid: this.currentPrHead ?? this.lastRevParseSha ?? "1234567890abcdef1234567890abcdef12345678",
          baseRefName: "main",
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    if (args[0] === "pr" && args[1] === "diff") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "pr" && args[1] === "view" && args.some((a) => a.includes("mergeable") && a.includes("statusCheckRollup"))) {
      if (args.some((a) => a.includes("body"))) {
        const next = this.ghResponses.shift();
        const nextObj = typeof next === "object" && next !== null ? next : undefined;
        const parsed = nextObj ? JSON.parse(nextObj.stdout || "{}") : {};
        return {
          stdout: JSON.stringify({
            headRefOid: parsed.headRefOid ?? this.currentPrHead ?? this.lastRevParseSha ?? "1234567890abcdef1234567890abcdef12345678",
            state: parsed.state ?? "OPEN",
            isDraft: parsed.isDraft ?? false,
            mergeable: parsed.mergeable ?? "MERGEABLE",
            body: parsed.body ?? "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
            statusCheckRollup: parsed.statusCheckRollup ?? [
              { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" },
            ],
            ...parsed,
          }),
          stderr: nextObj?.stderr ?? "",
          exitCode: nextObj?.exitCode ?? 0,
        };
      }
      if (this.ghResponses.length > 0) {
        const next = this.ghResponses.shift()!;
        if (typeof next === "function") return next(args);
        try {
          const p = JSON.parse(next.stdout || "{}");
          if (p.headRefOid) this.currentPrHead = p.headRefOid;
        } catch {
          // ignore malformed stdout
        }
        return next;
      }
      return {
        stdout: JSON.stringify({
          headRefOid: this.currentPrHead ?? this.lastRevParseSha ?? "1234567890abcdef1234567890abcdef12345678",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
          statusCheckRollup: [
            { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" },
          ],
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("headRefOid") && !args.includes("statusCheckRollup")) {
      const nextHead = this.headRefOidResponses.shift();
      if (typeof nextHead === "function") return nextHead(args);
      if (nextHead) {
        try {
          const p = JSON.parse(nextHead.stdout || "{}");
          if (p.headRefOid) this.currentPrHead = p.headRefOid;
        } catch {
          // ignore malformed stdout
        }
        return nextHead;
      }
      return { stdout: JSON.stringify({ headRefOid: this.currentPrHead ?? this.lastRevParseSha ?? "1234567890abcdef1234567890abcdef12345678" }), stderr: "", exitCode: 0 };
    }
    const next = this.ghResponses.shift();
    if (typeof next === "function") {
      return next(args);
    }
    return next ?? { stdout: "", stderr: "", exitCode: 0 };
  }

  async exec(command: string, cwd: string): Promise<DeliverySubprocessResult> {
    this.execCalls.push({ command, cwd });
    const next = this.execResponses.shift();
    if (typeof next === "function") {
      return next(command);
    }
    return next ?? { stdout: "", stderr: "", exitCode: 0 };
  }
}

class MockReviewGate implements DeliveryReviewGate {
  ensureReviewTaskCallCount = 0;
  verifyReviewApprovalCallCount = 0;
  getReviewStatusCallCount = 0;
  supersedeReviewTaskCallCount = 0;

  reviewTaskToReturn: DecisionTask | null = null;
  statusResults: DeliveryReviewStatusResult[] = [];
  approvalResults: DeliveryReviewApprovalResult[] = [];
  supersededTaskIds: string[] = [];

  async ensureReviewTask(
    sessionId: string,
    target: DecisionReviewTarget,
    _context?: DecisionContextBundle,
  ): Promise<DecisionTask> {
    this.ensureReviewTaskCallCount++;
    if (this.reviewTaskToReturn) return this.reviewTaskToReturn;
    return {
      schemaVersion: 1,
      id: `task-review-test-${target.headSha}`,
      sessionId,
      kind: "review",
      revision: 1,
      status: "completed",
      lease: null,
      claimGeneration: 1,
      lastClaimToken: "token-1",
      createdAtMs: 1_000_000 as UtcTimestampMs,
      updatedAtMs: 1_000_000 as UtcTimestampMs,
      target,
    };
  }

  async getReviewStatus(taskId: string): Promise<DeliveryReviewStatusResult> {
    this.getReviewStatusCallCount++;
    const next = this.statusResults.shift();
    if (next) return next;
    const shaMatch = taskId.match(/task-review-test-(.+)$/);
    const headSha = shaMatch ? shaMatch[1] : "1234567890abcdef1234567890abcdef12345678";
    return {
      taskId,
      status: "completed",
      result: {
        schemaVersion: 1,
        taskId,
        sessionId: "github:felixjichao/symphony-ts#80",
        kind: "review",
        revision: 1,
        createdAtMs: 1_000_000 as UtcTimestampMs,
        verdict: "approve",
        target: {
          repository: "felixjichao/symphony-ts",
          prNumber: 85,
          headSha: headSha!,
        },
        findings: [],
      },
    };
  }

  async verifyReviewApproval(
    target: DecisionReviewTarget & { readonly sessionId?: string },
  ): Promise<DeliveryReviewApprovalResult> {
    this.verifyReviewApprovalCallCount++;
    const next = this.approvalResults.shift();
    if (next) return next;
    return {
      approved: true,
      reason: "Approved in mock",
      taskId: `task-review-test-${target.headSha}`,
      headSha: target.headSha,
      verdict: "approve",
    };
  }

  async supersedeReviewTask(taskId: string): Promise<void> {
    this.supersedeReviewTaskCallCount++;
    this.supersededTaskIds.push(taskId);
  }
}

describe("Codex Delivery + Land Workflow Skill Runner", () => {
  const createTempCwd = () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-skill-test-"));
    return tmp;
  };

  let testClock = 1_000_000;
  const getBaseOptions = (cwd: string): Omit<RunDeliverySkillOptions, "runner"> => ({
    cwd,
    repo: "felixjichao/symphony-ts",
    issueNumber: 80,
    workspaceKey: "GH-80",
    headBranch: "symphony/GH-80",
    baseBranch: "main",
    validationCommand: "npm test",
    readyLabel: "symphony-ready",
    maxRepairAttempts: 2,
    maxWaitSeconds: 15,
    pollIntervalSeconds: 5,
    optInLand: true,
    reviewGate: new MockReviewGate(),
    nowFn: () => testClock,
    sleepFn: async (s) => {
      testClock += s * 1000;
    },
  });

  const setupPreMutationSuccess = (runner: MockDeliveryRunner, headBranch = "symphony/GH-80", repo = "felixjichao/symphony-ts") => {
    // 1. git branch --show-current
    runner.gitResponses.push({ stdout: `${headBranch}\n`, stderr: "", exitCode: 0 });
    // 2. git remote get-url origin
    runner.gitResponses.push({ stdout: `https://github.com/${repo}.git\n`, stderr: "", exitCode: 0 });
    // 3. gh issue view
    runner.ghResponses.push({
      stdout: JSON.stringify({ state: "OPEN", labels: [{ name: "symphony-ready" }], title: "issue 80" }),
      stderr: "",
      exitCode: 0,
    });
  };

  it("验收 1: 能够进行前置检查、运行项目验证、提交 (commit) 并推送到远端 (push)", async () => {
    const cwd = createTempCwd();
    const runner = new MockDeliveryRunner();

    setupPreMutationSuccess(runner);

    // 4. gh pr list
    runner.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 85,
          url: "https://github.com/felixjichao/symphony-ts/pull/85",
          title: "feat: delivery",
          state: "OPEN",
          headRefOid: "1234567890abcdef1234567890abcdef12345678",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });

    // 5. validationCommand exec
    runner.execResponses.push({ stdout: "tests passed", stderr: "", exitCode: 0 });

    // 6. git status porcelain (dirty)
    runner.gitResponses.push({ stdout: " M src/index.ts\n", stderr: "", exitCode: 0 });
    // 7. git add -A
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    // 8. git commit -m
    runner.gitResponses.push({ stdout: "[symphony/GH-80 1234567] feat commit", stderr: "", exitCode: 0 });
    // 9. git push origin symphony/GH-80
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    // 10. git rev-parse HEAD
    runner.gitResponses.push({ stdout: "1234567890abcdef1234567890abcdef12345678\n", stderr: "", exitCode: 0 });

    // 11. gh pr view (checks green via statusCheckRollup)
    runner.ghResponses.push({
      stdout: JSON.stringify({
        headRefOid: "1234567890abcdef1234567890abcdef12345678",
        mergeable: "MERGEABLE",
        state: "OPEN",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" },
        ],
      }),
      stderr: "",
      exitCode: 0,
    });

    // 12. gh pr view mergeable check before land
    runner.ghResponses.push({
      stdout: JSON.stringify({ mergeable: "MERGEABLE", state: "OPEN" }),
      stderr: "",
      exitCode: 0,
    });

    // 13. gh pr merge
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });

    // 14. gh pr view post-merge verify
    runner.ghResponses.push({
      stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "mergedsha999" } }),
      stderr: "",
      exitCode: 0,
    });

    // 15. gh issue view close verify
    runner.ghResponses.push({
      stdout: JSON.stringify({ state: "CLOSED" }),
      stderr: "",
      exitCode: 0,
    });

    const result = await runDeliverySkill({ ...getBaseOptions(cwd), runner });
    expect(result.status).toBe("completed");
    expect(result.prNumber).toBe(85);
    expect(result.mergeSha).toBe("mergedsha999");

    // 验证真实执行了 validationCommand
    expect(runner.execCalls).toHaveLength(1);
    expect(runner.execCalls[0]?.command).toBe("npm test");

    // 验证调用了 git commit 和 git push
    const gitCommitCall = runner.gitCalls.find((c) => c.args[0] === "commit");
    expect(gitCommitCall).toBeDefined();
    const gitPushCall = runner.gitCalls.find((c) => c.args[0] === "push");
    expect(gitPushCall).toBeDefined();
    expect(gitPushCall?.args).toContain("symphony/GH-80");
  });

  it("验收 2: 无 PR 时自动创建，已有 PR 时自动复用", async () => {
    // 场景 A: 无 PR -> 创建
    const cwdA = createTempCwd();
    const runnerA = new MockDeliveryRunner();
    setupPreMutationSuccess(runnerA);
    // gh pr list returns empty
    runnerA.ghResponses.push({ stdout: "[]", stderr: "", exitCode: 0 });
    runnerA.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 }); // validation
    runnerA.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status clean
    runnerA.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // push
    runnerA.gitResponses.push({ stdout: "head111\n", stderr: "", exitCode: 0 }); // rev-parse
    // gh pr create
    runnerA.ghResponses.push({
      stdout: "https://github.com/felixjichao/symphony-ts/pull/101\n",
      stderr: "",
      exitCode: 0,
    });
    // gh pr view checks (green)
    runnerA.ghResponses.push({
      stdout: JSON.stringify({
        headRefOid: "head111",
        mergeable: "MERGEABLE",
        state: "OPEN",
        statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
      stderr: "",
      exitCode: 0,
    });
    runnerA.ghResponses.push({ stdout: JSON.stringify({ mergeable: "MERGEABLE", state: "OPEN" }), stderr: "", exitCode: 0 });
    runnerA.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // merge
    runnerA.ghResponses.push({ stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "sha101" } }), stderr: "", exitCode: 0 });
    runnerA.ghResponses.push({ stdout: JSON.stringify({ state: "CLOSED" }), stderr: "", exitCode: 0 }); // issue closed

    const resA = await runDeliverySkill({ ...getBaseOptions(cwdA), runner: runnerA });
    expect(resA.status).toBe("completed");
    expect(resA.prNumber).toBe(101);
    const prCreateCall = runnerA.ghCalls.find((c) => c.args[0] === "pr" && c.args[1] === "create");
    expect(prCreateCall).toBeDefined();

    // 场景 B: 已有 PR -> 复用，不调用 pr create
    const cwdB = createTempCwd();
    const runnerB = new MockDeliveryRunner();
    setupPreMutationSuccess(runnerB);
    // gh pr list returns existing PR
    runnerB.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 88,
          url: "https://github.com/felixjichao/symphony-ts/pull/88",
          title: "feat: delivery",
          state: "OPEN",
          headRefOid: "head222",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });
    runnerB.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 });
    runnerB.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status
    runnerB.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // push
    runnerB.gitResponses.push({ stdout: "head222\n", stderr: "", exitCode: 0 }); // rev-parse
    runnerB.ghResponses.push({
      stdout: JSON.stringify({
        headRefOid: "head222",
        mergeable: "MERGEABLE",
        state: "OPEN",
        statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
      stderr: "",
      exitCode: 0,
    });
    runnerB.ghResponses.push({ stdout: JSON.stringify({ mergeable: "MERGEABLE", state: "OPEN" }), stderr: "", exitCode: 0 });
    runnerB.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // merge
    runnerB.ghResponses.push({ stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "sha88" } }), stderr: "", exitCode: 0 });
    runnerB.ghResponses.push({ stdout: JSON.stringify({ state: "CLOSED" }), stderr: "", exitCode: 0 });

    const resB = await runDeliverySkill({ ...getBaseOptions(cwdB), runner: runnerB });
    expect(resB.status).toBe("completed");
    expect(resB.prNumber).toBe(88);
    const noPrCreate = runnerB.ghCalls.find((c) => c.args[0] === "pr" && c.args[1] === "create");
    expect(noPrCreate).toBeUndefined();
  });

  it("验收 3 & 4: CI failed 进入修复循环并再次 push，CI green 后进入 land 判断并 squash merge", async () => {
    const cwd = createTempCwd();
    const runner = new MockDeliveryRunner();
    setupPreMutationSuccess(runner);

    // gh pr list (existing PR #90)
    runner.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 90,
          url: "https://github.com/felixjichao/symphony-ts/pull/90",
          title: "feat: delivery",
          state: "OPEN",
          headRefOid: "sha-head-1",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });

    runner.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 }); // initial validation
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // push
    runner.gitResponses.push({ stdout: "sha-head-1\n", stderr: "", exitCode: 0 }); // rev-parse

    // 第一次 checks: 失败！
    runner.ghResponses.push({
      stdout: JSON.stringify({
        headRefOid: "sha-head-1",
        mergeable: "MERGEABLE",
        state: "OPEN",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/felixjichao/symphony-ts/actions/runs/12345" },
        ],
      }),
      stderr: "",
      exitCode: 0,
    });

    // 修复阶段：
    // validationCommand re-run after repair
    runner.execResponses.push({ stdout: "validation after fix ok", stderr: "", exitCode: 0 });
    // git status (dirty check)
    runner.gitResponses.push({ stdout: " M src/index.ts\n", stderr: "", exitCode: 0 });
    // git add -A
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    // git commit
    runner.gitResponses.push({ stdout: "[symphony/GH-80 555] fix(ci)", stderr: "", exitCode: 0 });
    // git push
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    // git rev-parse (new SHA)
    runner.gitResponses.push({ stdout: "sha-head-repaired\n", stderr: "", exitCode: 0 });

    // 第二次 checks: 成功 (Green)!
    runner.ghResponses.push({
      stdout: JSON.stringify({
        headRefOid: "sha-head-repaired",
        mergeable: "MERGEABLE",
        state: "OPEN",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        ],
      }),
      stderr: "",
      exitCode: 0,
    });

    // merge & verify
    runner.ghResponses.push({ stdout: JSON.stringify({ mergeable: "MERGEABLE", state: "OPEN" }), stderr: "", exitCode: 0 });
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // merge
    runner.ghResponses.push({
      stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "mergedsha-fixed" } }),
      stderr: "",
      exitCode: 0,
    });
    runner.ghResponses.push({ stdout: JSON.stringify({ state: "CLOSED" }), stderr: "", exitCode: 0 });

    let repairCalled = false;
    const result = await runDeliverySkill({
      ...getBaseOptions(cwd),
      runner,
      repairFn: async (_context) => {
        repairCalled = true;
        return true;
      },
    });

    expect(repairCalled).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.spentRepairs).toBe(1);
    expect(result.mergeSha).toBe("mergedsha-fixed");

    // 检查是否有修复后的 push
    const pushCalls = runner.gitCalls.filter((c) => c.args[0] === "push");
    expect(pushCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("repairCommand (reference profile): CI 失败 → 执行 --repair-cmd → 新 SHA → green → land", async () => {
    const cwd = createTempCwd();
    const runner = new MockDeliveryRunner();
    setupPreMutationSuccess(runner);

    // gh pr list (existing PR #90)
    runner.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 90,
          url: "https://github.com/felixjichao/symphony-ts/pull/90",
          title: "feat: delivery",
          state: "OPEN",
          headRefOid: "sha-head-1",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });

    runner.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 }); // initial validation
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // push
    runner.gitResponses.push({ stdout: "sha-head-1\n", stderr: "", exitCode: 0 }); // rev-parse

    // 第一次 checks: 失败！
    runner.ghResponses.push({
      stdout: JSON.stringify({
        headRefOid: "sha-head-1",
        mergeable: "MERGEABLE",
        state: "OPEN",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/felixjichao/symphony-ts/actions/runs/12345" },
        ],
      }),
      stderr: "",
      exitCode: 0,
    });

    // 修复阶段：先执行 --repair-cmd，再重新运行 validation
    runner.execResponses.push({ stdout: "repaired", stderr: "", exitCode: 0 }); // repair command
    runner.execResponses.push({ stdout: "validation after fix ok", stderr: "", exitCode: 0 }); // validation re-run
    runner.gitResponses.push({ stdout: " M src/index.ts\n", stderr: "", exitCode: 0 }); // git status (dirty)
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // git add -A
    runner.gitResponses.push({ stdout: "[symphony/GH-80 555] fix(ci)", stderr: "", exitCode: 0 }); // git commit
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // git push
    runner.gitResponses.push({ stdout: "sha-head-repaired\n", stderr: "", exitCode: 0 }); // rev-parse (new SHA)

    // 第二次 checks: 成功 (Green)!
    runner.ghResponses.push({
      stdout: JSON.stringify({
        headRefOid: "sha-head-repaired",
        mergeable: "MERGEABLE",
        state: "OPEN",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        ],
      }),
      stderr: "",
      exitCode: 0,
    });

    // merge & verify
    runner.ghResponses.push({ stdout: JSON.stringify({ mergeable: "MERGEABLE", state: "OPEN" }), stderr: "", exitCode: 0 });
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // merge
    runner.ghResponses.push({
      stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "mergedsha-repair-cmd" } }),
      stderr: "",
      exitCode: 0,
    });
    runner.ghResponses.push({ stdout: JSON.stringify({ state: "CLOSED" }), stderr: "", exitCode: 0 });

    const result = await runDeliverySkill({
      ...getBaseOptions(cwd),
      runner,
      repairCommand: "npm run ci:fix",
    });

    expect(result.status).toBe("completed");
    expect(result.spentRepairs).toBe(1);
    expect(result.mergeSha).toBe("mergedsha-repair-cmd");
    // 修复入口确实被执行，且不是凭空成功：修复后产生了新的 SHA 并再次 push。
    expect(runner.execCalls.map((c) => c.command)).toContain("npm run ci:fix");
    const pushCalls = runner.gitCalls.filter((c) => c.args[0] === "push");
    expect(pushCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("验收 5 & 6: 修复次数超限终止，输出 Blocker 交接报告并移除 symphony-ready 标签停止派发", async () => {
    const cwd = createTempCwd();
    const runner = new MockDeliveryRunner();
    setupPreMutationSuccess(runner);

    // gh pr list
    runner.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 95,
          url: "https://github.com/felixjichao/symphony-ts/pull/95",
          title: "feat: delivery",
          state: "OPEN",
          headRefOid: "sha-head-err",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });

    runner.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "sha-head-err\n", stderr: "", exitCode: 0 });

    // 循环返回 CI failed
    const failChecks = {
      stdout: JSON.stringify({
        headRefOid: "sha-head-err",
        statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/felixjichao/symphony-ts/actions/runs/12345" }],
      }),
      stderr: "",
      exitCode: 0,
    };
    runner.ghResponses.push(failChecks); // check 1 -> attempt 1
    // repair 1
    runner.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: " M fix1", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "commit 1", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "sha-head-rep1\n", stderr: "", exitCode: 0 });

    const failChecks2 = {
      stdout: JSON.stringify({
        headRefOid: "sha-head-rep1",
        statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/felixjichao/symphony-ts/actions/runs/12345" }],
      }),
      stderr: "",
      exitCode: 0,
    };
    runner.ghResponses.push(failChecks2); // check 2 -> attempt 2
    // repair 2
    runner.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: " M fix2", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "commit 2", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "sha-head-rep2\n", stderr: "", exitCode: 0 });

    const failChecks3 = {
      stdout: JSON.stringify({
        headRefOid: "sha-head-rep2",
        statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/felixjichao/symphony-ts/actions/runs/12345" }],
      }),
      stderr: "",
      exitCode: 0,
    };
    runner.ghResponses.push(failChecks3); // check 3 -> exceeds maxRepairAttempts (2)

    // haltDispatch actions:
    // 1. gh issue edit 80 --remove-label symphony-ready
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    // 2. gh issue view 80 --json labels (verify label removed)
    runner.ghResponses.push({ stdout: JSON.stringify({ labels: [] }), stderr: "", exitCode: 0 });
    // 3. gh pr comment 95 --body ...
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });

    const result = await runDeliverySkill({
      ...getBaseOptions(cwd),
      maxRepairAttempts: 2,
      repairFn: async () => true,
      runner,
    });

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("ci_failed_max_repairs");
    expect(result.spentRepairs).toBe(2);
    expect(result.handoffMarkdown).toContain("Symphony Delivery Handoff Report");
    expect(result.handoffMarkdown).toContain("移除 `symphony-ready` 标签");

    // 验证调用了 gh issue edit --remove-label symphony-ready
    const removeLabelCall = runner.ghCalls.find(
      (c) =>
        c.args[0] === "issue" &&
        c.args[1] === "edit" &&
        c.args.includes("--remove-label") &&
        c.args.includes("symphony-ready"),
    );
    expect(removeLabelCall).toBeDefined();

    // 验证发表了 PR 交接评论
    const commentCall = runner.ghCalls.find(
      (c) => c.args[0] === "pr" && c.args[1] === "comment",
    );
    expect(commentCall).toBeDefined();
  });

  it("Blocker 1 回归: 严格校验 PR 所属标记，拒绝无 marker 或外来 PR", async () => {
    const cwd = createTempCwd();
    const runner = new MockDeliveryRunner();
    setupPreMutationSuccess(runner);

    // gh pr list returns a foreign PR with Fixes #80 but no valid marker
    runner.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 77,
          url: "https://github.com/felixjichao/symphony-ts/pull/77",
          title: "foreign PR",
          state: "OPEN",
          headRefOid: "foreign123",
          body: "Fixes #80 (submitted by external contributor without marker)",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });

    // haltDispatch actions
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // edit label
    runner.ghResponses.push({ stdout: JSON.stringify({ labels: [] }), stderr: "", exitCode: 0 }); // check labels
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // comment

    const result = await runDeliverySkill({ ...getBaseOptions(cwd), runner });
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("foreign_pr_conflict");

    // 确保没有发生任何 commit 或 push
    const gitCommit = runner.gitCalls.find((c) => c.args[0] === "commit");
    expect(gitCommit).toBeUndefined();
    const gitPush = runner.gitCalls.find((c) => c.args[0] === "push");
    expect(gitPush).toBeUndefined();
  });

  it("Blocker 2 回归: 真实执行 validationCommand，失败时禁止 commit/push/land", async () => {
    const cwd = createTempCwd();
    const runner = new MockDeliveryRunner();
    setupPreMutationSuccess(runner);

    // gh pr list returns empty
    runner.ghResponses.push({ stdout: "[]", stderr: "", exitCode: 0 });

    // validationCommand exec returns exitCode 1 (FAILED!)
    runner.execResponses.push({ stdout: "Tests failed!", stderr: "assertion error", exitCode: 1 });

    // haltDispatch actions
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // edit label
    runner.ghResponses.push({ stdout: JSON.stringify({ labels: [] }), stderr: "", exitCode: 0 }); // check label
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // comment

    const result = await runDeliverySkill({
      ...getBaseOptions(cwd),
      validationCommand: "npm run test:gate",
      runner,
    });

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("manual_intervention_required");
    expect(result.handoffMarkdown).toContain("Project validation command 'npm run test:gate' failed");

    // 绝不触发 commit 或 push
    const gitCommit = runner.gitCalls.find((c) => c.args[0] === "commit");
    expect(gitCommit).toBeUndefined();
    const gitPush = runner.gitCalls.find((c) => c.args[0] === "push");
    expect(gitPush).toBeUndefined();
  });

  it("Blocker 9 回归: 未显式 optInLand 时只停在 ready_to_land，不执行 merge", async () => {
    const cwd = createTempCwd();
    const runner = new MockDeliveryRunner();
    setupPreMutationSuccess(runner);

    runner.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 88,
          url: "https://github.com/felixjichao/symphony-ts/pull/88",
          title: "feat: delivery",
          state: "OPEN",
          headRefOid: "sha88",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });

    runner.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "sha88\n", stderr: "", exitCode: 0 });

    // checks green
    runner.ghResponses.push({
      stdout: JSON.stringify({
        headRefOid: "sha88",
        mergeable: "MERGEABLE",
        state: "OPEN",
        statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
      stderr: "",
      exitCode: 0,
    });

    const result = await runDeliverySkill({
      ...getBaseOptions(cwd),
      optInLand: false, // 禁用自动 merge
      runner,
    });

    expect(result.status).toBe("ready_to_land");
    expect(result.prNumber).toBe(88);
    expect(result.reason).toBe("ci_green_opt_in_disabled");

    // 确保没有调用 gh pr merge
    const mergeCall = runner.ghCalls.find((c) => c.args[0] === "pr" && c.args[1] === "merge");
    expect(mergeCall).toBeUndefined();
  });

  it("Blocker 7 (Origin 仓库与主机核验): 拒绝非 github.com 或异主机 origin URL，推送前安全终止", async () => {
    const cwd = createTempCwd();
    const runner = new MockDeliveryRunner();
    runner.gitResponses.push({ stdout: "symphony/GH-80\n", stderr: "", exitCode: 0 }); // branch
    // remote URL with invalid other host
    runner.gitResponses.push({ stdout: "https://other.invalid/felixjichao/symphony-ts.git\n", stderr: "", exitCode: 0 });

    const result = await runDeliverySkill({ ...getBaseOptions(cwd), runner });
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("manual_intervention_required");
    expect(result.handoffMarkdown).toContain("does not match expected GitHub repo");

    // 确保没有执行任何 push 或 commit
    expect(runner.gitCalls.some((c) => c.args[0] === "push")).toBe(false);
  });

  it("Blocker 8 (CI 安全校验): 当 PR 缺少 headRefOid 或与当前已推送 HEAD 不一致时等待/拒绝进入 Land", async () => {
    const cwd = createTempCwd();
    const runner = new MockDeliveryRunner();
    setupPreMutationSuccess(runner);

    runner.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 89,
          url: "https://github.com/felixjichao/symphony-ts/pull/89",
          title: "feat: delivery",
          state: "OPEN",
          headRefOid: "pushedSha99",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });

    runner.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // push
    runner.gitResponses.push({ stdout: "pushedSha99\n", stderr: "", exitCode: 0 }); // rev-parse HEAD

    // PR view response has successful checks but MISSING headRefOid
    runner.ghResponses.push({
      stdout: JSON.stringify({
        // headRefOid is missing!
        mergeable: "MERGEABLE",
        state: "OPEN",
        statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
      stderr: "",
      exitCode: 0,
    });

    const result = await runDeliverySkill({
      ...getBaseOptions(cwd),
      maxWaitSeconds: 5,
      pollIntervalSeconds: 5,
      requiredChecks: ["gate"],
      runner,
    });

    // 缺少 headRefOid 必须被判定为 pending 并超时终止，绝不能直接调用 merge
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("ci_wait_timeout");
    expect(runner.ghCalls.some((c) => c.args[0] === "pr" && c.args[1] === "merge")).toBe(false);
  });

  it("Blocker 9 (已合入重入终态闭环): 已 MERGED PR 且 Issue CLOSED 时返回 completed 与真实 mergeSha，不误判人工介入", async () => {
    const cwd = createTempCwd();
    const runner = new MockDeliveryRunner();
    runner.gitResponses.push({ stdout: "symphony/GH-80\n", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "https://github.com/felixjichao/symphony-ts.git\n", stderr: "", exitCode: 0 });

    // gh issue view (CLOSED)
    runner.ghResponses.push({
      stdout: JSON.stringify({ state: "CLOSED", labels: [] }),
      stderr: "",
      exitCode: 0,
    });

    // gh pr list returns MERGED PR
    runner.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 90,
          url: "https://github.com/felixjichao/symphony-ts/pull/90",
          title: "feat: delivery",
          state: "MERGED",
          headRefOid: "headRef123",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });

    // gh pr view to get actual mergeCommit
    runner.ghResponses.push({
      stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "realSquashMergeSha777" } }),
      stderr: "",
      exitCode: 0,
    });

    const result = await runDeliverySkill({ ...getBaseOptions(cwd), runner });
    expect(result.status).toBe("completed");
    expect(result.prNumber).toBe(90);
    expect(result.mergeSha).toBe("realSquashMergeSha777");
    expect(result.reason).toBe("already_merged_and_closed");
  });

  it("Blocker 9 (已合入但 Issue OPEN 时触发 reconciliation): 输出交接并移除 ready 标签，避免调度器重复派发", async () => {
    const cwd = createTempCwd();
    const runner = new MockDeliveryRunner();
    runner.gitResponses.push({ stdout: "symphony/GH-80\n", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "https://github.com/felixjichao/symphony-ts.git\n", stderr: "", exitCode: 0 });

    // gh issue view (OPEN)
    runner.ghResponses.push({
      stdout: JSON.stringify({ state: "OPEN", labels: [{ name: "symphony-ready" }] }),
      stderr: "",
      exitCode: 0,
    });

    // gh pr list returns MERGED PR
    runner.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 91,
          url: "https://github.com/felixjichao/symphony-ts/pull/91",
          title: "feat: delivery",
          state: "MERGED",
          headRefOid: "headRef456",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });

    // gh pr view for merge commit
    runner.ghResponses.push({
      stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "mergeCommit888" } }),
      stderr: "",
      exitCode: 0,
    });

    // haltDispatch: remove label & check label & comment
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // edit remove-label
    runner.ghResponses.push({ stdout: JSON.stringify({ labels: [] }), stderr: "", exitCode: 0 }); // view labels
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // comment

    const result = await runDeliverySkill({ ...getBaseOptions(cwd), runner });
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("reconciliation_needed");
    expect(result.handoffMarkdown).toContain("reconciliation_needed");
    expect(result.handoffMarkdown).toContain("已从 Issue #80 移除 `symphony-ready` 标签");

    // 确认调用了 remove-label
    const removeLabelCall = runner.ghCalls.find(
      (c) => c.args[0] === "issue" && c.args[1] === "edit" && c.args.includes("--remove-label"),
    );
    expect(removeLabelCall).toBeDefined();
  });

  it("Blocker 4 (真实失败诊断与权限/Infra 区分): 遇到权限或 Infra 错误时安全终止交接，不浪费代码修复预算", async () => {
    const cwd = createTempCwd();
    const runner = new MockDeliveryRunner();
    setupPreMutationSuccess(runner);

    runner.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 92,
          url: "https://github.com/felixjichao/symphony-ts/pull/92",
          title: "feat: delivery",
          state: "OPEN",
          headRefOid: "headSha92",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });

    runner.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "headSha92\n", stderr: "", exitCode: 0 });

    // CI failed
    runner.ghResponses.push({
      stdout: JSON.stringify({
        headRefOid: "headSha92",
        mergeable: "MERGEABLE",
        state: "OPEN",
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            name: "e2e",
            status: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "https://github.com/felixjichao/symphony-ts/actions/runs/12345",
          },
        ],
      }),
      stderr: "",
      exitCode: 0,
    });

    // Provide infra failure log in MockDeliveryRunner
    runner.gh = async (args: readonly string[], dir: string) => {
      runner.ghCalls.push({ args, cwd: dir });
      if (args[0] === "api" && args[1]?.includes("rules/branches")) return { stdout: "[]", stderr: "", exitCode: 0 };
      if (args[0] === "api" && typeof args[1] === "string" && args[1].includes("required_status_checks")) {
        return { stdout: "{}", stderr: "404 Branch not protected", exitCode: 1 };
      }
      if (args[0] === "run" && args[1] === "list") {
        return {
          stdout: JSON.stringify([{ databaseId: 12345, conclusion: "FAILURE", detailsUrl: "https://github.com/felixjichao/symphony-ts/actions/runs/12345" }]),
          stderr: "",
          exitCode: 0,
        };
      }
      if (args[0] === "run" && args[1] === "view" && args.includes("--log-failed")) {
        return {
          stdout: "Error: Resource not accessible by integration (Permission denied)\nrunner system failure",
          stderr: "",
          exitCode: 0,
        };
      }
      if (args[0] === "issue" && args[1] === "edit") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "issue" && args[1] === "view") {
        return { stdout: JSON.stringify({ labels: [] }), stderr: "", exitCode: 0 };
      }
      if (args[0] === "pr" && args[1] === "comment") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      const next = runner.ghResponses.shift();
      if (typeof next === "function") {
        return next(args);
      }
      return next ?? { stdout: "", stderr: "", exitCode: 0 };
    };

    let repairCalled = false;
    const result = await runDeliverySkill({
      ...getBaseOptions(cwd),
      repairFn: async () => {
        repairCalled = true;
        return true;
      },
      runner,
    });

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("manual_intervention_required");
    expect(repairCalled).toBe(false); // Infra 错误绝不调用 repairFn 浪费预算
    expect(result.handoffMarkdown).toContain("Resource not accessible by integration");
  });

  it("Blocker 6 (修复异常持久化预算): repair 抛出异常前已记录 spentRepairs，阻止重启后预算重置", async () => {
    const cwd = createTempCwd();
    const runner = new MockDeliveryRunner();
    setupPreMutationSuccess(runner);

    runner.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 93,
          url: "https://github.com/felixjichao/symphony-ts/pull/93",
          title: "feat: delivery",
          state: "OPEN",
          headRefOid: "headSha93",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });

    runner.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "headSha93\n", stderr: "", exitCode: 0 });

    // CI failed
    runner.ghResponses.push({
      stdout: JSON.stringify({
        headRefOid: "headSha93",
        mergeable: "MERGEABLE",
        state: "OPEN",
        statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/felixjichao/symphony-ts/actions/runs/12345" }],
      }),
      stderr: "",
      exitCode: 0,
    });

    // halt calls: edit, view labels, pr comment
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.ghResponses.push({ stdout: JSON.stringify({ labels: [] }), stderr: "", exitCode: 0 });
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });

    let writtenSpentRepairs = 0;
    const mockStorage = {
      readState: async () => null,
      writeState: async (state: PersistedDeliveryState) => {
        writtenSpentRepairs = state.spentRepairs;
      },
    };

    const result = await runDeliverySkill({
      ...getBaseOptions(cwd),
      stateStorage: mockStorage,
      repairFn: async () => {
        throw new Error("Disk full or unexpected crash during repair");
      },
      runner,
    });

    expect(result.status).toBe("blocked");
    expect(result.spentRepairs).toBe(1);
    expect(writtenSpentRepairs).toBe(1); // 修复发生异常时，预算已经被持久化，重试不会归零
  });

  describe("NEST-103 独立审查门禁 (Decision Review Gate before auto-merge)", () => {
    const shaA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const shaB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    it("验收 1: CI green + review approve at SHA-A -> 允许 land SHA-A", async () => {
      const cwd = createTempCwd();
      const runner = new MockDeliveryRunner();
      setupPreMutationSuccess(runner);

      // PR exists
      runner.ghResponses.push({
        stdout: JSON.stringify([
          {
            number: 85,
            url: "https://github.com/felixjichao/symphony-ts/pull/85",
            title: "feat: delivery",
            state: "OPEN",
            headRefOid: shaA,
            body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
          },
        ]),
        stderr: "",
        exitCode: 0,
      });

      runner.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 }); // validation
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status clean
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // push
      runner.gitResponses.push({ stdout: `${shaA}\n`, stderr: "", exitCode: 0 }); // rev-parse

      // CI green
      runner.ghResponses.push({
        stdout: JSON.stringify({
          headRefOid: shaA,
          mergeable: "MERGEABLE",
          state: "OPEN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
        stderr: "",
        exitCode: 0,
      });

      // Land mergeable check
      runner.ghResponses.push({ stdout: JSON.stringify({ mergeable: "MERGEABLE", state: "OPEN" }), stderr: "", exitCode: 0 });
      // Land merge
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });
      // Land verify merged
      runner.ghResponses.push({ stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "mergedshaA" } }), stderr: "", exitCode: 0 });
      // Issue closed verify
      runner.ghResponses.push({ stdout: JSON.stringify({ state: "CLOSED" }), stderr: "", exitCode: 0 });

      const reviewGate = new MockReviewGate();
      const result = await runDeliverySkill({
        ...getBaseOptions(cwd),
        reviewGate,
        runner,
      });

      expect(result.status).toBe("completed");
      expect(result.headSha).toBe(shaA);
      expect(result.mergeSha).toBe("mergedshaA");
      expect(reviewGate.ensureReviewTaskCallCount).toBe(1);
      expect(reviewGate.verifyReviewApprovalCallCount).toBeGreaterThanOrEqual(1);
    });

    it("验收 2: SHA-A 审查通过后 PR HEAD 变动到 SHA-B -> 阻止 merge 并要求对 SHA-B 重新审查", async () => {
      const cwd = createTempCwd();
      const runner = new MockDeliveryRunner();
      setupPreMutationSuccess(runner);

      // PR initially at shaA
      runner.ghResponses.push({
        stdout: JSON.stringify([
          {
            number: 85,
            url: "https://github.com/felixjichao/symphony-ts/pull/85",
            title: "feat: delivery",
            state: "OPEN",
            headRefOid: shaA,
            body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
          },
        ]),
        stderr: "",
        exitCode: 0,
      });

      runner.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 }); // validation
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status clean
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // push
      runner.gitResponses.push({ stdout: `${shaA}\n`, stderr: "", exitCode: 0 }); // rev-parse

      // CI green for shaA
      runner.ghResponses.push({
        stdout: JSON.stringify({
          headRefOid: shaA,
          mergeable: "MERGEABLE",
          state: "OPEN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
        stderr: "",
        exitCode: 0,
      });

      // While polling review for shaA, GitHub PR HEAD moves to shaB!
      runner.headRefOidResponses.push({
        stdout: JSON.stringify({ headRefOid: shaB }),
        stderr: "",
        exitCode: 0,
      });

      // CI green for shaB
      runner.ghResponses.push({
        stdout: JSON.stringify({
          headRefOid: shaB,
          mergeable: "MERGEABLE",
          state: "OPEN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
        stderr: "",
        exitCode: 0,
      });

      // Subsequent head checks stay at shaB
      runner.headRefOidResponses.push({
        stdout: JSON.stringify({ headRefOid: shaB }),
        stderr: "",
        exitCode: 0,
      });

      // Land mergeable check
      runner.ghResponses.push({ stdout: JSON.stringify({ mergeable: "MERGEABLE", state: "OPEN" }), stderr: "", exitCode: 0 });
      // Land merge
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });
      // Land verify merged
      runner.ghResponses.push({ stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "mergedshaB" } }), stderr: "", exitCode: 0 });
      // Issue closed verify
      runner.ghResponses.push({ stdout: JSON.stringify({ state: "CLOSED" }), stderr: "", exitCode: 0 });

      const reviewGate = new MockReviewGate();
      const result = await runDeliverySkill({
        ...getBaseOptions(cwd),
        reviewGate,
        runner,
      });

      expect(result.status).toBe("completed");
      expect(result.headSha).toBe(shaB);
      expect(result.mergeSha).toBe("mergedshaB");
      // Old task for shaA was superseded
      expect(reviewGate.supersedeReviewTaskCallCount).toBe(1);
      expect(reviewGate.supersededTaskIds).toContain(`task-review-test-${shaA}`);
      // Re-ensured review task for shaB
      expect(reviewGate.ensureReviewTaskCallCount).toBe(2);
    });

    it("验收 3 & 4: review requests changes -> findings 进入 repair loop，新 SHA 生成新 ReviewTask，旧任务被废弃 (superseded)", async () => {
      const cwd = createTempCwd();
      const runner = new MockDeliveryRunner();
      setupPreMutationSuccess(runner);

      // PR at shaA
      runner.ghResponses.push({
        stdout: JSON.stringify([
          {
            number: 85,
            url: "https://github.com/felixjichao/symphony-ts/pull/85",
            title: "feat: delivery",
            state: "OPEN",
            headRefOid: shaA,
            body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
          },
        ]),
        stderr: "",
        exitCode: 0,
      });

      runner.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 }); // validation
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status clean
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // push
      runner.gitResponses.push({ stdout: `${shaA}\n`, stderr: "", exitCode: 0 }); // rev-parse

      // CI green for shaA
      runner.ghResponses.push({
        stdout: JSON.stringify({
          headRefOid: shaA,
          mergeable: "MERGEABLE",
          state: "OPEN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
        stderr: "",
        exitCode: 0,
      });

      // Review Gate for shaA returns changes_requested
      const reviewGate = new MockReviewGate();
      reviewGate.statusResults.push({
        taskId: `task-review-test-${shaA}`,
        status: "completed",
        result: {
          schemaVersion: 1,
          taskId: `task-review-test-${shaA}`,
          sessionId: "github:felixjichao/symphony-ts#80",
          kind: "review",
          revision: 1,
          createdAtMs: 1_000_000 as UtcTimestampMs,
          verdict: "changes_requested",
          target: { repository: "felixjichao/symphony-ts", prNumber: 85, headSha: shaA },
          findings: [
            { severity: "blocker", message: "Found null pointer exception risk", location: "src/service.ts:42" },
          ],
        },
      });

      // Repair operations for review feedback:
      runner.execResponses.push({ stdout: "validation after review repair ok", stderr: "", exitCode: 0 }); // validation
      runner.gitResponses.push({ stdout: " M src/service.ts\n", stderr: "", exitCode: 0 }); // diff check
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // git add
      runner.gitResponses.push({ stdout: "[commit shaB]", stderr: "", exitCode: 0 }); // git commit
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // git push
      runner.gitResponses.push({ stdout: `${shaB}\n`, stderr: "", exitCode: 0 }); // rev-parse -> shaB

      // CI green for shaB
      runner.ghResponses.push({
        stdout: JSON.stringify({
          headRefOid: shaB,
          mergeable: "MERGEABLE",
          state: "OPEN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
        stderr: "",
        exitCode: 0,
      });

      // Review Gate for shaB returns approve
      reviewGate.statusResults.push({
        taskId: `task-review-test-${shaB}`,
        status: "completed",
        result: {
          schemaVersion: 1,
          taskId: `task-review-test-${shaB}`,
          sessionId: "github:felixjichao/symphony-ts#80",
          kind: "review",
          revision: 1,
          createdAtMs: 1_000_000 as UtcTimestampMs,
          verdict: "approve",
          target: { repository: "felixjichao/symphony-ts", prNumber: 85, headSha: shaB },
          findings: [],
        },
      });

      // Land mergeable check
      runner.ghResponses.push({ stdout: JSON.stringify({ mergeable: "MERGEABLE", state: "OPEN" }), stderr: "", exitCode: 0 });
      // Land merge
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });
      // Land verify merged
      runner.ghResponses.push({ stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "mergedshaB" } }), stderr: "", exitCode: 0 });
      // Issue closed verify
      runner.ghResponses.push({ stdout: JSON.stringify({ state: "CLOSED" }), stderr: "", exitCode: 0 });

      let receivedFeedback = "";
      const result = await runDeliverySkill({
        ...getBaseOptions(cwd),
        reviewGate,
        repairFn: async (feedback) => {
          receivedFeedback = feedback;
          return true;
        },
        runner,
      });

      expect(result.status).toBe("completed");
      expect(result.headSha).toBe(shaB);
      expect(receivedFeedback).toContain("Found null pointer exception risk");
      expect(reviewGate.supersedeReviewTaskCallCount).toBe(1);
      expect(reviewGate.supersededTaskIds).toContain(`task-review-test-${shaA}`);
      expect(reviewGate.ensureReviewTaskCallCount).toBe(2);
      expect(result.spentRepairs).toBe(1);
    });

    it("验收 5: needs_human -> 进入交付交接 (review_needs_human)，绝不自动 merge", async () => {
      const cwd = createTempCwd();
      const runner = new MockDeliveryRunner();
      setupPreMutationSuccess(runner);

      // PR at shaA
      runner.ghResponses.push({
        stdout: JSON.stringify([
          {
            number: 85,
            url: "https://github.com/felixjichao/symphony-ts/pull/85",
            title: "feat: delivery",
            state: "OPEN",
            headRefOid: shaA,
            body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
          },
        ]),
        stderr: "",
        exitCode: 0,
      });

      runner.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 }); // validation
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status clean
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // push
      runner.gitResponses.push({ stdout: `${shaA}\n`, stderr: "", exitCode: 0 }); // rev-parse

      // CI green for shaA
      runner.ghResponses.push({
        stdout: JSON.stringify({
          headRefOid: shaA,
          mergeable: "MERGEABLE",
          state: "OPEN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
        stderr: "",
        exitCode: 0,
      });

      // Review Gate returns needs_human
      const reviewGate = new MockReviewGate();
      reviewGate.statusResults.push({
        taskId: `task-review-test-${shaA}`,
        status: "completed",
        result: {
          schemaVersion: 1,
          taskId: `task-review-test-${shaA}`,
          sessionId: "github:felixjichao/symphony-ts#80",
          kind: "review",
          revision: 1,
          createdAtMs: 1_000_000 as UtcTimestampMs,
          verdict: "needs_human",
          target: { repository: "felixjichao/symphony-ts", prNumber: 85, headSha: shaA },
          findings: [
            { severity: "blocker", message: "Architectural ambiguity requires human decision", location: null },
          ],
        },
      });

      // Halt calls: remove ready label, check labels, post comment
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // edit remove-label
      runner.ghResponses.push({ stdout: JSON.stringify({ labels: [] }), stderr: "", exitCode: 0 }); // check labels
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // comment

      const result = await runDeliverySkill({
        ...getBaseOptions(cwd),
        reviewGate,
        runner,
      });

      expect(result.status).toBe("blocked");
      expect(result.reason).toBe("review_needs_human");
      expect(result.handoffMarkdown).toContain("Architectural ambiguity requires human decision");
    });

    it("验收 6: 审查任务失败或结果缺失/格式错误 -> fail-closed 阻止 merge", async () => {
      const cwd = createTempCwd();
      const runner = new MockDeliveryRunner();
      setupPreMutationSuccess(runner);

      // PR at shaA
      runner.ghResponses.push({
        stdout: JSON.stringify([
          {
            number: 85,
            url: "https://github.com/felixjichao/symphony-ts/pull/85",
            title: "feat: delivery",
            state: "OPEN",
            headRefOid: shaA,
            body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
          },
        ]),
        stderr: "",
        exitCode: 0,
      });

      runner.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 }); // validation
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status clean
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // push
      runner.gitResponses.push({ stdout: `${shaA}\n`, stderr: "", exitCode: 0 }); // rev-parse

      // CI green
      runner.ghResponses.push({
        stdout: JSON.stringify({
          headRefOid: shaA,
          mergeable: "MERGEABLE",
          state: "OPEN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
        stderr: "",
        exitCode: 0,
      });

      // Review Gate task failed
      const reviewGate = new MockReviewGate();
      reviewGate.statusResults.push({
        taskId: `task-review-test-${shaA}`,
        status: "failed",
        error: "Decision executor network timeout",
      });

      // Halt calls
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });
      runner.ghResponses.push({ stdout: JSON.stringify({ labels: [] }), stderr: "", exitCode: 0 });
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });

      const result = await runDeliverySkill({
        ...getBaseOptions(cwd),
        reviewGate,
        runner,
      });

      expect(result.status).toBe("blocked");
      expect(result.reason).toBe("manual_intervention_required");
      expect(result.handoffMarkdown).toContain("Decision executor network timeout");
    });

    it("验收 7: optInLand 开启时若未配置 reviewGate -> fail-closed 严禁静默 fallback 到纯 CI auto-merge", async () => {
      const cwd = createTempCwd();
      const runner = new MockDeliveryRunner();
      setupPreMutationSuccess(runner);

      // PR at shaA
      runner.ghResponses.push({
        stdout: JSON.stringify([
          {
            number: 85,
            url: "https://github.com/felixjichao/symphony-ts/pull/85",
            title: "feat: delivery",
            state: "OPEN",
            headRefOid: shaA,
            body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
          },
        ]),
        stderr: "",
        exitCode: 0,
      });

      runner.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 }); // validation
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status clean
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // push
      runner.gitResponses.push({ stdout: `${shaA}\n`, stderr: "", exitCode: 0 }); // rev-parse

      // CI green
      runner.ghResponses.push({
        stdout: JSON.stringify({
          headRefOid: shaA,
          mergeable: "MERGEABLE",
          state: "OPEN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
        stderr: "",
        exitCode: 0,
      });

      // Halt calls: remove ready label, check labels, post comment
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });
      runner.ghResponses.push({ stdout: JSON.stringify({ labels: [] }), stderr: "", exitCode: 0 });
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });

      const baseOpts = getBaseOptions(cwd);
      const result = await runDeliverySkill({
        ...baseOpts,
        reviewGate: undefined, // 缺失审查门禁
        optInLand: true,
        runner,
      });

      expect(result.status).toBe("blocked");
      expect(result.reason).toBe("manual_intervention_required");
      expect(result.handoffMarkdown).toContain("Auto-merge requires review gate verification, but no review gate is configured");
    });

    it("验收 8 (diff 获取失败 fail-closed): commit-pinned diff 获取失败时安全终止并请求人工介入，绝不发布空 diff 或浮动 diff", async () => {
      const cwd = createTempCwd();
      const runner = new MockDeliveryRunner();
      setupPreMutationSuccess(runner);

      // PR at shaA
      runner.ghResponses.push({
        stdout: JSON.stringify([
          {
            number: 85,
            url: "https://github.com/felixjichao/symphony-ts/pull/85",
            title: "feat: delivery",
            state: "OPEN",
            headRefOid: shaA,
            body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
          },
        ]),
        stderr: "",
        exitCode: 0,
      });

      runner.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 }); // validation
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status clean
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // push
      runner.gitResponses.push({ stdout: `${shaA}\n`, stderr: "", exitCode: 0 }); // rev-parse

      // CI green
      runner.ghResponses.push({
        stdout: JSON.stringify({
          headRefOid: shaA,
          mergeable: "MERGEABLE",
          state: "OPEN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
        stderr: "",
        exitCode: 0,
      });

      // Override git and gh to simulate failure to obtain commit-pinned diff
      const origGit = runner.git.bind(runner);
      runner.git = async (args, dir) => {
        if (args[0] === "diff" && args.some((a) => typeof a === "string" && a.includes("..."))) {
          return { stdout: "", stderr: "fatal: ambiguous argument", exitCode: 1 };
        }
        return origGit(args, dir);
      };
      const origGh = runner.gh.bind(runner);
      runner.gh = async (args, dir) => {
        if (args[0] === "api" && args.some((a) => typeof a === "string" && a.includes("compare"))) {
          return { stdout: "", stderr: "HTTP 503 Service Unavailable", exitCode: 1 };
        }
        return origGh(args, dir);
      };

      // Halt calls
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });
      runner.ghResponses.push({ stdout: JSON.stringify({ labels: [] }), stderr: "", exitCode: 0 });
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });

      const reviewGate = new MockReviewGate();
      const result = await runDeliverySkill({
        ...getBaseOptions(cwd),
        reviewGate,
        runner,
      });

      expect(result.status).toBe("blocked");
      expect(result.reason).toBe("manual_intervention_required");
      expect(result.handoffMarkdown).toContain("Failed to obtain commit-pinned diff");
      expect(reviewGate.ensureReviewTaskCallCount).toBe(0); // 未发布审查
    });

    it("验收 9 (Phase 7 Pre-merge 安全保护): 审查通过后但 merge 前 CI rerun 失败或 ownership 被篡改时阻止 merge", async () => {
      const cwd = createTempCwd();
      const runner = new MockDeliveryRunner();
      setupPreMutationSuccess(runner);

      // PR at shaA
      runner.ghResponses.push({
        stdout: JSON.stringify([
          {
            number: 85,
            url: "https://github.com/felixjichao/symphony-ts/pull/85",
            title: "feat: delivery",
            state: "OPEN",
            headRefOid: shaA,
            body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
          },
        ]),
        stderr: "",
        exitCode: 0,
      });

      runner.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 }); // validation
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status clean
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // push
      runner.gitResponses.push({ stdout: `${shaA}\n`, stderr: "", exitCode: 0 }); // rev-parse

      // CI green in Phase 6
      runner.ghResponses.push({
        stdout: JSON.stringify({
          headRefOid: shaA,
          mergeable: "MERGEABLE",
          state: "OPEN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
        stderr: "",
        exitCode: 0,
      });

      // Review Gate approves shaA
      const reviewGate = new MockReviewGate();

      // Pre-merge verification in Phase 7: status check was re-run and failed!
      runner.ghResponses.push({
        stdout: JSON.stringify({
          headRefOid: shaA,
          mergeable: "MERGEABLE",
          state: "OPEN",
          isDraft: false,
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
          statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "FAILURE" }],
        }),
        stderr: "",
        exitCode: 0,
      });

      // Halt calls
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });
      runner.ghResponses.push({ stdout: JSON.stringify({ labels: [] }), stderr: "", exitCode: 0 });
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });

      const result = await runDeliverySkill({
        ...getBaseOptions(cwd),
        reviewGate,
        runner,
      });

      expect(result.status).toBe("blocked");
      expect(result.reason).toBe("manual_intervention_required");
      expect(result.handoffMarkdown).toContain("Pre-merge CI check policy re-evaluation failed");
      expect(runner.ghCalls.some((c) => c.args[0] === "pr" && c.args[1] === "merge")).toBe(false);
    });

    it("验收 10 (diff 与 commit SHA 绑定与完整性校验): PR diff 混入非目标 SHA 的变更文件时阻止发布审查并安全终止", async () => {
      const cwd = createTempCwd();
      const runner = new MockDeliveryRunner();
      const origGit = runner.git.bind(runner);
      runner.git = async (args, dir) => {
        if (args[0] === "diff" && args.some((a) => typeof a === "string" && a.includes("..."))) {
          return { stdout: "diff --git a/b-only.ts b/b-only.ts\n+SHA-B-only change\n", stderr: "", exitCode: 0 };
        }
        return origGit(args, dir);
      };
      setupPreMutationSuccess(runner);

      // PR exists at shaA
      runner.ghResponses.push({
        stdout: JSON.stringify([
          {
            number: 85,
            url: "https://github.com/felixjichao/symphony-ts/pull/85",
            title: "feat: delivery",
            state: "OPEN",
            headRefOid: shaA,
            body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
          },
        ]),
        stderr: "",
        exitCode: 0,
      });

      runner.execResponses.push({ stdout: "ok", stderr: "", exitCode: 0 }); // validation
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status clean
      runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // push
      runner.gitResponses.push({ stdout: `${shaA}\n`, stderr: "", exitCode: 0 }); // rev-parse

      // CI green
      runner.ghResponses.push({
        stdout: JSON.stringify({
          headRefOid: shaA,
          mergeable: "MERGEABLE",
          state: "OPEN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
        stderr: "",
        exitCode: 0,
      });

      // Halt calls
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });
      runner.ghResponses.push({ stdout: JSON.stringify({ labels: [] }), stderr: "", exitCode: 0 });
      runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });

      const reviewGate = new MockReviewGate();
      const result = await runDeliverySkill({
        ...getBaseOptions(cwd),
        reviewGate,
        runner,
      });

      expect(result.status).toBe("blocked");
      expect(result.reason).toBe("manual_intervention_required");
      expect(result.handoffMarkdown).toContain("PR diff integrity verification failed");
      expect(result.handoffMarkdown).toContain("b-only.ts");
      expect(reviewGate.ensureReviewTaskCallCount).toBe(0);
      expect(runner.ghCalls.some((c) => c.args[0] === "pr" && c.args[1] === "merge")).toBe(false);
    });
  });
});
