/**
 * Typed config resolution（SPEC §6 Configuration Specification：§6.1 resolution
 * 管道、§6.4 core fields；schema 语义见 §5.3）。把 M1.2 产出的**未经校验的原始
 * front matter**（`WorkflowDefinition.config`）转换为 `@symphony/domain` 的
 * {@link ServiceConfig}（§4.1.3 typed view）。
 *
 * 管道（§6.1）：缺失 OPTIONAL → 默认值 → 显式 `$VAR` 环境解析 → coerce +
 * validate。硬约束：
 *
 * - **环境变量不得全局覆盖 YAML**——env 只参与显式 `$VAR` / `${VAR}` 引用，且
 *   核心层唯一做 env / path expansion 的字段是 `workspace.root`（§17.1 "$VAR for
 *   path values"；`codex.command` 原样保留、`tracker.provider` 的 `$VAR` / secret
 *   解析归所选 adapter，M2）。
 * - 无效值 → typed error（`invalid_config`，message 携带字段路径），不 crash、
 *   不静默修正。**唯一例外**：`agent.max_concurrent_agents_by_state` 的非法条目
 *   静默过滤（§5.3.5 原文 "are ignored"，与 `max_turns` 的 fail-validation 是
 *   SPEC 刻意的双策略，不得统一）。
 * - 第三方 parser / schema 异常不作为对外契约：手写校验，不引入 schema 库。
 *
 * 边缘语义决策（显式 `null` = 未配置、fail-fast、空 env 值 = missing、`~user`
 * 不展开、by-state key 冲突 last-wins 等）记录于
 * `notes/accepted/architecture/2026-09-27-config-resolution-contract.md`
 * 与包 README。
 */
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";

import {
  normalizeIssueState,
  type AgentConfig,
  type CodexConfig,
  type HooksConfig,
  type PollingConfig,
  type ServiceConfig,
  type TrackerConfig,
  type WorkflowDefinition,
  type WorkspaceConfig,
} from "@symphony/domain";

import { SymphonyConfigError } from "./errors";
import type { TrackerConfigExtension, TrackerConfigExtensionFailure } from "./tracker-extension";
import {
  describeValueType,
  isPlainMap,
  loadWorkflowFromFile,
  resolveWorkflowPath,
} from "./workflow-loader";

/** {@link resolveServiceConfig} 的注入点（cwd / env / home 可注入，测试不依赖机器环境）。 */
export interface ResolveServiceConfigOptions {
  /**
   * `WORKFLOW.md` 所在目录（绝对路径）：相对 `workspace.root` 的解析基准
   * （§5.3.3 "relative paths are resolved relative to the workflow file"）。
   */
  readonly workflowDir: string;
  /** `$VAR` / `${VAR}` 引用可见的环境变量；默认 `process.env`。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** `~` 展开用的 home 目录；默认 `os.homedir()`。 */
  readonly home?: string;
  /** 诊断用：workflow 文件绝对路径，写入错误对象的 `path`；缺省用 `workflowDir`。 */
  readonly sourcePath?: string;
  /**
   * tracker 配置校验扩展点（M2.1，§6.3 / §11.4）：由组合根注入
   * `@symphony/tracker` 注册表产出的 {@link TrackerConfigExtension}，在 core
   * resolution **之后**跑 selected-adapter 的 preflight 校验。
   *
   * 缺席 = M1 行为逐字不变（core resolution 不依赖任何 adapter 注册表，
   * 裸 `WORKFLOW.md` 仍得到全量默认值）。注入后失败抛
   * `SymphonyConfigError`，code ∈ `unsupported_tracker_kind` /
   * `invalid_tracker_config` / `missing_tracker_secret`。
   *
   * 本包不 import `@symphony/tracker`：契约是结构化类型，见
   * `./tracker-extension.ts`。
   */
  readonly trackerExtension?: TrackerConfigExtension;
}

