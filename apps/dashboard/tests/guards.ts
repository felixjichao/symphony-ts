/** Restricted presentation language guard, not a proof of arbitrary JS semantics. */
import ts from "typescript";
const sensitive = /\b(ci|review|pullRequest|task|result|outcome|target|headSha|anomalies|evidence|execution|planning)\b/;
const semantics = new Set(["phase", "attention", "health", "approval", "reason", "degradedWork", "anomalyCount"]);
export function browserErrors(name: string, source: string): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const errors: string[] = [];
  const tainted = new Set<string>();
  const isSensitive = (node: ts.Node): boolean => sensitive.test(node.getText(file)) || [...tainted].some(v => new RegExp(`\\b${v}\\b`).test(node.getText(file)));
  // Propagate through locals and helper aliases before inspecting computations.
  for (let pass = 0; pass < 10; pass++) {
    const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.initializer && isSensitive(node.initializer)) tainted.add(node.name.getText(file)); ts.forEachChild(node, visit); }; visit(file);
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier)) {
        const value = specifier.text;
        if (!value.startsWith("./") && !(value === "@symphony/operations" && ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)) errors.push("browser import boundary");
        if (value.startsWith("./") && !/^\.\/(identity|presentation|transport|validate|polling|view|style\.css)$/.test(value)) errors.push("unapproved local module");
        if (value.includes("examples") || value.includes("tests")) errors.push("Node/test graph in browser");
      }
    }
    if (ts.isIdentifier(node) && ["XMLHttpRequest", "WebSocket", "EventSource", "localStorage", "sessionStorage", "indexedDB", "require", "eval", "Function", "navigator", "Worker", "SharedWorker", "process", "Buffer"].includes(node.text)) errors.push("browser capability");
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) errors.push("dynamic import");
      if (node.expression.getText(file) === "fetch" && name !== "transport.ts") errors.push("fetch outside transport");
    }
    if (name !== "validate.ts") {
      if (ts.isPropertyAssignment(node) && semantics.has(node.name.getText(file))) errors.push("constructing derived field");
      if (ts.isBinaryExpression(node)) {
        const text = node.getText(file);
        const nullCheck = /^(.*)\s*(===|!==|==|!=)\s*(null|undefined)$/.test(text);
        const kindCheck = ts.isPropertyAccessExpression(node.left) && node.left.name.text === "kind" && ts.isStringLiteral(node.right);
        const fallback = node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && (node.right.kind === ts.SyntaxKind.NullKeyword || (ts.isStringLiteral(node.right) && ["未提供 CI 信号", "未报告原因"].includes(node.right.text)));
        const assignment = node.operatorToken.kind === ts.SyntaxKind.EqualsToken;
        if (assignment && ts.isPropertyAccessExpression(node.left) && semantics.has(node.left.name.text)) errors.push("assigning derived field");
        if (isSensitive(node) && !nullCheck && !kindCheck && !fallback && !assignment) errors.push(`source computation: ${text}`);
      }
      if (ts.isPropertyAccessExpression(node) && ["anomalies", "evidence"].includes(node.name.text)) errors.push("anomaly/evidence consumption");
      if (ts.isReturnStatement(node) && node.expression && ts.isStringLiteral(node.expression) && ["review", "coding", "approved_current_head", "degraded", "healthy"].includes(node.expression.text)) errors.push("returning domain conclusion");
    }
    ts.forEachChild(node, visit);
  }; visit(file);
  if (name === "transport.ts") {
    const calls: ts.CallExpression[] = [];
    const scan = (n: ts.Node) => { if (ts.isCallExpression(n) && n.expression.getText(file) === "fetch") calls.push(n); ts.forEachChild(n, scan); }; scan(file);
    if (calls.length !== 1 || calls[0]?.arguments[0]?.getText(file) !== '"/api/operations/snapshot"') errors.push("fixed endpoint");
    const options = calls[0]?.arguments[1];
    if (!options || !ts.isObjectLiteralExpression(options)) errors.push("fixed GET options");
    else for (const [key, value] of [["method", "GET"], ["cache", "no-store"], ["redirect", "error"]]) {
      if (!options.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText(file) === key && ts.isStringLiteral(p.initializer) && p.initializer.text === value)) errors.push(`fixed ${key}`);
    }
  }
  return errors;
}
