/**
 * M5.3 小型真实链路集成（审查建议，SPEC §8.4 / §16.6 / §17.4）。
 *
 * `runAgentAttempt → 真实 app-server fixture 子进程 → outcome → 注入 fake timer →
 * tracker refresh → 新 worker`：不 mock runner，验证 retry 重派会启动**新的 subprocess
 * session**，并**复用**同一确定性 workspace（第二次 `createdNow = false`）。
 *
 * 完整 poll loop / M5.6 跨包链路不在本用例范围。
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { runAgentAttempt, type AgentAttemptResult } from "@symphony/agent";
import type {
  AgentConfig,
  HooksConfig,
  Issue,
  PollingConfig,
  ServiceConfig,
  WorkflowDefinition,
} from "@symphony/domain";
import { createWorkspaceManager } from "@symphony/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OrchestratorAuthority,
  createOrchestratorRuntimeState,
  type AgentAttemptRunner,
  type AttemptContext,
  type DispatchPolicy,
  type RetryScheduler,
} from "./index";

const APP_SERVER_FIXTURE = fileURLToPath(
  new URL("../../agent/test-fixtures/app-server.mjs", import.meta.url),
);

function fixtureCommand(extraArgs: readonly string[] = []): string {
  return [process.execPath, APP_SERVER_FIXTURE, ...extraArgs]
    .map((part) => JSON.stringify(part))
    .join(" ");
}

/** 进程是否仍存活（`kill(pid, 0)`）：用于验证 attempt 结束后子进程确实退出。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface AttemptRecords {
  readonly startup: string;
  readonly world: string;
}

const POLICY: DispatchPolicy = {
  activeStates: ["Todo", "In Progress"],
  terminalStates: ["Done", "Cancelled"],
  requiredLabels: [],
  maxConcurrentAgentsByState: {},
};

class ManualScheduler implements RetryScheduler {
  private next = 0;
  private readonly callbacks = new Map<number, () => void>();

  public schedule(_delayMs: number, callback: () => void): unknown {
    const id = ++this.next;
    this.callbacks.set(id, callback);
    return id;
  }

  public cancel(handle: unknown): void {
    if (typeof handle === "number") {
      this.callbacks.delete(handle);
    }
  }

  public fire(handle: unknown): void {
    if (typeof handle !== "number") {
      return;
    }
    const callback = this.callbacks.get(handle);
    this.callbacks.delete(handle);
    callback?.();
  }
}

/** 轮询等待异步 retry handler 真正派发（短间隔，非退避测试）。 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("retry 真实链路：subprocess → outcome → fake timer → refresh → 新 worker", () => {
  let tempDir: string;
  let workspaceRoot: string;
  let config: ServiceConfig;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "symphony-m53-retry-"));
    workspaceRoot = path.join(tempDir, "workspaces");
    await fs.mkdir(workspaceRoot, { recursive: true });

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
        turnTimeoutMs: 5_000,
        stallTimeoutMs: 10_000,
      },
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("normal exit 后 fake timer 重派：新 subprocess session + workspace 复用", async () => {
    const manager = createWorkspaceManager({ workspace: { root: workspaceRoot } });
    const issue: Issue = {
      id: "issue-m53-real",
      nativeRef: null,
      identifier: "NEST-M53",
      title: "M5.3 real chain",
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
    const workflow: WorkflowDefinition = {
      config: {},
      promptTemplate: "Handle {{ issue.identifier }}",
    };
    const workflowPath = path.join(tempDir, "WORKFLOW.md");

    const state = createOrchestratorRuntimeState({ pollIntervalMs: 10_000, maxConcurrentAgents: 10 });
    const scheduler = new ManualScheduler();
    const results: AgentAttemptResult[] = [];
    const records: AttemptRecords[] = [];
    const runner: AgentAttemptRunner = async (options) => {
      const result = await runAgentAttempt(options);
      results.push(result);
      return result;
    };

    // 每次 attempt 的 config 注入独立的 record 文件，用进程级证据区分两次 subprocess。
    const createAttemptOptions = (context: AttemptContext) => {
      const index = records.length;
      const record: AttemptRecords = {
        startup: path.join(tempDir, `startup-${index}.txt`),
        world: path.join(tempDir, `world-${index}.json`),
      };
      records.push(record);
      const attemptConfig: ServiceConfig = {
        ...config,
        codex: {
          ...config.codex,
          command: fixtureCommand([
            "--record-startup",
            record.startup,
            "--record-world",
            record.world,
          ]),
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

    const authority = new OrchestratorAuthority({
      state,
      policy: POLICY,
      runner,
      tracker: { fetchIssuesByIds: async () => [issue] },
      resolveWorkspacePath: (target) => manager.resolveWorkspacePath(target.identifier),
      now: () => 1_000,
      monotonicNow: () => 5_000,
      createAttemptOptions,
      retry: {
        scheduler,
        maxRetryBackoffMs: () => config.agent.maxRetryBackoffMs,
        cleanupWorkspace: {
          removeWorkspace: async (identifier: string) => manager.removeWorkspace(identifier),
        },
      },
    });

    interface WorldRecord {
      readonly pid: number;
      readonly cwd: string;
      readonly argv: readonly string[];
    }
    const readWorld = async (file: string): Promise<WorldRecord> =>
      JSON.parse(await fs.readFile(file, "utf8")) as WorldRecord;
    const readPid = async (file: string): Promise<number> =>
      Number.parseInt((await fs.readFile(file, "utf8")).trim(), 10);

    try {
      // 第一次 attempt：真实 subprocess 握手、单 turn、正常退出 → continuation retry。
      authority.dispatchIssue(issue);
      await authority.waitForIdle();
      expect(results).toHaveLength(1);
      expect(results[0]?.workspace.createdNow).toBe(true);
      expect(records).toHaveLength(1);

      // 进程级证据：startup PID、world cwd 绑定 workspace、attempt 结束后进程已退出。
      const pid0 = await readPid(records[0]!.startup);
      const world0 = await readWorld(records[0]!.world);
      expect(Number.isInteger(pid0) && pid0 > 0).toBe(true);
      expect(world0.pid).toBe(pid0);
      expect(world0.cwd).toBe(results[0]!.workspace.path);
      expect(isAlive(pid0)).toBe(false);

      // 在复用前写入 marker：retry 复用同一 workspace 时必须保留内容。
      const markerPath = path.join(results[0]!.workspace.path, "reuse-marker.txt");
      await fs.writeFile(markerPath, "keep-across-retry", "utf8");

      const retry = state.retryAttempts.get(issue.id);
      expect(retry).toMatchObject({ attempt: 1, error: null });

      // retry timer fired → refresh（active）→ 第二次真实 attempt。
      scheduler.fire(retry!.timerHandle);
      await waitFor(() => authority.activeWorkerCount === 1);
      await authority.waitForIdle();
      expect(results).toHaveLength(2);
      expect(records).toHaveLength(2);

      // 新 session / 新 subprocess attempt：两次 PID 不同。
      expect(results[1]?.turnCount).toBe(1);
      expect(results[1]?.threadId).toBeTruthy();
      expect(results[1]?.lastTurn.sessionId).toBeTruthy();
      const pid1 = await readPid(records[1]!.startup);
      const world1 = await readWorld(records[1]!.world);
      expect(Number.isInteger(pid1) && pid1 > 0).toBe(true);
      expect(pid1).not.toBe(pid0);
      expect(world1.pid).toBe(pid1);
      expect(world1.cwd).toBe(results[1]!.workspace.path);
      expect(world1.cwd).toBe(world0.cwd);
      expect(isAlive(pid1)).toBe(false);

      // workspace 复用：同一确定性路径，第二次不再新建，且 marker 内容保留。
      expect(results[1]?.workspace.path).toBe(results[0]?.workspace.path);
      expect(results[1]?.workspace.createdNow).toBe(false);
      expect(await fs.readFile(markerPath, "utf8")).toBe("keep-across-retry");
    } finally {
      authority.cancelScheduledRetry(issue.id);
    }
  }, 30_000);
});
