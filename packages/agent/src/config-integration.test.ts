/**
 * config ↔ workspace ↔ agent 端到端集成验收（NEST-71 / M4.6，SPEC §10 / §12 / §17.2 / §17.5 / §18.1；
 * Core Conformance）。
 *
 * 把完整链路当作统一验收对象：
 *
 * ```text
 * 真实 WORKFLOW.md（临时目录）
 *   → @symphony/config loadEffectiveWorkflow
 *   → typed ServiceConfig + promptTemplate
 *   → @symphony/workspace WorkspaceManager
 *   → 真实临时 filesystem + 真实 lifecycle hooks
 *   → @symphony/agent runAgentAttempt
 *   → bash -lc app-server.mjs fixture 子进程
 *   → JSON-RPC session / turn / event 流
 *   → 最终 AgentAttemptResult / AgentEvent / WorkspaceHookEvent
 * ```
 *
 * 覆盖矩阵：
 * 1. workspace create / reuse / hooks 真实时序与 child 关停
 * 2. workflow front matter 解析与 prompt 严格渲染
 * 3. before_run / after_run 失败语义与 non-masking 不变量
 * 4. child cwd、bash -lc shell 展开与 launch boundary containment
 * 5. initialize / thread / turn 握手与错误参数化
 * 6. turn 终态判别与提前退出映射（含 codex_not_found）
 * 7. silence timeout、有效输出重置与 stderr 物理隔离
 * 8. headless server requests（approval / input / unsupported tool）
 * 9. telemetry 映射与多轮 continuation 循环（guidance / maxTurns / decider timeout）
 * 10. launch 边界负例补充（root equality / lexical out-of-root）
 */
import {
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadEffectiveWorkflow,
  type EffectiveWorkflow,
} from "@symphony/config";
import type {
  Issue,
} from "@symphony/domain";
import {
  createWorkspaceManager,
  type WorkspaceHookEvent,
} from "@symphony/workspace";

import {
  AgentError,
  DEFAULT_CONTINUATION_GUIDANCE,
  runAgentAttempt,
  startAppServerSession,
  type AgentEvent,
  type ContinuationDecider,
} from "./index";
import {
  appServerFixtureCommand,
  isProcessAlive,
  waitFor,
} from "../test-fixtures/harness";

