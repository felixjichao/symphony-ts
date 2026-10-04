import { describe, expect, it } from "vitest";

import { runDeliverySkill, type RunDeliverySkillOptions } from "./delivery-skill-runner";
import type { DeliveryGitGhRunner, DeliverySubprocessResult } from "./git-gh-runner";

class MockDeliveryRunner implements DeliveryGitGhRunner {
  readonly gitCalls: Array<{ args: readonly string[]; cwd: string }> = [];
  readonly ghCalls: Array<{ args: readonly string[]; cwd: string }> = [];

  gitResponses: Array<DeliverySubprocessResult | ((args: readonly string[]) => DeliverySubprocessResult)> = [];
  ghResponses: Array<DeliverySubprocessResult | ((args: readonly string[]) => DeliverySubprocessResult)> = [];

  async git(args: readonly string[], cwd: string): Promise<DeliverySubprocessResult> {
    this.gitCalls.push({ args, cwd });
    const next = this.gitResponses.shift();
    if (typeof next === "function") {
      return next(args);
    }
    return next ?? { stdout: "", stderr: "", exitCode: 0 };
  }

  async gh(args: readonly string[], cwd: string): Promise<DeliverySubprocessResult> {
    this.ghCalls.push({ args, cwd });
    const next = this.ghResponses.shift();
    if (typeof next === "function") {
      return next(args);
    }
    return next ?? { stdout: "", stderr: "", exitCode: 0 };
  }
}

