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
 * 稳定错误契约（§5.5）：{@link SymphonyConfigError} + {@link ConfigErrorCode}，
 * 第三方 fs / YAML / schema 异常一律转换后经 `cause` 保留。
 *
 * 尚未落地（后续里程碑）：严格模板渲染（§5.4，M1.4）；热重载与安全回退
 * （§6.2，M1.4）；`tracker.kind` supported-adapter 校验与 `provider` 键校验
 * （需 adapter 注册表，§6.3 / §11，M2）。进度见 docs/conformance.md。
 */

export { loadWorkflow } from "./workflow-loader";
export type { LoadWorkflowOptions } from "./workflow-loader";

export { loadEffectiveWorkflow, resolveServiceConfig } from "./config-resolution";
export type {
  EffectiveWorkflow,
  LoadEffectiveWorkflowOptions,
  ResolveServiceConfigOptions,
} from "./config-resolution";

export { SymphonyConfigError } from "./errors";
export type { ConfigErrorCode } from "./errors";
