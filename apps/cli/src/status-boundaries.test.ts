import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
function violations(source: string): string[] {
  const ast = ts.createSourceFile("status.ts", source, ts.ScriptTarget.Latest, true);
  const errors: string[] = [];
  const forbidden = /^(ensurePr|landPr|getNextTask|claimTask|heartbeatTask|submitResult|transaction|dispatchIssue|recoverDeliveryHandoff|deriveWorkPhase|deriveSystemHealth|projectWork|stopHost)$/;
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!["node:http", "node:fs/promises", "node:url", "@symphony/domain", "@symphony/operations", "@symphony/observability", "@symphony/tracker"].includes(node.moduleSpecifier.text)) errors.push("import");
    }
    if (ts.isIdentifier(node) && forbidden.test(node.text)) errors.push("control or semantic capability");
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) errors.push("dynamic import");
    ts.forEachChild(node, visit);
  }; visit(ast); return errors;
}
it("keeps production status composition closed over narrow observation capabilities", () => {
  const source = readFileSync(new URL("status.ts", import.meta.url), "utf8");
  expect(violations(source)).toEqual([]);
  expect(source).not.toMatch(/examples|demoService|vite|host\.stop|DurableDecisionStore/);
  for (const method of ["ensurePr", "getNextTask", "transaction", "dispatchIssue", "deriveWorkPhase"]) expect(violations(`${source}\nport.${method}();`)).not.toEqual([]);
  expect(violations(`${source}\nimport { hidden } from './host';`)).toContain("import");
  expect(violations(`${source}\nimport('./host');`)).toContain("dynamic import");
});
