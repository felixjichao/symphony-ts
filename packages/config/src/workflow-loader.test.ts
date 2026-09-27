/**
 * SPEC §5.1–§5.3 WORKFLOW.md 发现与解析测试（对齐 §17.1 Core Conformance 的
 * 前六项 + issue 验收口径）。全部经包公共入口 `./index` import，并在**真实临时
 * 目录 / 文件**上运行（docs/testing.md 三条哲学：验外部世界、用真实现、走真实入口）。
 *
 * 覆盖：explicit / default path、相对 path、missing file、read failure（EISDIR）、
 * 无 front matter、合法 YAML、unknown top-level keys 原样保留、config 非嵌套、
 * malformed YAML、非 map 根（标量 / 列表）、空 front matter、仅注释 front matter、
 * 未闭合 front matter、prompt trim、空正文、BOM、CRLF。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, afterEach, beforeEach, expect, it } from "vitest";

import { loadWorkflow, SymphonyConfigError } from "./index";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "symphony-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 写入一个文件并返回其绝对路径。 */
function write(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

/** 执行 `fn`，返回其抛出的异常（未抛出则返回 undefined）。 */
function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** 断言 `fn` 抛出 code 为 `code` 的 {@link SymphonyConfigError}，返回该错误。 */
function expectConfigError(fn: () => unknown, code: string): SymphonyConfigError {
  const error = capture(fn);
  expect(error).toBeInstanceOf(SymphonyConfigError);
  const configError = error as SymphonyConfigError;
  expect(configError.code).toBe(code);
  expect(configError.name).toBe("SymphonyConfigError");
  return configError;
}

describe("loadWorkflow — path discovery (SPEC §5.1)", () => {
  it("uses the explicit path when provided", () => {
    const file = write("custom.md", "---\nfoo: 1\n---\nExplicit body");
    const def = loadWorkflow({ path: file, cwd: dir });
    expect(def.config).toEqual({ foo: 1 });
    expect(def.promptTemplate).toBe("Explicit body");
  });

  it("prefers the explicit path over the cwd default WORKFLOW.md", () => {
    write("WORKFLOW.md", "default body");
    const explicit = write("custom.md", "explicit body");
    const def = loadWorkflow({ path: explicit, cwd: dir });
    expect(def.promptTemplate).toBe("explicit body");
  });

  it("falls back to WORKFLOW.md in cwd when no explicit path is given", () => {
    write("WORKFLOW.md", "---\npolling:\n  interval_ms: 5000\n---\nDefault body");
    const def = loadWorkflow({ cwd: dir });
    expect(def.config).toEqual({ polling: { interval_ms: 5000 } });
    expect(def.promptTemplate).toBe("Default body");
  });

  it("resolves a relative explicit path against cwd", () => {
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "wf.md"), "relative body", "utf8");
    const def = loadWorkflow({ path: "nested/wf.md", cwd: dir });
    expect(def.promptTemplate).toBe("relative body");
  });
});

describe("loadWorkflow — read failures (SPEC §5.1 / §5.5)", () => {
  it("returns missing_workflow_file for a nonexistent file, preserving the fs cause", () => {
    const missing = join(dir, "does-not-exist.md");
    const error = expectConfigError(
      () => loadWorkflow({ path: missing, cwd: dir }),
      "missing_workflow_file",
    );
    expect(error.path).toBe(missing);
    const cause = error.cause as { code?: string };
    expect(cause?.code).toBe("ENOENT");
  });

  it("returns missing_workflow_file when the path is a directory (EISDIR read failure)", () => {
    // 以 root 运行时 chmod 000 会被绕过；用目录路径制造对 root 也成立的读取失败。
    const error = expectConfigError(
      () => loadWorkflow({ path: dir, cwd: dir }),
      "missing_workflow_file",
    );
    expect(error.path).toBe(dir);
    const cause = error.cause as { code?: string };
    expect(cause?.code).toBe("EISDIR");
  });
});

describe("loadWorkflow — no front matter (SPEC §5.2)", () => {
  it("treats the entire file as prompt body with an empty config map", () => {
    const file = write("plain.md", "# Just Markdown\n\nNo front matter here.\n");
    const def = loadWorkflow({ path: file, cwd: dir });
    expect(def.config).toEqual({});
    expect(def.promptTemplate).toBe("# Just Markdown\n\nNo front matter here.");
  });

  it("does not treat a Markdown horizontal rule further down as front matter", () => {
    const file = write("rule.md", "Intro line\n\n---\n\nafter rule");
    const def = loadWorkflow({ path: file, cwd: dir });
    // 首行不是 `---`，因此整篇都是 prompt body（含中间的 `---`）。
    expect(def.config).toEqual({});
    expect(def.promptTemplate).toBe("Intro line\n\n---\n\nafter rule");
  });
});

