/**
 * docs-check — 轻量 doc gate（`npm run docs:check`，纳入 `npm run gate`）。
 *
 * 检查五件事，让"文档即架构契约"有 freshness protection：
 * 1. 仓库内所有 Markdown 的相对链接必须指向存在的文件 / 目录；
 * 2. `AGENTS.md` 行数不超过预算（standing orders 必须保持短小可导航）；
 * 3. 开发进度里程碑只存在于 `docs/status.md`（非空、恰好三列的 `## 里程碑` 表、名称唯一、
 *    状态可分类、不使用"✅ 本次"）；根 README / architecture / AGENTS 不得再出现里程碑进度表
 *    或「里程碑 / §section + 进度状态」摘要（按表结构与行内容识别，不依赖固定标题）；
 * 4. 已有测试文件的 workspace 不得继续使用 `--passWithNoTests`；
 * 5. `docs/diagrams/` 的四张 canonical 图（英文版 + 中文为主的 `zh/` 平行版）必须同时提交可编辑
 *    HTML 源与派生产物 SVG，产物与源逐字节一致，且被对应权威文档以正确的相对路径引用
 *    （避免缺图 / 过期产物 / 引用断裂）。
 *
 * 零依赖，Node >= 20 直接运行。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  DIAGRAMS,
  artifactPathFor,
  renderDiagram,
  sourcePathFor,
} from "./export-diagrams.mjs";

const ROOT = process.cwd();
const IGNORED_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);
const AGENTS_MAX_LINES = 150;

/** 匹配 [text](target) 与 ![alt](target)，允许可选的 "title"。 */
const LINK_RE = /!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
/** 任何 URL scheme（http:、https:、mailto:、mention: 等）都跳过。 */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

async function* walkMarkdown(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        yield* walkMarkdown(join(dir, entry.name));
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield join(dir, entry.name);
    }
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function checkLinks(file, errors) {
  const content = await readFile(file, "utf8");
  const lines = content.split(/\r?\n/);
  let checked = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const match of line.matchAll(LINK_RE)) {
      let target = match[1] ?? "";
      if (target.startsWith("<") && target.endsWith(">")) {
        target = target.slice(1, -1);
      }
      // 去掉 anchor：path#section → path；纯 anchor（#section）跳过。
      const hashIndex = target.indexOf("#");
      if (hashIndex >= 0) {
        target = target.slice(0, hashIndex);
      }
      if (target === "" || SCHEME_RE.test(target)) {
        continue;
      }
      checked += 1;
      const resolved = resolve(dirname(file), target);
      if (!(await exists(resolved))) {
        errors.push(
          `${relative(ROOT, file)}:${i + 1} 相对链接不存在 → ${match[1]}`,
        );
      }
    }
  }
  return checked;
}

async function checkAgentsBudget(errors) {
  const agentsPath = join(ROOT, "AGENTS.md");
  if (!(await exists(agentsPath))) {
    errors.push("AGENTS.md 不存在");
    return;
  }
  const content = await readFile(agentsPath, "utf8");
  const lines = content.trimEnd() === "" ? 0 : content.trimEnd().split(/\r?\n/).length;
  if (lines > AGENTS_MAX_LINES) {
    errors.push(`AGENTS.md 行数超预算：${lines} > ${AGENTS_MAX_LINES}`);
  }
  return lines;
}

function milestoneStatusCategory(status) {
  if (/已完成|✅/.test(status)) return "completed";
  if (/进行中|in-progress/i.test(status)) return "in-progress";
  if (/未开始|planned/i.test(status)) return "planned";
  return "unknown";
}

const MILESTONE_HEADING = "## 里程碑";
const STATUS_DOC = join("docs", "status.md");

/** 按管道拆分一个 Markdown 表格行，去掉首尾管道并 trim 每个单元格。 */
function splitTableRow(line) {
  const trimmed = line.trim();
  return trimmed
    .slice(1, trimmed.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((cell) => cell.trim());
}

const SEPARATOR_CELL = /^:?-{1,}:?$/;
const PROGRESS_STATUS_RE = /(已完成|未开始|进行中|in[ -]?progress|planned|deferred)/i;
const MILESTONE_OR_SPEC_RE = /(\bM[0-7](?:\.\d+)?\b|§\d+(?:\.\d+)?)/;

/**
 * 扫描全部 Markdown 表格，返回 [{ header, rows }]（rows 为数据行单元格数组）。
 * 只有「表头行 + 分隔行」开头、且至少一行数据的连续块才算表格。
 */
function findTables(content) {
  const lines = content.split(/\r?\n/);
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    if (!(lines[i] ?? "").trim().startsWith("|")) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < lines.length && (lines[j] ?? "").trim().startsWith("|")) {
      j += 1;
    }
    const block = lines.slice(i, j).map(splitTableRow);
    i = j;
    if (block.length < 3) continue;
    const separator = block[1] ?? [];
    if (separator.length === 0 || !separator.every((cell) => SEPARATOR_CELL.test(cell))) {
      continue;
    }
    tables.push({ header: block[0] ?? [], rows: block.slice(2) });
  }
  return tables;
}

