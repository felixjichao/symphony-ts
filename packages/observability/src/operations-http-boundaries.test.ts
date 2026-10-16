import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

it("HTTP transport has only Node HTTP and query-service capabilities, without source I/O or control APIs", () => {
  const source = readFileSync(new URL("operations-http.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("operations-http.ts", source, ts.ScriptTarget.Latest, true);
  const serviceCalls: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      expect(["node:http", "@symphony/operations"]).toContain(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      expect(node.expression.kind).not.toBe(ts.SyntaxKind.ImportKeyword);
      if (ts.isIdentifier(node.expression)) {
        expect(["require", "fetch", "setInterval", "setTimeout", "eval"]).not.toContain(node.expression.text);
      }
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(ast) === "service") {
        serviceCalls.push(node.expression.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(serviceCalls).toEqual(["getOperationalSnapshot"]);
  expect(source).not.toMatch(/\b(ensurePr|landPr|getNextTask|transaction|claimTask|heartbeatTask|submitResult|setPhase|setWorkPhase|setWaitingReason|setAttention|setHealth|deriveWorkPhase|deriveSystemHealth)\s*\(/);
});
