/**
 * M5.4 小型真实链路集成（SPEC §7.4、§8.5、§16.3、§17.4｜验收 03 / 04 的真实世界面）。
 *
 * `runAgentAttempt → 真实 app-server fixture 子进程 → reconciliation stop → outcome →
 * terminal cleanup`：不 mock runner，验证
 * - terminal 刷新必须等真实 worker（含 subprocess）收尾**之后**才删除 workspace，且
 *   子进程确实已退出；
 * - non-active 停止保留 workspace（不删除）。
 *
 * 完整 poll loop / M5.6 跨包链路不在本用例范围。
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { runAgentAttempt } from "@symphony/agent";
import type {
  AgentConfig,
  HooksConfig,
  Issue,
  PollingConfig,
  ServiceConfig,
  WorkflowDefinition,
} from "@symphony/domain";
import { createWorkspaceManager, type WorkspaceManager } from "@symphony/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OrchestratorAuthority,
  createOrchestratorRuntimeState,
  type AgentAttemptRunner,
  type AttemptContext,
  type DispatchPolicy,
  type RetryWorkspaceCleanup,
} from "./index";

const APP_SERVER_FIXTURE = fileURLToPath(
  new URL("../../agent/test-fixtures/app-server.mjs", import.meta.url),
);

function fixtureCommand(extraArgs: readonly string[] = []): string {
  return [process.execPath, APP_SERVER_FIXTURE, ...extraArgs]
    .map((part) => JSON.stringify(part))
    .join(" ");
}

/** 进程是否仍存活（`kill(pid, 0)`）。 */
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

const POLICY: DispatchPolicy = {
  activeStates: ["Todo", "In Progress"],
  terminalStates: ["Done", "Cancelled"],
  requiredLabels: [],
  maxConcurrentAgentsByState: {},
};

describe("reconciliation 真实链路：subprocess 停止 → outcome → cleanup", () => {
  let tempDir: string;
  let workspaceRoot: string;
  let config: ServiceConfig;
  let manager: WorkspaceManager;
  let currentIssue: Issue;
  let observedPid: number | null = null;

  const issue = (state: string): Issue => ({ ...currentIssue, state });

  function makeAuthority(options: {
    readonly cleanupWorkspace: RetryWorkspaceCleanup;
  }): OrchestratorAuthority {
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
          // turn 完成被延迟：worker 在 reconcile 时确实仍在运行。
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
        fetchIssuesByIds: async (ids) =>
          ids.includes(currentIssue.id) ? [currentIssue] : [],
      },
      resolveWorkspacePath: (target) => manager.resolveWorkspacePath(target.identifier),
      now: () => 1_000,
      monotonicNow: () => 5_000,
      createAttemptOptions,
      cleanupWorkspace: options.cleanupWorkspace,
      onCleanupDiagnostic: () => {},
    });
    return authority;
  }

  beforeEach(async () => {
    observedPid = null;
    tempDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "symphony-m54-real-"));
    workspaceRoot = path.join(tempDir, "workspaces");
    await fs.mkdir(workspaceRoot, { recursive: true });
    manager = createWorkspaceManager({ workspace: { root: workspaceRoot } });

    const hooks: HooksConfig = {
      afterCreate: null,
      beforeRun: null,
      // 每个 attempt 收尾都写 marker（cwd = workspace），供 cleanup 时验证 after_run 已结束。
      afterRun: "printf 'after-run' > after-run.marker",
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
        requiredLabels: [],
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
      id: "issue-m54-real",
      nativeRef: null,
      identifier: "NEST-M54",
      title: "M5.4 real chain",
      description: null,
      priority: 1,
      state: "Todo",
      branchName: null,
      url: null,
      assigneeId: null,
      labels: [],
      blockedBy: [],
      dispatchable: true,
      createdAt: 1,
      updatedAt: null,
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("terminal 刷新：真实 subprocess 与 after_run 收尾后才删除 workspace", async () => {
    // cleanup 端口在**删除发生的时刻**观测世界：PID 必须已退出、after_run marker 必须已写入。
    const observations: Array<{ pidAlive: boolean; afterRunMarker: boolean }> = [];
    const cleanupProbe: RetryWorkspaceCleanup = {
      removeWorkspace: async (identifier: string) => {
        observations.push({
          pidAlive: observedPid !== null && isAlive(observedPid),
          afterRunMarker: await pathExists(
            path.join(manager.resolveWorkspacePath(identifier), "after-run.marker"),
          ),
        });
        return manager.removeWorkspace(identifier);
      },
    };
    const authority = makeAuthority({ cleanupWorkspace: cleanupProbe });

    authority.dispatchIssue(currentIssue);
    const startupFile = path.join(tempDir, "startup-0.txt");
    await waitFor(() => pathExists(startupFile));
    const pid = Number.parseInt((await fs.readFile(startupFile, "utf8")).trim(), 10);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(isAlive(pid)).toBe(true);
    observedPid = pid;
    const workspacePath = manager.resolveWorkspacePath(currentIssue.identifier);
    expect(await pathExists(workspacePath)).toBe(true);

    // tracker 观察为 terminal → reconcile 停止 worker 并清理 workspace。
    currentIssue = issue("Done");
    const result = await authority.reconcileRunningIssues();

    expect(result.stoppedIssueIds).toEqual([currentIssue.id]);
    expect(result.cleanedIssueIds).toEqual([currentIssue.id]);
    expect(authority.activeWorkerCount).toBe(0);
    // 删除发生时已满足次序：subprocess 已退出、after_run 已完成。
    expect(observations).toEqual([{ pidAlive: false, afterRunMarker: true }]);
    // 真实收尾发生在删除之前：stop 返回时子进程已退出、目录已删除。
    expect(isAlive(pid)).toBe(false);
    expect(await pathExists(workspacePath)).toBe(false);
  }, 30_000);

  it("non-active 刷新：停止真实 subprocess 但保留 workspace", async () => {
    const authority = makeAuthority({
      cleanupWorkspace: { removeWorkspace: (identifier) => manager.removeWorkspace(identifier) },
    });

    authority.dispatchIssue(currentIssue);
    const startupFile = path.join(tempDir, "startup-0.txt");
    await waitFor(() => pathExists(startupFile));
    const pid = Number.parseInt((await fs.readFile(startupFile, "utf8")).trim(), 10);
    expect(isAlive(pid)).toBe(true);

    currentIssue = issue("Paused");
    const result = await authority.reconcileRunningIssues();

    expect(result.stoppedIssueIds).toEqual([currentIssue.id]);
    expect(result.cleanedIssueIds).toEqual([]);
    expect(isAlive(pid)).toBe(false);
    // workspace 保留（non-active 不 cleanup）。
    const workspacePath = manager.resolveWorkspacePath(currentIssue.identifier);
    expect(await pathExists(workspacePath)).toBe(true);
  }, 30_000);
});