// symlink 能力探测：host 不支持创建 symlink 时相关用例经 it.skipIf 显式 skip
const symlinkSupport = (() => {
  let probeDir: string | null = null;
  try {
    probeDir = mkdtempSync(path.join(os.tmpdir(), "sym-agent-integration-symlink-probe-"));
    symlinkSync(probeDir, path.join(probeDir, "probe"), "dir");
    return { supported: true as const, reason: "" };
  } catch (err: unknown) {
    return {
      supported: false as const,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (probeDir !== null) {
      try {
        rmSync(probeDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
})();

const ROOT_ENV_VAR = "SYM_AGENT_INTEGRATION_ROOT";

let tmp: string;
let workflowDir: string;
let outsideDir: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sym-agent-integration-")));
  workflowDir = path.join(tmp, "workflow");
  outsideDir = path.join(tmp, "outside");
  await fs.mkdir(workflowDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-71",
    nativeRef: { number: 71 },
    identifier: "NEST-71",
    title: "Agent integration and conformance closure",
    description: "Verify full workflow to agent runner pipeline",
    priority: 1,
    state: "In Progress",
    branchName: "feat/nest-71",
    url: "https://github.com/example/repo/issues/71",
    assigneeId: "agent-1",
    labels: ["agent", "integration", "core-conformance"],
    blockedBy: [{ id: "blocker-1", identifier: "NEST-70", state: "open" }],
    dispatchable: true,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_001_000_000,
    ...overrides,
  };
}

interface WorkflowFixtureOptions {
  workspaceRoot?: string | undefined;
  hooks?: {
    afterCreate?: readonly string[] | undefined;
    beforeRun?: readonly string[] | undefined;
    afterRun?: readonly string[] | undefined;
    timeoutMs?: number | undefined;
  } | undefined;
  agent?: {
    maxTurns?: number | undefined;
  } | undefined;
  codex?: {
    commandArgs?: readonly string[] | undefined;
    rawCommand?: string | undefined;
    approvalPolicy?: string | Record<string, unknown> | undefined;
    readTimeoutMs?: number | undefined;
    turnTimeoutMs?: number | undefined;
  } | undefined;
  promptBody?: string | undefined;
  env?: Record<string, string> | undefined;
}

function writeAndLoadWorkflow(
  dir: string,
  options: WorkflowFixtureOptions = {},
  customEnv: Record<string, string> = {},
): EffectiveWorkflow {
  const rootLine = options.workspaceRoot ?? `$${ROOT_ENV_VAR}/workspaces`;
  const lines: string[] = [
    "workspace:",
    `  root: ${rootLine}`,
  ];

  if (options.hooks) {
    lines.push("hooks:");
    lines.push(`  timeout_ms: ${options.hooks.timeoutMs ?? 5000}`);
    if (options.hooks.afterCreate) {
      lines.push("  after_create: |");
      for (const l of options.hooks.afterCreate) lines.push(`    ${l}`);
    }
    if (options.hooks.beforeRun) {
      lines.push("  before_run: |");
      for (const l of options.hooks.beforeRun) lines.push(`    ${l}`);
    }
    if (options.hooks.afterRun) {
      lines.push("  after_run: |");
      for (const l of options.hooks.afterRun) lines.push(`    ${l}`);
    }
  }

  if (options.agent) {
    lines.push("agent:");
    if (options.agent.maxTurns !== undefined) {
      lines.push(`  max_turns: ${options.agent.maxTurns}`);
    }
  }

  lines.push("codex:");
  const cmd = options.codex?.rawCommand ??
    appServerFixtureCommand(["--delay-completed-ms", "10", ...(options.codex?.commandArgs ?? [])]);
  lines.push(`  command: ${JSON.stringify(cmd)}`);
  if (options.codex?.approvalPolicy !== undefined) {
    if (typeof options.codex.approvalPolicy === "string") {
      lines.push(`  approval_policy: ${JSON.stringify(options.codex.approvalPolicy)}`);
    } else {
      lines.push("  approval_policy:");
      for (const [k, v] of Object.entries(options.codex.approvalPolicy)) {
        lines.push(`    ${k}: ${JSON.stringify(v)}`);
      }
    }
  }
  if (options.codex?.readTimeoutMs !== undefined) {
    lines.push(`  read_timeout_ms: ${options.codex.readTimeoutMs}`);
  }
  if (options.codex?.turnTimeoutMs !== undefined) {
    lines.push(`  turn_timeout_ms: ${options.codex.turnTimeoutMs}`);
  }

  const prompt = options.promptBody !== undefined ? options.promptBody : "Resolve {{ issue.identifier }}: {{ issue.title }}";
  const content = `---\n${lines.join("\n")}\n---\n${prompt}\n`;
  const workflowPath = path.join(dir, "WORKFLOW.md");
  writeFileSync(workflowPath, content, "utf8");

  return loadEffectiveWorkflow({
    path: workflowPath,
    env: {
      [ROOT_ENV_VAR]: tmp,
      ...customEnv,
      ...(options.env ?? {}),
    },
    home: tmp,
  });
}

describe("Suite 1: Workspace 创建 / 复用 / 生命周期 hooks 与进程关停 (SPEC §9 / §10.7)", () => {
  it("同 identifier 两次 attempt：路径不变、createdNow 翻转、after_create 仅执行一次、文件保留、after_run 前进程已关停", async () => {
    const seqFile = path.join(tmp, "hook-seq.log");
    const childPidFile = path.join(tmp, "child.pid");
    const stoppedCheckFile = path.join(tmp, "stopped-check.log");

    const effective = writeAndLoadWorkflow(workflowDir, {
      hooks: {
        afterCreate: [`echo "after_create:$PWD" >> '${seqFile}'`],
        beforeRun: [`echo "before_run:$PWD" >> '${seqFile}'`],
        afterRun: [
          `echo "after_run:$PWD" >> '${seqFile}'`,
          // 外部证据：在 after_run 执行时，子进程已提前被 session.stop() 关停
          `if [ -f '${childPidFile}' ]; then`,
          `  CPID=$(cat '${childPidFile}')`,
          `  if ! kill -0 "$CPID" 2>/dev/null; then`,
          `    echo "child_already_dead" >> '${stoppedCheckFile}'`,
          `  fi`,
          `fi`,
        ],
      },
      codex: {
        commandArgs: ["--record-startup", childPidFile],
      },
    });

    const issue = createIssue();

    // Attempt 1: 首次创建
    const res1 = await runAgentAttempt({
      issue,
      attempt: 1,
      workflow: effective.definition,
      workflowPath: effective.workflowPath,
      getConfig: () => effective.serviceConfig,
    });

    expect(res1.workspace.createdNow).toBe(true);
    expect(res1.stopReason).toBe("decider_stop");
    expect(res1.turnCount).toBe(1);

    // 在 workspace 内写入业务文件
    const testDoc = path.join(res1.workspace.path, "code.ts");
    await fs.writeFile(testDoc, "export const x = 42;", "utf8");

    // Attempt 2: 复用现有目录
    const res2 = await runAgentAttempt({
      issue,
      attempt: 2,
      workflow: effective.definition,
      workflowPath: effective.workflowPath,
      getConfig: () => effective.serviceConfig,
    });

    expect(res2.workspace.createdNow).toBe(false);
    expect(res2.workspace.path).toBe(res1.workspace.path);
    // 业务文件原样保留
    expect(await fs.readFile(testDoc, "utf8")).toBe("export const x = 42;");

    // 检查 hook 执行顺序
    const seq = (await fs.readFile(seqFile, "utf8")).trim().split("\n");
    expect(seq).toEqual([
      `after_create:${res1.workspace.path}`,
      `before_run:${res1.workspace.path}`,
      `after_run:${res1.workspace.path}`,
      `before_run:${res1.workspace.path}`,
      `after_run:${res1.workspace.path}`,
    ]);

    // 检查 after_run 中观测到的 child 状态（两次 attempt 的 after_run 均观测到 child 已关停）
    const stoppedLines = (await fs.readFile(stoppedCheckFile, "utf8")).trim().split("\n");
    expect(stoppedLines).toEqual(["child_already_dead", "child_already_dead"]);
  });
});

describe("Suite 2: Workflow 解析与 Prompt 严格渲染 (SPEC §5 / §6 / §12)", () => {
  it("支持 $VAR root、相对 root、snake_case 字段展开与 attempt 变量", async () => {
    const transcriptFile = path.join(tmp, "transcript.jsonl");

    // 测试相对 root 解析：相对于 WORKFLOW.md 目录
    const effective = writeAndLoadWorkflow(workflowDir, {
      workspaceRoot: "relative_workspaces",
      promptBody: "Task: {{ issue.identifier }} | {{ issue.title }} | desc: {{ issue.description }} | labels: {% for l in issue.labels %}{{ l }},{% endfor %} | blockers: {% for b in issue.blocked_by %}{{ b.identifier }},{% endfor %} | attempt: {{ attempt }}",
      codex: {
        commandArgs: ["--record-transcript", transcriptFile],
      },
    });

    const issue = createIssue({
      blockedBy: [{ id: "b-1", identifier: "NEST-70", state: "done" }],
    });
    const result = await runAgentAttempt({
      issue,
      attempt: 2,
      workflow: effective.definition,
      workflowPath: effective.workflowPath,
      getConfig: () => effective.serviceConfig,
    });

    // 验证相对 root 被解析为 workflowDir 下的绝对路径
    expect(result.workspace.path.startsWith(path.join(workflowDir, "relative_workspaces"))).toBe(true);

    // 验证首轮 wire 收到的是严格渲染后的文本，而非 Liquid 源码
    const lines = (await fs.readFile(transcriptFile, "utf8")).trim().split("\n");
    const turnStart = lines.map((l) => JSON.parse(l)).find((m: { method?: string }) => m.method === "turn/start");
    expect(turnStart).toBeDefined();
    const text = turnStart.params.input[0].text;
    expect(text).toContain("Task: NEST-71 | Agent integration and conformance closure");
    expect(text).toContain("desc: Verify full workflow to agent runner pipeline");
    expect(text).toContain("labels: agent,integration,core-conformance,");
    expect(text).toContain("blockers: NEST-70,");
    expect(text).toContain("attempt: 2");
  });

  it("首轮 attempt=null 时渲染为 null，空正文沿用默认 prompt 模板", async () => {
    const transcriptFile = path.join(tmp, "transcript-null.jsonl");

    const effective = writeAndLoadWorkflow(workflowDir, {
      promptBody: "",
      codex: {
        commandArgs: ["--record-transcript", transcriptFile],
      },
    });

    const issue = createIssue();
    await runAgentAttempt({
      issue,
      attempt: null,
      workflow: effective.definition,
      workflowPath: effective.workflowPath,
      getConfig: () => effective.serviceConfig,
    });

    const lines = (await fs.readFile(transcriptFile, "utf8")).trim().split("\n");
    const turnStart = lines.map((l) => JSON.parse(l)).find((m: { method?: string }) => m.method === "turn/start");
    expect(turnStart).toBeDefined();
    const text = turnStart.params.input[0].text;
    // 空正文沿用 SPEC §5.4 默认 prompt 模板
    expect(text).toBe("You are working on an issue from the configured tracker.");
  });

  it("未知模板变量在 launch 前严格失败，子进程不启动，after_run 仍安全执行", async () => {
    const childPidFile = path.join(tmp, "child-unknown.pid");
    const afterRunMarker = path.join(tmp, "after-run-unknown.marker");

    const effective = writeAndLoadWorkflow(workflowDir, {
      promptBody: "Unknown: {{ issue.no_such_variable_exists }}",
      hooks: {
        afterRun: [`touch '${afterRunMarker}'`],
      },
      codex: {
        commandArgs: ["--record-startup", childPidFile],
      },
    });

    const issue = createIssue();
    await expect(
      runAgentAttempt({
        issue,
        attempt: 1,
        workflow: effective.definition,
        workflowPath: effective.workflowPath,
        getConfig: () => effective.serviceConfig,
      }),
    ).rejects.toThrow();

    // 子进程完全没有启动
    expect(existsSync(childPidFile)).toBe(false);
    // after_run 依然安全执行
    expect(existsSync(afterRunMarker)).toBe(true);
  });
});

describe("Suite 3: before_run 与 after_run 失败处理与 non-masking 不变量 (SPEC §9.4 / §10.7)", () => {
  it("before_run 非零退出或超时阻止 launch，进入安全的 after_run", async () => {
    const childPidFile = path.join(tmp, "child-before-fail.pid");
    const afterRunMarker = path.join(tmp, "after-run-before-fail.marker");

    const effective = writeAndLoadWorkflow(workflowDir, {
      hooks: {
        beforeRun: ["exit 42"],
        afterRun: [`touch '${afterRunMarker}'`],
      },
      codex: {
        commandArgs: ["--record-startup", childPidFile],
      },
    });

    await expect(
      runAgentAttempt({
        issue: createIssue(),
        attempt: 1,
        workflow: effective.definition,
        workflowPath: effective.workflowPath,
        getConfig: () => effective.serviceConfig,
      }),
    ).rejects.toThrow();

    expect(existsSync(childPidFile)).toBe(false);
    expect(existsSync(afterRunMarker)).toBe(true);
  });

  it("success + after_run 非零退出或超时均保留原成功结果，并产生 operator hook 事件", async () => {
    const hookEvents: WorkspaceHookEvent[] = [];

    // 1. after_run 非零
    const effFail = writeAndLoadWorkflow(workflowDir, {
      hooks: {
        afterRun: ["exit 7"],
      },
    });

    const res1 = await runAgentAttempt({
      issue: createIssue({ identifier: "ISSUE-AR-FAIL" }),
      attempt: 1,
      workflow: effFail.definition,
      workflowPath: effFail.workflowPath,
      getConfig: () => effFail.serviceConfig,
      onHookEvent: (evt) => hookEvents.push(evt),
    });

    expect(res1.stopReason).toBe("decider_stop");
    expect(hookEvents.some((e) => e.hook === "after_run" && e.outcome === "failed")).toBe(true);

    // 2. after_run 超时
    const effTimeout = writeAndLoadWorkflow(workflowDir, {
      hooks: {
        timeoutMs: 150,
        afterRun: ["sleep 5"],
      },
    });

    const res2 = await runAgentAttempt({
      issue: createIssue({ identifier: "ISSUE-AR-TIMEOUT" }),
      attempt: 1,
      workflow: effTimeout.definition,
      workflowPath: effTimeout.workflowPath,
      getConfig: () => effTimeout.serviceConfig,
      onHookEvent: (evt) => hookEvents.push(evt),
    });

    expect(res2.stopReason).toBe("decider_stop");
    expect(hookEvents.some((e) => e.hook === "after_run" && e.outcome === "timeout")).toBe(true);
  });

  it("failure + after_run 非零或超时保留原 failure 错误，不被 hook 失败掩盖", async () => {
    const hookEvents: WorkspaceHookEvent[] = [];

    const effective = writeAndLoadWorkflow(workflowDir, {
      hooks: {
        timeoutMs: 150,
        afterRun: ["sleep 5"],
      },
      codex: {
        commandArgs: ["--turn-status", "failed", "--turn-error-message", "Original primary failure"],
      },
    });

    let primaryErr: unknown;
    try {
      await runAgentAttempt({
        issue: createIssue(),
        attempt: 1,
        workflow: effective.definition,
        workflowPath: effective.workflowPath,
        getConfig: () => effective.serviceConfig,
        onHookEvent: (evt) => hookEvents.push(evt),
      });
    } catch (err) {
      primaryErr = err;
    }

    expect(primaryErr).toBeInstanceOf(AgentError);
    expect((primaryErr as AgentError).code).toBe("turn_failed");
    expect((primaryErr as AgentError).message).toContain("Original primary failure");
    // after_run timeout 事件仍正常捕获
    expect(hookEvents.some((e) => e.hook === "after_run" && e.outcome === "timeout")).toBe(true);
  });
});

describe("Suite 4: Child cwd、bash -lc 展开与 Launch Boundary Containment (SPEC §10.1 / §17.2)", () => {
  it("真实子进程 cwd、wire 参数 cwd 均等于 per-issue workspace 绝对路径，且经 bash -lc 展开", async () => {
    const worldFile = path.join(tmp, "world.json");
    const transcriptFile = path.join(tmp, "transcript-cwd.jsonl");

    const effective = writeAndLoadWorkflow(workflowDir, {
      codex: {
        commandArgs: [
          "--record-world", worldFile,
          "--record-transcript", transcriptFile,
        ],
      },
    });

    const issue = createIssue({ identifier: "ISSUE-CWD" });
    const res = await runAgentAttempt({
      issue,
      attempt: 1,
      workflow: effective.definition,
      workflowPath: effective.workflowPath,
      getConfig: () => effective.serviceConfig,
    });

    const world = JSON.parse(await fs.readFile(worldFile, "utf8"));
    // 证明 1: child 实际 process.cwd() 等于 workspace.path
    expect(world.cwd).toBe(res.workspace.path);
    // 证明 2: bash -lc 展开了 $(pwd) 与 $BASH_VERSION
    expect(world.args.cwd).toBe(res.workspace.path);
    expect(typeof world.args.bash).toBe("string");
    expect(world.args.bash.length).toBeGreaterThan(0);

    // 证明 3: thread/start 与 turn/start 的 wire 参数携带正确的 workspace cwd
    const lines = (await fs.readFile(transcriptFile, "utf8")).trim().split("\n");
    const msgs = lines.map((l) => JSON.parse(l));
    const threadStart = msgs.find((m: { method?: string }) => m.method === "thread/start");
    const turnStart = msgs.find((m: { method?: string }) => m.method === "turn/start");
    expect(threadStart.params.cwd).toBe(res.workspace.path);
    expect(turnStart.params.cwd).toBe(res.workspace.path);
  });

  it.skipIf(!symlinkSupport.supported)("before_run 偷换逃逸 symlink 被 launch 安全拒绝，子进程零启动，外部目录原样保留", async () => {
    const secretFile = path.join(outsideDir, "secret.txt");
    await fs.writeFile(secretFile, "top-secret", "utf8");

    const startupMarker = path.join(tmp, "should-not-start.pid");
    const hookEvents: WorkspaceHookEvent[] = [];

    const effective = writeAndLoadWorkflow(workflowDir, {
      hooks: {
        // before_run 把当前 workspace 替换为指向 outsideDir 的 symlink
        beforeRun: [
          `WS_DIR="$PWD"`,
          `cd ..`,
          `rm -rf "$WS_DIR"`,
          `ln -s '${outsideDir}' "$WS_DIR"`,
        ],
      },
      codex: {
        commandArgs: ["--record-startup", startupMarker],
      },
    });

    let launchError: unknown;
    try {
      await runAgentAttempt({
        issue: createIssue({ identifier: "ISSUE-ESCAPE" }),
        attempt: 1,
        workflow: effective.definition,
        workflowPath: effective.workflowPath,
        getConfig: () => effective.serviceConfig,
        onHookEvent: (evt) => hookEvents.push(evt),
      });
    } catch (err) {
      launchError = err;
    }

    expect(launchError).toBeInstanceOf(AgentError);
    expect((launchError as AgentError).code).toBe("invalid_workspace_cwd");
    // spawn 前拦截：子进程从未启动
    expect(existsSync(startupMarker)).toBe(false);
    // 外部目录完好无损
    expect(await fs.readFile(secretFile, "utf8")).toBe("top-secret");
  });
});

describe("Suite 5: initialize / thread / turn 握手与错误参数化 (SPEC §10.2 / §10.3 / §17.5)", () => {
  it("transcript 严格保证 initialize → initialized → thread/start → turn/start 时序与身份传递", async () => {
    const transcriptFile = path.join(tmp, "transcript-seq.jsonl");

    const effective = writeAndLoadWorkflow(workflowDir, {
      codex: {
        approvalPolicy: "never",
        commandArgs: ["--record-transcript", transcriptFile],
      },
    });

    const res = await runAgentAttempt({
      issue: createIssue({ identifier: "ISSUE-HANDSHAKE" }),
      attempt: 1,
      workflow: effective.definition,
      workflowPath: effective.workflowPath,
      getConfig: () => effective.serviceConfig,
    });

    const lines = (await fs.readFile(transcriptFile, "utf8")).trim().split("\n");
    const msgs = lines.map((l) => JSON.parse(l));

    expect(msgs[0].method).toBe("initialize");
    expect(msgs[0].params.clientInfo.name).toBe("symphony-ts");
    expect(msgs[1].method).toBe("initialized");
    expect(msgs[2].method).toBe("thread/start");
    expect(msgs[2].params.approvalPolicy).toBe("never");
    expect(msgs[3].method).toBe("turn/start");
    expect(msgs[3].params.threadId).toBe(res.threadId);
  });

  const failureScenarios = [
    { arg: "--invalid-init", expectedCode: "protocol_error", name: "缺失 userAgent 的非法 initialize 响应" },
    { arg: "--missing-thread-id", expectedCode: "protocol_error", name: "缺失 thread.id 的 thread/start 响应" },
    { arg: "--error-on-turn-start", expectedCode: "response_error", name: "turn/start 收到 JSON-RPC error" },
    { arg: "--invalid-turn-response", expectedCode: "protocol_error", name: "turn/start 收到非 inProgress 状态" },
  ];

  for (const { arg, expectedCode, name } of failureScenarios) {
    it(`参数化启动异常：${name} 稳定映射为 ${expectedCode} 并回收进程`, async () => {
      const pidFile = path.join(tmp, `startup-${expectedCode}-${arg.replace(/[^a-zA-Z0-9]/g, "")}.pid`);
      const effective = writeAndLoadWorkflow(workflowDir, {
        codex: {
          commandArgs: [arg, "--record-startup", pidFile],
        },
      });

      let caught: unknown;
      try {
        await runAgentAttempt({
          issue: createIssue(),
          attempt: 1,
          workflow: effective.definition,
          workflowPath: effective.workflowPath,
          getConfig: () => effective.serviceConfig,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AgentError);
      expect((caught as AgentError).code).toBe(expectedCode);

      // 确认子进程已启动并在失败后完成回收
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number((await fs.readFile(pidFile, "utf8")).trim());
      const dead = await waitFor(() => !isProcessAlive(pid), 3000);
      expect(dead).toBe(true);
    });
  }
});

describe("Suite 6: 终态判定与提前退出映射 (SPEC §10.6 / §14.1 / §17.5)", () => {
  it("turn.status completed / failed / interrupted 准确映射，且失败后不触发 continuation", async () => {
    let deciderCalled = false;
    const decider: ContinuationDecider = async () => {
      deciderCalled = true;
      return { kind: "stop" };
    };

    // 1. turn_failed
    const effFail = writeAndLoadWorkflow(workflowDir, {
      codex: {
        commandArgs: ["--turn-status", "failed", "--turn-error-message", "Model crashed"],
      },
    });

    await expect(
      runAgentAttempt({
        issue: createIssue(),
        attempt: 1,
        workflow: effFail.definition,
        workflowPath: effFail.workflowPath,
        getConfig: () => effFail.serviceConfig,
        continuationDecider: decider,
      }),
    ).rejects.toSatisfy((err) => err instanceof AgentError && err.code === "turn_failed");
    expect(deciderCalled).toBe(false);

    // 2. turn_cancelled
    const effInterrupted = writeAndLoadWorkflow(workflowDir, {
      codex: {
        commandArgs: ["--turn-status", "interrupted"],
      },
    });

    await expect(
      runAgentAttempt({
        issue: createIssue(),
        attempt: 1,
        workflow: effInterrupted.definition,
        workflowPath: effInterrupted.workflowPath,
        getConfig: () => effInterrupted.serviceConfig,
        continuationDecider: decider,
      }),
    ).rejects.toSatisfy((err) => err instanceof AgentError && err.code === "turn_cancelled");
    expect(deciderCalled).toBe(false);
  });

  it("握手前退出码 127 映射为 codex_not_found，其他非零退出映射为 port_exit", async () => {
    // 握手前 127
    const eff127 = writeAndLoadWorkflow(workflowDir, {
      codex: {
        commandArgs: ["--exit-before-handshake", "127"],
      },
    });

    await expect(
      runAgentAttempt({
        issue: createIssue(),
        attempt: 1,
        workflow: eff127.definition,
        workflowPath: eff127.workflowPath,
        getConfig: () => eff127.serviceConfig,
      }),
    ).rejects.toSatisfy((err) => err instanceof AgentError && err.code === "codex_not_found");

    // 握手前 1
    const eff1 = writeAndLoadWorkflow(workflowDir, {
      codex: {
        commandArgs: ["--exit-before-handshake", "1"],
      },
    });

    await expect(
      runAgentAttempt({
        issue: createIssue(),
        attempt: 1,
        workflow: eff1.definition,
        workflowPath: eff1.workflowPath,
        getConfig: () => eff1.serviceConfig,
      }),
    ).rejects.toSatisfy((err) => err instanceof AgentError && err.code === "port_exit");

    // turn 中途退出
    const effExitTurn = writeAndLoadWorkflow(workflowDir, {
      codex: {
        commandArgs: ["--exit-during-turn"],
      },
    });

    await expect(
      runAgentAttempt({
        issue: createIssue(),
        attempt: 1,
        workflow: effExitTurn.definition,
        workflowPath: effExitTurn.workflowPath,
        getConfig: () => effExitTurn.serviceConfig,
      }),
    ).rejects.toSatisfy((err) => err instanceof AgentError && err.code === "port_exit");
  });
});

describe("Suite 7: Timeout、stderr 与 framing 隔离 (SPEC §10.3 / §10.6)", () => {
  it("silent initialize 触发 response_timeout，silent turn 触发 turn_timeout", async () => {
    const effInit = writeAndLoadWorkflow(workflowDir, {
      codex: {
        readTimeoutMs: 200,
        commandArgs: ["--silent-init"],
      },
    });

    await expect(
      runAgentAttempt({
        issue: createIssue(),
        attempt: 1,
        workflow: effInit.definition,
        workflowPath: effInit.workflowPath,
        getConfig: () => effInit.serviceConfig,
      }),
    ).rejects.toSatisfy((err) => err instanceof AgentError && err.code === "response_timeout");

    const effTurn = writeAndLoadWorkflow(workflowDir, {
      codex: {
        turnTimeoutMs: 200,
        commandArgs: ["--silent-turn"],
      },
    });

    await expect(
      runAgentAttempt({
        issue: createIssue(),
        attempt: 1,
        workflow: effTurn.definition,
        workflowPath: effTurn.workflowPath,
        getConfig: () => effTurn.serviceConfig,
      }),
    ).rejects.toSatisfy((err) => err instanceof AgentError && err.code === "turn_timeout");
  });

  it("有效 periodic output 延长 silence 窗口；stderr 噪声不能延长且伪造 protocol 不进入解析器", async () => {
    // 1. periodic output 保持活跃：turnTimeoutMs=80ms，但每 25ms 发一次 notification（共 6 次），
    // 持续活跃耗时 ~170ms（明确跨过 80ms 初始超时窗口），相邻间隔 25ms 保留充分余量（< 80ms），turn 正常完成
    const effPeriodic = writeAndLoadWorkflow(workflowDir, {
      codex: {
        turnTimeoutMs: 80,
        commandArgs: ["--periodic-notifications", "6", "--delay-completed-ms", "20"],
      },
    });

    const res = await runAgentAttempt({
      issue: createIssue(),
      attempt: 1,
      workflow: effPeriodic.definition,
      workflowPath: effPeriodic.workflowPath,
      getConfig: () => effPeriodic.serviceConfig,
    });
    expect(res.stopReason).toBe("decider_stop");

    // 2. periodic output 停止后静默，silence timer 超时发生（证明输出停止后进入超时）
    const effPeriodicHang = writeAndLoadWorkflow(workflowDir, {
      codex: {
        turnTimeoutMs: 80,
        commandArgs: ["--periodic-notifications", "3", "--periodic-hang-after"],
      },
    });

    await expect(
      runAgentAttempt({
        issue: createIssue(),
        attempt: 1,
        workflow: effPeriodicHang.definition,
        workflowPath: effPeriodicHang.workflowPath,
        getConfig: () => effPeriodicHang.serviceConfig,
      }),
    ).rejects.toSatisfy((err) => err instanceof AgentError && err.code === "turn_timeout");

    // 3. stderr 刷屏无法延长 silence 窗口：turn 依然静默，超时发生
    const effStderrSpam = writeAndLoadWorkflow(workflowDir, {
      codex: {
        turnTimeoutMs: 150,
        commandArgs: ["--stderr-spam", "--silent-turn"],
      },
    });

    await expect(
      runAgentAttempt({
        issue: createIssue(),
        attempt: 1,
        workflow: effStderrSpam.definition,
        workflowPath: effStderrSpam.workflowPath,
        getConfig: () => effStderrSpam.serviceConfig,
      }),
    ).rejects.toSatisfy((err) => err instanceof AgentError && err.code === "turn_timeout");
  });
});

describe("Suite 8: Headless Server Requests (Approval / Input / Tool) (SPEC §10.4 / §10.5)", () => {
  it("approval never 自动同意并完成 turn，非 never 稳定失败为 approval_required", async () => {
    const events: AgentEvent[] = [];

    // never 策略
    const effNever = writeAndLoadWorkflow(workflowDir, {
      codex: {
        approvalPolicy: "never",
        commandArgs: ["--server-request", "command-approval"],
      },
    });

    const res = await runAgentAttempt({
      issue: createIssue(),
      attempt: 1,
      workflow: effNever.definition,
      workflowPath: effNever.workflowPath,
      getConfig: () => effNever.serviceConfig,
      onEvent: (e) => events.push(e),
    });

    expect(res.stopReason).toBe("decider_stop");
    expect(events.some((e) => e.event === "approval_auto_approved")).toBe(true);

    // manual 策略
    const effManual = writeAndLoadWorkflow(workflowDir, {
      codex: {
        approvalPolicy: "manual",
        commandArgs: ["--server-request", "command-approval"],
      },
    });

    await expect(
      runAgentAttempt({
        issue: createIssue(),
        attempt: 1,
        workflow: effManual.definition,
        workflowPath: effManual.workflowPath,
        getConfig: () => effManual.serviceConfig,
      }),
    ).rejects.toSatisfy((err) => err instanceof AgentError && err.code === "approval_required");
  });

  it("人工输入请求立即以 turn_input_required 失败", async () => {
    const effective = writeAndLoadWorkflow(workflowDir, {
      codex: {
        commandArgs: ["--server-request", "user-input"],
      },
    });

    await expect(
      runAgentAttempt({
        issue: createIssue(),
        attempt: 1,
        workflow: effective.definition,
        workflowPath: effective.workflowPath,
        getConfig: () => effective.serviceConfig,
      }),
    ).rejects.toSatisfy((err) => err instanceof AgentError && err.code === "turn_input_required");
  });

  it("unsupported tool 返回结构化失败且两轮 turn 连续成功完成", async () => {
    const events: AgentEvent[] = [];
    const effective = writeAndLoadWorkflow(workflowDir, {
      codex: {
        commandArgs: ["--multi-turn-tool"],
      },
    });

    let continuationCount = 0;
    const decider: ContinuationDecider = async () => {
      continuationCount += 1;
      return continuationCount === 1 ? { kind: "continue", issue: createIssue() } : { kind: "stop" };
    };

    const res = await runAgentAttempt({
      issue: createIssue(),
      attempt: 1,
      workflow: effective.definition,
      workflowPath: effective.workflowPath,
      getConfig: () => effective.serviceConfig,
      continuationDecider: decider,
      onEvent: (e) => events.push(e),
    });

    expect(res.turnCount).toBe(2);
    expect(res.stopReason).toBe("decider_stop");
    expect(events.some((e) => e.event === "unsupported_tool_call")).toBe(true);
  });
});

describe("Suite 9: Telemetry 映射与多轮 Continuation 循环 (SPEC §10.2 / §10.4 / §12.3)", () => {
  it("遥测快照无损映射到 AgentEvent；多轮 continuation 共用同一 live thread，首轮模板后轮 guidance", async () => {
    const transcriptFile = path.join(tmp, "transcript-multi-turn.jsonl");
    const events: AgentEvent[] = [];

    const effective = writeAndLoadWorkflow(workflowDir, {
      agent: { maxTurns: 5 },
      promptBody: "Initial strict prompt: {{ issue.identifier }}",
      codex: {
        commandArgs: [
          "--send-usage",
          "--send-rate-limits",
          "--record-transcript", transcriptFile,
        ],
      },
    });

    let currentTurn = 0;
    const decider: ContinuationDecider = async (ctx) => {
      currentTurn += 1;
      if (currentTurn === 1) {
        // 透传 refreshed issue
        return { kind: "continue", issue: { ...ctx.issue, title: "Refreshed by continuation" } };
      }
      return { kind: "stop" };
    };

    const res = await runAgentAttempt({
      issue: createIssue(),
      attempt: 1,
      workflow: effective.definition,
      workflowPath: effective.workflowPath,
      getConfig: () => effective.serviceConfig,
      continuationDecider: decider,
      onEvent: (e) => events.push(e),
    });

    expect(res.turnCount).toBe(2);
    expect(res.stopReason).toBe("decider_stop");
    expect(res.issue.title).toBe("Refreshed by continuation");

    // 验证遥测事件：完整的 usage 快照与非累加断言（SPEC §10.4）
    const usageEvents = events.filter(
      (e) => e.event === "notification" && e.protocolMethod === "thread/tokenUsage/updated",
    );
    expect(usageEvents).toHaveLength(2);
    // Turn 1 usage 快照提取
    expect(usageEvents[0]?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
    // Turn 2 usage 快照提取：验证其为独立快照，未将 Turn 1 累加进来（300 而非 150 + 300 = 450）
    expect(usageEvents[1]?.usage).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
    });
    expect(usageEvents[1]?.usage?.totalTokens).not.toBe(150 + 300);

    // 验证 rateLimits 事件：完整的 rateLimits 快照与 account 级身份断言
    const rateLimitEvents = events.filter(
      (e) => e.event === "notification" && e.protocolMethod === "account/rateLimits/updated",
    );
    expect(rateLimitEvents.length).toBeGreaterThanOrEqual(1);
    expect(rateLimitEvents[0]?.rateLimits).toEqual({
      limitId: "lim-1",
      limitName: "standard",
      normalModelSlug: "gpt-4",
      primary: { usedPercent: 42, windowMinutes: 60 },
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: false,
      planType: "team",
      rateLimitReachedType: null,
    });
    // account 级限流快照不包含 turnId 与 sessionId
    expect("turnId" in (rateLimitEvents[0] ?? {})).toBe(false);
    expect("sessionId" in (rateLimitEvents[0] ?? {})).toBe(false);

    // 验证 wire transcript：首轮使用渲染模板，后续轮使用 DEFAULT_CONTINUATION_GUIDANCE
    const lines = (await fs.readFile(transcriptFile, "utf8")).trim().split("\n");
    const msgs = lines.map((l) => JSON.parse(l));
    const turnStarts = msgs.filter((m: { method?: string }) => m.method === "turn/start");
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts[0].params.input[0].text).toBe("Initial strict prompt: NEST-71");
    expect(turnStarts[1].params.input[0].text).toBe(DEFAULT_CONTINUATION_GUIDANCE);
    // 两轮共用同一 threadId
    expect(turnStarts[0].params.threadId).toBe(res.threadId);
    expect(turnStarts[1].params.threadId).toBe(res.threadId);
  });

  it("达到 max_turns 硬上限以 max_turns 正常结束", async () => {
    const effective = writeAndLoadWorkflow(workflowDir, {
      agent: { maxTurns: 2 },
    });

    // decider 总是请求继续，但 max_turns=2 限制
    const decider: ContinuationDecider = async (ctx) => ({ kind: "continue", issue: ctx.issue });

    const res = await runAgentAttempt({
      issue: createIssue(),
      attempt: 1,
      workflow: effective.definition,
      workflowPath: effective.workflowPath,
      getConfig: () => effective.serviceConfig,
      continuationDecider: decider,
    });

    expect(res.turnCount).toBe(2);
    expect(res.stopReason).toBe("max_turns");
  });

  it("decider 超时映射为 continuation_timeout，进程与 after_run 正常清理", async () => {
    const afterRunMarker = path.join(tmp, "after-run-decider-timeout.marker");
    const effective = writeAndLoadWorkflow(workflowDir, {
      hooks: {
        afterRun: [`touch '${afterRunMarker}'`],
      },
    });

    const hangingDecider: ContinuationDecider = async () => {
      await new Promise((r) => setTimeout(r, 2000));
      return { kind: "stop" };
    };

    await expect(
      runAgentAttempt({
        issue: createIssue(),
        attempt: 1,
        workflow: effective.definition,
        workflowPath: effective.workflowPath,
        getConfig: () => effective.serviceConfig,
        continuationDecider: hangingDecider,
        continuationTimeoutMs: 150,
      }),
    ).rejects.toSatisfy((err) => err instanceof AgentError && err.code === "continuation_timeout");

    expect(existsSync(afterRunMarker)).toBe(true);
  });
});

describe("Suite 10: Launch 负例补充 (SPEC §9.5 / §17.2)", () => {
  it("root equality 与 lexical out-of-root 经公共 startAppServerSession 稳定拒绝为 invalid_workspace_cwd", async () => {
    const wsRoot = path.join(tmp, "workspaces");
    await fs.mkdir(wsRoot, { recursive: true });
    const manager = createWorkspaceManager({ workspace: { root: wsRoot } });

    // 1. root equality
    await expect(
      startAppServerSession({
        command: appServerFixtureCommand(),
        workspacePath: wsRoot,
        workspacePathSafety: manager,
      }),
    ).rejects.toSatisfy((err) => err instanceof AgentError && err.code === "invalid_workspace_cwd");

    // 2. lexical out-of-root
    const outPath = path.join(wsRoot, "..", "outside");
    await expect(
      startAppServerSession({
        command: appServerFixtureCommand(),
        workspacePath: outPath,
        workspacePathSafety: manager,
      }),
    ).rejects.toSatisfy((err) => err instanceof AgentError && err.code === "invalid_workspace_cwd");
  });
});