/** {@link loadEffectiveWorkflow} 的可选注入点。 */
export interface LoadEffectiveWorkflowOptions {
  /** 语义同 `LoadWorkflowOptions.path`（§5.1 显式 workflow 文件路径）。 */
  readonly path?: string;
  /** 语义同 `LoadWorkflowOptions.cwd`（发现与相对路径的基准目录）。 */
  readonly cwd?: string;
  /** 语义同 {@link ResolveServiceConfigOptions.env}。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 语义同 {@link ResolveServiceConfigOptions.home}。 */
  readonly home?: string;
  /** 语义同 {@link ResolveServiceConfigOptions.trackerExtension}（M2.1）。 */
  readonly trackerExtension?: TrackerConfigExtension;
}

/** {@link loadEffectiveWorkflow} 的结果：原始 definition + resolved typed config。 */
export interface EffectiveWorkflow {
  /** M1.2 产出：`config` 仍是**未经校验的原始 YAML 根对象**（unknown keys 保留）。 */
  readonly definition: WorkflowDefinition;
  /** §4.1.3 typed view：§6.4 全部 core fields 已解析（默认值 / env / 路径规范化）。 */
  readonly serviceConfig: ServiceConfig;
  /** 实际加载的 workflow 文件绝对路径（§5.1 优先级的解析结果）。 */
  readonly workflowPath: string;
}

/**
 * 文件级组合入口：发现并加载 `WORKFLOW.md`，再把原始 config 解析为 typed
 * {@link ServiceConfig}（§6.1 管道）。workflow 路径解析与
 * `loadWorkflow`（`workflow-loader.ts`）共用同一 helper
 * （{@link resolveWorkflowPath}）；`WORKFLOW.md` 所在目录即相对
 * `workspace.root` 的解析基准。
 *
 * 错误面 = loader 三码（§5.1–§5.3）+ resolution 两码（`invalid_config` /
 * `missing_env_reference`）+ 注入扩展点后的 tracker preflight 三码
 * （`unsupported_tracker_kind` / `invalid_tracker_config` /
 * `missing_tracker_secret`），统一 {@link SymphonyConfigError}。
 *
 * {@link loadWorkflowFromFile}（loader 侧）的 JSDoc 与包 README 中的边缘语义在此
 * 同样生效。
 */
export function loadEffectiveWorkflow(
  options: LoadEffectiveWorkflowOptions = {},
): EffectiveWorkflow {
  const workflowPath = resolveWorkflowPath(options);
  const definition = loadWorkflowFromFile(workflowPath);
  const serviceConfig = resolveServiceConfig(definition.config, {
    workflowDir: dirname(workflowPath),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.home !== undefined ? { home: options.home } : {}),
    ...(options.trackerExtension !== undefined ? { trackerExtension: options.trackerExtension } : {}),
    sourcePath: workflowPath,
  });
  return { definition, serviceConfig, workflowPath };
}

/**
 * 纯 resolver：把原始 front matter config（`WorkflowDefinition["config"]`）按
 * §6.1 管道解析为 {@link ServiceConfig}（§6.4 全部 23 个 core fields）。
 * 无 IO、不读 `process.cwd()`；env / home / workflowDir 全部显式注入。
 * M1.4 热重载可直接复用（reload = 重新 load + resolve，失败保留 last-known-good）。
 *
 * 校验 fail-fast：core typed 校验按 tracker → polling → workspace → hooks →
 * agent → codex 的字段顺序抛出第一个 `invalid_config`（message 携带字段路径）。
 *
 * 注入了 `trackerExtension` 时，core resolution **全部成功之后**再跑一次
 * selected-adapter preflight（§6.3）；失败抛同一 {@link SymphonyConfigError}，
 * code 为三个 tracker 码之一。顺序是刻意的：core 不借注册表之手校验自己的字段，
 * adapter 也拿不到半 resolved 的配置。
 */
