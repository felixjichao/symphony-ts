/**
 * `@symphony/config` 的稳定错误契约（SPEC §5.5 Workflow Validation and Error
 * Surface）。第三方异常（fs、YAML parser）**不作为**对外契约：一律转换为
 * {@link SymphonyConfigError}，原始异常经 `cause` 保留供诊断（父 issue §7）。
 *
 * 判别式是 {@link SymphonyConfigError.code}，取值来自 {@link ConfigErrorCode}。
 * M1.2（§5.1–§5.3）落地发现 / 解析三码，M1.3（§6 typed config 校验）追加
 * `invalid_config` / `missing_env_reference`，M1.4（§5.4 严格模板渲染）追加
 * `template_parse_error` / `template_render_error`；消费方应容忍未知码并按 `code`
 * 精确分支。
 */

/**
 * config 包对外错误码（SPEC §5.5）。M1.2 落地前三个，M1.3 追加后两个，M1.4 追加
 * 最后两个：
 *
 * - `missing_workflow_file`：workflow 文件缺失或不可读（§5.1）。ENOENT 与
 *   EACCES / EISDIR 等**读取失败**统一用本码，具体 fs 错误经 `cause` 区分。
 * - `workflow_parse_error`：YAML front matter 语法错误，或 front matter 未闭合
 *   （以 `---` 开头却缺少结束的 `---`）。
 * - `workflow_front_matter_not_a_map`：front matter 解析成功但根不是 map/object
 *   （§5.2，如 list / 标量）。
 * - `invalid_config`：front matter 值未通过 typed 校验（§5.3 / §6.1，如错类型、
 *   非正整数、section 非 map）。message 携带字段路径（如 `agent.max_turns`）与
 *   诊断详情；`path` 为 workflow 文件路径（纯 resolver 调用时为 `workflowDir`）。
 * - `missing_env_reference`：显式 `$VAR` / `${VAR}` 环境引用（核心层仅
 *   `workspace.root`，§6.1）未设置或为空。message 携带变量名与字段路径。
 * - `template_parse_error`：prompt 模板本身不可解析（§5.5 "during prompt
 *   rendering"，如 tokenization / 语法错误）。只 fail 受影响的那次 attempt。
 * - `template_render_error`：模板可解析但求值失败（§5.5：unknown variable /
 *   filter、invalid interpolation）。同样只 fail 当次 attempt。
 *   注：`liquidjs` 在 `parse()` 阶段即解析 filter 名，本包把"未注册 filter"归类为
 *   本码（而非 `template_parse_error`）以对齐 §5.5 的错误分类（见 prompt-rendering
 *   Agent Note）。
 *
 * 模板两码携带 `path` 为 workflow 文件绝对路径；对无文件上下文的裸模板调用，
 * `path` 为哨兵值 `"<inline>"`。
 */
export type ConfigErrorCode =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "invalid_config"
  | "missing_env_reference"
  | "template_parse_error"
  | "template_render_error";

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
  /**
   * 相关的已解析绝对文件路径（诊断用；不参与判别）。模板两码在无文件上下文
   * （裸模板渲染）时为哨兵值 `"<inline>"`。
   */
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
