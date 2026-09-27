/**
 * SPEC §5.3 / §6 typed config resolution 测试（对齐 §17.1 Core Conformance：
 * defaults、typed validation、`$VAR` 环境解析、路径规范化、per-state 并发覆盖与
 * 无效条目过滤 + issue 验收口径）。全部经包公共入口 `./index` import，并在**真实
 * 临时 WORKFLOW.md 文件**上从组合入口 `loadEffectiveWorkflow` 测起
 * （docs/testing.md 三条哲学）；env / home / cwd 全部注入，测试不依赖机器环境。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, afterEach, beforeEach, expect, it } from "vitest";

import {
  loadEffectiveWorkflow,
  resolveServiceConfig,
  SymphonyConfigError,
  type EffectiveWorkflow,
} from "./index";

/** 注入的 home（不使用真实 os.homedir()，测试不依赖机器环境）。 */
const HOME = "/home/test-user";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "symphony-resolution-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 写入一个文件并返回其绝对路径。 */
function write(name: string, content: string): string {
  const p = join(dir, name);
  mkdirSync(join(dir, name, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
  return p;
}

/**
 * 用给定 front matter 写一个真实 `WORKFLOW.md` 并经组合入口加载 + resolve。
 * `env` 缺省为空 map（隔离机器环境）；`home` 缺省为注入的 {@link HOME}。
 */
function loadWithFrontMatter(
  frontMatter: string,
  options: {
    env?: Record<string, string | undefined>;
    home?: string;
    cwd?: string;
    file?: string;
  } = {},
): EffectiveWorkflow {
  const file = write(options.file ?? "WORKFLOW.md", `---\n${frontMatter}\n---\nbody`);
  return loadEffectiveWorkflow({
    path: file,
    cwd: options.cwd ?? dir,
    env: options.env ?? {},
    home: options.home ?? HOME,
  });
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
function expectConfigError(fn: () => unknown, code: string): SymphonyConfigError {
  const error = capture(fn);
  expect(error).toBeInstanceOf(SymphonyConfigError);
  const configError = error as SymphonyConfigError;
  expect(configError.code).toBe(code);
  expect(configError.name).toBe("SymphonyConfigError");
  return configError;
}

/** 断言 front matter 触发 `invalid_config`，且 message 携带字段路径。 */
function expectInvalidConfig(frontMatter: string, field: string): SymphonyConfigError {
  const error = expectConfigError(
    () => loadWithFrontMatter(frontMatter),
    "invalid_config",
  );
  expect(error.message).toContain(field);
  return error;
}

describe("resolveServiceConfig — defaults (SPEC §6.4)", () => {
  it("resolves a bare-Markdown workflow (no front matter) to the full default table", () => {
    const file = write("plain.md", "# Just Markdown\n\nNo front matter.\n");
    const eff = loadEffectiveWorkflow({ path: file, cwd: dir, env: {}, home: HOME });
    expect(eff.serviceConfig).toEqual({
      tracker: {
        kind: "",
        provider: {},
        requiredLabels: [],
        activeStates: null,
        terminalStates: null,
      },
      polling: { intervalMs: 30_000 },
      workspace: { root: join(tmpdir(), "symphony_workspaces") },
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
    });
  });

  it("resolves an empty front matter block to defaults instead of failing (M1.2 loader contract)", () => {
    const file = write("empty-fm.md", "---\n---\nBody only");
    const eff = loadEffectiveWorkflow({ path: file, cwd: dir, env: {}, home: HOME });
    // loader Note 定死：空块 = 空 config；M1.3 不得反过来当校验失败。
    expect(eff.definition.config).toEqual({});
    expect(eff.serviceConfig.tracker.kind).toBe("");
    expect(eff.serviceConfig.polling.intervalMs).toBe(30_000);
    expect(eff.serviceConfig.agent.maxTurns).toBe(20);
    expect(eff.serviceConfig.codex.command).toBe("codex app-server");
  });

  it("treats explicit null values and null sections as absent (defaults apply)", () => {
    const eff = loadWithFrontMatter(
      ["polling:", "  interval_ms:", "codex:", "  approval_policy:", "workspace:"].join("\n"),
    );
    expect(eff.serviceConfig.polling.intervalMs).toBe(30_000);
    expect(eff.serviceConfig.codex.approvalPolicy).toBeNull();
    expect(eff.serviceConfig.workspace.root).toBe(join(tmpdir(), "symphony_workspaces"));
  });

  it("keeps the pure resolver injectable: workflowDir/env/home without any file IO", () => {
    const config = resolveServiceConfig(
      { workspace: { root: "ws/$SEG" } },
      { workflowDir: dir, env: { SEG: "issues" }, home: HOME },
    );
    expect(config.workspace.root).toBe(join(dir, "ws", "issues"));
    expect(config.tracker.kind).toBe("");
  });
});

describe("resolveServiceConfig — typed validation (SPEC §5.3 / §6.1)", () => {
  it("rejects agent.max_turns <= 0 (SPEC §5.3.5: positive integer, fail validation)", () => {
    const error = expectInvalidConfig("agent:\n  max_turns: 0", "agent.max_turns");
    expect(error.path).toBe(join(dir, "WORKFLOW.md"));
  });

  it("rejects a fractional agent.max_turns", () => {
    expectInvalidConfig("agent:\n  max_turns: 2.5", "agent.max_turns");
  });

  it("rejects a stringified number for agent.max_turns (no implicit coercion)", () => {
    expectInvalidConfig('agent:\n  max_turns: "20"', "agent.max_turns");
  });

  it("rejects a boolean for agent.max_turns", () => {
    expectInvalidConfig("agent:\n  max_turns: true", "agent.max_turns");
  });

  it("rejects a negative polling.interval_ms", () => {
    expectInvalidConfig("polling:\n  interval_ms: -5", "polling.interval_ms");
  });

  it("rejects a non-numeric hooks.timeout_ms (SPEC §5.3.4: invalid value fails validation)", () => {
    expectInvalidConfig("hooks:\n  timeout_ms: soon", "hooks.timeout_ms");
  });

  it("rejects codex.read_timeout_ms: 0 (positive-integer rule; stall_timeout_ms is the only exception)", () => {
    expectInvalidConfig("codex:\n  read_timeout_ms: 0", "codex.read_timeout_ms");
  });

  it("accepts codex.stall_timeout_ms <= 0 as 'stall detection disabled' (SPEC §5.3.6)", () => {
    expect(loadWithFrontMatter("codex:\n  stall_timeout_ms: 0").serviceConfig.codex.stallTimeoutMs).toBe(0);
    expect(loadWithFrontMatter("codex:\n  stall_timeout_ms: -1").serviceConfig.codex.stallTimeoutMs).toBe(-1);
  });

  it("rejects a fractional codex.stall_timeout_ms", () => {
    expectInvalidConfig("codex:\n  stall_timeout_ms: 1.5", "codex.stall_timeout_ms");
  });

  it("rejects a non-string tracker.kind", () => {
    expectInvalidConfig("tracker:\n  kind: 42", "tracker.kind");
  });

  it("rejects a scalar tracker section", () => {
    expectInvalidConfig('tracker: "linear"', "tracker");
  });

  it("rejects required_labels that are not a list of strings", () => {
    expectInvalidConfig("tracker:\n  required_labels: symphony", "tracker.required_labels");
    expectInvalidConfig("tracker:\n  required_labels:\n    - 1", "tracker.required_labels");
  });

  it("rejects active_states / terminal_states that are not string lists", () => {
    expectInvalidConfig("tracker:\n  active_states:\n    - 1", "tracker.active_states");
    expectInvalidConfig("tracker:\n  terminal_states: done", "tracker.terminal_states");
  });

  it("rejects a non-string codex.approval_policy but passes any string through (no hand-maintained enum, §5.3.6)", () => {
    expectInvalidConfig("codex:\n  approval_policy: 42", "codex.approval_policy");
    const eff = loadWithFrontMatter(
      [
        "codex:",
        "  approval_policy: never-ask-in-this-dialect",
        "  thread_sandbox: some-future-mode",
        "  turn_sandbox_policy: another-one",
      ].join("\n"),
    );
    expect(eff.serviceConfig.codex.approvalPolicy).toBe("never-ask-in-this-dialect");
    expect(eff.serviceConfig.codex.threadSandbox).toBe("some-future-mode");
    expect(eff.serviceConfig.codex.turnSandboxPolicy).toBe("another-one");
  });

  it("preserves active_states / terminal_states strings as-is (matching semantics belong to the scheduler)", () => {
    const eff = loadWithFrontMatter(
      "tracker:\n  active_states:\n    - In Progress\n  terminal_states:\n    - Done",
    );
    expect(eff.serviceConfig.tracker.activeStates).toEqual(["In Progress"]);
    expect(eff.serviceConfig.tracker.terminalStates).toEqual(["Done"]);
  });

  it("preserves multi-line hook scripts verbatim", () => {
    const eff = loadWithFrontMatter(
      ["hooks:", "  after_create: |", "    #!/usr/bin/env bash", "    echo hi"].join("\n"),
    );
    expect(eff.serviceConfig.hooks.afterCreate).toBe("#!/usr/bin/env bash\necho hi\n");
  });
});

describe("resolveServiceConfig — $VAR environment resolution (SPEC §6.1)", () => {
  it("expands an embedded $VAR inside workspace.root", () => {
    const eff = loadWithFrontMatter("workspace:\n  root: $SYM_ROOT/workspaces", {
      env: { SYM_ROOT: "/data/sym" },
    });
    expect(eff.serviceConfig.workspace.root).toBe("/data/sym/workspaces");
  });

  it("expands the ${VAR} braced form", () => {
    const eff = loadWithFrontMatter("workspace:\n  root: ${SYM_ROOT}/ws", {
      env: { SYM_ROOT: "/data/sym" },
    });
    expect(eff.serviceConfig.workspace.root).toBe("/data/sym/ws");
  });

  it("returns missing_env_reference (typed, with the variable name) for an unset variable", () => {
    const error = expectConfigError(
      () => loadWithFrontMatter("workspace:\n  root: $SYM_ROOT_NOPE/ws"),
      "missing_env_reference",
    );
    expect(error.message).toContain("SYM_ROOT_NOPE");
    expect(error.message).toContain("workspace.root");
    expect(error.path).toBe(join(dir, "WORKFLOW.md"));
  });

  it("treats an empty environment value as missing", () => {
    expectConfigError(
      () => loadWithFrontMatter("workspace:\n  root: $EMPTY_VAR/ws", { env: { EMPTY_VAR: "" } }),
      "missing_env_reference",
    );
  });

  it("never lets env override an explicit YAML value (env is reference-only)", () => {
    const eff = loadWithFrontMatter("workspace:\n  root: /explicit/path", {
      env: { SYM_ROOT: "/from-env", WORKSPACE_ROOT: "/also-from-env" },
    });
    expect(eff.serviceConfig.workspace.root).toBe("/explicit/path");
  });

  it("only reads the injected env — process.env is not consulted when env is provided", () => {
    // PATH 几乎必然存在于 process.env；注入空 env 后必须按 missing 处理。
    expectConfigError(
      () => loadWithFrontMatter("workspace:\n  root: $PATH/ws", { env: {} }),
      "missing_env_reference",
    );
  });

  it("does not expand $VAR in codex.command (shell command strings are never rewritten)", () => {
    const eff = loadWithFrontMatter("codex:\n  command: run $SYM_ROOT --flag", {
      env: { SYM_ROOT: "/data/sym" },
    });
    expect(eff.serviceConfig.codex.command).toBe("run $SYM_ROOT --flag");
  });

  it("does not expand $VAR inside tracker.provider (adapter-owned, M2)", () => {
    const eff = loadWithFrontMatter("tracker:\n  provider:\n    token: $SECRET", {
      env: { SECRET: "hunter2" },
    });
    expect(eff.serviceConfig.tracker.provider).toEqual({ token: "$SECRET" });
  });

  it("rejects $VAR in an integer field as invalid_config (no env-to-number coercion)", () => {
    expectInvalidConfig("polling:\n  interval_ms: $NUM", "polling.interval_ms");
  });

  it("applies tilde expansion after env expansion ($VAR → ~ → resolve order)", () => {
    const eff = loadWithFrontMatter("workspace:\n  root: $HOME_BASE/ws", {
      env: { HOME_BASE: "~" },
    });
    expect(eff.serviceConfig.workspace.root).toBe(join(HOME, "ws"));
  });
});

describe("resolveServiceConfig — workspace.root path normalization (SPEC §5.3.3 / §6.1)", () => {
  it('expands a quoted "~" to the injected home', () => {
    const eff = loadWithFrontMatter('workspace:\n  root: "~"');
    expect(eff.serviceConfig.workspace.root).toBe(HOME);
  });

  it("treats an unquoted ~ as YAML null = unset (default root), not as home", () => {
    // YAML 里裸 `~` 是 null 字面量 → 显式 null = 未配置 → 默认值；
    // 要指 home 必须写引号形式 "~"（README / Agent Note 记录）。
    const eff = loadWithFrontMatter("workspace:\n  root: ~");
    expect(eff.serviceConfig.workspace.root).toBe(resolve(tmpdir(), "symphony_workspaces"));
  });

  it("expands ~/… against the injected home", () => {
    const eff = loadWithFrontMatter("workspace:\n  root: ~/symphony-workspaces");
    expect(eff.serviceConfig.workspace.root).toBe(join(HOME, "symphony-workspaces"));
  });

  it("does not expand the ~user form (treated as a literal path segment)", () => {
    const eff = loadWithFrontMatter("workspace:\n  root: ~bob/ws");
    expect(eff.serviceConfig.workspace.root).toBe(join(dir, "~bob", "ws"));
  });

  it("resolves a relative root against the WORKFLOW.md directory, not the caller cwd", () => {
    const eff = loadWithFrontMatter("workspace:\n  root: ws", {
      file: join("nested", "WORKFLOW.md"),
      cwd: dir,
    });
    expect(eff.serviceConfig.workspace.root).toBe(join(dir, "nested", "ws"));
    expect(eff.workflowPath).toBe(join(dir, "nested", "WORKFLOW.md"));
  });

  it("keeps an absolute root and normalizes it", () => {
    const eff = loadWithFrontMatter("workspace:\n  root: /data/sym/../symphony/ws/");
    expect(eff.serviceConfig.workspace.root).toBe("/data/symphony/ws");
  });

  it("defaults to <system-temp>/symphony_workspaces", () => {
    const eff = loadWithFrontMatter("polling:\n  interval_ms: 1000");
    expect(eff.serviceConfig.workspace.root).toBe(resolve(tmpdir(), "symphony_workspaces"));
  });

  it("rejects an empty or whitespace-only root", () => {
    expectInvalidConfig('workspace:\n  root: ""', "workspace.root");
    expectInvalidConfig('workspace:\n  root: "   "', "workspace.root");
  });
});

describe("resolveServiceConfig — max_concurrent_agents_by_state (SPEC §5.3.5)", () => {
  it("normalizes state keys (trim + lowercase, same source as normalizeIssueState)", () => {
    const eff = loadWithFrontMatter(
      [
        "agent:",
        "  max_concurrent_agents_by_state:",
        '    " Blocked ": 2',
        "    IN_PROGRESS: 3",
      ].join("\n"),
    );
    expect(eff.serviceConfig.agent.maxConcurrentAgentsByState).toEqual({
      blocked: 2,
      in_progress: 3,
    });
  });

  it("silently ignores invalid entries (non-numeric / fractional / non-positive) without failing", () => {
    const eff = loadWithFrontMatter(
      [
        "agent:",
        "  max_concurrent_agents_by_state:",
        '    blocked: "5"',
        "    in_progress: 0",
        "    done: -3",
        "    review: 1.5",
        "    todo: true",
        "    active: 4",
      ].join("\n"),
    );
    expect(eff.serviceConfig.agent.maxConcurrentAgentsByState).toEqual({ active: 4 });
  });

  it("resolves normalized key conflicts as last-wins in document order", () => {
    const eff = loadWithFrontMatter(
      ["agent:", "  max_concurrent_agents_by_state:", "    Blocked: 1", "    blocked: 2"].join("\n"),
    );
    expect(eff.serviceConfig.agent.maxConcurrentAgentsByState).toEqual({ blocked: 2 });
  });

  it("ignores entries whose key normalizes to empty", () => {
    const eff = loadWithFrontMatter(
      ['agent:', '  max_concurrent_agents_by_state:', '    "   ": 3', "    active: 2"].join("\n"),
    );
    expect(eff.serviceConfig.agent.maxConcurrentAgentsByState).toEqual({ active: 2 });
  });

  it("rejects a non-map by_state value as invalid_config (section shape is still typed)", () => {
    expectInvalidConfig(
      "agent:\n  max_concurrent_agents_by_state:\n    - 1\n    - 2",
      "agent.max_concurrent_agents_by_state",
    );
  });

  it("accepts explicit positive overrides alongside the global default", () => {
    const eff = loadWithFrontMatter(
      ["agent:", "  max_concurrent_agents: 4", "  max_concurrent_agents_by_state:", "    blocked: 1"].join("\n"),
    );
    expect(eff.serviceConfig.agent.maxConcurrentAgents).toBe(4);
    expect(eff.serviceConfig.agent.maxConcurrentAgentsByState).toEqual({ blocked: 1 });
  });
});

describe("resolveServiceConfig — pass-through & forward compatibility (SPEC §5.3 / §6.1)", () => {
  it("preserves codex.command verbatim (no ~, no $VAR, no URI rewriting)", () => {
    const eff = loadWithFrontMatter("codex:\n  command: ~/bin/codex --flag 'x y'");
    expect(eff.serviceConfig.codex.command).toBe("~/bin/codex --flag 'x y'");
  });

  it("preserves tracker.provider contents as-is, including unknown nested keys", () => {
    const eff = loadWithFrontMatter(
      [
        "tracker:",
        "  kind: linear",
        "  provider:",
        "    endpoint: https://api.linear.app",
        "    scopes:",
        "      - issues:write",
        "    nested:",
        "      deep: 1",
      ].join("\n"),
    );
    expect(eff.serviceConfig.tracker.kind).toBe("linear");
    expect(eff.serviceConfig.tracker.provider).toEqual({
      endpoint: "https://api.linear.app",
      scopes: ["issues:write"],
      nested: { deep: 1 },
    });
  });

  it("rejects a non-map tracker.provider", () => {
    expectInvalidConfig("tracker:\n  provider: linear", "tracker.provider");
  });

  it("keeps unknown top-level keys in definition.config and ignores unknown keys inside known sections", () => {
    const eff = loadWithFrontMatter(
      [
        "agent:",
        "  max_turn: 99", // 拼错的字段名 → 忽略（forward-compat，与 top-level 策略一致）
        "future_extension:",
        "  enabled: true",
        "x_custom: 42",
      ].join("\n"),
    );
    expect(eff.serviceConfig.agent.maxTurns).toBe(20);
    expect(eff.definition.config).toEqual({
      agent: { max_turn: 99 },
      future_extension: { enabled: true },
      x_custom: 42,
    });
  });
});

describe("loadEffectiveWorkflow — composition & error surface (SPEC §5.5 / §6.1)", () => {
  it("returns definition, serviceConfig and the resolved workflowPath from one entry", () => {
    const eff = loadWithFrontMatter(
      ["tracker:", "  kind: linear", "polling:", "  interval_ms: 5000", "custom: keep-me"].join("\n"),
    );
    expect(eff.workflowPath).toBe(join(dir, "WORKFLOW.md"));
    expect(eff.definition.config).toEqual({
      tracker: { kind: "linear" },
      polling: { interval_ms: 5000 },
      custom: "keep-me",
    });
    expect(eff.definition.promptTemplate).toBe("body");
    expect(eff.serviceConfig.tracker.kind).toBe("linear");
    expect(eff.serviceConfig.polling.intervalMs).toBe(5000);
  });

  it("propagates loader errors unchanged (missing file stays missing_workflow_file)", () => {
    const missing = join(dir, "does-not-exist.md");
    const error = expectConfigError(
      () => loadEffectiveWorkflow({ path: missing, cwd: dir, env: {}, home: HOME }),
      "missing_workflow_file",
    );
    expect(error.path).toBe(missing);
  });

  it("reports invalid_config with the workflow file path for diagnostics", () => {
    const error = expectInvalidConfig("agent:\n  max_concurrent_agents: 0", "agent.max_concurrent_agents");
    expect(error.path).toBe(join(dir, "WORKFLOW.md"));
    expect(error.message).toContain("expected a positive integer");
  });

  it("validates fail-fast in documented section order (tracker before agent)", () => {
    const error = expectInvalidConfig(
      ["tracker:", "  kind: 42", "agent:", "  max_turns: -1"].join("\n"),
      "tracker.kind",
    );
    expect(error.message).not.toContain("max_turns");
  });
});
