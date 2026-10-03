/**
 * 真实 fixture 回归（审查 blocker 2）：异 thread / 异 turn 的 completion 由
 * agent 映射为稳定 `other_message`，不得推进 orchestrator 的 LiveSession turn 计数
 * 或改混身份。
 *
 * 使用真实 `runAgentAttempt` + 现有 app-server fixture（`--interleaved-other-completed`）
 * + 真实临时 workspace，不 mock runner。
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
  RunningEntry,
  ServiceConfig,
  WorkflowDefinition,
} from "@symphony/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyAgentEvent, createAgentTelemetryState, createOrchestratorRuntimeState } from "./index";

const APP_SERVER_FIXTURE = fileURLToPath(
  new URL("../../agent/test-fixtures/app-server.mjs", import.meta.url),
);

/** 构造 `bash -lc` 下的 fixture 命令（仅用于测试，不 mock 子进程）。 */
function fixtureCommand(extraArgs: readonly string[]): string {
  return [process.execPath, APP_SERVER_FIXTURE, ...extraArgs]
    .map((part) => JSON.stringify(part))
    .join(" ");
}

function makeIssue(): Issue {
  return {
    id: "issue-interleaved",
    nativeRef: null,
    identifier: "NEST-INT",
    title: "Interleaved telemetry",
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

function makeEntry(issue: Issue): RunningEntry {
  return {
    issue,
    attempt: {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt: null,
      workspacePath: "/tmp/ws",
      startedAt: 0,
      status: "streaming_turn",
    },
    session: null,
    workspacePath: "/tmp/ws",
    startedAtMs: 0,
    workerHandle: null,
  };
}

describe("interleaved other-completed — 真实 fixture（审查 blocker 2）", () => {
  let tempDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "symphony-m52-interleaved-"));
    workspaceRoot = path.join(tempDir, "workspaces");
    await fs.mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("归约后的 LiveSession.turnCount 与 runner 的真实 turn 数一致，不混入异 thread/turn 事件", async () => {
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
        command: fixtureCommand(["--interleaved-other-completed"]),
        approvalPolicy: "never",
        threadSandbox: null,
        turnSandboxPolicy: null,
        readTimeoutMs: 5_000,
        turnTimeoutMs: 5_000,
        stallTimeoutMs: 10_000,
      },
    };

    const issue = makeIssue();
    const entry = makeEntry(issue);
    const telemetry = createAgentTelemetryState();
    const state = createOrchestratorRuntimeState({ pollIntervalMs: 10_000, maxConcurrentAgents: 10 });
    const workflow: WorkflowDefinition = { config: {}, promptTemplate: "Handle {{ issue.identifier }}" };

    const result = await runAgentAttempt({
      issue,
      attempt: null,
      workflow,
      workflowPath: path.join(tempDir, "WORKFLOW.md"),
      getConfig: () => config,
      onEvent: (event) => applyAgentEvent(state, entry, telemetry, event),
    });

    expect(result.turnCount).toBe(1);
    expect(telemetry.turnCount).toBe(1);
    expect(entry.session?.turnCount).toBe(1);
    expect(entry.session?.threadId).toBe(result.threadId);
    expect(entry.session?.turnId).toBe(result.lastTurn.turnId);
    // 异 thread / 异 turn 事件不携带 usage，不应污染 token 汇总。
    expect(state.codexTotals.inputTokens).toBe(0);
    expect(state.codexTotals.totalTokens).toBe(0);
  });
});
