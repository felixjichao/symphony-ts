/**
 * @symphony/config — SPEC §5 Workflow Specification / §6 Configuration
 * Specification 的 owner 包（§3 的 Workflow Loader + Config Layer）。
 *
 * 本文件是包的唯一公共 API 面（下游包与测试都从这里 import）。M1.2 落地内容：
 *
 * - WORKFLOW.md 发现与基础解析：{@link loadWorkflow}（§5.1 路径优先级、§5.2 文件
 *   格式、§5.3 forward-compatibility），产出 `@symphony/domain` 的
 *   `WorkflowDefinition`（`config` = 未经校验的原始 YAML 根对象，`promptTemplate`
 *   = trim 后的 Markdown 正文）。
 * - 稳定错误契约：{@link SymphonyConfigError} + {@link ConfigErrorCode}（§5.5），
 *   第三方 fs / YAML 异常一律转换后经 `cause` 保留。
 *
 * 尚未落地（后续里程碑）：front matter schema 校验、typed `ServiceConfig`
 * resolution、默认值合并、`$VAR` 环境解析、路径规范化（§6，M1.3）；严格模板渲染
 * （§5.4，M1.4）；热重载与安全回退（§6.2，M1.4）。进度见 docs/conformance.md。
 */

export { loadWorkflow } from "./workflow-loader";
export type { LoadWorkflowOptions } from "./workflow-loader";

export { SymphonyConfigError } from "./errors";
export type { ConfigErrorCode } from "./errors";