describe("loadWorkflow — valid front matter (SPEC §5.2 / §5.3)", () => {
  it("parses YAML front matter into config and trims the body into promptTemplate", () => {
    const file = write(
      "full.md",
      [
        "---",
        "tracker:",
        "  kind: linear",
        "  required_labels:",
        "    - symphony",
        "polling:",
        "  interval_ms: 15000",
        "---",
        "",
        "   # Prompt title",
        "",
        "Do the work for {{ issue.identifier }}.",
        "   ",
      ].join("\n"),
    );
    const def = loadWorkflow({ path: file, cwd: dir });
    expect(def.config).toEqual({
      tracker: { kind: "linear", required_labels: ["symphony"] },
      polling: { interval_ms: 15000 },
    });
    // trim 只作用于正文的首尾边界（前导空行 + 缩进、尾部空白行），不改内部行。
    expect(def.promptTemplate).toBe(
      "# Prompt title\n\nDo the work for {{ issue.identifier }}.",
    );
  });

  it("exposes the front matter root object directly, not nested under a config key", () => {
    const file = write("root.md", "---\nworkspace:\n  root: /tmp/ws\n---\nbody");
    const def = loadWorkflow({ path: file, cwd: dir });
    expect(def.config.workspace).toEqual({ root: "/tmp/ws" });
    expect(def.config).not.toHaveProperty("config");
  });

  it("preserves unknown top-level keys as-is for forward compatibility (SPEC §5.3)", () => {
    const file = write(
      "unknown.md",
      ["---", "tracker:", "  kind: linear", "future_extension:", "  enabled: true", "x_custom: 42", "---", "body"].join(
        "\n",
      ),
    );
    const def = loadWorkflow({ path: file, cwd: dir });
    expect(def.config).toEqual({
      tracker: { kind: "linear" },
      future_extension: { enabled: true },
      x_custom: 42,
    });
  });

  it("treats an empty front matter block as an empty config map", () => {
    // 决策：`---` 紧跟 `---`（YAML 为 null）等价于无配置，而非 not_a_map。
    const file = write("empty-fm.md", "---\n---\nBody only");
    const def = loadWorkflow({ path: file, cwd: dir });
    expect(def.config).toEqual({});
    expect(def.promptTemplate).toBe("Body only");
  });

  it("treats a comment-only front matter block as an empty config map", () => {
    const file = write("comment-fm.md", "---\n# nothing but a comment\n---\nBody");
    const def = loadWorkflow({ path: file, cwd: dir });
    expect(def.config).toEqual({});
    expect(def.promptTemplate).toBe("Body");
  });

  it("strips a leading BOM and normalizes CRLF line endings", () => {
    const file = write("bom-crlf.md", "\uFEFF---\r\nfoo: bar\r\n---\r\nLine one\r\nLine two\r\n");
    const def = loadWorkflow({ path: file, cwd: dir });
    expect(def.config).toEqual({ foo: "bar" });
    expect(def.promptTemplate).toBe("Line one\nLine two");
  });
});

describe("loadWorkflow — malformed input (SPEC §5.2 / §5.5)", () => {
  it("returns workflow_parse_error for invalid YAML, preserving the parser cause", () => {
    const file = write("bad-yaml.md", "---\nlist: [1, 2\n---\nbody");
    const error = expectConfigError(
      () => loadWorkflow({ path: file, cwd: dir }),
      "workflow_parse_error",
    );
    expect(error.path).toBe(file);
    expect(error.cause).toBeDefined();
  });

  it("returns workflow_parse_error for unterminated front matter", () => {
    // 决策：未闭合 front matter 按 parse error，避免 YAML 文本静默漏进 prompt。
    const file = write("unterminated.md", "---\nfoo: bar\nthis line is never closed");
    const error = expectConfigError(
      () => loadWorkflow({ path: file, cwd: dir }),
      "workflow_parse_error",
    );
    expect(error.path).toBe(file);
  });

  it("returns workflow_front_matter_not_a_map for a scalar root", () => {
    const file = write("scalar.md", "---\njust a plain string\n---\nbody");
    const error = expectConfigError(
      () => loadWorkflow({ path: file, cwd: dir }),
      "workflow_front_matter_not_a_map",
    );
    expect(error.path).toBe(file);
  });

  it("returns workflow_front_matter_not_a_map for a list root", () => {
    const file = write("list.md", "---\n- alpha\n- beta\n---\nbody");
    expectConfigError(
      () => loadWorkflow({ path: file, cwd: dir }),
      "workflow_front_matter_not_a_map",
    );
  });
});

describe("loadWorkflow — prompt trimming (SPEC §5.2)", () => {
  it("trims surrounding whitespace and newlines from the prompt body", () => {
    const file = write("trim.md", "---\nfoo: 1\n---\n\n\n   Body text   \n\n\n");
    const def = loadWorkflow({ path: file, cwd: dir });
    expect(def.promptTemplate).toBe("Body text");
  });

  it("yields an empty promptTemplate for a whitespace-only body without erroring", () => {
    const file = write("empty-body.md", "---\nfoo: 1\n---\n   \n\n  ");
    const def = loadWorkflow({ path: file, cwd: dir });
    expect(def.config).toEqual({ foo: 1 });
    expect(def.promptTemplate).toBe("");
  });
});
