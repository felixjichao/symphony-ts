/**
 * 真实 fixture 回归（审查 blocker 2 及其续修）：异 thread / 异 turn 的 completion 由
 * agent 映射为稳定 `other_message`，不得推进 orchestrator 的 LiveSession turn 计数、
 * 改混身份，或（在 thread owner 尚未确认时）抢占 owner。
 *
 * 使用真实 `runAgentAttempt` + 现有 app-server fixture + 真实临时 workspace，不 mock runner。
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

import {
  applyAgentEvent,
  createAgentTelemetryState,
  createOrchestratorRuntimeState,
  type AgentTelemetryState,
} from "./index";

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

describe("interleaved / early foreign completion — 真实 fixture", () => {
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

  function makeConfig(fixtureFlags: readonly string[]): ServiceConfig {
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
    return {
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
        command: fixtureCommand(fixtureFlags),
        approvalPolicy: "never",
        threadSandbox: null,
        turnSandboxPolicy: null,
        readTimeoutMs: 5_000,
        turnTimeoutMs: 5_000,
        stallTimeoutMs: 10_000,
      },
    };
  }

  interface Reduction {
    readonly runTurnCount: number;
    readonly runThreadId: string;
    readonly session: RunningEntry["session"];
    readonly telemetry: AgentTelemetryState;
    readonly state: ReturnType<typeof createOrchestratorRuntimeState>;
  }

  async function runWithFixture(fixtureFlags: readonly string[]): Promise<Reduction> {
    const config = makeConfig(fixtureFlags);
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

    return {
      runTurnCount: result.turnCount,
      runThreadId: result.threadId,
      session: entry.session,
      telemetry,
      state,
    };
  }

  it("夹入的 other-completed 不污染 turn 计数与身份", async () => {
    const r = await runWithFixture(["--interleaved-other-completed"]);

    expect(r.runTurnCount).toBe(1);
    expect(r.telemetry.turnCount).toBe(1);
    expect(r.session?.turnCount).toBe(1);
    expect(r.session?.threadId).toBe(r.runThreadId);
    expect(r.state.codexTotals.inputTokens).toBe(0);
    expect(r.state.codexTotals.totalTokens).toBe(0);
  });

  it("thread/start 响应前夹入异 thread completion：不锁定错误 owner，真实身份与 usage 不受影响", async () => {
    const r = await runWithFixture(["--foreign-completed-before-thread-start", "--send-usage"]);

    expect(r.runTurnCount).toBe(1);
    expect(r.runThreadId).toBe("thread-test-uuid-1");
    expect(r.session?.threadId).toBe("thread-test-uuid-1");
    expect(r.session?.turnCount).toBe(1);
    expect(r.telemetry.threadId).toBe("thread-test-uuid-1");
    // fixture 单 turn 上报绝对 usage 100 / 50 / 150。
    expect(r.state.codexTotals).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
    expect(r.session?.codexTotalTokens).toBe(150);
  });

  it("交错候选绝对快照 A→B→A 不重复入账（审查复现）", async () => {
    const r = await runWithFixture(["--candidate-usage-before-thread-start", "--send-usage"]);

    expect(r.runTurnCount).toBe(1);
    expect(r.runThreadId).toBe("thread-test-uuid-1");
    // A=100 + B=20 + A 重复快照 0 + A=150 增量 50 = 170（不是重复计 A 的 270）。
    expect(r.state.codexTotals).toMatchObject({
      inputTokens: 120,
      outputTokens: 50,
      totalTokens: 170,
    });
    expect(r.session?.codexTotalTokens).toBe(150);
    expect(r.session?.lastReportedTotalTokens).toBe(150);
  });
});
