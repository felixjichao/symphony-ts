/**
 * NEST-128: 联合回归验证
 * 链路：可控标签移除 → 真实 Orchestrator reconciliation → Worker 进程停止 → 重读磁盘状态 → 正式 recover-handoff 恢复入口。
 * 覆盖两个关键取消点：
 * 1. 未发评论（worker 终止前尚未发布评论）
 * 2. 评论成功但尚未落盘（评论已被 GitHub 接收，但 worker 在本地落盘前被终止）
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgentAttempt, type DeliveryGitGhRunner, type DeliverySubprocessResult } from "@symphony/agent";
import type {
  AgentConfig,
  HooksConfig,
  Issue,
  PollingConfig,
  ServiceConfig,
  WorkflowDefinition,
} from "@symphony/domain";
import {
  OrchestratorAuthority,
  createOrchestratorRuntimeState,
  type AgentAttemptRunner,
  type AttemptContext,
  type DispatchPolicy,
} from "@symphony/orchestrator";
import { createWorkspaceManager, type WorkspaceManager } from "@symphony/workspace";

import { runDeliverySkillCli } from "./delivery-skill-cli";

const APP_SERVER_FIXTURE = fileURLToPath(
  new URL("../../../packages/agent/test-fixtures/app-server.mjs", import.meta.url),
);

function fixtureCommand(extraArgs: readonly string[] = []): string {
  return [process.execPath, APP_SERVER_FIXTURE, ...extraArgs]
    .map((part) => JSON.stringify(part))
    .join(" ");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

class MockRecoveryGhRunner implements DeliveryGitGhRunner {
  readonly ghCalls: Array<{ args: readonly string[]; cwd: string }> = [];
  readonly gitCalls: Array<{ args: readonly string[]; cwd: string }> = [];
  readonly execCalls: Array<{ command: string; cwd: string }> = [];

  ghResponses: DeliverySubprocessResult[] = [];

  async git(args: readonly string[], cwd: string): Promise<DeliverySubprocessResult> {
    this.gitCalls.push({ args, cwd });
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  async exec(command: string, cwd: string): Promise<DeliverySubprocessResult> {
    this.execCalls.push({ command, cwd });
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  async gh(args: readonly string[], cwd: string): Promise<DeliverySubprocessResult> {
    this.ghCalls.push({ args, cwd });
    return this.ghResponses.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
  }
}

const POLICY: DispatchPolicy = {
  activeStates: ["Todo", "In Progress"],
  terminalStates: ["Done", "Cancelled"],
  requiredLabels: ["symphony-ready"],
  maxConcurrentAgentsByState: {},
};

describe("NEST-128: 真实 reconciliation 取消与 recover-handoff 恢复联合回归", () => {
  let tempDir: string;
  let workspaceRoot: string;
  let config: ServiceConfig;
  let manager: WorkspaceManager;
  let currentIssue: Issue;

  function makeAuthority(): OrchestratorAuthority {
    const workflow: WorkflowDefinition = {
      config: {},
      promptTemplate: "Handle {{ issue.identifier }}",
    };
    const workflowPath = path.join(tempDir, "WORKFLOW.md");
    const records: Array<{ startup: string }> = [];

    const runner: AgentAttemptRunner = (attemptOptions) => runAgentAttempt(attemptOptions);

    const createAttemptOptions = (context: AttemptContext) => {
      const index = records.length;
      const record = { startup: path.join(tempDir, `startup-${index}.txt`) };
      records.push(record);
      const attemptConfig: ServiceConfig = {
        ...config,
        codex: {
          ...config.codex,
          // 延迟完成以保证子进程在 reconcile 触发时处于运行状态
          command: fixtureCommand(["--record-startup", record.startup, "--delay-completed-ms", "60000"]),
        },
      };
      return {
        issue: context.issue,
        attempt: context.attempt,
        workflow,
        workflowPath,
        getConfig: () => attemptConfig,
        signal: context.signal,
        onPhase: context.onPhase,
        onEvent: context.onEvent,
        continuationDecider: context.continuationDecider,
      };
    };

    const state = createOrchestratorRuntimeState({ pollIntervalMs: 10_000, maxConcurrentAgents: 10 });
    const authority = new OrchestratorAuthority({
      state,
      policy: POLICY,
      runner,
      tracker: {
        fetchIssuesByIds: async (ids) => (ids.includes(currentIssue.id) ? [currentIssue] : []),
      },
      resolveWorkspacePath: (target) => manager.resolveWorkspacePath(target.identifier),
      now: () => 1_000,
      monotonicNow: () => 5_000,
      createAttemptOptions,
      cleanupWorkspace: { removeWorkspace: (identifier) => manager.removeWorkspace(identifier) },
      onCleanupDiagnostic: () => {},
    });
    return authority;
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "symphony-joint-test-"));
    workspaceRoot = path.join(tempDir, "workspaces");
    await fs.mkdir(workspaceRoot, { recursive: true });
    manager = createWorkspaceManager({ workspace: { root: workspaceRoot } });

    const hooks: HooksConfig = {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 5_000,
    };
    const agent: AgentConfig = {
      maxConcurrentAgents: 10,
      maxTurns: 1,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: {},
    };
    const polling: PollingConfig = { intervalMs: 10_000 };
    config = {
      tracker: {
        kind: "memory",
        provider: {},
        requiredLabels: ["symphony-ready"],
        activeStates: null,
        terminalStates: null,
      },
      polling,
      workspace: { root: workspaceRoot },
      hooks,
      agent,
      codex: {
        command: fixtureCommand(),
        approvalPolicy: "never",
        threadSandbox: null,
        turnSandboxPolicy: null,
        readTimeoutMs: 5_000,
        turnTimeoutMs: 60_000,
        stallTimeoutMs: 10_000,
      },
    };
    currentIssue = {
      id: "issue-80",
      nativeRef: null,
      identifier: "GH-80",
      title: "Fix bug #80",
      description: null,
      priority: 1,
      state: "In Progress",
      branchName: null,
      url: null,
      assigneeId: null,
      labels: ["symphony-ready"],
      blockedBy: [],
      dispatchable: true,
      createdAt: 1,
      updatedAt: null,
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("取消点 1（未发评论）：标签移除 → 真实 reconciliation 停止 worker 子进程 → 保留磁盘预算与 deadline → recover-handoff 正式入口补齐评论与终态", async () => {
    const authority = makeAuthority();

    // 1. 启动任务并派发，触发真实 worker 子进程启动
    authority.dispatchIssue(currentIssue);
    const startupFile = path.join(tempDir, "startup-0.txt");
    await waitFor(() => pathExists(startupFile));
    const pid = Number.parseInt((await fs.readFile(startupFile, "utf8")).trim(), 10);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(isAlive(pid)).toBe(true);

    const workspacePath = manager.resolveWorkspacePath(currentIssue.identifier);
    expect(await pathExists(workspacePath)).toBe(true);

    // 2. 模拟 worker 在暂停时将 delivery 状态写入磁盘（已消耗预算：repairs=2, wait=45s, 固定 deadline）
    const fixedDeadline = 1700000045000;
    const handoffId = "handoff-felixjichao-symphony-ts-80-joint-cancel-pt1";
    const stateFile = path.join(workspacePath, ".symphony", "delivery-state.json");
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(
      stateFile,
      JSON.stringify(
        {
          repo: "felixjichao/symphony-ts",
          issueNumber: 80,
          workspaceKey: "GH-80",
          spentRepairs: 2,
          spentWaitSeconds: 45,
          deadlineTimestampMs: fixedDeadline,
          isPaused: true,
          pauseReason: "ci_failed_max_repairs",
          readyLabelRemoved: true,
          commentPosted: false,
          commentVerifyStatus: "pending",
          pendingCompensation: true,
          lastUpdated: new Date().toISOString(),
          handoff: {
            handoffId,
            reason: "ci_failed_max_repairs",
            details: "CI failed and reached max repair attempts",
            readyLabelRemoved: true,
            commentPosted: false,
            prNumber: 95,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    // 3. 可控标签移除：tracker 上移除 symphony-ready 标签
    currentIssue = { ...currentIssue, labels: [] };

    // 4. 触发真实 Orchestrator reconciliation
    const reconResult = await authority.reconcileRunningIssues();

    // 验证 Orchestrator 判定为 stop 且 non-active，不删除 workspace
    expect(reconResult.stoppedIssueIds).toEqual([currentIssue.id]);
    expect(reconResult.cleanedIssueIds).toEqual([]);

    // 验证真实 worker 子进程已退出终止！
    await waitFor(() => !isAlive(pid));
    expect(isAlive(pid)).toBe(false);

    // 5. 重读磁盘：验证 workspace 与 delivery state 完好无损，且非零预算与 deadline 保持不变
    expect(await pathExists(workspacePath)).toBe(true);
    const diskStateAfterKill = JSON.parse(await fs.readFile(stateFile, "utf8"));
    expect(diskStateAfterKill.spentRepairs).toBe(2);
    expect(diskStateAfterKill.spentWaitSeconds).toBe(45);
    expect(diskStateAfterKill.deadlineTimestampMs).toBe(fixedDeadline);
    expect(diskStateAfterKill.isPaused).toBe(true);
    expect(diskStateAfterKill.readyLabelRemoved).toBe(true);
    expect(diskStateAfterKill.commentPosted).toBe(false);
    expect(diskStateAfterKill.pendingCompensation).toBe(true);
    expect(diskStateAfterKill.handoff?.handoffId).toBe(handoffId);

    // 6. 调用正式恢复入口 runDeliverySkillCli(['recover-handoff', ...])
    const recoveryRunner = new MockRecoveryGhRunner();
    // PR #95 评论查询返回空（尚未发布评论）
    recoveryRunner.ghResponses.push({
      stdout: JSON.stringify({ comments: [] }),
      stderr: "",
      exitCode: 0,
    });
    // PR 评论发布成功
    recoveryRunner.ghResponses.push({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const io = {
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    };

    const exitCode = await runDeliverySkillCli(
      ["recover-handoff", "--repo", "felixjichao/symphony-ts", "--issue", "80", "--cwd", workspacePath],
      io,
      recoveryRunner,
    );

    expect(exitCode).toBe(0);

    // 验证正式恢复向 PR #95 发布了包含 handoffId 的交接报告
    const commentCall = recoveryRunner.ghCalls.find((c) => c.args[0] === "pr" && c.args[1] === "comment");
    expect(commentCall).toBeDefined();
    expect(commentCall?.args).toContain("95");
    expect(commentCall?.args.some((a) => a.includes(handoffId))).toBe(true);

    // 验证恢复完成后磁盘状态：预算与 deadline 不变，commentPosted 与 pendingCompensation 闭环
    const finalDiskState = JSON.parse(await fs.readFile(stateFile, "utf8"));
    expect(finalDiskState.spentRepairs).toBe(2);
    expect(finalDiskState.spentWaitSeconds).toBe(45);
    expect(finalDiskState.deadlineTimestampMs).toBe(fixedDeadline);
    expect(finalDiskState.isPaused).toBe(true);
    expect(finalDiskState.readyLabelRemoved).toBe(true);
    expect(finalDiskState.commentPosted).toBe(true);
    expect(finalDiskState.commentVerifyStatus).toBe("posted");
    expect(finalDiskState.pendingCompensation).toBe(false);
    expect(finalDiskState.handoff?.handoffId).toBe(handoffId);
  }, 30_000);

  it("取消点 2（评论成功但尚未落盘）：标签移除 → 真实 reconciliation 停止 worker 子进程 → 正式 recover-handoff 识别远端报告精准去重不重复发布", async () => {
    const authority = makeAuthority();

    // 1. 启动任务并派发
    authority.dispatchIssue(currentIssue);
    const startupFile = path.join(tempDir, "startup-0.txt");
    await waitFor(() => pathExists(startupFile));
    const pid = Number.parseInt((await fs.readFile(startupFile, "utf8")).trim(), 10);
    expect(isAlive(pid)).toBe(true);

    const workspacePath = manager.resolveWorkspacePath(currentIssue.identifier);

    // 2. 模拟 worker 崩溃时点：评论已成功被 GitHub 接收，但本地尚未写入 commentPosted: true 的回执
    const fixedDeadline = 1700000045000;
    const handoffId = "handoff-felixjichao-symphony-ts-80-joint-cancel-pt2";
    const stateFile = path.join(workspacePath, ".symphony", "delivery-state.json");
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(
      stateFile,
      JSON.stringify(
        {
          repo: "felixjichao/symphony-ts",
          issueNumber: 80,
          workspaceKey: "GH-80",
          spentRepairs: 2,
          spentWaitSeconds: 45,
          deadlineTimestampMs: fixedDeadline,
          isPaused: true,
          pauseReason: "ci_failed_max_repairs",
          readyLabelRemoved: true,
          commentPosted: false, // 本地回执未更新
          commentVerifyStatus: "pending",
          pendingCompensation: true,
          lastUpdated: new Date().toISOString(),
          handoff: {
            handoffId,
            reason: "ci_failed_max_repairs",
            details: "CI failed and reached max repair attempts",
            readyLabelRemoved: true,
            commentPosted: false,
            prNumber: 95,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    // 3. 可控标签移除
    currentIssue = { ...currentIssue, labels: [] };

    // 4. 触发真实 reconciliation
    const reconResult = await authority.reconcileRunningIssues();
    expect(reconResult.stoppedIssueIds).toEqual([currentIssue.id]);
    await waitFor(() => !isAlive(pid));
    expect(isAlive(pid)).toBe(false);

    // 5. 调用正式恢复入口 runDeliverySkillCli(['recover-handoff', ...])
    const recoveryRunner = new MockRecoveryGhRunner();
    // GitHub 远端已有该 handoffId 的报告
    recoveryRunner.ghResponses.push({
      stdout: JSON.stringify({
        comments: [
          {
            body: `## 🚨 Symphony Delivery Handoff Report\n\n- **Handoff ID**: \`${handoffId}\`\n<!-- symphony:handoff-id:${handoffId} -->\n- **原因**：CI 连续失败`,
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

    const exitCode = await runDeliverySkillCli(
      ["recover-handoff", "--repo", "felixjichao/symphony-ts", "--issue", "80", "--cwd", workspacePath],
      io,
      recoveryRunner,
    );

    expect(exitCode).toBe(0);

    // 关键验证：精准识别已发布，绝不发起新的评论请求（去重生效）
    const commentCall = recoveryRunner.ghCalls.find((c) => c.args[0] === "pr" && c.args[1] === "comment");
    expect(commentCall).toBeUndefined();

    // 验证磁盘状态被更新为完成闭环，且预算与 deadline 保持不变
    const finalDiskState = JSON.parse(await fs.readFile(stateFile, "utf8"));
    expect(finalDiskState.spentRepairs).toBe(2);
    expect(finalDiskState.spentWaitSeconds).toBe(45);
    expect(finalDiskState.deadlineTimestampMs).toBe(fixedDeadline);
    expect(finalDiskState.isPaused).toBe(true);
    expect(finalDiskState.readyLabelRemoved).toBe(true);
    expect(finalDiskState.commentPosted).toBe(true);
    expect(finalDiskState.commentVerifyStatus).toBe("posted");
    expect(finalDiskState.pendingCompensation).toBe(false);
    expect(finalDiskState.handoff?.handoffId).toBe(handoffId);
  }, 30_000);
});
