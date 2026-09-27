/**
 * 解析后的 `WORKFLOW.md` 载荷（SPEC §4.1.2、§5.2）。
 *
 * 发现 / 解析 / 校验 / 热重载**行为**归 `@symphony/config`（§5、§6）；本类型只是
 * 解析结果的共享契约，config 包产出、下游包消费。
 */
export interface WorkflowDefinition {
  /**
   * SPEC `config`：YAML front matter 根对象（**不**嵌套在 `config` key 下）。
   * 文件无 front matter 时为空对象（§5.2）。值是未经校验的原始 YAML 结果；
   * typed 化后的形状见 `ServiceConfig`（§4.1.3）。
   */
  readonly config: Readonly<Record<string, unknown>>;
  /**
   * SPEC `prompt_template`：front matter 之后的 Markdown 正文，已 trim（§5.2）。
   * 允许为空字符串——空正文的 fallback 策略属 §5.4（config 包决定并记录）。
   */
  readonly promptTemplate: string;
}