/**
 * 判断表格是否为「里程碑进度表」（而非普通配置 / 映射表）：
 * 表头三列为里程碑 / 内容 / 状态，或（标题被改写时）存在
 * `M#` / `GitHub Delivery MVP` 之类名称加可分类状态的数据行。
 */
function isMilestoneProgressTable(table) {
  const { header, rows } = table;
  if (rows.length === 0) return false;
  const headerLooks =
    header.length === 3 &&
    /里程碑|阶段|milestone/i.test(header[0] ?? "") &&
    /状态|status/i.test(header[2] ?? "");
  if (headerLooks) return true;
  return rows.some((cells) => {
    if (cells.length !== 3) return false;
    const name = cells[0] ?? "";
    const status = cells[2] ?? "";
    return (
      (/^M\d/.test(name) || /GitHub Delivery MVP/.test(name)) &&
      milestoneStatusCategory(status) !== "unknown"
    );
  });
}

/**
 * 读取一个 `## 里程碑` 小节里的进度表。返回 { hasHeading, rows }，
 * rows 为数据行（跳过表头与分隔行），支持任意里程碑名称（如 `GitHub Delivery MVP`）。
 * 缺 heading、空表或列数不对都由调用方判定，不在解析阶段静默丢弃。
 */
function readMilestoneTable(content) {
  const lines = content.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim() === MILESTONE_HEADING);
  if (heading < 0) {
    return { hasHeading: false, rows: [] };
  }
  const rows = [];
  let inTable = false;
  for (let i = heading + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.startsWith("## ")) break;
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      if (inTable) break;
      continue;
    }
    const cells = splitTableRow(trimmed);
    if (!inTable) {
      inTable = true; // 表头行
      continue;
    }
    if (cells.length > 0 && cells.every((cell) => SEPARATOR_CELL.test(cell))) continue; // 分隔行
    rows.push({ name: cells[0] ?? "", status: cells[2] ?? "", columns: cells.length });
  }
  return { hasHeading: true, rows };
}

async function checkStatusMilestones(errors) {
  const statusPath = join(ROOT, STATUS_DOC);
  if (!(await exists(statusPath))) {
    errors.push(`${STATUS_DOC} 不存在：开发进度里程碑必须集中在该文件`);
    return 0;
  }
  const { hasHeading, rows } = readMilestoneTable(await readFile(statusPath, "utf8"));
  if (!hasHeading) {
    errors.push(`${STATUS_DOC} 缺少 \`${MILESTONE_HEADING}\` 小节`);
  }
  if (rows.length === 0) {
    errors.push(`${STATUS_DOC} 的 \`${MILESTONE_HEADING}\` 表为空：不能静默通过`);
  }
  const seen = new Set();
  for (const { name, status, columns } of rows) {
    if (columns !== 3) {
      errors.push(`${STATUS_DOC} 里程碑行必须恰好三列（实际 ${columns} 列）：${name || "(空名称)"}`);
      continue;
    }
    if (name === "") {
      errors.push(`${STATUS_DOC} 里程碑行为空名称`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`${STATUS_DOC} 里程碑重复：${name}`);
      continue;
    }
    seen.add(name);
    if (status.includes("✅ 本次")) {
      errors.push(`里程碑 ${name} 使用了时间性状态“✅ 本次”，请改为稳定状态`);
    } else if (milestoneStatusCategory(status) === "unknown") {
      errors.push(`里程碑 ${name} 状态无法分类：${status}`);
    }
  }
  for (const rel of ["README.md", join("docs", "architecture.md")]) {
    const path = join(ROOT, rel);
    if (!(await exists(path))) continue;
    const tables = findTables(await readFile(path, "utf8"));
    if (tables.some(isMilestoneProgressTable)) {
      errors.push(`${rel} 出现里程碑进度表：里程碑进度唯一归 ${STATUS_DOC}`);
    }
  }
  return seen.size;
}

/**
 * README / architecture / AGENTS 只描述身份、稳定边界与 standing orders，不得复述
 * 「里程碑 / SPEC section + 进度状态」这类当前进度摘要——它只归 docs/status.md。
 */
async function checkProgressSingleSource(errors) {
  let checked = 0;
  for (const rel of ["README.md", "AGENTS.md", join("docs", "architecture.md")]) {
    const path = join(ROOT, rel);
    if (!(await exists(path))) continue;
    checked += 1;
    const lines = (await readFile(path, "utf8")).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (PROGRESS_STATUS_RE.test(line) && MILESTONE_OR_SPEC_RE.test(line)) {
        errors.push(`${rel}:${index + 1} 出现里程碑 / 进度摘要：当前状态只由 ${STATUS_DOC} 维护`);
      }
    });
  }
  return checked;
}

async function hasTestFile(dir) {
  if (!(await exists(dir))) return false;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await hasTestFile(path)) return true;
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      return true;
    }
  }
  return false;
}

