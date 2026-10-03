/**
 * 结构边界测试（M5.2 / #51 验收 08、SPEC §7.3 / §10.4）。
 *
 * orchestrator 只能消费稳定 AgentEvent 契约：不得接触 Codex `ChildProcess`、
 * 不得解析 raw Codex JSON、不得按 Codex wire method literal 分支、不得 import
 * agent 私有 transport / protocol 实现。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { describe, expect, it } from "vitest";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(): string[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => path.join(SRC_DIR, name));
}

describe("orchestrator 边界 — 验收 08", () => {
  it("不 import child_process / agent 私有 transport", () => {
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      expect(source, path.basename(file)).not.toMatch(/from\s+["']node:child_process["']/);
      expect(source, path.basename(file)).not.toMatch(/@symphony\/agent\/src/);
      expect(source, path.basename(file)).not.toMatch(/from\s+["'][^"']*\/transport["']/);
      expect(source, path.basename(file)).not.toMatch(/from\s+["'][^"']*\/process-launcher["']/);
    }
  });

  it("不含 Codex wire method literal 依赖", () => {
    const wireLiterals = [
      "thread/start",
      "turn/start",
      "turn/completed",
      "thread/tokenUsage/updated",
      "account/rateLimits/updated",
      '"initialize"',
      '"initialized"',
    ];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      for (const literal of wireLiterals) {
        expect(source.includes(literal), `${path.basename(file)} contains ${literal}`).toBe(false);
      }
    }
  });
});

/** AST imports cover static import/export, import(), and require() without matching comments. */
function moduleSpecifiers(source: string): string[] {
  const file = ts.createSourceFile("boundary.ts", source, ts.ScriptTarget.Latest, true);
  const result: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)) result.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) result.push(argument.text);
      else result.push("<computed module>");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

const PACKAGES = path.resolve(SRC_DIR, "../..");
function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? productionFiles(file) :
      entry.name.endsWith(".ts") && !entry.name.includes(".test") ? [file] : [];
  });
}

describe("M5 public API and runtime dependency direction", () => {
  const allowed: Record<string, readonly string[]> = {
    domain: [], config: ["domain"], tracker: ["domain"], workspace: ["domain"],
    agent: ["domain", "config", "workspace"],
    orchestrator: ["domain", "config", "tracker", "workspace", "agent"],
  };
  it("checks every production import/export/dynamic import against public package entries", () => {
    for (const [owner, dependencies] of Object.entries(allowed)) {
      for (const file of productionFiles(path.join(PACKAGES, owner, "src"))) {
        for (const specifier of moduleSpecifiers(readFileSync(file, "utf8"))) {
          expect(specifier, file).not.toBe("<computed module>");
          if (specifier.startsWith("@symphony/")) {
            expect(dependencies.map((name) => `@symphony/${name}`), file).toContain(specifier);
          } else if (specifier.startsWith(".")) {
            const resolved = path.resolve(path.dirname(file), specifier);
            expect(resolved.startsWith(path.join(PACKAGES, owner, "src") + path.sep), file).toBe(true);
          }
        }
      }
    }
  });
  it("runtime manifests preserve exact dependency direction and test script cannot silently pass empty", () => {
    for (const [owner, dependencies] of Object.entries(allowed)) {
      const manifest = JSON.parse(readFileSync(path.join(PACKAGES, owner, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>; scripts: Record<string, string>;
      };
      const runtime = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
      expect(Object.keys(runtime).filter((name) => name.startsWith("@symphony/")).sort(), owner)
        .toEqual(dependencies.map((name) => `@symphony/${name}`).sort());
      if (owner === "orchestrator") expect(manifest.scripts.test).not.toContain("--passWithNoTests");
    }
  });
  it("orchestrator production has no raw JSON parser", () => {
    for (const file of productionFiles(SRC_DIR)) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/JSON\s*\.\s*parse\s*\(/);
    }
  });
  it("specifier extraction covers each syntactic boundary and ignores comments", () => {
    expect(moduleSpecifiers(`import x from '@symphony/agent/src/private';
      export * from '../../agent/src/index'; const x = import('@symphony/tracker/private');
      const y = require('@symphony/orchestrator'); // import('ignored')`)).toEqual([
        "@symphony/agent/src/private", "../../agent/src/index", "@symphony/tracker/private", "@symphony/orchestrator",
      ]);
  });
});
