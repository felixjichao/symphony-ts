/**
 * 严格 prompt 模板渲染（SPEC §5.4 Prompt Template Contract；渲染规则见 §12.2、
 * attempt 语义见 §12.3、失败语义见 §12.4、错误码见 §5.5）。
 *
 * `WORKFLOW.md` 的 Markdown 正文即 per-issue prompt 模板。本模块把它渲染为最终
 * prompt 字符串，输入为 `@symphony/domain` 的归一化 {@link Issue} 与可选
 * `attempt` 计数。
 *
 * 硬约束（§5.4 MUST）：
 *
 * - **严格变量检查**：未识别变量 → 渲染失败，绝不静默渲染成空串。
 * - **严格 filter 检查**：未注册 filter → 渲染失败。
 * - **不读文件**：读盘类标签（`{% include %}` 等）被结构性拒绝，渲染结果不依赖进程
 *   cwd（见 {@link FILESYSTEM_FREE_FS}）。
 * - 渲染失败只影响当次调用（纯函数抛 typed error），天然满足 §5.5 "template
 *   errors fail only the affected run attempt"；重试 / 派发处置归 orchestrator
 *   （M5），本层不做。
 *
 * 变量面（§12.2）：`issue`（全部归一化字段，含 `labels` / `blockers` 等嵌套
 * 集合，保留供模板迭代）+ `attempt`（integer 或 `null`）。顶层键名用 SPEC §4.1.1
 * 的 snake_case 字段名——`Issue` 是 camelCase 领域类型，映射职责显式落在本渲染层
 * （见 `notes/accepted/architecture/2026-09-27-domain-contracts.md`），不回改领域
 * 类型。
 *
 * 边缘语义与选型（empty prompt 默认值、`null` 渲染为空、filter 错误归类、时间戳
 * 格式、文件系统无关性）记录于
 * `notes/accepted/architecture/2026-09-27-prompt-rendering-contract.md`
 * 与包 README。
 */
import { dirname, sep } from "node:path";

import { Liquid, LiquidError, type FS, type Template } from "liquidjs";

import type { Issue } from "@symphony/domain";

import { SymphonyConfigError, type ConfigErrorCode } from "./errors";

/**
 * SPEC §5.4 的 minimal default prompt：workflow 正文为空时的 fallback（§5.4 MAY）。
 * 逐字对齐 SPEC 原文；不含任何模板变量，故不经模板引擎。
 */
export const DEFAULT_PROMPT_TEMPLATE = "You are working on an issue from the configured tracker.";

/**
 * 无 workflow 文件上下文（裸模板渲染）时写入 {@link SymphonyConfigError.path} 的
 * 哨兵值。真实调用（orchestrator 渲染 `WORKFLOW.md` 正文）应显式传 `workflowPath`。
 */
const INLINE_PROMPT_PATH = "<inline>";

/**
 * `liquidjs` 以 `undefined filter: <name>` 前缀报告未注册 filter（该判定发生在
 * `parse()` 阶段）。SPEC §5.5 把 unknown filter 归入 `template_render_error`，
 * 这里据此前缀把它从 `template_parse_error` 中区分出来（见 Agent Note）。
 */
const UNDEFINED_FILTER_PREFIX = "undefined filter:";

/**
 * 文件系统无关的 `fs` 实现：`{% include %}` / `{% render %}` / `{% layout %}`
 * 等内建 fs 标签会按 `process.cwd()` 读盘，把任意仓库文件内容带进 prompt，并使
 * 渲染结果依赖进程 cwd。渲染层只消费显式注入的 `issue` / `attempt`，**不读文件**，
 * 因此这里让所有读盘入口（含 `resolve`）直接抛错——渲染必然失败并归
 * `template_render_error`，契约由结构保证而非文档承诺。
 *
 * `dirname` / `sep` 仍提供真实实现（纯字符串运算、不触盘），以免 liquidjs 因
 * 相对引用而告警；`resolve` 本身已被拒绝，故它们不会被用于实际查找。
 */
const FILESYSTEM_FREE_FS: FS = {
  exists: () => denyFilesystem("fs.exists"),
  existsSync: () => denyFilesystem("fs.existsSync"),
  readFile: () => denyFilesystem("fs.readFile"),
  readFileSync: () => denyFilesystem("fs.readFileSync"),
  resolve: () => denyFilesystem("fs.resolve"),
  dirname,
  sep,
};

function denyFilesystem(operation: string): never {
  // 故意抛普通 `Error`（而非 liquidjs 的抽象 `LiquidError`）：它从 renderSync 逃逸后
  // 由 {@link toPromptError} 按"render 阶段失败"归 `template_render_error`。
  throw new Error(`prompt templates must be filesystem-free; ${operation} is not supported`);
}

/**
 * 进程内共享的严格引擎实例。`strictVariables` 让未定义变量求值失败；
 * `strictFilters` 让未注册 filter 失败。`ownPropertyOnly`（liquidjs 10 默认）
 * 关闭原型链查找（`{{ issue.constructor.name }}` → `template_render_error`）。
 * `fs` 被替换为 {@link FILESYSTEM_FREE_FS}，`relativeReference` 关闭。
 * 引擎无每调用状态，模块级单例即可。
 */
const strictEngine = new Liquid({
  strictVariables: true,
  strictFilters: true,
  relativeReference: false,
  fs: FILESYSTEM_FREE_FS,
});

