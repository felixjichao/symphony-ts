import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

it("projection call graph stays synchronous with only domain imports and no I/O/timer capabilities", () => {
  for (const name of ["snapshot.ts", "index.ts"]) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      expect(node.kind).not.toBe(ts.SyntaxKind.AwaitExpression);
      expect(node.kind).not.toBe(ts.SyntaxKind.AsyncKeyword);
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          // Public index accumulates logger exports; snapshot implementation remains domain-only.
          expect(name === "index.ts" ? ["@symphony/domain", "./snapshot", "./logger"] : ["@symphony/domain"]).toContain(node.moduleSpecifier.text);
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
  }
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>; scripts: { test: string };
  };
  expect(Object.keys(pkg.dependencies)).toEqual(["@symphony/domain"]);
  expect(pkg.scripts.test).toBe("vitest run");
});
