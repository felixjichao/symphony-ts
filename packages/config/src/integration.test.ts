/**
 * M1.5 跨组件集成验收（SPEC §17.1 Workflow and Config Parsing，Core Conformance）。
 *
 * 本文件是 M1 唯一一条**端到端**链路测试：现有四个测试文件（loader /
 * resolution / rendering / reload）各自只覆盖单模块；这里从真实临时目录里的真实
 * `WORKFLOW.md` 出发，经包唯一公共出口 `./index` 走完 load → resolve → render →
 * reload 全链路（docs/testing.md 三条哲学：验外部世界、用真实现、走真实入口），
 * 覆盖 NEST-52 的五条验收。
 *
 * 与单模块测试的分工：单模块文件逐字段穷举 SPEC 边缘语义；本文件只验证"这些模块
 * 组合起来，经过公共 API 面，对真实文件产生稳定、可判别、可恢复的外部行为"，因此
 * 断言按验收场景组织，不重复逐字段矩阵。
 *
 * watcher 用例沿用 `workflow-reload.test.ts` 已验证的模式（注入 10–20ms 轮询间隔 +
 * `afterEach` 强制 `close()`）；另有一条用 fake timer 精确断言 `close()` 不遗留
 * 定时器 handle。
 */
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Issue } from "@symphony/domain";

import {
  DEFAULT_PROMPT_TEMPLATE,
  loadEffectiveWorkflow,
  renderPrompt,
  SymphonyConfigError,
  watchWorkflow,
  type ConfigErrorCode,
  type EffectiveWorkflow,
  type WorkflowReloadEvent,
  type WorkflowWatchHandle,
} from "./index";

/** 注入的 home（不使用真实 `os.homedir()`，测试不依赖机器环境）。 */
const HOME = "/home/test-user";

/** 渲染上下文用的归一化 {@link Issue}（§4.1.1）；含嵌套集合与时间戳以覆盖映射。 */
const ISSUE: Issue = {
  id: "issue-1",
  nativeRef: { linear_id: "uuid-1" },
  identifier: "ABC-123",
  title: "Fix the widget",
  description: "It is broken.",
  priority: 1,
  state: "In Progress",
  branchName: "abc-123-fix-widget",
  url: "https://example.test/ABC-123",
  assigneeId: "user-7",
  labels: ["bug", "p1"],
  blockedBy: [{ id: "issue-2", identifier: "ABC-124", state: "Blocked" }],
  dispatchable: true,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_060_000,
};

/** §6.4 全量默认值表（裸 `WORKFLOW.md` 的 resolved 期望）。 */
const DEFAULT_SERVICE_CONFIG = {
  tracker: {
    kind: "",
    provider: {},
    requiredLabels: [],
    activeStates: null,
    terminalStates: null,
  },
  polling: { intervalMs: 30_000 },
  workspace: { root: resolve(tmpdir(), "symphony_workspaces") },
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
    approvalPolicy: null,
    threadSandbox: null,
    turnSandboxPolicy: null,
    turnTimeoutMs: 3_600_000,
    readTimeoutMs: 5_000,
    stallTimeoutMs: 300_000,
  },
} as const;

let dir: string;
let handle: WorkflowWatchHandle | undefined;
let events: WorkflowReloadEvent[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "symphony-integration-"));
  events = [];
});

