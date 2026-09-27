/**
 * 其余 §4 实体的类型契约测试：WorkflowDefinition（§4.1.2）、ServiceConfig typed
 * view（§4.1.3 / §5.3 / §6.4）、RunAttempt（§4.1.5 / §7.2）、RetryEntry（§4.1.7）、
 * RunningEntry / OrchestratorRuntimeState（§4.1.8）。
 *
 * 这些契约的主体是**编译期形状**（必填 / nullable / optional、readonly、时钟域），
 * 运行时断言只固化 SPEC 明文规定的语义。`@ts-expect-error` 均为负例类型断言
 * （见 issue.test.ts 头注）。
 */
import { describe, expect, it } from "vitest";

import {
  RUN_ATTEMPT_STATUSES,
  type CodexTotals,
  type Issue,
  type OrchestratorRuntimeState,
  type RetryEntry,
  type RunAttempt,
  type RunAttemptStatus,
  type RunningEntry,
  type ServiceConfig,
  type WorkflowDefinition,
} from "./index";

const AN_ISSUE: Issue = {
  id: "provider-item-001",
  nativeRef: null,
  identifier: "ABC-123",
  title: "Example issue",
  description: null,
  priority: null,
  state: "Todo",
  branchName: null,
  url: "https://tracker.example.com/ABC-123",
  assigneeId: null,
  labels: ["bug"],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
};

describe("WorkflowDefinition (SPEC §4.1.2 / §5.2)", () => {
  it("carries the front-matter root object and the trimmed prompt body", () => {
    const workflow: WorkflowDefinition = {
      config: {
        tracker: { kind: "linear" },
        polling: { interval_ms: 5_000 },
        unknown_extension_key: { kept: true }, // §5.3：unknown keys 不因类型报错（config 为 Record<string, unknown>）
      },
      promptTemplate: "Fix {{ issue.identifier }}.",
    };
    expect(workflow.config["tracker"]).toEqual({ kind: "linear" });
    expect(workflow.promptTemplate).toBe("Fix {{ issue.identifier }}.");
  });

  it("supports absent front matter (empty config) and an empty prompt body (§5.2 / §5.4)", () => {
    const workflow: WorkflowDefinition = { config: {}, promptTemplate: "" };
    expect(Object.keys(workflow.config)).toEqual([]);
    expect(workflow.promptTemplate).toBe("");
  });

  it("is a readonly value object at the type level", () => {
    const workflow: WorkflowDefinition = { config: {}, promptTemplate: "x" };
    const mutate = (w: WorkflowDefinition): void => {
      // @ts-expect-error WorkflowDefinition 是值对象，字段 readonly。
      w.promptTemplate = "y";
    };
    void mutate;
    expect(workflow.promptTemplate).toBe("x");
  });
});

describe("ServiceConfig typed view (SPEC §4.1.3 / §6.4)", () => {
  /** §6.4 cheat-sheet 默认值填充后的完整 resolved 配置。 */
  const resolvedWithDefaults: ServiceConfig = {
    tracker: {
      kind: "linear",
      provider: {},
      requiredLabels: [],
      activeStates: null, // null = adapter profile 文档化默认（§6.4）
      terminalStates: null,
    },
    polling: { intervalMs: 30_000 },
    workspace: { root: "/tmp/symphony_workspaces" },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000,
    },
    agent: {
      maxConcurrentAgents: 10,
      maxTurns: 20,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: {},
    },
    codex: {
      command: "codex app-server",
      approvalPolicy: null, // null = implementation-defined 默认（§5.3.6）
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 3_600_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 300_000,
    },
  };

  it("covers every §6.4 core field with the documented defaults", () => {
    expect(resolvedWithDefaults.polling.intervalMs).toBe(30_000);
    expect(resolvedWithDefaults.hooks.timeoutMs).toBe(60_000);
    expect(resolvedWithDefaults.agent.maxConcurrentAgents).toBe(10);
    expect(resolvedWithDefaults.agent.maxTurns).toBe(20);
    expect(resolvedWithDefaults.agent.maxRetryBackoffMs).toBe(300_000);
    expect(resolvedWithDefaults.codex.command).toBe("codex app-server");
    expect(resolvedWithDefaults.codex.turnTimeoutMs).toBe(3_600_000);
    expect(resolvedWithDefaults.codex.readTimeoutMs).toBe(5_000);
    expect(resolvedWithDefaults.codex.stallTimeoutMs).toBe(300_000);
  });

  it("keeps adapter-owned provider keys opaque (Record<string, unknown>)", () => {
    const config: ServiceConfig = {
      ...resolvedWithDefaults,
      tracker: {
        ...resolvedWithDefaults.tracker,
        provider: { endpoint: "https://api.example.com", team: "core" },
        activeStates: ["Todo", "In Progress"],
      },
    };
    expect(config.tracker.provider["endpoint"]).toBe("https://api.example.com");
    expect(config.tracker.activeStates).toEqual(["Todo", "In Progress"]);
  });
});

