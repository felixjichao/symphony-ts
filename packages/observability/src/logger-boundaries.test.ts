import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
it("logger depends only on domain; owner imports and scheduler state cannot enter the logging package", () => {
  const source = readFileSync(new URL("logger.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("logger.ts", source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      expect(node.moduleSpecifier.text).toBe("@symphony/domain");
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(source).not.toMatch(/WorkerHandle|TimerHandle|OrchestratorRuntimeState|retryAttempts|snapshot/);
});