afterEach(() => {
  vi.useRealTimers();
  handle?.close();
  handle = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** 在临时目录下写入文件（自动建父目录）并返回绝对路径。 */
function write(name: string, content: string): string {
  const p = join(dir, name);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
  return p;
}

/** 执行 `fn`，返回其抛出的异常（未抛出则返回 undefined）。 */
function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** 断言 `fn` 抛出 code 为 `code` 的 {@link SymphonyConfigError}，返回该错误。 */
function expectConfigError(fn: () => unknown, code: ConfigErrorCode): SymphonyConfigError {
  const error = capture(fn);
  expect(error).toBeInstanceOf(SymphonyConfigError);
  const configError = error as SymphonyConfigError;
  expect(configError.code).toBe(code);
  expect(configError.name).toBe("SymphonyConfigError");
  return configError;
}

/** 从 `dir` 经组合入口加载（注入空 env 与固定 home）。 */
function load(options: { path?: string; env?: Record<string, string | undefined> } = {}): EffectiveWorkflow {
  return loadEffectiveWorkflow({
    ...(options.path !== undefined ? { path: options.path } : {}),
    cwd: dir,
    env: options.env ?? {},
    home: HOME,
  });
}

// ---------------------------------------------------------------------------
// 验收 1：最小合法 workflow → 稳定 WorkflowDefinition + 全量默认 ServiceConfig
// ---------------------------------------------------------------------------

describe("M1 integration — bare WORKFLOW.md resolves to defaults (acceptance 1)", () => {
  it("loads a plain-Markdown workflow through the public entry into a stable definition and the full default config", () => {
    const body = "# Just Markdown\n\nNo front matter here.";
    write("WORKFLOW.md", `${body}\n`);

    const eff = load();

    expect(eff.workflowPath).toBe(join(dir, "WORKFLOW.md"));
    expect(eff.definition.config).toEqual({});
    expect(eff.definition.promptTemplate).toBe(body);
    expect(eff.serviceConfig).toEqual(DEFAULT_SERVICE_CONFIG);
  });

  it("is deterministic: two independent loads yield structurally equal results", () => {
    write("WORKFLOW.md", "---\npolling:\n  interval_ms: 1234\n---\nbody");

    const first = load();
    const second = load();

    expect(second.workflowPath).toBe(first.workflowPath);
    expect(second.definition).toEqual(first.definition);
    expect(second.serviceConfig).toEqual(first.serviceConfig);
  });
});

// ---------------------------------------------------------------------------
// §5.1 path precedence：显式 path 优先于 cwd 默认（同一 load 链路内）
// ---------------------------------------------------------------------------

describe("M1 integration — workflow path precedence (SPEC §5.1)", () => {
  it("prefers an explicit path over the cwd default in the same load chain", () => {
    // cwd 默认 WORKFLOW.md 与显式文件内容不同：断言确实读取了显式文件。
    write("WORKFLOW.md", "---\npolling:\n  interval_ms: 11111\n---\ndefault body");
    write(
      join("configs", "custom.md"),
      "---\npolling:\n  interval_ms: 22222\n---\nexplicit body",
    );

    const explicit = load({ path: join("configs", "custom.md") });
    expect(explicit.workflowPath).toBe(join(dir, "configs", "custom.md"));
    expect(explicit.serviceConfig.polling.intervalMs).toBe(22_222);
    expect(explicit.definition.promptTemplate).toBe("explicit body");

    const fallback = load();
    expect(fallback.workflowPath).toBe(join(dir, "WORKFLOW.md"));
    expect(fallback.serviceConfig.polling.intervalMs).toBe(11_111);
    expect(fallback.definition.promptTemplate).toBe("default body");
  });
});

// ---------------------------------------------------------------------------
// 完整配置样例：$VAR、~、相对路径、by-state 归一化、codex.command 原样保留
// ---------------------------------------------------------------------------

describe("M1 integration — complete front matter resolves through the public entry", () => {
  it("resolves every §6.4 core field from a realistic WORKFLOW.md", () => {
    const file = write(
      "WORKFLOW.md",
      [
        "---",
        "tracker:",
        "  kind: linear",
        "  provider:",
        "    endpoint: https://api.linear.app/graphql",
        "    api_key: $LINEAR_SECRET",
        "    project: SYM",
        "  required_labels:",
        "    - symphony",
        "    - autostart",
        "  active_states:",
        "    - In Progress",
        "    - Todo",
        "  terminal_states:",
        "    - Done",
        "    - Cancelled",
        "polling:",
        "  interval_ms: 15000",
        "workspace:",
        "  root: $SYM_BASE/ws",
        "hooks:",
        "  after_create: |",
        "    #!/usr/bin/env bash",
        "    git clone --depth 1 https://example.test/repo.git .",
        "  before_run: echo before",
        "  timeout_ms: 120000",
        "agent:",
        "  max_concurrent_agents: 4",
        "  max_turns: 12",
        "  max_retry_backoff_ms: 600000",
        "  max_concurrent_agents_by_state:",
        '    " Blocked ": 2',
        "    IN_PROGRESS: 3",
        '    "": 5',
        "    Done: 0",
        "codex:",
        "  command: bash -lc 'codex app-server --verbose'",
        "  approval_policy: never",
        "  thread_sandbox: workspace-write",
        "  turn_sandbox_policy: workspace-write",
        "  turn_timeout_ms: 900000",
        "  read_timeout_ms: 7000",
        "  stall_timeout_ms: -1",
        "---",
        "Issue {{ issue.identifier }}",
        "",
      ].join("\n"),
    );

    const eff = load({
      env: { LINEAR_SECRET: "hunter2", SYM_BASE: "nested" },
    });

    expect(eff.workflowPath).toBe(file);
    expect(eff.serviceConfig).toEqual({
      tracker: {
        kind: "linear",
        // adapter-owned 内容原样保留：$VAR 不被 core 展开（M2 归 adapter）。
        provider: {
          endpoint: "https://api.linear.app/graphql",
          api_key: "$LINEAR_SECRET",
          project: "SYM",
        },
        requiredLabels: ["symphony", "autostart"],
        activeStates: ["In Progress", "Todo"],
        terminalStates: ["Done", "Cancelled"],
      },
      polling: { intervalMs: 15_000 },
      // $VAR 展开后仍是相对路径 → 按 WORKFLOW.md 所在目录解析为绝对路径。
      workspace: { root: join(dir, "nested", "ws") },
      hooks: {
        afterCreate: "#!/usr/bin/env bash\ngit clone --depth 1 https://example.test/repo.git .\n",
        beforeRun: "echo before",
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 120_000,
      },
      agent: {
        maxConcurrentAgents: 4,
        maxTurns: 12,
        maxRetryBackoffMs: 600_000,
        // key 经 normalizeIssueState；空 key 与非法值（Done: 0）被静默过滤。
        maxConcurrentAgentsByState: { blocked: 2, in_progress: 3 },
      },
      codex: {
        command: "bash -lc 'codex app-server --verbose'",
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
        turnSandboxPolicy: "workspace-write",
        turnTimeoutMs: 900_000,
        readTimeoutMs: 7_000,
        stallTimeoutMs: -1,
      },
    });
  });

  it("expands ~ in workspace.root against the injected home", () => {
    write("WORKFLOW.md", '---\nworkspace:\n  root: "~/symphony/ws"\n---\nbody');

    expect(load().serviceConfig.workspace.root).toBe(join(HOME, "symphony", "ws"));
  });
});

// ---------------------------------------------------------------------------
// 验收 2：malformed workflow / config 都产生可判别错误（7 个错误码面）
// ---------------------------------------------------------------------------

describe("M1 integration — typed error surface is distinguishable (acceptance 2)", () => {
  it("surfaces each workflow/config error class as a distinct SymphonyConfigError.code", () => {
    // 1. missing_workflow_file：临时目录里没有 WORKFLOW.md。
    const missing = expectConfigError(() => load(), "missing_workflow_file");
    expect(missing.cause).toBeInstanceOf(Error);

    // 2/3/4/5：loader 与 resolution 的 typed 错误，均经同一公共入口。
    write(join("bad-yaml", "WORKFLOW.md"), "---\npolling: [unclosed\n---\nbody");
    const parseError = expectConfigError(
      () => load({ path: join("bad-yaml", "WORKFLOW.md") }),
      "workflow_parse_error",
    );
    // 第三方 YAML 异常被折叠为 typed error 并保留在 cause（不越过包边界）。
    expect(parseError.cause).toBeInstanceOf(Error);

    write(join("non-map", "WORKFLOW.md"), "---\n- just\n- a\n- list\n---\nbody");
    const notAMap = expectConfigError(
      () => load({ path: join("non-map", "WORKFLOW.md") }),
      "workflow_front_matter_not_a_map",
    );

    write(join("invalid-typed", "WORKFLOW.md"), "---\nagent:\n  max_turns: 0\n---\nbody");
    const invalid = expectConfigError(
      () => load({ path: join("invalid-typed", "WORKFLOW.md") }),
      "invalid_config",
    );
    expect(invalid.message).toContain("agent.max_turns");

    write(join("missing-env", "WORKFLOW.md"), "---\nworkspace:\n  root: $SYM_MISSING_ENV/ws\n---\nbody");
    const missingEnv = expectConfigError(
      () => load({ path: join("missing-env", "WORKFLOW.md") }),
      "missing_env_reference",
    );
    expect(missingEnv.message).toContain("SYM_MISSING_ENV");

    // 6/7：模板两码只在 renderPrompt 调用处出现（§5.5 gating：front matter 合法）。
    const renderable = load({ path: write(join("renderable", "WORKFLOW.md"), "---\npolling:\n  interval_ms: 1000\n---\nbody") });
    const parseTemplate = expectConfigError(
      () => renderPrompt("Hello {{ unclosed ", { issue: ISSUE, attempt: null, workflowPath: renderable.workflowPath }),
      "template_parse_error",
    );
    expect(parseTemplate.path).toBe(renderable.workflowPath);

    const renderTemplate = expectConfigError(
      () => renderPrompt("Hi {{ issue.nope }}", { issue: ISSUE, attempt: null, workflowPath: renderable.workflowPath }),
      "template_render_error",
    );
    expect(renderTemplate.path).toBe(renderable.workflowPath);

    // 七个码彼此不同（消费方可按 code 精确分支）。
    const codes: ConfigErrorCode[] = [
      missing.code,
      parseError.code,
      notAMap.code,
      invalid.code,
      missingEnv.code,
      parseTemplate.code,
      renderTemplate.code,
    ];
    expect([...new Set(codes)].sort()).toEqual(
      [
        "invalid_config",
        "missing_env_reference",
        "missing_workflow_file",
        "template_parse_error",
        "template_render_error",
        "workflow_front_matter_not_a_map",
        "workflow_parse_error",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// §5.4 prompt 渲染：用加载出的模板 + issue / attempt 上下文
// ---------------------------------------------------------------------------

describe("M1 integration — renderPrompt over the loaded template (acceptance 1)", () => {
  const TEMPLATE_BODY = [
    "Issue {{ issue.identifier }} ({{ issue.state }})",
    "Title: {{ issue.title }}",
    "Labels: {% for label in issue.labels %}{{ label }}{% unless forloop.last %},{% endunless %}{% endfor %}",
    "Blockers: {% for b in issue.blocked_by %}{{ b.identifier }}={{ b.state }}{% unless forloop.last %},{% endunless %}{% endfor %}",
    "Created: {{ issue.created_at }}",
    "Attempt: {{ attempt }}",
  ].join("\n");

  it("renders the workflow body loaded from disk with issue and attempt context", () => {
    write("WORKFLOW.md", `---\npolling:\n  interval_ms: 1000\n---\n${TEMPLATE_BODY}\n`);
    const eff = load();

    const first = renderPrompt(eff.definition.promptTemplate, {
      issue: ISSUE,
      attempt: null,
      workflowPath: eff.workflowPath,
    });
    expect(first).toContain("Issue ABC-123 (In Progress)");
    expect(first).toContain("Title: Fix the widget");
    expect(first).toContain("Labels: bug,p1");
    expect(first).toContain("Blockers: ABC-124=Blocked");
    expect(first).toContain("Created: 2023-11-14T22:13:20.000Z");
    // 首次尝试 attempt = null 渲染为空串（§5.4 "null/absent on first attempt"）：
    // 末行只允许 "Attempt:" 与空白，不含任何数字。
    expect(first).toMatch(/Attempt:\s*$/);

    const retry = renderPrompt(eff.definition.promptTemplate, {
      issue: ISSUE,
      attempt: 3,
      workflowPath: eff.workflowPath,
    });
    expect(retry).toMatch(/Attempt: 3\s*$/);
  });

  it("falls back to DEFAULT_PROMPT_TEMPLATE when the on-disk body is empty", () => {
    write("WORKFLOW.md", "---\npolling:\n  interval_ms: 1000\n---\n");
    const eff = load();

    expect(eff.definition.promptTemplate).toBe("");
    expect(renderPrompt(eff.definition.promptTemplate, { issue: ISSUE, attempt: null })).toBe(
      DEFAULT_PROMPT_TEMPLATE,
    );
  });

  it("strict rendering failure does not disturb the already-resolved config (SPEC §5.5 gating)", () => {
    // front matter 合法 + 模板正文引用未知变量：load/resolve 成功，渲染失败。
    write("WORKFLOW.md", "---\npolling:\n  interval_ms: 4200\n---\nHi {{ issue.does_not_exist }}");
    const eff = load();
    const snapshot = eff.serviceConfig;

    expectConfigError(
      () => renderPrompt(eff.definition.promptTemplate, { issue: ISSUE, attempt: null }),
      "template_render_error",
    );
    // 渲染失败只影响当次调用：已 resolved config 逐字段不变。
    expect(eff.serviceConfig).toBe(snapshot);
    expect(eff.serviceConfig.polling.intervalMs).toBe(4200);
  });
});

// ---------------------------------------------------------------------------
// 验收 3：valid / invalid reload 的 last-known-good 行为
// ---------------------------------------------------------------------------

describe("M1 integration — watchWorkflow over real files (acceptance 3)", () => {
  /** 启动 watcher（注入临时目录、空 env、固定 home、短轮询间隔）。 */
  function watch(intervalMs = 15): WorkflowWatchHandle {
    handle = watchWorkflow({
      cwd: dir,
      env: {},
      home: HOME,
      intervalMs,
      onEvent: (event) => events.push(event),
    });
    return handle;
  }

  function workflow(intervalMs: number, body: string): string {
    return `---\npolling:\n  interval_ms: ${intervalMs}\n---\n${body}`;
  }

  it("re-applies a valid reload to the resolved config and the rendered prompt", async () => {
    write("WORKFLOW.md", workflow(5000, "First {{ issue.identifier }}"));
    const watcher = watch();
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(5000);
    expect(
      renderPrompt(watcher.current().definition.promptTemplate, { issue: ISSUE, attempt: null }),
    ).toBe("First ABC-123");

    write("WORKFLOW.md", workflow(9000, "Second {{ issue.identifier }} (retry)"));

    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0]?.kind).toBe("reloaded");
    // 验外部世界：handle.current() 反映新 effective，而非只看事件被调用过。
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(9000);
    expect(
      renderPrompt(watcher.current().definition.promptTemplate, { issue: ISSUE, attempt: null }),
    ).toBe("Second ABC-123 (retry)");
  });

  it("keeps last-known-good on an invalid reload, emits an error event, then self-heals", async () => {
    write("WORKFLOW.md", workflow(5000, "good {{ issue.identifier }}"));
    const watcher = watch();
    const before = watcher.current();

    // 非法 typed 值 → invalid_config；有效配置不得被覆盖。
    write("WORKFLOW.md", "---\nagent:\n  max_turns: 0\n---\nbad body");
    await vi.waitFor(() => expect(events.length).toBe(1));
    const event = events[0];
    expect(event?.kind).toBe("error");
    if (event?.kind === "error") {
      expect(event.error.code).toBe("invalid_config");
    }
    expect(watcher.current()).toBe(before);
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(5000);
    // last-known-good 的模板仍可正常渲染。
    expect(
      renderPrompt(watcher.current().definition.promptTemplate, { issue: ISSUE, attempt: null }),
    ).toBe("good ABC-123");

    // 文件修好后自愈为一次 valid reload。
    write("WORKFLOW.md", workflow(8000, "healed {{ issue.identifier }}"));
    await vi.waitFor(() => expect(events.length).toBe(2));
    expect(events[1]?.kind).toBe("reloaded");
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(8000);
    expect(
      renderPrompt(watcher.current().definition.promptTemplate, { issue: ISSUE, attempt: null }),
    ).toBe("healed ABC-123");
  });

  it("stops polling and releases its interval handle on close()", () => {
    write("WORKFLOW.md", workflow(5000, "steady body"));

    vi.useFakeTimers();
    const baseline = vi.getTimerCount();
    const watcher = watch(10);
    expect(vi.getTimerCount()).toBe(baseline + 1);

    watcher.close();
    watcher.close(); // 幂等

    expect(vi.getTimerCount()).toBe(baseline);
    // close() 后文件变化不再触发事件（handle 已释放）。
    write("WORKFLOW.md", workflow(6000, "changed after close"));
    vi.advanceTimersByTime(100);
    expect(events).toEqual([]);
  });

  it("drops a deleted workflow file to last-known-good with a typed error event", async () => {
    const file = write("WORKFLOW.md", workflow(5000, "good body"));
    const watcher = watch();

    unlinkSync(file);
    await vi.waitFor(() => expect(events.length).toBe(1));
    const event = events[0];
    expect(event?.kind).toBe("error");
    if (event?.kind === "error") {
      expect(event.error.code).toBe("missing_workflow_file");
    }
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(5000);
  });
});