describe("RunAttempt (SPEC §4.1.5 / §7.2)", () => {
  it("models the first run with attempt === null and no error property", () => {
    const firstRun: RunAttempt = {
      issueId: AN_ISSUE.id,
      issueIdentifier: AN_ISSUE.identifier,
      attempt: null,
      workspacePath: "/tmp/symphony_workspaces/ABC-123",
      startedAt: Date.UTC(2026, 8, 27),
      status: "preparing_workspace",
    };
    expect(firstRun.attempt).toBeNull();
    expect("error" in firstRun).toBe(false);
  });

  it("models retries/continuations with attempt >= 1 and an optional error", () => {
    const retry: RunAttempt = {
      issueId: AN_ISSUE.id,
      issueIdentifier: AN_ISSUE.identifier,
      attempt: 2,
      workspacePath: "/tmp/symphony_workspaces/ABC-123",
      startedAt: Date.UTC(2026, 8, 27),
      status: "failed",
      error: "turn_failed",
    };
    expect(retry.attempt).toBeGreaterThanOrEqual(1);
    expect(retry.error).toBe("turn_failed");
  });

  it("rejects explicit undefined for the OPTIONAL error (exactOptionalPropertyTypes)", () => {
    // 仅编译期断言：build 不执行（vitest 不做类型检查）。TS2375（eOPT 违规）
    // 报告在字面量首行，因此 directive 放在声明行上方。
    // @ts-expect-error OPTIONAL 字段：要么缺席要么 string，不接受显式 undefined。
    const build = (): RunAttempt => ({
      issueId: AN_ISSUE.id,
      issueIdentifier: AN_ISSUE.identifier,
      attempt: null,
      workspacePath: "/tmp/symphony_workspaces/ABC-123",
      startedAt: Date.UTC(2026, 8, 27),
      status: "finishing",
      error: undefined,
    });
    void build;
    const withoutError: RunAttempt = {
      issueId: AN_ISSUE.id,
      issueIdentifier: AN_ISSUE.identifier,
      attempt: null,
      workspacePath: "/tmp/symphony_workspaces/ABC-123",
      startedAt: Date.UTC(2026, 8, 27),
      status: "finishing",
    };
    expect("error" in withoutError).toBe(false);
  });

  it("RUN_ATTEMPT_STATUSES covers exactly the §7.2 lifecycle phases, in order", () => {
    expect([...RUN_ATTEMPT_STATUSES]).toEqual([
      "preparing_workspace",
      "building_prompt",
      "launching_agent_process",
      "initializing_session",
      "streaming_turn",
      "finishing",
      "succeeded",
      "failed",
      "timed_out",
      "stalled",
      "canceled_by_reconciliation",
    ]);
    // 类型层：常量数组与 union 单一来源（编译期穷尽）。
    const exhaustive: readonly RunAttemptStatus[] = RUN_ATTEMPT_STATUSES;
    expect(exhaustive).toHaveLength(11);
  });
});

describe("RetryEntry (SPEC §4.1.7)", () => {
  it("stores the 1-based attempt, monotonic due time and an opaque timer handle", () => {
    const timerHandle = { opaque: "setTimeout-result" };
    const entry: RetryEntry = {
      issueId: AN_ISSUE.id,
      identifier: AN_ISSUE.identifier,
      attempt: 1,
      dueAtMs: 123_456, // MonotonicTimestampMs：仅差值有意义
      timerHandle,
      error: "turn_failed",
    };
    expect(entry.timerHandle).toBe(timerHandle); // 原样存取，不解释
    expect(entry.attempt).toBe(1);
    expect(entry.identifier).toBe("ABC-123");
  });

  it("allows best-effort identifier and no error (both nullable)", () => {
    const entry: RetryEntry = {
      issueId: AN_ISSUE.id,
      identifier: null,
      attempt: 1,
      dueAtMs: 1_000,
      timerHandle: 42,
      error: null,
    };
    expect(entry.identifier).toBeNull();
    expect(entry.error).toBeNull();
  });
});

describe("OrchestratorRuntimeState (SPEC §4.1.8)", () => {
  it("starts empty: no runs, no claims, zeroed totals, null rate limits", () => {
    const totals: CodexTotals = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0,
    };
    const state: OrchestratorRuntimeState = {
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 10,
      running: new Map(),
      claimed: new Set(),
      retryAttempts: new Map(),
      completed: new Set(),
      codexTotals: totals,
      codexRateLimits: null,
    };
    expect(state.running.size).toBe(0);
    expect(state.claimed.size).toBe(0);
    expect(state.codexRateLimits).toBeNull();
  });

  it("keys running/claimed/retryAttempts/completed by Issue.id and holds running entries", () => {
    const firstRun: RunAttempt = {
      issueId: AN_ISSUE.id,
      issueIdentifier: AN_ISSUE.identifier,
      attempt: null,
      workspacePath: "/tmp/symphony_workspaces/ABC-123",
      startedAt: Date.UTC(2026, 8, 27),
      status: "streaming_turn",
    };
    const runningEntry: RunningEntry = {
      issue: AN_ISSUE,
      attempt: firstRun,
      session: null, // 子进程 session 建立前
      workspacePath: firstRun.workspacePath,
      startedAtMs: 1_000, // MonotonicTimestampMs（§13.5 elapsed 口径）
      workerHandle: { taskRef: "worker-1" }, // 不透明 runtime 句柄
    };
    const state: OrchestratorRuntimeState = {
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 10,
      running: new Map([[AN_ISSUE.id, runningEntry]]),
      claimed: new Set([AN_ISSUE.id]),
      retryAttempts: new Map(),
      completed: new Set(),
      codexTotals: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        secondsRunning: 0,
      },
      codexRateLimits: { primary: { used_percent: 12 } },
    };

    expect(state.claimed.has(AN_ISSUE.id)).toBe(true);
    expect(state.running.get(AN_ISSUE.id)?.session).toBeNull();
    expect(state.running.get(AN_ISSUE.id)?.issue.url).toBe(
      "https://tracker.example.com/ABC-123",
    );
    expect(state.codexRateLimits?.["primary"]).toEqual({ used_percent: 12 });
  });
});
