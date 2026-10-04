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
 * 已落地的 GitHub provider（M2.2 / #19 + M2.3 / #20）：`tracker.kind: github` 的
 * profile（{@link githubAdapterProfile}，provider 键 / secret / states 校验）、
 * payload → `Issue` 归一化（{@link normalizeGitHubIssue}）、实现 `TrackerAdapter`
 * 的 {@link GitHubTrackerAdapter}（§11.1 的 malformed-record 两副面孔），以及
 * 真实 REST transport（{@link createGitHubIssueTransport}：repository scope、
 * 分页、§11.4 的 request / status / rate-limit / response / pagination 映射）。
 *
 * 尚未落地：其余 provider 的 malformed-record 日志接线（§13，M6）、以及
 * provider-native agent tools（§11.5 / §17.3）。进度见 docs/conformance.md。
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

// --- GitHub Issues adapter（SPEC §11.2 / §11.3，M2.2 / #19）-------------------
// provider knowledge 只活在 github/ 子目录 + 这一层出口；registry 与 config 都不
// 认识 "github" 这个字符串（除注册点之外）。

export {
  createGitHubAdapterProfile,
  githubAdapterProfile,
  type GitHubAdapterProfileOptions,
} from "./github/profile";
export { GITHUB_PROVIDER_KEYS, GITHUB_TRACKER_KIND } from "./github/config";
export { GitHubTrackerAdapter } from "./github/adapter";
export type {
  GitHubIssueTransport,
  GitHubMalformedRecord,
  GitHubTrackerAdapterOptions,
} from "./github/adapter";
export { createGitHubIssueTransport } from "./github/transport";
export type { GitHubFetchImpl, GitHubFetchResponse, GitHubIssueTransportOptions } from "./github/transport";
export { normalizeGitHubIssue } from "./github/normalize";

// --- GitHub Delivery Primitives (SPEC §11.5 / MVP.3) -------------------------
export {
  GitHubDeliveryService,
  DefaultGhRunner,
  classifyGhError,
  parseJsonStream,
  sanitizeCredentials,
  type EnsurePrOptions,
  type GhExecOptions,
  type GhExecResult,
  type GhRunner,
  type LandPrOptions,
  type LandPrResult,
  type PrChecksReport,
  type ReadChecksOptions,
  type ReadPrOptions,
  type VerifyMergedResult,
} from "./github/delivery";
