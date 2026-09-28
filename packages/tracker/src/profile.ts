/**
 * Adapter profile 契约（SPEC §11.2 Adapter Responsibilities）。
 *
 * §11.2 规定"每个 adapter 拥有"的一切——从 effective tracker 配置构造自己、
 * provider-specific scope / 认证 / 分页、payload 归一化、`dispatchable` 推导——
 * 其中**与配置相关的部分**在本文件声明为 profile 的可执行面，好让 provider
 * knowledge 只活在 tracker 侧：`@symphony/config` 不在 core 里硬编码任何 provider
 * 分支（§6.3 / §17.1，根 AGENTS.md 依赖方向）。
 *
 * 一个 profile = 一个 `tracker.kind` 的"配置 + 构造"声明：
 *
 * | §11.2 / checklist 能力 | 本契约的落点 |
 * |---|---|
 * | exact supported `tracker.kind` | {@link TrackerAdapterProfile.kind} |
 * | whole tracker config validation | {@link TrackerAdapterProfile.validateConfig}（可选） |
 * | provider-owned config validation / defaults | {@link TrackerAdapterProfile.resolveProviderConfig}（可选） |
 * | adapter-owned secret / env fallback | `resolveProviderConfig` 的 `env` 入参 + {@link TrackerAdapterProfile.secretProviderKeys} / {@link TrackerAdapterProfile.secretEnvVars} 声明 |
 * | active/terminal state validation / defaults | `validateConfig`（校验）+ {@link TrackerAdapterProfile.defaultActiveStates} / {@link TrackerAdapterProfile.defaultTerminalStates}（回填，`tracker.*_states === null` 时） |
 * | public error mapping / profile metadata | {@link TrackerAdapterProfile.documentation}（§11.2 compact profile 必须覆盖的 8 项） |
 * | construction from effective config | {@link TrackerAdapterProfile.createAdapter} |
 *
 * **约定：profile 的校验 / 解析方法以抛出 `TrackerError` 表达失败**（§11.4
 * 明确允许 language-native exception 代替 literal error object）。registry 会把
 * 抛出的 `TrackerError` 原样作为 `category` 呈现；抛出**非** `TrackerError` 的异常
 * 视为 adapter 缺陷，由 registry 归一化为 `invalid_tracker_config` 并经 `cause`
 * 保留原异常（§11.4 要求 public form → category 映射稳定）。
 */
import type { TrackerConfig } from "@symphony/domain";

import type { TrackerAdapter } from "./adapter";

/**
 * adapter 可见的环境变量视图（§6.1 "adapter-local, not a cross-provider
 * convention"）：core 的 `$VAR` 展开只作用于 `workspace.root`，provider 的
 * secret / env fallback 由 profile 自己解释这些名字（如 #19 的 `GITHUB_TOKEN`）。
 */
export type TrackerEnv = Readonly<Record<string, string | undefined>>;

/**
 * {@link TrackerAdapterProfile.createAdapter} 的入参：已经过 profile 校验 / 解析 /
 * 默认值回填的 effective tracker 配置（§11.2 "construction from the current
 * effective tracker configuration, including active/terminal states"）。
 *
 * `env` 一并给出，但**已经**被 `resolveProviderConfig` 消费过：adapter 不应再自行
 * 解释 secret（那会让 secret 逻辑分裂在两处）。保留它是为了 provider-native tool
 * 之类的构造期需要（§11.5，#19 起）。
 */
export interface TrackerAdapterContext {
  /** 选择本 adapter 的 `tracker.kind` 值（与 profile.kind 相同）。 */
  readonly kind: string;
  /** profile 解析后的 provider-owned 配置（键与默认值由 profile 决定，core 原样保留过）。 */
  readonly provider: Readonly<Record<string, unknown>>;
  /** `tracker.required_labels`，原样（匹配语义归 scheduler，§5.3.1）。 */
  readonly requiredLabels: readonly string[];
  /** resolved active states：`tracker.activeStates ?? profile.defaultActiveStates`。 */
  readonly activeStates: readonly string[];
  /** resolved terminal states：`tracker.terminalStates ?? profile.defaultTerminalStates`。 */
  readonly terminalStates: readonly string[];
  /** adapter-local 环境变量视图（见 {@link TrackerEnv}）。 */
  readonly env: TrackerEnv;
}

/**
 * 一个 `tracker.kind` 的 profile 声明。实现者只需提供自己需要的可选方法；
 * registry 按 `TrackerAdapterRegistry` 的顺序执行校验 → 解析 → 构造。
 */
export interface TrackerAdapterProfile {
  /** 本 profile 支持的**确切** `tracker.kind` 值（§11.2；区分大小写，不 trim）。 */
  readonly kind: string;

  /**
   * §11.2 要求的 compact profile 文档落点（README / docs 的相对路径或锚点文本）。
   * **不允许只在代码里**（§11.2 "not only code"）：必须覆盖 supported kind、
   * exact provider keys 与默认值、secret 键 / 环境变量名、scope selection、
   * 分页与请求上限、`id` / `native_ref` 映射、state / label / priority / timestamp /
   * dispatchable / malformed-record / optional-field 归一化、provider-native tools、
   * 以及 public error form → category + message 的映射。
   */
  readonly documentation: string;

  /**
   * `tracker.provider` 中**敏感**的键名（值本身是 secret，MUST NOT 进日志 /
   * `native_ref` / prompt）。无 secret 的 provider 用空数组。
   */
  readonly secretProviderKeys: readonly string[];

  /**
   * adapter-local 环境变量名中属于 secret 的那些（如 `GITHUB_TOKEN`）。
   * core 不做跨 provider 的 env fallback，故此处只是声明面（供 M6 日志脱敏）。
   */
  readonly secretEnvVars: readonly string[];

  /** `tracker.active_states` 缺失（`null`）时的 profile 默认（§5.3.1 / §6.4）。 */
  readonly defaultActiveStates: readonly string[];

  /** `tracker.terminal_states` 缺失（`null`）时的 profile 默认。 */
  readonly defaultTerminalStates: readonly string[];

  /**
   * whole-tracker config 校验（§6.3 preflight 的 adapter 部分）：可以检查
   * `provider` 的整体形状、`required_labels`、以及 active / terminal states 的
   * provider 语义合法性。
   *
   * 失败抛 `TrackerError`（`invalid_tracker_config` /
   * `missing_tracker_secret`）；通过则返回 `void`。
   */
  validateConfig?(tracker: TrackerConfig, env: TrackerEnv): void;

  /**
   * provider-owned keys 的校验 + 默认值回填 + secret / env fallback（§5.3.1 /
   * §6.1：core 原样保留 unknown keys、不规定跨 provider schema，本方法是唯一
   * 解释这些键的地方）。
   *
   * 返回 resolved provider map（交给 {@link TrackerAdapterProfile.createAdapter}）；
   * 缺省时 registry 原样透传 `tracker.provider`。
   * secret 缺失 / 空 → 抛 `missing_tracker_secret`；键非法 → `invalid_tracker_config`。
   */
  resolveProviderConfig?(
    provider: Readonly<Record<string, unknown>>,
    env: TrackerEnv,
  ): Readonly<Record<string, unknown>>;

  /**
   * 构造 provider adapter（§11.2 的 "construction from the current effective
   * tracker configuration"）。返回的 adapter 只实现
   * `TrackerAdapterOperations`，normalized `Issue` 之外不得暴露 provider payload。
   */
  createAdapter(context: TrackerAdapterContext): TrackerAdapter;
}
