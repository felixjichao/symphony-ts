/**
 * NEST-128: 联合回归验证
 * 链路：被停止的 Worker 实际执行 runDeliverySkill 交付实现 → fake Git/gh 在受控动作处触发真实 Orchestrator reconciliation
 *       → Worker 终止 → 重读 Worker 自身生成的真实磁盘状态 → 正式 recover-handoff 恢复入口。
 * 覆盖两个关键取消点：
 * 1. 移除标签后、尚未发评论（worker 在标签确认移除后被 reconciliation 终止）
 * 2. 远端接收评论后、尚未记录回执（评论已被 GitHub 接收，但 worker 在本地写入回执前被终止）
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  runDeliverySkill,
  type AgentAttemptOptions,
  type AgentAttemptResult,
  type DeliveryGitGhRunner,
  type DeliverySubprocessResult,
} from "@symphony/agent";
import type {
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
  type ReconciliationResult,
} from "@symphony/orchestrator";
import { createWorkspaceManager, type WorkspaceManager } from "@symphony/workspace";

import { FileDeliveryStateStorage, runDeliverySkillCli } from "./delivery-skill-cli";

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

class FakeDeliveryGhRunner implements DeliveryGitGhRunner {
  readonly ghCalls: Array<{ args: readonly string[]; cwd: string }> = [];
  readonly gitCalls: Array<{ args: readonly string[]; cwd: string }> = [];
  readonly execCalls: Array<{ command: string; cwd: string }> = [];

  readonly publishedPrComments: Array<{ body: string }> = [];

  // 屏障钩子：delivery-skill 确认移除标签时触发真实 reconciliation
  onLabelRemovalVerified?: () => Promise<void> | void;

  // 屏障钩子：GitHub 远端成功接收交接评论时触发真实 reconciliation / 进程崩溃
  onPrCommentReceived?: (body: string) => Promise<void> | void;

  async git(args: readonly string[], cwd: string): Promise<DeliverySubprocessResult> {
    this.gitCalls.push({ args, cwd });
    if (args[0] === "branch" && args[1] === "--show-current") {
      return { stdout: "symphony/GH-80\n", stderr: "", exitCode: 0 };
    }
    if (args[0] === "remote" && args[1] === "get-url") {
      return { stdout: "https://github.com/owner/repo.git\n", stderr: "", exitCode: 0 };
    }
    if (args[0] === "status") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "push") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      return { stdout: "sha-head-initial\n", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  async exec(command: string, cwd: string): Promise<DeliverySubprocessResult> {
    this.execCalls.push({ command, cwd });
    return { stdout: "ok", stderr: "", exitCode: 0 };
  }

  async gh(args: readonly string[], cwd: string): Promise<DeliverySubprocessResult> {
    this.ghCalls.push({ args, cwd });

    // 1. Issue view for pre-mutation inspection
    if (args[0] === "issue" && args[1] === "view" && args.some((a) => a.includes("title,body") || a.includes("title"))) {
      return {
        stdout: JSON.stringify({ state: "OPEN", title: "issue 80", body: "body 80", labels: [{ name: "symphony-ready" }] }),
        stderr: "",
        exitCode: 0,
      };
    }

    // 2. PR list: 存在已开启的目标 PR #95
    if (args[0] === "pr" && args[1] === "list") {
      return {
        stdout: JSON.stringify([
          {
            number: 95,
            url: "https://github.com/owner/repo/pull/95",
            title: "feat: delivery for #80",
            state: "OPEN",
            headRefOid: "sha-head-initial",
            body: 'Fixes #80\n\n<!-- symphony-delivery-marker: {"schemaVersion":1,"workspaceKey":"GH-80","issueNumber":80,"repo":"owner/repo","headBranch":"symphony/GH-80","baseBranch":"main"} -->',
          },
        ]),
        stderr: "",
        exitCode: 0,
      };
    }

    // 3. PR view: 模拟 CI 检查失败，触发 delivery 修复/暂停分支
    if (args[0] === "pr" && args[1] === "view" && args.some((a) => a.includes("statusCheckRollup"))) {
      return {
        stdout: JSON.stringify({
          headRefOid: "sha-head-initial",
          state: "OPEN",
          mergeable: "MERGEABLE",
          statusCheckRollup: [
            { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "FAILURE" },
          ],
        }),
        stderr: "",
        exitCode: 0,
      };
    }

    // 4. Issue edit --remove-label symphony-ready: 移除标签成功
    if (args[0] === "issue" && args[1] === "edit" && args.includes("--remove-label")) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    // 5. Issue view --json labels: 标签移除验证屏障
    if (args[0] === "issue" && args[1] === "view" && args.includes("labels")) {
      if (this.onLabelRemovalVerified) {
        await this.onLabelRemovalVerified();
      }
      return { stdout: JSON.stringify({ labels: [] }), stderr: "", exitCode: 0 };
    }

    // 6. PR comment: 发布交接报告评论
    if (args[0] === "pr" && args[1] === "comment") {
      const bodyIdx = args.indexOf("--body");
      const body = bodyIdx !== -1 && args[bodyIdx + 1] ? args[bodyIdx + 1]! : "";
      this.publishedPrComments.push({ body });
      if (this.onPrCommentReceived) {
        await this.onPrCommentReceived(body);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    // 7. PR view comments: recover-handoff 查询远端评论
    if (args[0] === "pr" && args[1] === "view" && args.includes("comments")) {
      return {
        stdout: JSON.stringify({ comments: this.publishedPrComments }),
        stderr: "",
        exitCode: 0,
      };
    }

    return { stdout: "", stderr: "", exitCode: 0 };
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
  let manager: WorkspaceManager;
  let currentIssue: Issue;
  let currentWorkerRunner: AgentAttemptRunner;

  function makeAuthority(): OrchestratorAuthority {
    const workflow: WorkflowDefinition = {
      config: {},
      promptTemplate: "Handle {{ issue.identifier }}",
    };
    const workflowPath = path.join(tempDir, "WORKFLOW.md");

    const runner: AgentAttemptRunner = async (attemptOptions) => {
      return await currentWorkerRunner(attemptOptions);
    };

    const polling: PollingConfig = { intervalMs: 10_000 };
    const config: ServiceConfig = {
      tracker: {
        kind: "memory",
        provider: {},
        requiredLabels: ["symphony-ready"],
        activeStates: null,
        terminalStates: null,
      },
      polling,
      workspace: { root: workspaceRoot },
      hooks: {
        afterCreate: null,
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 5_000,
      },
      agent: {
        maxConcurrentAgents: 10,
        maxTurns: 1,
        maxRetryBackoffMs: 300_000,
        maxConcurrentAgentsByState: {},
      },
      codex: {
        command: "node",
        approvalPolicy: "never",
        threadSandbox: null,
        turnSandboxPolicy: null,
        readTimeoutMs: 5_000,
        turnTimeoutMs: 60_000,
        stallTimeoutMs: 10_000,
      },
    };

    const createAttemptOptions = (context: AttemptContext) => ({
      issue: context.issue,
      attempt: context.attempt,
      workflow,
      workflowPath,
      getConfig: () => config,
      signal: context.signal,
      onPhase: context.onPhase,
      onEvent: context.onEvent,
      continuationDecider: context.continuationDecider,
    });

    const state = createOrchestratorRuntimeState({ pollIntervalMs: 10_000, maxConcurrentAgents: 10 });
    return new OrchestratorAuthority({
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
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "symphony-joint-test-"));
    workspaceRoot = path.join(tempDir, "workspaces");
    await fs.mkdir(workspaceRoot, { recursive: true });
    manager = createWorkspaceManager({ workspace: { root: workspaceRoot } });

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

  it("取消点 1（移除标签后、尚未发评论）：Worker 执行真实 delivery 写入 → 标签移除触发真实 reconciliation → 重读 Worker 落盘状态并由正式入口恢复", async () => {
    const authority = makeAuthority();
    const workspacePath = manager.resolveWorkspacePath(currentIssue.identifier);
    await fs.mkdir(workspacePath, { recursive: true });

    // 1. 父测试仅准备初始非零预算（绝不预写任何 paused / handoff 终态！）
    const nowMs = 1700000000000;
    const fixedDeadline = nowMs + (300 - 45) * 1000;
    const stateFile = path.join(workspacePath, ".symphony", "delivery-state.json");
    const storage = new FileDeliveryStateStorage(stateFile);
    storage.writeState({
      repo: "owner/repo",
      issueNumber: 80,
      workspaceKey: "GH-80",
      spentRepairs: 2, // 已消耗 2 次修复预算，达到 maxRepairAttempts=2 上限
      spentWaitSeconds: 45,
      deadlineTimestampMs: fixedDeadline,
      isPaused: false, // 尚未暂停
      lastUpdated: new Date(nowMs).toISOString(),
    });

    const fakeDeliveryRunner = new FakeDeliveryGhRunner();
    let reconPromise: Promise<ReconciliationResult> | null = null;

    // 屏障设置：delivery-skill 移除标签后，在校验标签成功时触发真实 Orchestrator reconciliation
    fakeDeliveryRunner.onLabelRemovalVerified = () => {
      // 真实 tracker 上 symphony-ready 标签被移除
      currentIssue = { ...currentIssue, labels: [] };
      // 触发真实 Orchestrator active reconciliation（同步将 worker.signal 置为 abort）
      reconPromise = authority.reconcileRunningIssues();
    };

    // 2. Worker 实际执行正式 runDeliverySkill 实现
    currentWorkerRunner = (async (attemptOptions: AgentAttemptOptions) => {
      await runDeliverySkill({
        cwd: workspacePath,
        repo: "owner/repo",
        issueNumber: 80,
        workspaceKey: "GH-80",
        headBranch: "symphony/GH-80",
        baseBranch: "main",
        maxRepairAttempts: 2,
        maxWaitSeconds: 300,
        requiredChecks: ["gate"],
        nowFn: () => nowMs,
        stateStorage: storage,
        signal: attemptOptions.signal,
        runner: fakeDeliveryRunner,
        log: () => {},
      });
      return undefined as unknown as AgentAttemptResult;
    }) as unknown as AgentAttemptRunner;

    // 3. 派发 Issue，启动 Worker 执行 delivery
    const dispatchResult = authority.dispatchIssue(currentIssue);
    expect(dispatchResult.kind).toBe("dispatched");

    // 4. 等待真实 reconciliation 停止 Worker 并收敛
    await waitFor(() => reconPromise !== null);
    const reconResult = await reconPromise!;
    expect(reconResult.stoppedIssueIds).toEqual([currentIssue.id]);
    expect(reconResult.cleanedIssueIds).toEqual([]); // non-active stop 保留工作区
    expect(authority.activeWorkerCount).toBe(0);

    // 5. 验证磁盘上的状态完全是由 runDeliverySkill 自身生成并持久化的！
    const diskStateAfterKill = storage.readState();
    expect(diskStateAfterKill).not.toBeNull();
    expect(diskStateAfterKill?.isPaused).toBe(true);
    expect(diskStateAfterKill?.pauseReason).toBe("ci_failed_max_repairs");
    expect(diskStateAfterKill?.readyLabelRemoved).toBe(true);
    expect(diskStateAfterKill?.commentPosted).toBe(false); // 尚未发评论
    expect(diskStateAfterKill?.commentVerifyStatus).toBe("pending");
    expect(diskStateAfterKill?.pendingCompensation).toBe(true);
    expect(diskStateAfterKill?.spentRepairs).toBe(2); // 保持非零预算
    expect(diskStateAfterKill?.spentWaitSeconds).toBe(45);
    expect(diskStateAfterKill?.deadlineTimestampMs).toBe(fixedDeadline); // deadline 保持不变
    expect(diskStateAfterKill?.handoff?.handoffId).toBeDefined();
    expect(diskStateAfterKill?.handoff?.handoffId).toMatch(/^handoff-owner-repo-80-/);
    expect(diskStateAfterKill?.handoff?.prNumber).toBe(95);

    // 验证远端尚未发布评论
    expect(fakeDeliveryRunner.publishedPrComments.length).toBe(0);

    // 6. 调用正式恢复入口 runDeliverySkillCli(['recover-handoff', ...])
    const recoveryRunner = new FakeDeliveryGhRunner();
    const io = {
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    };

    const exitCode = await runDeliverySkillCli(
      ["recover-handoff", "--repo", "owner/repo", "--issue", "80", "--cwd", workspacePath],
      io,
      recoveryRunner,
    );

    expect(exitCode).toBe(0);

    // 验证正式恢复向 PR #95 发布了交接报告，且包含 Worker 自身生成的 handoffId
    expect(recoveryRunner.publishedPrComments.length).toBe(1);
    expect(recoveryRunner.publishedPrComments[0]?.body).toContain(diskStateAfterKill!.handoff!.handoffId);

    // 验证最终磁盘状态：预算与 deadline 不变，commentPosted 与 pendingCompensation 闭环
    const finalDiskState = storage.readState();
    expect(finalDiskState?.spentRepairs).toBe(2);
    expect(finalDiskState?.spentWaitSeconds).toBe(45);
    expect(finalDiskState?.deadlineTimestampMs).toBe(fixedDeadline);
    expect(finalDiskState?.isPaused).toBe(true);
    expect(finalDiskState?.readyLabelRemoved).toBe(true);
    expect(finalDiskState?.commentPosted).toBe(true);
    expect(finalDiskState?.commentVerifyStatus).toBe("posted");
    expect(finalDiskState?.pendingCompensation).toBe(false);
    expect(finalDiskState?.handoff?.handoffId).toBe(diskStateAfterKill!.handoff!.handoffId);
  }, 30_000);

  it("取消点 2（远端接收评论后、尚未记录回执）：Worker 执行真实 delivery 写入 → 评论发布后触发真实 reconciliation → 正式入口识别远端报告精准去重", async () => {
    const authority = makeAuthority();
    const workspacePath = manager.resolveWorkspacePath(currentIssue.identifier);
    await fs.mkdir(workspacePath, { recursive: true });

    // 1. 父测试仅准备初始非零预算（绝不预写任何 paused / handoff 终态！）
    const nowMs = 1700000000000;
    const fixedDeadline = nowMs + (300 - 45) * 1000;
    const stateFile = path.join(workspacePath, ".symphony", "delivery-state.json");
    const storage = new FileDeliveryStateStorage(stateFile);
    storage.writeState({
      repo: "owner/repo",
      issueNumber: 80,
      workspaceKey: "GH-80",
      spentRepairs: 2,
      spentWaitSeconds: 45,
      deadlineTimestampMs: fixedDeadline,
      isPaused: false,
      lastUpdated: new Date(nowMs).toISOString(),
    });

    const fakeDeliveryRunner = new FakeDeliveryGhRunner();
    let reconPromise: Promise<ReconciliationResult> | null = null;

    // 屏障设置：交接评论已被 GitHub 远端接收（记录在 publishedPrComments 中），
    // 此时模拟真实 reconciliation 触发并终止 worker（在写回本地持久化回执之前）
    fakeDeliveryRunner.onPrCommentReceived = () => {
      // tracker 移除标签并触发真实 reconciliation
      currentIssue = { ...currentIssue, labels: [] };
      reconPromise = authority.reconcileRunningIssues();
      // 抛出 reconciliation 异常模拟本地写回前进程被终止
      throw new Error("worker_finished: canceled_by_reconciliation");
    };

    // 2. Worker 实际执行正式 runDeliverySkill 实现
    currentWorkerRunner = (async (attemptOptions: AgentAttemptOptions) => {
      await runDeliverySkill({
        cwd: workspacePath,
        repo: "owner/repo",
        issueNumber: 80,
        workspaceKey: "GH-80",
        headBranch: "symphony/GH-80",
        baseBranch: "main",
        maxRepairAttempts: 2,
        maxWaitSeconds: 300,
        requiredChecks: ["gate"],
        nowFn: () => nowMs,
        stateStorage: storage,
        signal: attemptOptions.signal,
        runner: fakeDeliveryRunner,
        log: () => {},
      });
      return undefined as unknown as AgentAttemptResult;
    }) as unknown as AgentAttemptRunner;

    // 3. 派发 Issue
    const dispatchResult = authority.dispatchIssue(currentIssue);
    expect(dispatchResult.kind).toBe("dispatched");

    // 4. 等待真实 reconciliation 停止 Worker
    await waitFor(() => reconPromise !== null);
    const reconResult = await reconPromise!;
    expect(reconResult.stoppedIssueIds).toEqual([currentIssue.id]);
    expect(authority.activeWorkerCount).toBe(0);

    // 5. 验证磁盘上的状态：标签已移除，但评论回执尚未落盘（commentPosted 为 false）
    const diskStateAfterKill = storage.readState();
    expect(diskStateAfterKill).not.toBeNull();
    expect(diskStateAfterKill?.isPaused).toBe(true);
    expect(diskStateAfterKill?.readyLabelRemoved).toBe(true);
    expect(diskStateAfterKill?.commentPosted).toBe(false); // 本地回执尚未记录
    expect(diskStateAfterKill?.commentVerifyStatus).toBe("pending");
    expect(diskStateAfterKill?.pendingCompensation).toBe(true);
    expect(diskStateAfterKill?.spentRepairs).toBe(2);
    expect(diskStateAfterKill?.deadlineTimestampMs).toBe(fixedDeadline);
    expect(diskStateAfterKill?.handoff?.handoffId).toBeDefined();

    // 验证远端 GitHub 确实已经接收到了该 handoffId 的评论
    expect(fakeDeliveryRunner.publishedPrComments.length).toBe(1);
    expect(fakeDeliveryRunner.publishedPrComments[0]?.body).toContain(diskStateAfterKill!.handoff!.handoffId);

    // 6. 调用正式恢复入口 runDeliverySkillCli(['recover-handoff', ...])
    const recoveryRunner = new FakeDeliveryGhRunner();
    // 将远端已接收的评论提供给 recoveryRunner
    recoveryRunner.publishedPrComments.push(...fakeDeliveryRunner.publishedPrComments);

    const io = {
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    };

    const exitCode = await runDeliverySkillCli(
      ["recover-handoff", "--repo", "owner/repo", "--issue", "80", "--cwd", workspacePath],
      io,
      recoveryRunner,
    );

    expect(exitCode).toBe(0);

    // 关键验证：精准去重生效，绝不发起新的评论请求！
    const commentCalls = recoveryRunner.ghCalls.filter((c) => c.args[0] === "pr" && c.args[1] === "comment");
    expect(commentCalls.length).toBe(0);

    // 验证最终磁盘状态完成闭环
    const finalDiskState = storage.readState();
    expect(finalDiskState?.spentRepairs).toBe(2);
    expect(finalDiskState?.spentWaitSeconds).toBe(45);
    expect(finalDiskState?.deadlineTimestampMs).toBe(fixedDeadline);
    expect(finalDiskState?.isPaused).toBe(true);
    expect(finalDiskState?.readyLabelRemoved).toBe(true);
    expect(finalDiskState?.commentPosted).toBe(true);
    expect(finalDiskState?.commentVerifyStatus).toBe("posted");
    expect(finalDiskState?.pendingCompensation).toBe(false);
    expect(finalDiskState?.handoff?.handoffId).toBe(diskStateAfterKill!.handoff!.handoffId);
  }, 30_000);
});
