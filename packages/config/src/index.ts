/**
 * @symphony/config — SPEC §5 Workflow Specification / §6 Configuration
 * Specification 的 owner 包（§3 的 Workflow Loader + Config Layer）。
 *
 * 本文件是包的唯一公共 API 面（下游包与测试都从这里 import）。
 *
 * M1.2 落地（§5.1–§5.3）：
 *
 * - WORKFLOW.md 发现与基础解析：{@link loadWorkflow}，产出 `@symphony/domain` 的
 *   `WorkflowDefinition`（`config` = 未经校验的原始 YAML 根对象，`promptTemplate`
 *   = trim 后的 Markdown 正文）。
 *
 * M1.3 落地（§5.3 schema / §6.1 管道 / §6.4 core fields）：
 *
 * - typed config resolution：{@link resolveServiceConfig}（纯 resolver：默认值
 *   合并、显式 `$VAR` 环境解析、路径规范化、typed validation）与
 *   {@link loadEffectiveWorkflow}（文件级组合入口：load + resolve），产出
 *   `@symphony/domain` 的 `ServiceConfig`（§4.1.3 typed view）。
 *
 * M1.4 落地（§5.4 严格渲染 / §6.2 热重载）：
 *
 * - 严格 prompt 渲染：{@link renderPrompt}（`issue` / `attempt` 上下文、严格变量与
 *   filter 检查、空正文 {@link DEFAULT_PROMPT_TEMPLATE} fallback），渲染失败抛
 *   `template_parse_error` / `template_render_error`。
 * - 动态热重载：{@link watchWorkflow}（轮询检测 `WORKFLOW.md` 变化、valid reload
 *   更新 effective config、invalid reload 保留 last-known-good 并经 `onEvent` 上报
 *   operator-visible error、handle 可显式 `close`）。
 *
 * M2.1 落地（§6.3 / §11.4 tracker preflight 扩展点）：
 *
 * - {@link TrackerConfigExtension}：把 selected-adapter 的 tracker 配置校验注入
 *   `resolveServiceConfig` / `loadEffectiveWorkflow` / `watchWorkflow` 的
 *   `trackerExtension` 选项。本包**不 import `@symphony/tracker`**——契约是结构化
 *   类型，由组合根把 tracker 注册表产出的 extension 传进来；不注入时 M1 行为逐字
 *   不变。
 *
 * 稳定错误契约（§5.5）：{@link SymphonyConfigError} + {@link ConfigErrorCode}，
 * 第三方 fs / YAML / liquidjs 异常一律转换后经 `cause` 保留。
 *
 * 尚未落地（后续里程碑）：provider-native tools 与工单写回（§11.5）、workspace
 * lifecycle（§9，M3）。进度见 docs/conformance.md。
 */

export { loadWorkflow } from "./workflow-loader";
export type { LoadWorkflowOptions } from "./workflow-loader";

export { loadEffectiveWorkflow, resolveServiceConfig } from "./config-resolution";
export type {
  EffectiveWorkflow,
  LoadEffectiveWorkflowOptions,
  ResolveServiceConfigOptions,
} from "./config-resolution";

export { DEFAULT_PROMPT_TEMPLATE, renderPrompt } from "./prompt-rendering";
export type { RenderPromptOptions } from "./prompt-rendering";

export { watchWorkflow } from "./workflow-reload";
export type {
  ReloadWithResultOptions,
  WatchWorkflowOptions,
  WorkflowEffectiveStore,
  WorkflowReloadEvent,
  WorkflowReloadResult,
  WorkflowWatchHandle,
} from "./workflow-reload";

export type {
  TrackerConfigExtension,
  TrackerConfigExtensionFailure,
  TrackerConfigValidationContext,
  TrackerExtensionErrorCode,
} from "./tracker-extension";

export { SymphonyConfigError } from "./errors";
export type { ConfigErrorCode } from "./errors";
