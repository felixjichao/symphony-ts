/**
 * attempt 级取消契约测试（SPEC §10.6 / §10.7，M5.2 / #51）。
 *
 * 覆盖：启动前取消不创建 workspace / 不 spawn；握手期取消终止已 launch 的 transport；
 * continuation 等待被外部取消立即收敛。使用真实 fixture app-server 子进程与真实
 * 临时文件系统（docs/testing.md）。
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AgentConfig,
  CodexConfig,
  HooksConfig,
  Issue,
  PollingConfig,
  ServiceConfig,
  WorkflowDefinition,
} from "@symphony/domain";

import {
  executeContinuationDecider,
  runAgentAttempt,
  type AgentEvent,
  type AgentError as AgentErrorType,
} from "./index";
import { appServerFixtureCommand, isProcessAlive, waitFor } from "../test-fixtures/harness";

describe("attempt 级取消 — M5.2 / #51", () => {
  let tempDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "symphony-m52-cancel-"));
    workspaceRoot = path.join(tempDir, "workspaces");
    await fs.mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function createIssue(): Issue {
    return {
      id: "issue-c1",
      nativeRef: null,
      identifier: "NEST-C1",
      title: "Cancellation",
      description: null,
      priority: null,
      state: "In Progress",
      branchName: null,
      url: null,
      assigneeId: null,
      labels: [],
      blockedBy: [],
      dispatchable: true,
      createdAt: null,
      updatedAt: null,
    };
  }

  function createConfig(codexOverrides: Partial<CodexConfig> = {}): { getConfig: () => ServiceConfig } {
    const hooks: HooksConfig = {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 5_000,
    };
    const agent: AgentConfig = {
      maxConcurrentAgents: 10,
      maxTurns: 5,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: {},
    };
    const polling: PollingConfig = { intervalMs: 10_000 };
    const config: ServiceConfig = {
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
        command: appServerFixtureCommand(),
        approvalPolicy: "never",
        threadSandbox: null,
        turnSandboxPolicy: null,
        readTimeoutMs: 5_000,
        turnTimeoutMs: 60_000,
        stallTimeoutMs: 60_000,
        ...codexOverrides,
      },
    };
    return { getConfig: () => config };
  }

  const workflow: WorkflowDefinition = { config: {}, promptTemplate: "Do {{ issue.identifier }}" };

  it("启动前已 abort：不创建 workspace、不 spawn，抛 turn_cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { getConfig } = createConfig();

    let thrown: unknown;
    try {
      await runAgentAttempt({
        issue: createIssue(),
        attempt: null,
        workflow,
        workflowPath: path.join(tempDir, "WORKFLOW.md"),
        getConfig,
        signal: controller.signal,
      });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as AgentErrorType).code).toBe("turn_cancelled");
    const entries = await fs.readdir(workspaceRoot);
    expect(entries).toEqual([]);
  });

  it("握手期 abort：终止已 launch 的子进程并抛 turn_cancelled", async () => {
    const startupMarker = path.join(tempDir, "startup.txt");
    const { getConfig } = createConfig({ command: appServerFixtureCommand(["--record-startup", startupMarker]) });
    const controller = new AbortController();

    let thrown: unknown;
    try {
      await runAgentAttempt({
        issue: createIssue(),
        attempt: null,
        workflow,
        workflowPath: path.join(tempDir, "WORKFLOW.md"),
        getConfig,
        signal: controller.signal,
        onEvent: (event: AgentEvent) => {
          // session_started 在握手期发射：此时 abort 应终止 transport。
          if (event.event === "session_started") {
            controller.abort();
          }
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as AgentErrorType).code).toBe("turn_cancelled");

    const rawPid = (await fs.readFile(startupMarker, "utf8")).trim();
    const childPid = Number.parseInt(rawPid, 10);
    expect(Number.isSafeInteger(childPid)).toBe(true);
    await waitFor(() => !isProcessAlive(childPid), 5_000);
    expect(isProcessAlive(childPid)).toBe(false);
  });

  it("continuation 等待被外部 abort 立即收敛为 turn_cancelled", async () => {
    const controller = new AbortController();
    let deciderCalls = 0;
    const pending = executeContinuationDecider(
      () => {
        deciderCalls += 1;
        return new Promise(() => {
          /* 永不 settle，验证外部取消能立即收敛 */
        });
      },
      {
        issue: createIssue(),
        threadId: "t1",
        turnId: "u1",
        turnCount: 1,
        event: { event: "turn_completed", timestamp: 1, codexAppServerPid: null, threadId: "t1", turnId: "u1" },
      },
      60_000,
      controller.signal,
    );

    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "turn_cancelled" });
    expect(deciderCalls).toBe(1);
  });
});
