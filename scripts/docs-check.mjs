/**
 * docs-check — 轻量 doc gate（`npm run docs:check`，纳入 `npm run gate`）。
 *
 * 检查两件事，让"文档即架构契约"有 freshness protection：
 * 1. 仓库内所有 Markdown 的相对链接必须指向存在的文件 / 目录；
 * 2. `AGENTS.md` 行数不超过预算（standing orders 必须保持短小可导航，
 *    详细内容下沉到 docs/ 与各包 README）。
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

const errors = [];
let files = 0;
let links = 0;
for await (const file of walkMarkdown(ROOT)) {
  files += 1;
  links += await checkLinks(file, errors);
}
const agentsLines = await checkAgentsBudget(errors);

if (errors.length > 0) {
  console.error(`docs-check 失败（${errors.length} 个问题）：`);
  for (const error of errors) {
    console.error(`  ✗ ${error}`);
  }
  process.exit(1);
}
console.log(
  `docs-check 通过：${files} 个 Markdown 文件，${links} 个相对链接有效；AGENTS.md ${agentsLines}/${AGENTS_MAX_LINES} 行。`,
);