async function checkPassWithNoTests(errors) {
  let checked = 0;
  for (const group of ["packages", "apps"]) {
    const groupDir = join(ROOT, group);
    if (!(await exists(groupDir))) continue;
    for (const entry of await readdir(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const workspaceDir = join(groupDir, entry.name);
      const packagePath = join(workspaceDir, "package.json");
      if (!(await exists(packagePath)) || !(await hasTestFile(join(workspaceDir, "src")))) {
        continue;
      }
      checked += 1;
      const manifest = JSON.parse(await readFile(packagePath, "utf8"));
      const testScript = manifest.scripts?.test;
      if (typeof testScript === "string" && testScript.includes("--passWithNoTests")) {
        errors.push(
          `${relative(ROOT, packagePath)} 已有测试文件，但 test 脚本仍包含 --passWithNoTests`,
        );
      }
    }
  }
  return checked;
}

/**
 * 每张 (locale, name) 图各自的权威引用文档（相对仓库根）。除文档存在外，还要求该文档以
 * 指向该 artifact 的正确相对路径引用它——按 `relative(dirname(doc), artifact)` 计算，
 * 从而把英文版与 `zh/` 版区分开。
 */
const REQUIRED_DIAGRAM_REFS = {
  "en:runtime-architecture": ["README.md", join("docs", "architecture.md"), join("docs", "diagrams", "README.md")],
  "en:package-dependencies": [join("docs", "architecture.md"), join("docs", "diagrams", "README.md")],
  "en:github-delivery-loop": [join("docs", "github-delivery-workflow.md"), join("docs", "diagrams", "README.md")],
  "en:delivery-trust-boundary": [join("docs", "github-delivery-workflow.md"), join("docs", "diagrams", "README.md")],
  "zh:runtime-architecture": ["README.md", join("docs", "architecture.md"), join("docs", "diagrams", "README.md")],
  "zh:package-dependencies": [join("docs", "architecture.md"), join("docs", "diagrams", "README.md")],
  "zh:github-delivery-loop": [join("docs", "diagrams", "README.md")],
  "zh:delivery-trust-boundary": [join("docs", "diagrams", "README.md")],
};

async function checkDiagramAssets(errors) {
  let checked = 0;
  for (const { name, locale } of DIAGRAMS) {
    const label = locale === "en" ? name : `${locale}/${name}`;
    const source = sourcePathFor(name, locale);
    const artifact = artifactPathFor(name, locale);
    const sourceRel = relative(ROOT, source);
    const artifactRel = relative(ROOT, artifact);
    if (!(await exists(source))) {
      errors.push(`docs/diagrams: 缺少 ${label} 的 HTML 源（${sourceRel}）`);
      continue;
    }
    if (!(await exists(artifact))) {
      errors.push(`docs/diagrams: 缺少 ${label}.svg 产物（${artifactRel}，运行 npm run docs:diagrams）`);
      continue;
    }
    try {
      const expected = renderDiagram(await readFile(source, "utf8"));
      const actual = await readFile(artifact, "utf8");
      if (actual !== expected) {
        errors.push(`docs/diagrams: ${label}.svg 与源不一致（运行 npm run docs:diagrams）`);
      }
    } catch (error) {
      errors.push(`docs/diagrams: ${label} 源无法导出为 SVG：${error.message}`);
    }
    checked += 1;
    for (const doc of REQUIRED_DIAGRAM_REFS[`${locale}:${name}`] ?? []) {
      const docPath = join(ROOT, doc);
      if (!(await exists(docPath))) {
        errors.push(`docs/diagrams: ${label} 的引用文档 ${doc} 不存在`);
        continue;
      }
      const target = relative(dirname(docPath), artifact);
      if (!(await readFile(docPath, "utf8")).includes(target)) {
        errors.push(`docs/diagrams: ${doc} 未引用 ${label}.svg（期望路径 ${target}）`);
      }
    }
  }
  return checked;
}

const errors = [];
let files = 0;
let links = 0;
for await (const file of walkMarkdown(ROOT)) {
  files += 1;
  links += await checkLinks(file, errors);
}
const agentsLines = await checkAgentsBudget(errors);
const milestones = await checkStatusMilestones(errors);
const progressSources = await checkProgressSingleSource(errors);
const testedWorkspaces = await checkPassWithNoTests(errors);
const diagramAssets = await checkDiagramAssets(errors);

if (errors.length > 0) {
  console.error(`docs-check 失败（${errors.length} 个问题）：`);
  for (const error of errors) {
    console.error(`  ✗ ${error}`);
  }
  process.exit(1);
}
console.log(
  `docs-check 通过：${files} 个 Markdown 文件，${links} 个相对链接有效；AGENTS.md ${agentsLines}/${AGENTS_MAX_LINES} 行；docs/status.md ${milestones} 个里程碑；${progressSources} 个进度单源文件无重复摘要；${testedWorkspaces} 个已有测试的 workspace 未使用 --passWithNoTests；${diagramAssets} 组 canonical 图源/产物一致且被引用。`,
);
