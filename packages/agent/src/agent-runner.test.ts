/**
 * Agent Runner 测试（SPEC §10.7 / §12 / §16.5，M4.5 / #41）。
 *
 * 覆盖 9 项验收指标：
 * 1. strict prompt 使用真实 config renderer；unknown variable 在 child launch 前失败，无 child 启动，after_run 仍执行；
 * 2. before_run failure 阻断 child launch，child marker 缺席，after_run 仍执行；
 * 3. normal attempt 执行 after_run；子进程确认停止；目录文件保留；同 identifier 复用 workspace 不重复 after_create；
 * 4. startup / turn / timeout 失败均执行 after_run，且 after_run failure 不覆盖原结果；
 * 5. continuation 复用同一 thread，新 turn ID 由 app-server 返回；首轮为模板渲染，后续轮为 guidance，refreshed issue 生效；
 * 6. maxTurns 硬上限；达到上限以 stopReason="max_turns" 正常结束；提前 stop 以 "decider_stop" 结束；
 * 7. 可替换 decider；无 eligibility/retry policy；超时与迟到结算收敛；
 * 8. repo-wide 边界断言（已在 contracts.test.ts 锁定）；
 * 9. gate 全绿。
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
  TrackerConfig,
  WorkflowDefinition,
  WorkspaceConfig,
} from "@symphony/domain";
import type { WorkspaceHookEvent } from "@symphony/workspace";

import {
  AgentError,
  DEFAULT_CONTINUATION_GUIDANCE,
  executeContinuationDecider,
  runAgentAttempt,
  type AgentEvent,
  type ContinuationDecider,
} from "./index";
import { appServerFixtureCommand, isProcessAlive, waitFor } from "../test-fixtures/harness";

describe("Agent Runner — SPEC §10.7 / §12 / §16.5 Worker Attempt Primitive", () => {
  let tempDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "symphony-m45-"));
    workspaceRoot = path.join(tempDir, "workspaces");
    await fs.mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function createIssue(overrides: Partial<Issue> = {}): Issue {
    return {
      id: "issue-100",
      nativeRef: { number: 100 },
      identifier: "NEST-100",
      title: "Worker attempt integration",
      description: "Testing worker attempt runner",
      priority: null,
      state: "In Progress",
      branchName: null,
      url: null,
      assigneeId: null,
      labels: ["agent", "runner"],
      blockedBy: [],
      dispatchable: true,
      createdAt: 1_700_000_000_000,
      updatedAt: null,
      ...overrides,
    };
  }

  function createConfig(
    codexArgs: string[] = [],
    hooksOverrides: Partial<HooksConfig> = {},
    serviceOverrides: {
      tracker?: Partial<TrackerConfig>;
      polling?: Partial<PollingConfig>;
      workspace?: Partial<WorkspaceConfig>;
      hooks?: Partial<HooksConfig>;
      agent?: Partial<AgentConfig>;
      codex?: Partial<CodexConfig>;
    } = {},
  ): { getConfig: () => ServiceConfig } {
    const hooks: HooksConfig = {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 5_000,
      ...hooksOverrides,
      ...serviceOverrides.hooks,
    };

    const config: ServiceConfig = {
      tracker: {
        kind: "memory",
        provider: {},
        requiredLabels: [],
        activeStates: null,
        terminalStates: null,
        ...serviceOverrides.tracker,
      },
      polling: {
        intervalMs: 10_000,
        ...serviceOverrides.polling,
      },
      workspace: {
        root: workspaceRoot,
        ...serviceOverrides.workspace,
      },
      hooks,
      agent: {
        maxConcurrentAgents: 10,
        maxTurns: 5,
        maxRetryBackoffMs: 300_000,
        maxConcurrentAgentsByState: {},
        ...serviceOverrides.agent,
      },
      codex: {
        command: appServerFixtureCommand(["--delay-completed-ms", "5", ...codexArgs]),
        approvalPolicy: "never",
        threadSandbox: null,
        turnSandboxPolicy: null,
        readTimeoutMs: 5_000,
        turnTimeoutMs: 5_000,
        stallTimeoutMs: 10_000,
        ...serviceOverrides.codex,
      },
    };

    return {
      getConfig: () => config,
    };
  }

  describe("验收 1: 真实 strict renderer 与未知变量在 launch 前失败", () => {
    it("正常模板使用真实 config 严格渲染，变量全部展开到首轮 prompt", async () => {
      const transcriptFile = path.join(tempDir, "transcript.jsonl");
      const { getConfig } = createConfig(["--record-transcript", transcriptFile]);
      const issue = createIssue({ identifier: "ISSUE-42", title: "Strict prompt test" });
      const workflow: WorkflowDefinition = {
        config: {},
        promptTemplate:
          "Handle {{ issue.identifier }}: {{ issue.title }} with labels: {% for l in issue.labels %}{{ l }},{% endfor %} attempt={{ attempt }}",
      };

      const result = await runAgentAttempt({
        issue,
        attempt: 1,
        workflow,
        workflowPath: path.join(tempDir, "WORKFLOW.md"),
        getConfig,
      });

      expect(result.stopReason).toBe("decider_stop");
      expect(result.turnCount).toBe(1);

      // 验证 transcript 中首轮 turn/start 携带真实 renderer 结果
      const transcript = (await fs.readFile(transcriptFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });

      const turnStartMsg = transcript.find((m) => m.method === "turn/start");
      expect(turnStartMsg).toBeDefined();
      const input = (turnStartMsg?.params?.input as Array<{ text: string }>)?.[0];
      expect(input?.text).toBe(
        "Handle ISSUE-42: Strict prompt test with labels: agent,runner, attempt=1",
      );
    });

    it("unknown variable 在 child launch 之前报错，阻止子进程启动，但 after_run 依然执行", async () => {
      const startupMarker = path.join(tempDir, "child-started.marker");
      const afterRunMarker = path.join(tempDir, "after-run.marker");
      const { getConfig } = createConfig(["--record-startup", startupMarker], {
        afterRun: `echo "after_run_executed" > "${afterRunMarker}"`,
      });

      const issue = createIssue();
      // 使用未知变量 {{ issue.unknown_future_field }}，严格模式下 Liquid 将报错
      const workflow: WorkflowDefinition = {
        config: {},
        promptTemplate: "Task: {{ issue.unknown_future_field }}",
      };

      let thrownError: unknown;
      try {
        await runAgentAttempt({
          issue,
          attempt: null,
          workflow,
          workflowPath: path.join(tempDir, "WORKFLOW.md"),
          getConfig,
        });
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeDefined();
      expect((thrownError as { code?: string }).code).toBe("template_render_error");

      // 验证 child 未启动
      let childStarted = false;
      try {
        await fs.stat(startupMarker);
        childStarted = true;
      } catch {
        childStarted = false;
      }
      expect(childStarted).toBe(false);

      // 验证 after_run 依然执行
      const afterRunContent = await fs.readFile(afterRunMarker, "utf8");
      expect(afterRunContent.trim()).toBe("after_run_executed");
    });
  });

  describe("验收 2: before_run failure 阻断 child launch", () => {
    it("before_run 退出非零时阻止子进程启动，抛出 hook_execution_failed，且 after_run 执行", async () => {
      const startupMarker = path.join(tempDir, "child-started.marker");
      const beforeRunMarker = path.join(tempDir, "before-run.marker");
      const afterRunMarker = path.join(tempDir, "after-run.marker");

      const { getConfig } = createConfig(["--record-startup", startupMarker], {
        beforeRun: `echo "before_run_ran" > "${beforeRunMarker}"; exit 42`,
        afterRun: `echo "after_run_ran" > "${afterRunMarker}"`,
      });

      const issue = createIssue();
      const workflow: WorkflowDefinition = {
        config: {},
        promptTemplate: "Fix issue {{ issue.identifier }}",
      };

      let thrownError: unknown;
      try {
        await runAgentAttempt({
          issue,
          attempt: 1,
          workflow,
          workflowPath: path.join(tempDir, "WORKFLOW.md"),
          getConfig,
        });
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeDefined();
      expect((thrownError as { code?: string }).code).toBe("hook_execution_failed");

      // before_run 确实运行过
      const beforeRunContent = await fs.readFile(beforeRunMarker, "utf8");
      expect(beforeRunContent.trim()).toBe("before_run_ran");

      // child 未启动
      let childStarted = false;
      try {
        await fs.stat(startupMarker);
        childStarted = true;
      } catch {
        childStarted = false;
      }
      expect(childStarted).toBe(false);

      // after_run 依然执行
      const afterRunContent = await fs.readFile(afterRunMarker, "utf8");
      expect(afterRunContent.trim()).toBe("after_run_ran");
    });
  });

  describe("验收 3: normal attempt 执行 after_run 与 workspace 保持", () => {
    it("正常 attempt 执行 after_run，子进程退出，目录与业务文件保留，再次运行复用且不重复 after_create", async () => {
      const afterCreateMarker = path.join(tempDir, "after-create.count");
      const afterRunMarker = path.join(tempDir, "after-run.count");
      const startupPidFile = path.join(tempDir, "child.pid");
      const pidStatusFile = path.join(tempDir, "pid-status-during-after-run.txt");

      const { getConfig } = createConfig(["--record-startup", startupPidFile], {
        afterCreate: `echo "create" >> "${afterCreateMarker}"`,
        afterRun: `echo "run" >> "${afterRunMarker}"; PID=$(cat "${startupPidFile}"); if kill -0 "$PID" 2>/dev/null; then echo "ALIVE" > "${pidStatusFile}"; else echo "STOPPED" > "${pidStatusFile}"; fi`,
      });

      const issue = createIssue({ identifier: "SYM-REUSE" });
      const workflow: WorkflowDefinition = {
        config: {},
        promptTemplate: "Resolve {{ issue.identifier }}",
      };

      // 第一次运行
      const result1 = await runAgentAttempt({
        issue,
        attempt: 1,
        workflow,
        workflowPath: path.join(tempDir, "WORKFLOW.md"),
        getConfig,
      });

      expect(result1.stopReason).toBe("decider_stop");

      // 验证 PID 记录已产生，且在 after_run 执行时子进程就已经被 stop
      const pidStatusDuringHook = (await fs.readFile(pidStatusFile, "utf8")).trim();
      expect(pidStatusDuringHook).toBe("STOPPED");

      const pidStr = (await fs.readFile(startupPidFile, "utf8")).trim();
      const pid = Number.parseInt(pidStr, 10);
      expect(Number.isFinite(pid)).toBe(true);
      const processStopped = await waitFor(() => !isProcessAlive(pid), 3_000);
      expect(processStopped).toBe(true);

      // 在 workspace 写入一个业务标记文件
      const userWorkFile = path.join(result1.workspace.path, "work.txt");
      await fs.writeFile(userWorkFile, "important artifact content", "utf8");

      // 验证 after_create 和 after_run 各执行了一次
      const createCount1 = (await fs.readFile(afterCreateMarker, "utf8")).trim().split("\n").length;
      const runCount1 = (await fs.readFile(afterRunMarker, "utf8")).trim().split("\n").length;
      expect(createCount1).toBe(1);
      expect(runCount1).toBe(1);

      // 第二次运行相同 identifier
      const result2 = await runAgentAttempt({
        issue,
        attempt: 2,
        workflow,
        workflowPath: path.join(tempDir, "WORKFLOW.md"),
        getConfig,
      });

      expect(result2.workspace.path).toBe(result1.workspace.path);
      // 业务文件仍完好保留
      const preservedContent = await fs.readFile(userWorkFile, "utf8");
      expect(preservedContent).toBe("important artifact content");

      // after_create 不重复执行（仍为 1），after_run 再次执行（变为 2）
      const createCount2 = (await fs.readFile(afterCreateMarker, "utf8")).trim().split("\n").length;
      const runCount2 = (await fs.readFile(afterRunMarker, "utf8")).trim().split("\n").length;
      expect(createCount2).toBe(1);
      expect(runCount2).toBe(2);
    });

    it("正常 attempt 成功但在 after_run hook 失败（exit non-zero）时，结果仍正常返回且不被覆盖", async () => {
      const hookEvents: WorkspaceHookEvent[] = [];
      const startupPidFile = path.join(tempDir, "child-afterrun-fail.pid");
      const { getConfig } = createConfig(["--record-startup", startupPidFile], {
        afterRun: "exit 42",
      });

      const issue = createIssue();
      const workflow: WorkflowDefinition = {
        config: {},
        promptTemplate: "Do {{ issue.identifier }}",
      };

      const result = await runAgentAttempt({
        issue,
        attempt: 1,
        workflow,
        workflowPath: path.join(tempDir, "WORKFLOW.md"),
        getConfig,
        onHookEvent: (evt) => hookEvents.push(evt),
      });

      // attempt 结果未被覆盖，正常返回
      expect(result.stopReason).toBe("decider_stop");
      expect(result.turnCount).toBe(1);

      // after_run 的失败通过 onHookEvent 暴露
      expect(hookEvents.some((e) => e.hook === "after_run" && e.outcome === "failed")).toBe(true);

      // 子进程依然已退出
      const pidStr = (await fs.readFile(startupPidFile, "utf8")).trim();
      const pid = Number.parseInt(pidStr, 10);
      expect(await waitFor(() => !isProcessAlive(pid), 3_000)).toBe(true);
    });
  });

  describe("验收 4: startup / turn / timeout 失败均执行 after_run 且不覆盖结果", () => {
    it("startup exit 127 映射为 codex_not_found，执行 after_run", async () => {
      const afterRunMarker = path.join(tempDir, "after-run.marker");
      const { getConfig } = createConfig(["--exit-before-handshake", "127"], {
        afterRun: `echo "after_run_on_startup_127" > "${afterRunMarker}"`,
      });

      const issue = createIssue();
      const workflow: WorkflowDefinition = {
        config: {},
        promptTemplate: "Do {{ issue.identifier }}",
      };

      let thrownError: unknown;
      try {
        await runAgentAttempt({
          issue,
          attempt: 1,
          workflow,
          workflowPath: path.join(tempDir, "WORKFLOW.md"),
          getConfig,
        });
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(AgentError);
      expect((thrownError as AgentError).code).toBe("codex_not_found");

      const afterRunContent = await fs.readFile(afterRunMarker, "utf8");
      expect(afterRunContent.trim()).toBe("after_run_on_startup_127");
    });

    it("turn 失败抛出 turn_failed，执行 after_run，且 after_run non-zero 不覆盖原结果", async () => {
      const hookEvents: WorkspaceHookEvent[] = [];
      const { getConfig } = createConfig(
        [
          "--turn-status",
          "failed",
          "--turn-error-message",
          "syntactic compilation error",
        ],
        {
          afterRun: `exit 99`, // after_run 失败
        },
      );

      const issue = createIssue();
      const workflow: WorkflowDefinition = {
        config: {},
        promptTemplate: "Do {{ issue.identifier }}",
      };

      let thrownError: unknown;
      try {
        await runAgentAttempt({
          issue,
          attempt: 1,
          workflow,
          workflowPath: path.join(tempDir, "WORKFLOW.md"),
          getConfig,
          onHookEvent: (evt) => hookEvents.push(evt),
        });
      } catch (err) {
        thrownError = err;
      }

      // 原 turn_failed 错误不被覆盖
      expect(thrownError).toBeInstanceOf(AgentError);
      expect((thrownError as AgentError).code).toBe("turn_failed");
      expect((thrownError as AgentError).message).toContain("syntactic compilation error");

      // hook 失败事件通过 onHookEvent 暴露
      expect(hookEvents.some((e) => e.hook === "after_run" && e.outcome === "failed")).toBe(true);
    });

    it("turn silence timeout 执行 after_run，抛出 turn_timeout，且子进程 PID 已终止", async () => {
      const afterRunMarker = path.join(tempDir, "after-run.marker");
      const startupPidFile = path.join(tempDir, "child-turn-timeout.pid");
      const { getConfig } = createConfig(
        ["--silent-turn", "--record-startup", startupPidFile],
        {
          afterRun: `echo "after_run_on_turn_timeout" > "${afterRunMarker}"`,
        },
        {
          codex: {
            command: appServerFixtureCommand([
              "--silent-turn",
              "--record-startup",
              startupPidFile,
            ]),
            approvalPolicy: "never",
            threadSandbox: null,
            turnSandboxPolicy: null,
            readTimeoutMs: 5_000,
            turnTimeoutMs: 150, // 短 silence timeout
            stallTimeoutMs: 10_000,
          },
        },
      );

      const issue = createIssue();
      const workflow: WorkflowDefinition = {
        config: {},
        promptTemplate: "Do {{ issue.identifier }}",
      };

      let thrownError: unknown;
      try {
        await runAgentAttempt({
          issue,
          attempt: 1,
          workflow,
          workflowPath: path.join(tempDir, "WORKFLOW.md"),
          getConfig,
        });
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(AgentError);
      expect((thrownError as AgentError).code).toBe("turn_timeout");

      const afterRunContent = await fs.readFile(afterRunMarker, "utf8");
      expect(afterRunContent.trim()).toBe("after_run_on_turn_timeout");

      // 验证失败后子进程完全退出
      const pidStr = (await fs.readFile(startupPidFile, "utf8")).trim();
      const pid = Number.parseInt(pidStr, 10);
      expect(await waitFor(() => !isProcessAlive(pid), 3_000)).toBe(true);
    });

    it("before_run timeout 阻止子进程启动，抛出 hook_timeout，且 after_run 执行", async () => {
      const startupMarker = path.join(tempDir, "child-never-started.marker");
      const afterRunMarker = path.join(tempDir, "after-run-on-before-run-timeout.marker");
      const { getConfig } = createConfig(
        ["--record-startup", startupMarker],
        {
          beforeRun: "sleep 10",
          afterRun: `echo "after_run_executed" > "${afterRunMarker}"`,
          timeoutMs: 150,
        },
      );

      const issue = createIssue();
      const workflow: WorkflowDefinition = {
        config: {},
        promptTemplate: "Do {{ issue.identifier }}",
      };

      let thrownError: unknown;
      try {
        await runAgentAttempt({
          issue,
          attempt: 1,
          workflow,
          workflowPath: path.join(tempDir, "WORKFLOW.md"),
          getConfig,
        });
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeDefined();
      expect((thrownError as { code?: string }).code).toBe("hook_timeout");

      let childStarted = false;
      try {
        await fs.stat(startupMarker);
        childStarted = true;
      } catch {
        childStarted = false;
      }
      expect(childStarted).toBe(false);

      const afterRunContent = await fs.readFile(afterRunMarker, "utf8");
      expect(afterRunContent.trim()).toBe("after_run_executed");
    });

    it("startup read timeout 抛出 read_timeout，执行 after_run，且子进程 PID 已终止", async () => {
      const afterRunMarker = path.join(tempDir, "after-run-startup-timeout.marker");
      const startupPidFile = path.join(tempDir, "startup-timeout-child.pid");
      const { getConfig } = createConfig(
        ["--silent-init", "--record-startup", startupPidFile],
        {
          afterRun: `echo "after_run_on_startup_timeout" > "${afterRunMarker}"`,
        },
        {
          codex: {
            command: appServerFixtureCommand([
              "--silent-init",
              "--record-startup",
              startupPidFile,
            ]),
            approvalPolicy: "never",
            threadSandbox: null,
            turnSandboxPolicy: null,
            readTimeoutMs: 150, // 短 read timeout
            turnTimeoutMs: 5_000,
            stallTimeoutMs: 10_000,
          },
        },
      );

      const issue = createIssue();
      const workflow: WorkflowDefinition = {
        config: {},
        promptTemplate: "Do {{ issue.identifier }}",
      };

      let thrownError: unknown;
      try {
        await runAgentAttempt({
          issue,
          attempt: 1,
          workflow,
          workflowPath: path.join(tempDir, "WORKFLOW.md"),
          getConfig,
        });
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(AgentError);
      expect((thrownError as AgentError).code).toBe("response_timeout");

      const afterRunContent = await fs.readFile(afterRunMarker, "utf8");
      expect(afterRunContent.trim()).toBe("after_run_on_startup_timeout");

      const pidStr = (await fs.readFile(startupPidFile, "utf8")).trim();
      const pid = Number.parseInt(pidStr, 10);
      expect(await waitFor(() => !isProcessAlive(pid), 3_000)).toBe(true);
    });
  });

  describe("验收 5: continuation 复用同一 thread，新 turn ID 由 app-server 返回", () => {
    it("多次 turn 复用同一 thread，首轮使用模板渲染，后续轮使用 guidance，新 turn ID 各异", async () => {
      const transcriptFile = path.join(tempDir, "transcript.jsonl");
      const { getConfig } = createConfig(["--record-transcript", transcriptFile]);

      const issue = createIssue({ identifier: "CONT-1", title: "Continuation Test" });
      const workflow: WorkflowDefinition = {
        config: {},
        promptTemplate: "First prompt for {{ issue.identifier }}",
      };

      let deciderCount = 0;
      const seenSnapshots: Issue[] = [];
      const decider: ContinuationDecider = async (ctx) => {
        deciderCount += 1;
        seenSnapshots.push(ctx.issue);
        if (deciderCount === 1) {
          // 第一次完成：带 refreshed Issue 继续
          return {
            kind: "continue",
            issue: {
              ...ctx.issue,
              title: "Updated Title After Turn 1",
            },
          };
        }
        return { kind: "stop" };
      };

      const events: AgentEvent[] = [];
      const result = await runAgentAttempt({
        issue,
        attempt: 1,
        workflow,
        workflowPath: path.join(tempDir, "WORKFLOW.md"),
        getConfig,
        continuationDecider: decider,
        onEvent: (e) => events.push(e),
      });

      expect(result.stopReason).toBe("decider_stop");
      expect(result.turnCount).toBe(2);
      expect(result.issue.title).toBe("Updated Title After Turn 1");

      // 验证 transcript 请求
      const lines = (await fs.readFile(transcriptFile, "utf8")).trim().split("\n");
      const msgs = lines.map(
        (l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown> },
      );

      // thread/start 只调用了一次
      const threadStartCalls = msgs.filter((m) => m.method === "thread/start");
      expect(threadStartCalls).toHaveLength(1);

      // turn/start 发生了 2 次
      const turnStartCalls = msgs.filter((m) => m.method === "turn/start");
      expect(turnStartCalls).toHaveLength(2);

      // turn 1 传入首轮模板
      const input1 = (turnStartCalls[0]?.params?.input as Array<{ text: string }>)?.[0];
      expect(input1?.text).toBe("First prompt for CONT-1");

      // turn 2 传入 DEFAULT_CONTINUATION_GUIDANCE，未重发完整模板
      const input2 = (turnStartCalls[1]?.params?.input as Array<{ text: string }>)?.[0];
      expect(input2?.text).toBe(DEFAULT_CONTINUATION_GUIDANCE);

      // 两个 turn 的 turn ID 不同
      const completedEvents = events.filter((e) => e.event === "turn_completed");
      expect(completedEvents).toHaveLength(2);
      expect(completedEvents[0]?.turnId).toBe("turn-test-uuid-1");
      expect(completedEvents[1]?.turnId).toBe("turn-test-uuid-2");
      expect(result.lastTurn.turnId).toBe("turn-test-uuid-2");
    });
  });

  describe("验收 6: maxTurns 硬上限限制", () => {
    it("maxTurns=1 时即使 decider 返回 continue 也立即以 max_turns 结束，不启动第 2 轮", async () => {
      const transcriptFile = path.join(tempDir, "transcript.jsonl");
      const { getConfig } = createConfig(["--record-transcript", transcriptFile], {}, {
        agent: { maxTurns: 1 },
      });

      const issue = createIssue();
      const workflow: WorkflowDefinition = {
        config: {},
        promptTemplate: "Single turn max",
      };

      let deciderCalled = 0;
      const decider: ContinuationDecider = async (ctx) => {
        deciderCalled += 1;
        return { kind: "continue", issue: ctx.issue };
      };

      const result = await runAgentAttempt({
        issue,
        attempt: 1,
        workflow,
        workflowPath: path.join(tempDir, "WORKFLOW.md"),
        getConfig,
        continuationDecider: decider,
      });

      expect(deciderCalled).toBe(1);
      expect(result.turnCount).toBe(1);
      expect(result.stopReason).toBe("max_turns");

      const lines = (await fs.readFile(transcriptFile, "utf8")).trim().split("\n");
      const msgs = lines.map((l) => JSON.parse(l) as { method?: string });
      const turnStartCalls = msgs.filter((m) => m.method === "turn/start");
      expect(turnStartCalls).toHaveLength(1);
    });

    it("maxTurns=2 时跑满 2 轮后以 max_turns 结束，不发起第 3 轮", async () => {
      const transcriptFile = path.join(tempDir, "transcript.jsonl");
      const { getConfig } = createConfig(["--record-transcript", transcriptFile], {}, {
        agent: { maxTurns: 2 },
      });

      const issue = createIssue();
      const workflow: WorkflowDefinition = {
        config: {},
        promptTemplate: "Two turns max",
      };

      let deciderCalled = 0;
      const decider: ContinuationDecider = async (ctx) => {
        deciderCalled += 1;
        return { kind: "continue", issue: ctx.issue };
      };

      const result = await runAgentAttempt({
        issue,
        attempt: 1,
        workflow,
        workflowPath: path.join(tempDir, "WORKFLOW.md"),
        getConfig,
        continuationDecider: decider,
      });

      expect(deciderCalled).toBe(2);
      expect(result.turnCount).toBe(2);
      expect(result.stopReason).toBe("max_turns");

      const lines = (await fs.readFile(transcriptFile, "utf8")).trim().split("\n");
      const msgs = lines.map((l) => JSON.parse(l) as { method?: string });
      const turnStartCalls = msgs.filter((m) => m.method === "turn/start");
      expect(turnStartCalls).toHaveLength(2);
    });
  });

  describe("验收 7: 可替换 decider，无 tracker/eligibility 依赖，异常与超时收敛", () => {
    it("decider 抛错时以 continuation_failed 失败，保留 cause", async () => {
      const { getConfig } = createConfig();
      const issue = createIssue();
      const workflow: WorkflowDefinition = {
        config: {},
        promptTemplate: "Decider failure test",
      };

      const rootError = new Error("Custom tracker refresh network down");
      const decider: ContinuationDecider = async () => {
        throw rootError;
      };

      let thrownError: unknown;
      try {
        await runAgentAttempt({
          issue,
          attempt: 1,
          workflow,
          workflowPath: path.join(tempDir, "WORKFLOW.md"),
          getConfig,
          continuationDecider: decider,
        });
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(AgentError);
      expect((thrownError as AgentError).code).toBe("continuation_failed");
      expect((thrownError as AgentError).cause).toBe(rootError);
    });

    it("decider 返回异 ID 工单时以 continuation_failed 失败", async () => {
      const { getConfig } = createConfig();
      const issue = createIssue({ id: "expected-id" });
      const workflow: WorkflowDefinition = {
        config: {},
        promptTemplate: "Mismatched ID test",
      };

      const decider: ContinuationDecider = async (ctx) => {
        return {
          kind: "continue",
          issue: { ...ctx.issue, id: "different-id" },
        };
      };

      let thrownError: unknown;
      try {
        await runAgentAttempt({
          issue,
          attempt: 1,
          workflow,
          workflowPath: path.join(tempDir, "WORKFLOW.md"),
          getConfig,
          continuationDecider: decider,
        });
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(AgentError);
      expect((thrownError as AgentError).code).toBe("continuation_failed");
      expect((thrownError as AgentError).message).toContain("mismatched id");
    });

    it("decider 超时时以 continuation_timeout 失败，迟到 resolve/reject 不触发 unhandled rejection", async () => {
      const { getConfig } = createConfig();
      const issue = createIssue();
      const workflow: WorkflowDefinition = {
        config: {},
        promptTemplate: "Timeout test",
      };

      let lateSettled = false;
      const decider: ContinuationDecider = (ctx) => {
        return new Promise((resolve, reject) => {
          // 监听 signal
          ctx.signal?.addEventListener("abort", () => {
            // 稍后迟到 reject
            setTimeout(() => {
              lateSettled = true;
              reject(new Error("Late rejection after abort"));
            }, 50);
          });
        });
      };

      let thrownError: unknown;
      try {
        await runAgentAttempt({
          issue,
          attempt: 1,
          workflow,
          workflowPath: path.join(tempDir, "WORKFLOW.md"),
          getConfig,
          continuationDecider: decider,
          continuationTimeoutMs: 50, // 50ms 超时
        });
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(AgentError);
      expect((thrownError as AgentError).code).toBe("continuation_timeout");

      // 等待迟到结算发生，验证未崩溃
      await waitFor(() => lateSettled, 1_000);
      expect(lateSettled).toBe(true);
    });

    it("换不同 state/labels/dispatchable 的同 ID 快照，agent 照常发起续轮并将刷新快照透传到后续 context", async () => {
      const transcriptFile = path.join(tempDir, "transcript.jsonl");
      const { getConfig } = createConfig(["--record-transcript", transcriptFile]);
      const issue = createIssue({
        id: "same-id",
        identifier: "NEST-SNAPSHOT",
        state: "Open",
        labels: ["initial"],
        dispatchable: true,
      });
      const workflow: WorkflowDefinition = {
        config: {},
        promptTemplate: "Resolve {{ issue.identifier }}",
      };

      const observedContextIssues: Issue[] = [];
      const decider: ContinuationDecider = async (ctx) => {
        observedContextIssues.push(ctx.issue);
        if (ctx.turnCount === 1) {
          // 第 1 轮返回已变成 Closed / 缺失 label / dispatchable=false 的刷新快照
          return {
            kind: "continue",
            issue: {
              ...ctx.issue,
              state: "Closed",
              labels: ["arbitrary-unmatched-label"],
              dispatchable: false,
            },
          };
        }
        // 第 2 轮 stop
        return { kind: "stop" };
      };

      const result = await runAgentAttempt({
        issue,
        attempt: 1,
        workflow,
        workflowPath: path.join(tempDir, "WORKFLOW.md"),
        getConfig,
        continuationDecider: decider,
      });

      expect(result.stopReason).toBe("decider_stop");
      expect(result.turnCount).toBe(2);

      // 第 1 轮 context 看到原始 issue 快照
      expect(observedContextIssues[0]?.state).toBe("Open");
      expect(observedContextIssues[0]?.labels).toEqual(["initial"]);
      expect(observedContextIssues[0]?.dispatchable).toBe(true);

      // 第 2 轮 context 成功收到续轮返回的刷新快照，未被 agent runner 过滤或丢弃
      expect(observedContextIssues[1]?.state).toBe("Closed");
      expect(observedContextIssues[1]?.labels).toEqual(["arbitrary-unmatched-label"]);
      expect(observedContextIssues[1]?.dispatchable).toBe(false);

      // 核对 transcript：第 2 轮请求已发出，且携带标准续轮 guidance
      const lines = (await fs.readFile(transcriptFile, "utf8")).trim().split("\n");
      const msgs = lines.map(
        (l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown> },
      );
      const turnStarts = msgs.filter((m) => m.method === "turn/start");
      expect(turnStarts).toHaveLength(2);
      const input2 = (turnStarts[1]?.params?.input as Array<{ text: string }>)?.[0];
      expect(input2?.text).toBe(DEFAULT_CONTINUATION_GUIDANCE);
    });

    it("外部 decider 抛出 AgentError 被统一包装为 continuation_failed 并保留 cause（公共 API probe 回归）", async () => {
      const { getConfig } = createConfig();
      const issue = createIssue();
      const workflow: WorkflowDefinition = {
        config: {},
        promptTemplate: "Do {{ issue.identifier }}",
      };

      const injectedError = new AgentError("response_timeout", "tracker refresh HTTP timeout", {
        protocolMethod: "issue/get",
      });

      let thrownError: unknown;
      try {
        await runAgentAttempt({
          issue,
          attempt: 1,
          workflow,
          workflowPath: path.join(tempDir, "WORKFLOW.md"),
          getConfig,
          continuationDecider: async () => {
            throw injectedError;
          },
        });
      } catch (err) {
        thrownError = err;
      }

      // 验证收到的并非透传的 response_timeout，而是统一包装的 continuation_failed
      expect(thrownError).toBeInstanceOf(AgentError);
      const agentErr = thrownError as AgentError;
      expect(agentErr.code).toBe("continuation_failed");
      expect(agentErr.message).toContain("tracker refresh HTTP timeout");
      expect(agentErr.cause).toBe(injectedError);

      // 同时直接验证 executeContinuationDecider 公共出口
      let helperError: unknown;
      try {
        await executeContinuationDecider(
          async () => {
            throw new AgentError("response_timeout", "refresh failed");
          },
          {
            issue,
            threadId: "thread-test",
            turnId: "turn-test",
            turnCount: 1,
            event: {
              event: "turn_completed",
              timestamp: Date.now(),
              codexAppServerPid: null,
            },
          },
        );
      } catch (err) {
        helperError = err;
      }
      expect(helperError).toBeInstanceOf(AgentError);
      expect((helperError as AgentError).code).toBe("continuation_failed");
      expect((helperError as AgentError).cause).toBeInstanceOf(AgentError);
      expect(((helperError as AgentError).cause as AgentError).code).toBe("response_timeout");
    });
  });
});
