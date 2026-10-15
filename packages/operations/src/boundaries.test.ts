import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

it("operations readers and projectors stay read-only with domain imports and no I/O/timer/mutation capabilities", () => {
  for (const name of readdirSync(new URL(".", import.meta.url)).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          expect(node.moduleSpecifier.text === "@symphony/domain" || node.moduleSpecifier.text.startsWith("./")).toBe(true);
        }
      }
      if (ts.isCallExpression(node)) {
        expect(node.expression.kind).not.toBe(ts.SyntaxKind.ImportKeyword);
        if (ts.isIdentifier(node.expression)) {
          expect(["fetch", "require", "setTimeout", "setInterval", "queueMicrotask", "eval"])
            .not.toContain(node.expression.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(source).not.toMatch(/\b(ensurePr|landPr|getNextTask|transaction|claimTask|heartbeatTask|submitResult|setPhase|setWorkPhase|setWaitingReason|setAttention|setHealth)\s*\(/);
  }
  for (const pkgName of ["tracker", "decision", "orchestrator", "agent", "observability"]) {
    const scan = (directory: URL): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
        if (entry.isDirectory()) scan(url);
        else if (entry.name.endsWith(".ts")) expect(readFileSync(url, "utf8")).not.toContain('from "@symphony/operations"');
      }
    };
    scan(new URL(`../../${pkgName}/src/`, import.meta.url));
  }

  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: { test: string };
  };
  expect(Object.keys(pkg.dependencies)).toEqual(["@symphony/domain"]);
  expect(Object.keys(pkg.devDependencies).sort()).toEqual(["@symphony/decision", "@symphony/observability", "@symphony/tracker", "@types/node", "typescript", "vitest"]);
  expect(pkg.scripts.test).toBe("vitest run");
});
