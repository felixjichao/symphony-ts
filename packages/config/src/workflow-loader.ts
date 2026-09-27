/**
 * WORKFLOW.md 发现与解析（SPEC §5.1 File Discovery and Path Resolution、
 * §5.2 File Format、§5.3 Front Matter Schema 的 forward-compatibility 约束）。
 *
 * 本文件只做 discovery + 基础解析，产出 `@symphony/domain` 的
 * {@link WorkflowDefinition}：`config` 是**未经校验的原始 YAML 根对象**，
 * `promptTemplate` 是 trim 后的 Markdown 正文。typed config resolution
 * （默认值 / `$VAR` / 路径规范化，§6.1）归 `config-resolution.ts`（M1.3），
 * 模板渲染（§5.4）归 M1.4。
 *
 * 边缘语义决策（未闭合 front matter、空 front matter、定界符严格度、
 * BOM / CRLF）记录于
 * `notes/accepted/architecture/2026-09-27-workflow-loader-contract.md`
 * 与包 README。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import type { WorkflowDefinition } from "@symphony/domain";

import { SymphonyConfigError } from "./errors";

/** {@link loadWorkflow} 的可选注入点。 */
export interface LoadWorkflowOptions {
  /**
   * 显式 workflow 文件路径（SPEC §5.1 优先级 1：explicit application/runtime
   * setting）。相对路径按 `cwd` 解析。缺省时回退到 `cwd` 下的 `WORKFLOW.md`
   * （§5.1 优先级 2）。
   */
  readonly path?: string;
  /**
   * 发现 `WORKFLOW.md` 与解析相对 `path` 的基准目录；默认 `process.cwd()`。
   * 可注入以满足"测试不依赖机器环境"（docs/testing.md）。
   */
  readonly cwd?: string;
}

/** front matter 定界行：`---`，容忍行尾空白（决策见包 README / Agent Note）。 */
function isFrontMatterDelimiter(line: string): boolean {
  return line.replace(/\s+$/, "") === "---";
}

/**
 * YAML 解析结果是否为可作 `config` / section 的 plain map：排除 `null`、数组与
 * Date / Map 等非 plain object（§5.2 "MUST decode to a map/object"）。
 * 包内共享（config-resolution 的 section 校验复用同一判定），不经 `index.ts` 导出。
 */
export function isPlainMap(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 发现并加载 `WORKFLOW.md`，返回原始 {@link WorkflowDefinition}（SPEC §5.1–§5.3）。
 *
 * 路径优先级：显式 `options.path` > `options.cwd`（默认 `process.cwd()`）下的
 * `WORKFLOW.md`。同步读取；错误一律抛 {@link SymphonyConfigError}：
 *
 * - 文件缺失 / 不可读（ENOENT、EACCES、EISDIR…）→ `missing_workflow_file`（§5.1），
 *   底层 fs 异常在 `cause`；
 * - front matter 未闭合或 YAML 语法错误 → `workflow_parse_error`，parser 异常在 `cause`；
 * - front matter 根非 map/object（list、标量）→ `workflow_front_matter_not_a_map`（§5.2）。
 *
 * 无 front matter → `config` 为空对象；空 front matter 块（YAML 为 `null`）同样
 * 按空对象处理；空正文 → `promptTemplate: ""`（不报错，fallback 策略属 §5.4/M1.4）。
 * unknown top-level keys 原样保留、不校验（§5.3 forward compatibility）。
 */
export function loadWorkflow(options: LoadWorkflowOptions = {}): WorkflowDefinition {
  return loadWorkflowFromFile(resolveWorkflowPath(options));
}

/**
 * 按 §5.1 优先级把 {@link LoadWorkflowOptions} 解析为 workflow 文件的绝对路径
 * （显式 `path` 相对 `cwd` 解析；缺省为 `cwd` 下的 `WORKFLOW.md`）。
 *
 * 包内共享：`loadEffectiveWorkflow`（config-resolution）复用本函数拿到同一条
 * 路径，再把其所在目录作为相对 `workspace.root` 的解析基准——不得存在第二份
 * 路径解析逻辑。不经 `index.ts` 导出。
 */
export function resolveWorkflowPath(options: LoadWorkflowOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  return resolve(cwd, options.path ?? "WORKFLOW.md");
}

/**
 * 从已解析的绝对路径加载 workflow（{@link loadWorkflow} 的实现体；供
 * `loadEffectiveWorkflow` 复用，避免二次路径解析）。不经 `index.ts` 导出。
 */
export function loadWorkflowFromFile(filePath: string): WorkflowDefinition {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (cause) {
    // §5.1：missing 与 read failure 统一为 missing_workflow_file，fs 错误进 cause。
    throw new SymphonyConfigError(
      "missing_workflow_file",
      `Cannot read workflow file at ${filePath}`,
      { path: filePath, cause },
    );
  }

  // 决策：剥掉单个前导 BOM、CRLF 归一为 LF，保证定界符匹配与正文的确定性。
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  if (!isFrontMatterDelimiter(lines[0] ?? "")) {
    // §5.2：无 front matter——整个文件都是 prompt body，config 为空 map。
    return { config: {}, promptTemplate: text.trim() };
  }

  const closing = lines.findIndex((line, index) => index > 0 && isFrontMatterDelimiter(line));
  if (closing === -1) {
    // 决策：未闭合 front matter 按 parse error，避免 YAML 文本静默漏进 prompt。
    throw new SymphonyConfigError(
      "workflow_parse_error",
      `Unterminated YAML front matter in ${filePath}: opening '---' has no matching closing '---'`,
      { path: filePath },
    );
  }

  const frontMatterText = lines.slice(1, closing).join("\n");
  const promptTemplate = lines.slice(closing + 1).join("\n").trim();

  let parsed: unknown;
  try {
    parsed = parseYaml(frontMatterText);
  } catch (cause) {
    // 第三方 YAML 异常不越过包边界（父 issue §7）：转换为 workflow_parse_error。
    throw new SymphonyConfigError(
      "workflow_parse_error",
      `Invalid YAML front matter in ${filePath}`,
      { path: filePath, cause },
    );
  }

  if (parsed === null || parsed === undefined) {
    // 决策：空 front matter 块（`---` 紧跟 `---`）或仅注释 → 等价于无配置，
    // 按空 map 处理而非 not_a_map（见 Agent Note）。
    return { config: {}, promptTemplate };
  }

  if (!isPlainMap(parsed)) {
    throw new SymphonyConfigError(
      "workflow_front_matter_not_a_map",
      `Workflow front matter in ${filePath} must decode to a map/object (SPEC §5.2), got ${describeValueType(parsed)}`,
      { path: filePath },
    );
  }

  // §5.2：config 是 front matter 根对象本身（不嵌套在 `config` key 下）；
  // §5.3：unknown top-level keys 原样保留，schema 校验归 M1.3。
  return { config: parsed, promptTemplate };
}

/** 错误消息里的类型描述（诊断用，非契约面）；包内共享，不经 `index.ts` 导出。 */
export function describeValueType(value: unknown): string {
  if (Array.isArray(value)) {
    return "a list";
  }
  return typeof value;
}
