/**
 * Service Config（typed view，SPEC §4.1.3）：由 `WorkflowDefinition.config` 经
 * 默认值合并、`$VAR` 环境解析与路径规范化（§6.1）得到的 typed 运行时配置。
 *
 * 本文件只定义**解析结果**的类型契约；解析 / 校验 / 默认值 / 热重载行为归
 * `@symphony/config`（§5、§6）。字段与 §5.3 / §6.4 一一对应。resolved 语义下所有
 * 字段必填：`| null` 表示 SPEC 把取值决策交给下游（adapter profile 默认、
 * implementation-defined 默认、未配置 hook）。
 */

/** SPEC §5.3.1 `tracker`。 */
export interface TrackerConfig {
  /**
   * `tracker.kind`：选择实现支持的 tracker adapter；dispatch 必需（§6.3 preflight
   * 校验 present & supported）。
   */
  readonly kind: string;
  /**
   * `tracker.provider`：adapter-owned 配置（endpoint、scope/project selector、
   * credentials 等）。core MUST 原样保留 unknown keys、不规定跨 provider 的
   * credential / scope schema（§5.3.1）；`$VAR` 解析与键校验归 adapter。默认 `{}`。
   */
  readonly provider: Readonly<Record<string, unknown>>;
  /**
   * `tracker.required_labels`：issue 必须命中**每个**配置 label 才可派发 / 继续；
   * 匹配忽略大小写与首尾空白，空白配置项不命中任何 issue（§5.3.1）。默认 `[]`。
   */
  readonly requiredLabels: readonly string[];
  /**
   * `tracker.active_states`：provider 原生状态名，scheduler 比较时大小写不敏感
   * （经 `normalizeIssueState`）。`null` = 采用所选 adapter profile 文档化的默认
   * （§5.3.1 / §6.4）。
   */
  readonly activeStates: readonly string[] | null;
  /** `tracker.terminal_states`：语义同 {@link TrackerConfig.activeStates}。 */
  readonly terminalStates: readonly string[] | null;
}

/** SPEC §5.3.2 `polling`。 */
export interface PollingConfig {
  /** `polling.interval_ms`：默认 30000；变更 SHOULD 运行时生效、影响后续 tick（§6.2）。 */
  readonly intervalMs: number;
}

/** SPEC §5.3.3 `workspace`。 */
export interface WorkspaceConfig {
  /**
   * `workspace.root`：resolved 后恒为**绝对路径**——`~` 已展开，相对路径已相对
   * `WORKFLOW.md` 所在目录解析（§5.3.3 / §6.1）。默认 `<system-temp>/symphony_workspaces`。
   */
  readonly root: string;
}

/**
 * SPEC §5.3.4 `hooks`：workspace 生命周期脚本（多行 shell）。执行时机 / 失败语义
 * 的**行为**归 `@symphony/workspace`（§9，M3）；`null` = 未配置该 hook。
 */
export interface HooksConfig {
  /** `hooks.after_create`：仅 workspace 新建时运行；失败中止创建。 */
  readonly afterCreate: string | null;
  /** `hooks.before_run`：每次 attempt 运行、启动 coding agent 之前；失败中止当前 attempt。 */
  readonly beforeRun: string | null;
  /** `hooks.after_run`：每次 attempt 结束后（成败 / 超时 / 取消）；失败仅记日志。 */
  readonly afterRun: string | null;
  /** `hooks.before_remove`：删除已存在 workspace 目录前；失败仅记日志，cleanup 继续。 */
  readonly beforeRemove: string | null;
  /** `hooks.timeout_ms`：适用于所有 hooks；默认 60000；非法值使配置校验失败。 */
  readonly timeoutMs: number;
}

/** SPEC §5.3.5 `agent`。 */
export interface AgentConfig {
  /** `agent.max_concurrent_agents`：全局并发上限；默认 10；变更影响后续 dispatch（§6.2）。 */
  readonly maxConcurrentAgents: number;
  /** `agent.max_turns`：单个 worker session 内 coding-agent turn 数上限；正整数，默认 20。 */
  readonly maxTurns: number;
  /** `agent.max_retry_backoff_ms`：默认 300000（5 分钟）；变更影响后续 retry 调度。 */
  readonly maxRetryBackoffMs: number;
  /**
   * `agent.max_concurrent_agents_by_state`：per-state 并发覆盖。resolved 语义：
   * key 已归一化（trim + lowercase），非法条目（非数值 / 非正数）已过滤（§5.3.5，
   * 归一化与过滤**动作**归 config 包）。默认空 map。
   */
  readonly maxConcurrentAgentsByState: Readonly<Record<string, number>>;
}

/** SPEC §5.3.6 `codex`。 */
export interface CodexConfig {
  /**
   * `codex.command`：shell 命令字符串，运行时经 `bash -lc` 在 workspace 目录启动，
   * 子进程 MUST 通过 stdio 讲兼容的 app-server 协议；默认 `codex app-server`；
   * dispatch preflight 要求非空（§6.3）。原样保留，不做 `~` / URI 改写（§6.1）。
   */
  readonly command: string;
  /**
   * `codex.approval_policy`：Codex `AskForApproval` **pass-through** 值（§5.3.6 建议
   * 不在 SPEC 层手维护枚举）；`null` = implementation-defined 默认。
   */
  readonly approvalPolicy: string | null;
  /** `codex.thread_sandbox`：Codex `SandboxMode` pass-through；`null` 同上。 */
  readonly threadSandbox: string | null;
  /** `codex.turn_sandbox_policy`：Codex `SandboxPolicy` pass-through；`null` 同上。 */
  readonly turnSandboxPolicy: string | null;
  /** `codex.turn_timeout_ms`：默认 3600000（1 小时）。 */
  readonly turnTimeoutMs: number;
  /** `codex.read_timeout_ms`：默认 5000。 */
  readonly readTimeoutMs: number;
  /** `codex.stall_timeout_ms`：默认 300000（5 分钟）；`<= 0` 表示禁用 stall 检测。 */
  readonly stallTimeoutMs: number;
}

/**
 * SPEC §4.1.3 Service Config（typed view）：完整 resolved 配置，覆盖 §6.4 全部
 * core fields。热重载时整体替换（§6.2 last-known-good 语义：无效 reload 不覆盖
 * 当前有效值），因此所有字段 readonly。
 */
export interface ServiceConfig {
  readonly tracker: TrackerConfig;
  readonly polling: PollingConfig;
  readonly workspace: WorkspaceConfig;
  readonly hooks: HooksConfig;
  readonly agent: AgentConfig;
  readonly codex: CodexConfig;
}
