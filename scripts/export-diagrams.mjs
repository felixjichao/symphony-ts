/**
 * export-diagrams — 从 `docs/diagrams/source` 与 `docs/diagrams/zh/source` 提取内嵌 SVG，
 * 产出可提交的 `docs/diagrams/*.svg` 与 `docs/diagrams/zh/*.svg`（`npm run docs:diagrams`）。
 *
 * 设计约束（对应 NEST-96 / GitHub #91）：
 * - HTML 是唯一可编辑源，SVG 是派生产物；两者都必须提交。
 * - 不引入浏览器 / 渲染依赖：SVG 样式内联在 `<style>` 中，导出只做确定性文本抽取，
 *   因此同一份 HTML 每次产出逐字节一致。
 * - `--check` 不写文件，只校验已提交 SVG 与重新导出结果一致（供 docs gate 做 freshness protection）。
 * - 每张图有 `en` / `zh` 两个 locale：英文版是原始版本，中文版是中文为主的平行版本，
 *   两者共享同一逻辑名与布局约定。
 *
 * 零依赖，Node >= 20 直接运行。
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 四张 canonical 图的逻辑名（= 源/产物文件名，不含扩展名）。 */
export const DIAGRAM_NAMES = Object.freeze([
  "runtime-architecture",
  "package-dependencies",
  "github-delivery-loop",
  "delivery-trust-boundary",
]);

/** 支持的 locale；`en` 为原始英文版，`zh` 为中文为主版本。 */
export const DIAGRAM_LOCALES = Object.freeze(["en", "zh"]);

/** 全部 (name, locale) 组合。 */
export const DIAGRAMS = Object.freeze(
  DIAGRAM_LOCALES.flatMap((locale) => DIAGRAM_NAMES.map((name) => ({ name, locale }))),
);

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const SVG_RE = /<svg\b[\s\S]*?<\/svg>/;

function sourceDirFor(locale) {
  return locale === "zh"
    ? join(ROOT, "docs", "diagrams", "zh", "source")
    : join(ROOT, "docs", "diagrams", "source");
}

function outputDirFor(locale) {
  return locale === "zh"
    ? join(ROOT, "docs", "diagrams", "zh")
    : join(ROOT, "docs", "diagrams");
}

/** 相对仓库根的源 / 产物路径（供脚本调用方与 docs gate 复用）。 */
export function sourcePathFor(name, locale = "en") {
  return join(sourceDirFor(locale), `${name}.html`);
}

export function artifactPathFor(name, locale = "en") {
  return join(outputDirFor(locale), `${name}.svg`);
}

/**
 * 从一份 HTML 源中提取第一段 `svg` 元素，补齐 `xmlns` / `viewBox`，
 * 前置 XML 声明，得到可独立渲染的 SVG 文档。
 */
export function renderDiagram(html) {
  const match = SVG_RE.exec(html);
  if (match === null) {
    throw new Error("HTML 源中没有找到 <svg> 块");
  }
  let svg = match[0];
  if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg)) {
    svg = svg.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  if (!/\bviewBox="/.test(svg)) {
    throw new Error("<svg> 缺少 viewBox，无法导出为可缩放 artifact");
  }
  return `${XML_HEADER}${svg}\n`;
}

async function exportAll() {
  for (const { name, locale } of DIAGRAMS) {
    const html = await readFile(sourcePathFor(name, locale), "utf8");
    await writeFile(artifactPathFor(name, locale), renderDiagram(html), "utf8");
  }
}

async function checkAll() {
  const stale = [];
  for (const { name, locale } of DIAGRAMS) {
    const label = locale === "en" ? name : `${locale}/${name}`;
    let html;
    try {
      html = await readFile(sourcePathFor(name, locale), "utf8");
    } catch {
      stale.push(`${label}.html 源缺失`);
      continue;
    }
    const expected = renderDiagram(html);
    let actual;
    try {
      actual = await readFile(artifactPathFor(name, locale), "utf8");
    } catch {
      stale.push(`${label}.svg 产物缺失`);
      continue;
    }
    if (actual !== expected) {
      stale.push(`${label}.svg 与源不一致（请运行 npm run docs:diagrams）`);
    }
  }
  if (stale.length > 0) {
    console.error(`export-diagrams --check 失败（${stale.length} 个问题）：`);
    for (const problem of stale) console.error(`  ✗ ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`export-diagrams --check 通过：${DIAGRAMS.length} 个 SVG 产物与源一致。`);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.argv.includes("--check")) {
    await checkAll();
  } else {
    await exportAll();
    console.log(`export-diagrams: 已从源导出 ${DIAGRAMS.length} 个 SVG 到 docs/diagrams/。`);
  }
}