describe("Codex Delivery + Land Workflow Skill Runner", () => {
  const baseOptions: Omit<RunDeliverySkillOptions, "runner"> = {
    cwd: "/mock/workspace",
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
    sleepFn: async () => {}, // Instant sleep in tests
  };


  it("验收 1: 能够自动提交 (commit) 并推送到远端 (push)", async () => {
    const runner = new MockDeliveryRunner();

    // 1. git status
    runner.gitResponses.push({ stdout: " M src/index.ts\n", stderr: "", exitCode: 0 });
    // 2. git status porcelain (commit phase)
    runner.gitResponses.push({ stdout: " M src/index.ts\n", stderr: "", exitCode: 0 });
    // 3. git add -A
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    // 4. git commit -m
    runner.gitResponses.push({ stdout: "[symphony/GH-80 1234567] feat commit", stderr: "", exitCode: 0 });
    // 5. git push origin symphony/GH-80
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    // 6. git rev-parse HEAD
    runner.gitResponses.push({ stdout: "1234567890abcdef1234567890abcdef12345678\n", stderr: "", exitCode: 0 });

    // gh pr list (existing pr)
    runner.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 85,
          url: "https://github.com/felixjichao/symphony-ts/pull/85",
          title: "feat: delivery",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });

    // gh pr checks (checks are green)
    runner.ghResponses.push({
      stdout: JSON.stringify([
        { name: "test", state: "success", conclusion: "success" },
      ]),
      stderr: "",
      exitCode: 0,
    });

    // gh pr merge
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    // gh pr view
    runner.ghResponses.push({
      stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "mergedsha999" } }),
      stderr: "",
      exitCode: 0,
    });

    const result = await runDeliverySkill({ ...baseOptions, runner });
    expect(result.status).toBe("completed");
    expect(result.prNumber).toBe(85);
    expect(result.mergeSha).toBe("mergedsha999");

    // 验证调用了 git commit 和 git push
    const gitCommitCall = runner.gitCalls.find((c) => c.args[0] === "commit");
    expect(gitCommitCall).toBeDefined();
    const gitPushCall = runner.gitCalls.find((c) => c.args[0] === "push");
    expect(gitPushCall).toBeDefined();
    expect(gitPushCall?.args).toContain("symphony/GH-80");
  });

  it("验收 2: 无 PR 时自动创建，已有 PR 时自动复用", async () => {
    // 场景 A: 无 PR -> 创建
    const runnerA = new MockDeliveryRunner();
    runnerA.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status
    runnerA.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status
    runnerA.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // push
    runnerA.gitResponses.push({ stdout: "head111\n", stderr: "", exitCode: 0 }); // rev-parse
    // gh pr list returns empty
    runnerA.ghResponses.push({ stdout: "[]", stderr: "", exitCode: 0 });
    // gh pr create
    runnerA.ghResponses.push({
      stdout: "https://github.com/felixjichao/symphony-ts/pull/101\n",
      stderr: "",
      exitCode: 0,
    });
    // gh pr checks (green)
    runnerA.ghResponses.push({
      stdout: JSON.stringify([{ name: "test", state: "success", conclusion: "success" }]),
      stderr: "",
      exitCode: 0,
    });
    // gh pr merge
    runnerA.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    // gh pr view
    runnerA.ghResponses.push({
      stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "sha101" } }),
      stderr: "",
      exitCode: 0,
    });

    const resA = await runDeliverySkill({ ...baseOptions, runner: runnerA });
    expect(resA.status).toBe("completed");
    expect(resA.prNumber).toBe(101);
    const prCreateCall = runnerA.ghCalls.find((c) => c.args[0] === "pr" && c.args[1] === "create");
    expect(prCreateCall).toBeDefined();

    // 场景 B: 已有 PR -> 复用，不调用 pr create
    const runnerB = new MockDeliveryRunner();
    runnerB.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status
    runnerB.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // status
    runnerB.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // push
    runnerB.gitResponses.push({ stdout: "head222\n", stderr: "", exitCode: 0 }); // rev-parse
    // gh pr list returns existing PR
    runnerB.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 88,
          url: "https://github.com/felixjichao/symphony-ts/pull/88",
          title: "feat: delivery",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });
    // gh pr checks
    runnerB.ghResponses.push({
      stdout: JSON.stringify([{ name: "test", state: "success", conclusion: "success" }]),
      stderr: "",
      exitCode: 0,
    });
    // gh pr merge
    runnerB.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    // gh pr view
    runnerB.ghResponses.push({
      stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "sha88" } }),
      stderr: "",
      exitCode: 0,
    });

    const resB = await runDeliverySkill({ ...baseOptions, runner: runnerB });
    expect(resB.status).toBe("completed");
    expect(resB.prNumber).toBe(88);
    const noPrCreate = runnerB.ghCalls.find((c) => c.args[0] === "pr" && c.args[1] === "create");
    expect(noPrCreate).toBeUndefined();
  });

  it("验收 3 & 4: CI failed 进入修复循环并再次 push，CI green 后进入 land 判断并 squash merge", async () => {
    const runner = new MockDeliveryRunner();
    let repairCalled = false;

    // git setup
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "sha-head-1\n", stderr: "", exitCode: 0 });

    // gh pr list (existing PR #90)
    runner.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 90,
          url: "https://github.com/felixjichao/symphony-ts/pull/90",
          title: "feat: delivery",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });

    // 第一次 checks: 失败！
    runner.ghResponses.push({
      stdout: JSON.stringify([
        { name: "test", state: "failure", conclusion: "failure", link: "https://ci/fail" },
      ]),
      stderr: "",
      exitCode: 0,
    });

    // 修复时的 git add, git commit, git push, git rev-parse
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // git add
    runner.gitResponses.push({ stdout: "[symphony/GH-80 555] fix(ci)", stderr: "", exitCode: 0 }); // git commit
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // git push
    runner.gitResponses.push({ stdout: "sha-head-repaired\n", stderr: "", exitCode: 0 }); // rev-parse

    // 第二次 checks: 成功 (Green)!
    runner.ghResponses.push({
      stdout: JSON.stringify([
        { name: "test", state: "success", conclusion: "success" },
      ]),
      stderr: "",
      exitCode: 0,
    });

    // gh pr merge
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    // gh pr view
    runner.ghResponses.push({
      stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "mergedsha-fixed" } }),
      stderr: "",
      exitCode: 0,
    });

    const result = await runDeliverySkill({
      ...baseOptions,
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

  it("验收 5 & 6: 修复次数超限终止，输出 Blocker 交接报告并移除 symphony-ready 标签停止派发", async () => {
    const runner = new MockDeliveryRunner();

    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "sha-head-err\n", stderr: "", exitCode: 0 });

    // gh pr list
    runner.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 95,
          url: "https://github.com/felixjichao/symphony-ts/pull/95",
          title: "feat: delivery",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });

    // 循环返回 CI failed
    const failChecks = {
      stdout: JSON.stringify([{ name: "test", state: "failure", conclusion: "failure" }]),
      stderr: "",
      exitCode: 0,
    };
    runner.ghResponses.push(failChecks); // check 1 -> attempt 1
    // repair 1
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "commit", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "sha-head-rep1\n", stderr: "", exitCode: 0 });

    runner.ghResponses.push(failChecks); // check 2 -> attempt 2
    // repair 2
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "commit", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "sha-head-rep2\n", stderr: "", exitCode: 0 });

    runner.ghResponses.push(failChecks); // check 3 -> exceeds maxRepairAttempts (2)

    // haltDispatch actions:
    // 1. gh issue edit 80 --remove-label symphony-ready
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    // 2. gh pr comment 95 --body ...
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 });

    const result = await runDeliverySkill({
      ...baseOptions,
      maxRepairAttempts: 2,
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

  it("验收 5 & 6 (续): CI 等待超时上限终止，输出 Blocker 并移除 ready 标签", async () => {
    const runner = new MockDeliveryRunner();

    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "", stderr: "", exitCode: 0 });
    runner.gitResponses.push({ stdout: "sha-head-pending\n", stderr: "", exitCode: 0 });

    runner.ghResponses.push({
      stdout: JSON.stringify([
        {
          number: 96,
          url: "https://github.com/felixjichao/symphony-ts/pull/96",
          title: "feat: delivery",
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
        },
      ]),
      stderr: "",
      exitCode: 0,
    });

    // 持续返回 pending
    const pendingChecks = {
      stdout: JSON.stringify([{ name: "test", state: "pending", conclusion: null }]),
      stderr: "",
      exitCode: 0,
    };
    runner.ghResponses.push(pendingChecks); // 0s -> wait 5s
    runner.ghResponses.push(pendingChecks); // 5s -> wait 5s
    runner.ghResponses.push(pendingChecks); // 10s -> wait 5s -> 15s >= maxWaitSeconds (15)

    // haltDispatch actions
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // edit label
    runner.ghResponses.push({ stdout: "", stderr: "", exitCode: 0 }); // comment

    const result = await runDeliverySkill({
      ...baseOptions,
      maxWaitSeconds: 15,
      pollIntervalSeconds: 5,
      runner,
    });

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("ci_wait_timeout");
    expect(result.spentWaitSeconds).toBeGreaterThanOrEqual(15);
  });
});