/** {@link renderPrompt} 的输入：SPEC §5.4 / §12.1 的模板变量面。 */
export interface RenderPromptOptions {
  /** 归一化 issue（§4.1.1）；渲染层映射为 snake_case 变量面供模板消费。 */
  readonly issue: Issue;
  /**
   * 1-based retry / continuation 计数（§12.3）：首次运行为 `null` / 缺席，
   * 后续运行为整数。上下文**恒包含** `attempt` 键——首次运行显式传 `null` 而不是
   * 让键缺席（`strictVariables` 下缺席会让 `{{ attempt }}` 报错，违背 §5.4 的
   * "`null`/absent on first attempt" 合法语义）。
   */
  readonly attempt?: number | null;
  /**
   * 诊断用：workflow 文件绝对路径，写入渲染错误的 `path`；缺省为哨兵
   * {@link INLINE_PROMPT_PATH}。
   */
  readonly workflowPath?: string;
}

/**
 * 按 §5.4 严格语义渲染 prompt 模板。
 *
 * - 空 / 纯空白模板 → 返回 {@link DEFAULT_PROMPT_TEMPLATE}（§5.4 MAY 的 fallback）。
 * - 未识别变量、未注册 filter、语法错误 → 抛 {@link SymphonyConfigError}
 *   （`template_render_error` / `template_parse_error`，见 §5.5），第三方引擎异常
 *   经 `cause` 保留、不越过包边界。
 *
 * **纯函数、不读文件**：引擎的 `fs` 被替换为 {@link FILESYSTEM_FREE_FS}，`{% include %}`
 * / `{% render %}` / `{% layout %}` 等会读盘的标签一律失败（`template_render_error`），
 * 渲染结果只取决于入参，不依赖 `process.cwd()`。可安全用于多次重试与并发渲染。
 */
export function renderPrompt(template: string, options: RenderPromptOptions): string {
  if (template.trim() === "") {
    // §5.4：正文为空时使用最小默认 prompt；不报错（loader 已把空正文固化为合法输入）。
    return DEFAULT_PROMPT_TEMPLATE;
  }

  const workflowPath = options.workflowPath ?? INLINE_PROMPT_PATH;
  const context: Record<string, unknown> = {
    issue: toTemplateIssue(options.issue),
    attempt: options.attempt ?? null,
  };

  let parsed: Template[];
  try {
    parsed = strictEngine.parse(template);
  } catch (error) {
    throw toPromptError(error, "parse", workflowPath);
  }
  try {
    return strictEngine.renderSync(parsed, context);
  } catch (error) {
    throw toPromptError(error, "render", workflowPath);
  }
}

/**
 * `Issue`（camelCase 领域类型）→ 模板变量面（snake_case 字符串键，§12.2）。
 *
 * - 键名对齐 SPEC §4.1.1 的规范字段名，模板生态与 SPEC 一致；不同时暴露 camelCase
 *   双份键面，避免两套变量名漂移。
 * - `labels` / `blocked_by` 原样保留为数组供模板迭代（§12.2 "preserve nested
 *   arrays/maps"）；`native_ref` 原样透传（不透明 provider 载荷，§4.1.1）。
 * - `created_at` / `updated_at`（epoch ms number）映射为 **ISO 8601 字符串**，
 *   模板可读；不可得时保持 `null`（渲染为空串，`null` 是"已定义值"而非未定义）。
 */
function toTemplateIssue(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    native_ref: issue.nativeRef,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branchName,
    url: issue.url,
    assignee_id: issue.assigneeId,
    labels: issue.labels,
    blocked_by: issue.blockedBy.map((blocker) => ({
      id: blocker.id,
      identifier: blocker.identifier,
      state: blocker.state,
    })),
    dispatchable: issue.dispatchable,
    created_at: toIsoTimestamp(issue.createdAt),
    updated_at: toIsoTimestamp(issue.updatedAt),
  };
}

/** epoch ms → ISO 8601 字符串；`null` 保持 `null`。 */
function toIsoTimestamp(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/**
 * 把 `liquidjs` 异常折叠为单个 {@link SymphonyConfigError}（§5.5 / 父 issue §7：
 * 第三方异常不越过包边界，原始异常进 `cause`）。
 *
 * 分类规则：
 * - `render` 阶段失败 → `template_render_error`；
 * - `parse` 阶段的未注册 filter → `template_render_error`（对齐 §5.5 对
 *   "unknown variable/filter" 的分类，见 Agent Note）；
 * - 其余 parse 阶段失败（tokenization / 语法错误）→ `template_parse_error`。
 */
function toPromptError(
  error: unknown,
  stage: "parse" | "render",
  workflowPath: string,
): SymphonyConfigError {
  if (error instanceof SymphonyConfigError) {
    return error;
  }
  const isUndefinedFilter =
    error instanceof LiquidError && error.message.startsWith(UNDEFINED_FILTER_PREFIX);
  const code: ConfigErrorCode =
    stage === "render" || isUndefinedFilter ? "template_render_error" : "template_parse_error";
  const detail = error instanceof Error ? error.message : String(error);
  return new SymphonyConfigError(code, `Failed to ${stage} prompt template: ${detail}`, {
    path: workflowPath,
    cause: error,
  });
}
