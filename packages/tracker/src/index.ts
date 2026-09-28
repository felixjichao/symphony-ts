/**
 * @symphony/tracker — SPEC §11 Issue Tracker Integration Contract 的 owner 包
 * （§3 的 Issue Tracker Adapter）。
 *
 * 本文件是包的唯一公共 API 面（下游包与测试都从这里 import）。
 *
 * M2.1 落地 provider 无关的内核与选择机制：
 *
 * - read kernel（§11.1）：{@link TrackerAdapter} / {@link TrackerAdapterOperations}
 *   两个 REQUIRED operation，{@link createTrackerReadKernel} 统一保证"空输入 →
 *   空结果且零 provider 请求"；返回值只有 normalized `@symphony/domain` Issue，
 *   provider payload 不越界（§11.2 / §11.3）。
 * - 稳定错误契约（§11.4）：{@link TrackerError} + {@link TrackerErrorCode}
 *   （8 个推荐 category 一字不差）+ {@link TrackerConfigErrorCategory}（其中属于
 *   配置阶段的 3 个）。
 * - profile / registry（§11.2）：{@link TrackerAdapterProfile} 声明一个 kind 的
 *   whole-config 校验、provider-owned 键与 secret/env fallback、active/terminal
 *   states 默认值、compact profile 文档指针与构造；{@link TrackerAdapterRegistry}
 *   按 `tracker.kind` 精确选择并构造，{@link createTrackerAdapterRegistry} +
 *   {@link BUILT_IN_TRACKER_ADAPTER_PROFILES} 是组合根的注册点。
 * - config 集成（§6.3 / §17.1）：{@link TrackerAdapterRegistry.createConfigExtension}
 *   产出 {@link TrackerConfigExtension}，注入 `@symphony/config` 的
 *   `loadEffectiveWorkflow({ trackerExtension })` / `resolveServiceConfig`，
 *   使 unsupported kind 与 adapter-owned provider 校验在 effective config
 *   preflight 失败——**本包不 import `@symphony/config`**，两侧各自声明同形的
 *   结构化契约（见 Agent Note）。
 *
 * 边界（根 `AGENTS.md` 两条硬约束 + §11 / §11.5）：
 *
 * - **永不 import `@symphony/orchestrator`**：polling cadence、claim、调度、
 *   retry、`required_labels` 过滤、并发上限全部属 coordination 层；
 * - 不新增 generic 写操作 CRUD（comment / state / attachment）；ticket 变更由
 *   coding agent 经 provider-native tools 完成（§11.5）。
 *
 * 尚未落地：provider payload → Issue 的归一化与 §11.1 malformed-record 策略、
 * provider-native agent tools、以及 GitHub Issues（#19 / #20）。
 * 进度见 docs/conformance.md。
 */

export type { TrackerAdapter, TrackerAdapterOperations } from "./adapter";
export { createTrackerReadKernel } from "./adapter";

export { TrackerError } from "./errors";
export type { TrackerConfigErrorCategory, TrackerErrorCode, TrackerErrorDetails } from "./errors";

export type {
  TrackerAdapterContext,
  TrackerAdapterProfile,
  TrackerEnv,
} from "./profile";

export { BUILT_IN_TRACKER_ADAPTER_PROFILES, TrackerAdapterRegistry, createTrackerAdapterRegistry } from "./registry";
export type {
  TrackerConfigExtension,
  TrackerConfigExtensionFailure,
  TrackerConfigValidationContext,
} from "./registry";
