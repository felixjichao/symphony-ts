/**
 * docs-check — 轻量 doc gate（`npm run docs:check`，纳入 `npm run gate`）。
 *
 * 检查四件事，让"文档即架构契约"有 freshness protection：
 * 1. 仓库内所有 Markdown 的相对链接必须指向存在的文件 / 目录；
 * 2. `AGENTS.md` 行数不超过预算（standing orders 必须保持短小可导航）；
 * 3. 开发进度里程碑只存在于 `docs/status.md`（非空 `## 里程碑` 表、名称唯一、状态可分类、
 *    不使用"✅ 本次"）；根 README 与 architecture 不得再出现里程碑进度表；
 * 4. 已有测试文件的 workspace 不得继续使用 `--passWithNoTests`。
 *
 * 零依赖，Node >= 20 直接运行。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

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

/**
 * 读取一个 `## 里程碑` 小节里的三列进度表。返回 { hasHeading, rows }，
 * rows 为数据行（跳过表头与分隔行），支持任意里程碑名称（如 `GitHub Delivery MVP`）。
 * 缺 heading、空表或非三列行都由调用方判定，不在解析阶段静默丢弃。
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
    const cells = trimmed
      .slice(1, trimmed.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((cell) => cell.trim());
    if (!inTable) {
      inTable = true; // 表头行
      continue;
    }
    if (cells.every((cell) => /^:?-{1,}:?$/.test(cell))) continue; // 分隔行
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
    if (columns < 3) {
      errors.push(`${STATUS_DOC} 里程碑行缺少三列：${name || "(空名称)"}`);
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
    const table = readMilestoneTable(await readFile(path, "utf8"));
    if (table.hasHeading && table.rows.length > 0) {
      errors.push(`${rel} 出现里程碑进度表：里程碑进度唯一归 ${STATUS_DOC}`);
    }
  }
  return seen.size;
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

const errors = [];
let files = 0;
let links = 0;
for await (const file of walkMarkdown(ROOT)) {
  files += 1;
  links += await checkLinks(file, errors);
}
const agentsLines = await checkAgentsBudget(errors);
const milestones = await checkStatusMilestones(errors);
const testedWorkspaces = await checkPassWithNoTests(errors);

if (errors.length > 0) {
  console.error(`docs-check 失败（${errors.length} 个问题）：`);
  for (const error of errors) {
    console.error(`  ✗ ${error}`);
  }
  process.exit(1);
}
console.log(
  `docs-check 通过：${files} 个 Markdown 文件，${links} 个相对链接有效；AGENTS.md ${agentsLines}/${AGENTS_MAX_LINES} 行；docs/status.md ${milestones} 个里程碑；${testedWorkspaces} 个已有测试的 workspace 未使用 --passWithNoTests。`,
);
