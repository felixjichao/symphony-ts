import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runDeliverySkill, type RunDeliverySkillOptions } from "./delivery-skill-runner";
import type { DeliveryGitGhRunner, DeliverySubprocessResult } from "./git-gh-runner";

class MockDeliveryRunner implements DeliveryGitGhRunner {
  readonly gitCalls: Array<{ args: readonly string[]; cwd: string }> = [];
  readonly ghCalls: Array<{ args: readonly string[]; cwd: string }> = [];
  readonly execCalls: Array<{ command: string; cwd: string }> = [];

  gitResponses: Array<DeliverySubprocessResult | ((args: readonly string[]) => DeliverySubprocessResult)> = [];
  ghResponses: Array<DeliverySubprocessResult | ((args: readonly string[]) => DeliverySubprocessResult)> = [];
  execResponses: Array<DeliverySubprocessResult | ((command: string) => DeliverySubprocessResult)> = [];

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

  async exec(command: string, cwd: string): Promise<DeliverySubprocessResult> {
    this.execCalls.push({ command, cwd });
    const next = this.execResponses.shift();
    if (typeof next === "function") {
      return next(command);
    }
    return next ?? { stdout: "", stderr: "", exitCode: 0 };
  }
}

describe("Codex Delivery + Land Workflow Skill Runner", () => {
  const createTempCwd = () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-skill-test-"));
    return tmp;
  };

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
    sleepFn: async () => {}, // Instant sleep in tests
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
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
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
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
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
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
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
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/fail" },
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
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
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
        statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
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
        statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
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
        statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
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
          body: "Fixes #80\n\n<!-- symphony-delivery-marker: {\"workspaceKey\":\"GH-80\",\"issueNumber\":80,\"repo\":\"felixjichao/symphony-ts\",\"headBranch\":\"symphony/GH-80\",\"baseBranch\":\"main\"} -->",
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
});
