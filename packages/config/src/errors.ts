/**
 * `@symphony/config` 的稳定错误契约（SPEC §5.5 Workflow Validation and Error
 * Surface）。第三方异常（fs、YAML parser）**不作为**对外契约：一律转换为
 * {@link SymphonyConfigError}，原始异常经 `cause` 保留供诊断（父 issue §7）。
 *
 * 判别式是 {@link SymphonyConfigError.code}，取值来自 {@link ConfigErrorCode}。
 * M1.2（SPEC §5.1–§5.3）只涉及 workflow 发现 / 解析相关的三个码；后续里程碑
 * （§6 typed config 校验、§5.4 模板渲染）会向该联合追加新码，消费方应容忍
 * 未知码并按 `code` 精确分支。
 */

/**
 * config 包对外错误码（SPEC §5.5）。M1.2 落地前三个：
 *
 * - `missing_workflow_file`：workflow 文件缺失或不可读（§5.1）。ENOENT 与
 *   EACCES / EISDIR 等**读取失败**统一用本码，具体 fs 错误经 `cause` 区分。
 * - `workflow_parse_error`：YAML front matter 语法错误，或 front matter 未闭合
 *   （以 `---` 开头却缺少结束的 `---`）。
 * - `workflow_front_matter_not_a_map`：front matter 解析成功但根不是 map/object
 *   （§5.2，如 list / 标量）。
 *
 * `template_parse_error` / `template_render_error`（§5.4 渲染期）与 §6 的
 * invalid-config / missing-env 类码留待 M1.4 / M1.3 追加。
 */
export type ConfigErrorCode =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map";

/**
 * config 包的统一 typed error。除标准 `Error` 字段外携带：
 *
 * - {@link SymphonyConfigError.code}：稳定判别式（见 {@link ConfigErrorCode}）。
 * - {@link SymphonyConfigError.path}：触发错误的**已解析绝对路径**（诊断用）。
 * - `cause`：底层 fs / YAML 原始异常（构造时经 `ErrorOptions.cause` 传入）。
 */
export class SymphonyConfigError extends Error {
  /** 稳定错误码判别式（SPEC §5.5）。 */
  readonly code: ConfigErrorCode;
  /** 相关的已解析绝对文件路径（诊断用；不参与判别）。 */
  readonly path: string;

  constructor(
    code: ConfigErrorCode,
    message: string,
    options: { path: string; cause?: unknown },
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "SymphonyConfigError";
    this.code = code;
    this.path = options.path;
  }
}