export function resolveServiceConfig(
  raw: WorkflowDefinition["config"],
  options: ResolveServiceConfigOptions,
): ServiceConfig {
  const ctx: ResolutionContext = {
    workflowDir: options.workflowDir,
    env: options.env ?? process.env,
    home: options.home ?? homedir(),
    errorPath: options.sourcePath ?? options.workflowDir,
  };

  const trackerSection = readSection(raw, "tracker", ctx);
  const tracker: TrackerConfig = {
    // 缺失 → ""（哨兵）：kind 是 dispatch preflight（§6.3）校验项，resolution
    // 不强制 present。"supported adapter" 校验由 M2.1 的 trackerExtension 在
    // resolution 之后负责（空串在那里报 invalid_tracker_config）。见 Agent Note。
    kind: readString(trackerSection, "kind", "tracker.kind", ctx) ?? "",
    provider: readProvider(trackerSection, "tracker.provider", ctx),
    requiredLabels: readStringList(trackerSection, "required_labels", "tracker.required_labels", ctx) ?? [],
    // 缺失 / null → null = 采用所选 adapter profile 文档化的默认（§5.3.1 / §6.4）。
    activeStates: readStringList(trackerSection, "active_states", "tracker.active_states", ctx) ?? null,
    terminalStates: readStringList(trackerSection, "terminal_states", "tracker.terminal_states", ctx) ?? null,
  };

  const pollingSection = readSection(raw, "polling", ctx);
  const polling: PollingConfig = {
    intervalMs: readPositiveInt(pollingSection, "interval_ms", "polling.interval_ms", 30_000, ctx),
  };

  const workspaceSection = readSection(raw, "workspace", ctx);
  const workspace: WorkspaceConfig = {
    root: readWorkspaceRoot(workspaceSection, ctx),
  };

  const hooksSection = readSection(raw, "hooks", ctx);
  const hooks: HooksConfig = {
    // hook 脚本原样保留（多行 shell，不 trim / 不改写）；null = 未配置。
    afterCreate: readString(hooksSection, "after_create", "hooks.after_create", ctx) ?? null,
    beforeRun: readString(hooksSection, "before_run", "hooks.before_run", ctx) ?? null,
    afterRun: readString(hooksSection, "after_run", "hooks.after_run", ctx) ?? null,
    beforeRemove: readString(hooksSection, "before_remove", "hooks.before_remove", ctx) ?? null,
    timeoutMs: readPositiveInt(hooksSection, "timeout_ms", "hooks.timeout_ms", 60_000, ctx),
  };

  const agentSection = readSection(raw, "agent", ctx);
  const agent: AgentConfig = {
    maxConcurrentAgents: readPositiveInt(
      agentSection,
      "max_concurrent_agents",
      "agent.max_concurrent_agents",
      10,
      ctx,
    ),
    maxTurns: readPositiveInt(agentSection, "max_turns", "agent.max_turns", 20, ctx),
    maxRetryBackoffMs: readPositiveInt(
      agentSection,
      "max_retry_backoff_ms",
      "agent.max_retry_backoff_ms",
      300_000,
      ctx,
    ),
    maxConcurrentAgentsByState: readByStateMap(
      agentSection,
      "max_concurrent_agents_by_state",
      "agent.max_concurrent_agents_by_state",
      ctx,
    ),
  };

  const codexSection = readSection(raw, "codex", ctx);
  const codex: CodexConfig = {
    // 原样保留：不做 `~` / `$VAR` / URI / shell 改写（§6.1 + §17.1）；
    // 非空校验属 dispatch preflight（§6.3，M5）。
    command: readString(codexSection, "command", "codex.command", ctx) ?? "codex app-server",
    // pass-through 三字段：只校验 string 类型，不手维枚举（§5.3.6 SHOULD）。
    approvalPolicy: readString(codexSection, "approval_policy", "codex.approval_policy", ctx) ?? null,
    threadSandbox: readString(codexSection, "thread_sandbox", "codex.thread_sandbox", ctx) ?? null,
    turnSandboxPolicy:
      readString(codexSection, "turn_sandbox_policy", "codex.turn_sandbox_policy", ctx) ?? null,
    turnTimeoutMs: readPositiveInt(codexSection, "turn_timeout_ms", "codex.turn_timeout_ms", 3_600_000, ctx),
    readTimeoutMs: readPositiveInt(codexSection, "read_timeout_ms", "codex.read_timeout_ms", 5_000, ctx),
    // 唯一显式允许非正数的字段：`<= 0` = 禁用 stall 检测（§5.3.6）。
    stallTimeoutMs: readInt(codexSection, "stall_timeout_ms", "codex.stall_timeout_ms", 300_000, ctx),
  };

  const serviceConfig: ServiceConfig = { tracker, polling, workspace, hooks, agent, codex };

  // §6.3 tracker preflight：core 校验已全绿，才轮到 selected adapter 看自己的
  // 配置。契约要求扩展以**返回值**表达失败，但它由调用方注入（#19 的 adapter 代码），
  // 属于系统边界：抛出的异常一律在这里收敛成 typed error，否则 §6.2 的
  // crash-resistance 会被一次 WORKFLOW.md 编辑击穿——非 SymphonyConfigError 沿
  // `reloadNow` 逃出定时器，成为杀进程的 uncaughtException。
  // message 明确写"扩展自身抛出"：缺陷 ≠ 一次配置失败，诊断靠 message + `cause`。
  let failure: TrackerConfigExtensionFailure | undefined;
  try {
    failure = options.trackerExtension?.validateTrackerConfig({ tracker, env: ctx.env });
  } catch (error) {
    throw new SymphonyConfigError(
      "invalid_tracker_config",
      `Tracker config validation extension threw \`${describeThrownValue(error)}\` instead of returning a failure ` +
        "(extension defect, not an invalid configuration value)",
      { path: ctx.errorPath, cause: error },
    );
  }
  if (failure !== undefined) {
    throw new SymphonyConfigError(failure.category, failure.message, {
      path: ctx.errorPath,
      ...(failure.cause !== undefined ? { cause: failure.cause } : {}),
    });
  }

  return serviceConfig;
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/** 一次 resolution 的固定上下文（注入点已解析为具体值）。 */
interface ResolutionContext {
  readonly workflowDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  /** 错误对象的 `path`（诊断用）：workflow 文件路径，纯 resolver 缺省 workflowDir。 */
  readonly errorPath: string;
}

function invalidConfig(field: string, detail: string, ctx: ResolutionContext): never {
  throw new SymphonyConfigError(
    "invalid_config",
    `Invalid value for \`${field}\`: ${detail}`,
    { path: ctx.errorPath },
  );
}

/**
 * 扩展抛出的值在 message 里的稳定描述：Error 取 `name`（如 `TypeError`），其余取
 * 值类型。抛出物本身始终经 `cause` 保留，这里只保证 message 可判别。
 */
function describeThrownValue(error: unknown): string {
  return error instanceof Error ? error.name : describeValueType(error);
}

/**
 * 读取一个已知 section（`tracker` / `polling` / …）：缺失或显式 `null` → 空 map
 * （= 全部走默认值；对齐 loader 的"空 front matter 块 = 空 config"精神）；
 * 非 plain map（标量 / list / Date 等）→ `invalid_config`。
 * section 内部的 unknown keys 忽略（与 top-level forward-compat 策略一致）。
 */
function readSection(
  raw: Readonly<Record<string, unknown>>,
  name: string,
  ctx: ResolutionContext,
): Record<string, unknown> {
  const value: unknown = raw[name];
  if (value === undefined || value === null) {
    return {};
  }
  if (!isPlainMap(value)) {
    invalidConfig(name, `expected a map/object, got ${describeValueType(value)}`, ctx);
  }
  return value;
}

/**
 * 读取 string 字段：缺失 / 显式 `null` → `undefined`（调用方决定默认值或 null）；
 * 非 string → `invalid_config`（不做隐式 coerce，如 number → string）。
 */
function readString(
  section: Record<string, unknown>,
  key: string,
  field: string,
  ctx: ResolutionContext,
): string | undefined {
  const value: unknown = section[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    invalidConfig(field, `expected a string, got ${describeValueType(value)}`, ctx);
  }
  return value;
}

/**
 * 读取 string 列表字段：缺失 / `null` → `undefined`；present 必须是 string 数组
 * （元素**原样保留**——trim / 大小写不敏感是消费方的匹配语义，如 §5.3.1
 * required_labels 归 scheduler、active_states 归 `normalizeIssueState`）。
 */
function readStringList(
  section: Record<string, unknown>,
  key: string,
  field: string,
  ctx: ResolutionContext,
): readonly string[] | undefined {
  const value: unknown = section[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    invalidConfig(field, `expected a list of strings, got ${describeValueType(value)}`, ctx);
  }
  return value;
}

/**
 * 读取正整数字段：缺失 / `null` → `fallback`；非 number / 非整数 / `<= 0` →
 * `invalid_config`（YAML `"20"` 字符串同样报错——不做 env / string → number 的
 * 隐式 coerce）。并发、超时、间隔类字段一律要求正数；唯一例外见 {@link readInt}。
 */
function readPositiveInt(
  section: Record<string, unknown>,
  key: string,
  field: string,
  fallback: number,
  ctx: ResolutionContext,
): number {
  const value = readInt(section, key, field, fallback, ctx);
  if (value <= 0) {
    invalidConfig(field, `expected a positive integer, got ${value}`, ctx);
  }
  return value;
}

/** 读取整数字段（允许 0 / 负数）：仅 `codex.stall_timeout_ms` 使用（`<= 0` = 禁用）。 */
function readInt(
  section: Record<string, unknown>,
  key: string,
  field: string,
  fallback: number,
  ctx: ResolutionContext,
): number {
  const value: unknown = section[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    invalidConfig(field, `expected an integer, got ${describeValueType(value)}`, ctx);
  }
  return value;
}

/**
 * `tracker.provider`：缺失 / `null` → `{}`；present 必须是 plain map，内容
 * **原样保留**——不做 `$VAR` 解析、不校验键（endpoint / scope / credentials 的
 * schema 与 secret 解析归所选 adapter：core 不预校验 provider 内容，adapter 经
 * `trackerExtension` 在 preflight 阶段解释，§5.3.1 / §6.1 / §11.2）。
 */
function readProvider(
  section: Record<string, unknown>,
  field: string,
  ctx: ResolutionContext,
): Readonly<Record<string, unknown>> {
  const value: unknown = section["provider"];
  if (value === undefined || value === null) {
    return {};
  }
  if (!isPlainMap(value)) {
    invalidConfig(field, `expected a map/object, got ${describeValueType(value)}`, ctx);
  }
  return value;
}

/** 显式环境引用：`$NAME` 与 `${NAME}`（NAME = `[A-Za-z_][A-Za-z0-9_]*`），支持内嵌。 */
const ENV_REFERENCE_PATTERN =
  /\$\{(?<braced>[A-Za-z_][A-Za-z0-9_]*)\}|\$(?<bare>[A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * 展开字符串中的全部显式 `$VAR` / `${VAR}` 引用（§6.1 step "Environment
 * variables are resolved when explicitly referenced"）。引用的变量**未设置或为
 * 空串** → `missing_env_reference`（稳定 typed error，message 携带变量名；
 * 空串按 missing 处理对齐 §5.3.1 secret "empty = missing" 精神）。
 * `$` 后跟非法变量名字符（如 `$5`）不是引用，原样保留。无转义语法（`$$` 不特殊）。
 */
function expandEnvReferences(
  value: string,
  field: string,
  ctx: ResolutionContext,
): string {
  return value.replace(ENV_REFERENCE_PATTERN, (match, ...rest) => {
    const groups = rest[rest.length - 1] as { braced?: string; bare?: string };
    const name = groups.braced ?? groups.bare ?? match;
    const resolved = ctx.env[name];
    if (resolved === undefined || resolved === "") {
      throw new SymphonyConfigError(
        "missing_env_reference",
        `Environment variable "${name}" referenced by \`${field}\` is not set or empty`,
        { path: ctx.errorPath },
      );
    }
    return resolved;
  });
}

/**
 * `workspace.root`（核心层唯一做 env / path expansion 的字段）：
 *
 * 1. 缺失 / `null` / 空串处理：缺失或 `null` → 默认 `<tmpdir>/symphony_workspaces`；
 *    显式空串或 trim 后为空 → `invalid_config`（root 必须是非空路径）。
 * 2. `$VAR` / `${VAR}` 展开（缺失 → `missing_env_reference`）。
 * 3. `~` 展开：`~` 与 `~/…` 用注入的 home；`~user/…` **不展开**（无 portable 的
 *    user-home 查询，按字面路径段处理）。注意 YAML 里裸 `~` 是 null 字面量 →
 *    按"显式 null = 未配置"走默认值；要指 home 须写引号形式 `"~"`。
 * 4. 相对路径按 `workflowDir`（WORKFLOW.md 所在目录）解析；最终 normalize 为
 *    绝对路径——resolved 后恒为 absolute（§5.3.3 / §6.1，domain 契约）。
 */
function readWorkspaceRoot(section: Record<string, unknown>, ctx: ResolutionContext): string {
  const raw = readString(section, "root", "workspace.root", ctx);
  if (raw === undefined) {
    return resolvePath(tmpdir(), "symphony_workspaces");
  }
  if (raw.trim() === "") {
    invalidConfig("workspace.root", "expected a non-empty path string", ctx);
  }
  const expanded = expandTilde(expandEnvReferences(raw, "workspace.root", ctx), ctx.home);
  return resolvePath(ctx.workflowDir, expanded);
}

/** `~` / `~/…` → home；其余（含 `~user/…`）原样返回。 */
function expandTilde(value: string, home: string): string {
  if (value === "~") {
    return home;
  }
  if (value.startsWith("~/")) {
    return join(home, value.slice(2));
  }
  return value;
}

/**
 * `agent.max_concurrent_agents_by_state`：缺失 / `null` → `{}`；非 plain map →
 * `invalid_config`。条目语义（§5.3.5）：
 *
 * - key 经 `normalizeIssueState`（trim + lowercase，与 scheduler 的 state 比较
 *   同源）归一化；归一化后为空串 → 视为非法条目忽略；
 * - value 非正整数（非数值 / 非整数 / `<= 0`）→ **静默忽略**（SPEC 原文 "Values
 *   that are not positive integers are ignored"——不报错，与 `max_turns` 的
 *   fail-validation 是刻意对比）；
 * - 归一化后 key 冲突 → last-wins，序**定义为 JS 对象键迭代序**：与 YAML 文档序
 *   一致，整数样 key（如 `"7"`）除外——V8 将整数样键按升序前置，冲突对含整数样
 *   key 时以迭代序为准（有测试锁定；真实 provider state 名均为词语，无实际影响）。
 */
function readByStateMap(
  section: Record<string, unknown>,
  key: string,
  field: string,
  ctx: ResolutionContext,
): Readonly<Record<string, number>> {
  const value: unknown = section[key];
  if (value === undefined || value === null) {
    return {};
  }
  if (!isPlainMap(value)) {
    invalidConfig(field, `expected a map/object, got ${describeValueType(value)}`, ctx);
  }
  const resolved: Record<string, number> = {};
  for (const [rawKey, entry] of Object.entries(value)) {
    const stateKey = normalizeIssueState(rawKey);
    if (stateKey === "") {
      continue;
    }
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry <= 0) {
      continue;
    }
    resolved[stateKey] = entry;
  }
  return resolved;
}
