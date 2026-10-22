/** Restricted presentation language guard, not a proof of arbitrary JS semantics. */
import ts from "typescript";
const sensitive = /\b(ci|review|pullRequest|task|result|outcome|target|headSha|anomalies|evidence|execution|planning)\b/;
const globalMembers: Record<string, readonly string[]> = {
  window: ["location", "addEventListener", "removeEventListener"],
  globalThis: [], self: [],
};
function referenceName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return undefined;
}
function isNullOrKindTest(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return isNullOrKindTest(node.expression);
  if (!ts.isBinaryExpression(node)) return false;
  if (![ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) return false;
  if (node.right.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node.right) && node.right.text === "undefined")) return true;
  return ts.isPropertyAccessExpression(node.left) && node.left.name.text === "kind" && ts.isStringLiteral(node.right) && node.right.text === "review";
}
const semantics = new Set(["phase", "attention", "health", "approval", "reason", "degradedWork", "anomalyCount"]);
export function browserErrors(name: string, source: string): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const errors: string[] = [];
  const tainted = new Set<string>();
  const isSensitive = (node: ts.Node): boolean => sensitive.test(node.getText(file)) || [...tainted].some(v => new RegExp(`\\b${v}\\b`).test(node.getText(file)));
  // Reach a fixed point over bindings, including destructuring and later writes.
  const markBinding = (binding: ts.BindingName) => {
    if (ts.isIdentifier(binding)) tainted.add(binding.text);
    else for (const element of binding.elements) if (ts.isBindingElement(element)) markBinding(element.name);
  };
  let previousSize = -1;
  while (previousSize !== tainted.size) {
    previousSize = tainted.size;
    const propagate = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer && isSensitive(node.initializer)) markBinding(node.name);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && isSensitive(node.right)) tainted.add(node.left.text);
      ts.forEachChild(node, propagate);
    };
    propagate(file);
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
    // Capability references are allowed only at the fixed transport invocation.
    // Reject at binding creation, so aliases/destructuring/bind/call cannot escape.
    if (referenceName(node) === "fetch") {
      if (!(name === "transport.ts" && ts.isIdentifier(node) && ts.isCallExpression(node.parent) && node.parent.expression === node)) errors.push("fetch capability reference outside fixed invocation");
    }
    if (ts.isIdentifier(node) && Object.hasOwn(globalMembers, node.text)) {
      const parent = node.parent;
      if (!(ts.isPropertyAccessExpression(parent) && parent.expression === node && globalMembers[node.text]?.includes(parent.name.text))) errors.push("global capability binding/access");
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "defaultView") errors.push("browser global capability alias");
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) errors.push("dynamic import");
      if (node.expression.getText(file) === "fetch" && name !== "transport.ts") errors.push("fetch outside transport");
    }
    if (name !== "validate.ts") {
      if (name === "view.ts" && ts.isFunctionDeclaration(node) && !["el", "reviewDetails", "workTable", "mount"].includes(node.name?.text ?? "")) errors.push("unregistered presentation helper");
      if (name === "view.ts" && ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && node.name.getText(file) !== "locate") errors.push("unregistered presentation callback");
      const condition = ts.isConditionalExpression(node) ? node.condition : ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) ? node.expression : ts.isForStatement(node) ? node.condition : ts.isSwitchStatement(node) ? node.expression : undefined;
      if (condition && isSensitive(condition) && !isNullOrKindTest(condition)) errors.push("source-dependent control flow");
      if (ts.isPrefixUnaryExpression(node) && isSensitive(node.operand) && !isNullOrKindTest(node.operand)) errors.push("source truthiness/computation");
      if (ts.isCallExpression(node) && (node.arguments.some(isSensitive) || isSensitive(node.expression)) && !["el", "JSON.stringify", "details.append", "row.append", "reviewCell.append"].includes(node.expression.getText(file))) errors.push("source passed to unapproved helper");
      if (ts.isReturnStatement(node) && node.expression && isSensitive(node.expression)) errors.push("returning source-derived value");
      if (ts.isPropertyAssignment(node) && semantics.has(node.name.getText(file))) errors.push("constructing derived field");
      if (ts.isBinaryExpression(node)) {
        const text = node.getText(file);
        const nullCheck = isNullOrKindTest(node);
        const kindCheck = ts.isPropertyAccessExpression(node.left) && node.left.name.text === "kind" && ts.isStringLiteral(node.right);
        const fallback = node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && (node.right.kind === ts.SyntaxKind.NullKeyword || (ts.isStringLiteral(node.right) && ["未提供 CI 信号", "未报告原因"].includes(node.right.text)));
        const assignment = node.operatorToken.kind === ts.SyntaxKind.EqualsToken;
        if (assignment && ts.isPropertyAccessExpression(node.left) && semantics.has(node.left.name.text)) errors.push("assigning derived field");
        if (isSensitive(node) && !nullCheck && !kindCheck && !fallback && !assignment) errors.push(`source computation: ${text}`);
      }
      if ((ts.isPropertyAccessExpression(node) && ["anomalies", "evidence"].includes(node.name.text)) || (ts.isElementAccessExpression(node) && ["anomalies", "evidence"].includes(referenceName(node.argumentExpression) ?? ""))) errors.push("anomaly/evidence consumption");
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
    else {
      const keys = options.properties.map(p => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) ? p.name.getText(file) : "<spread/computed>");
      if (keys.length !== 4 || new Set(keys).size !== 4 || keys.some(k => !["method", "cache", "redirect", "signal"].includes(k))) errors.push("closed transport options");
    }
    if (options && ts.isObjectLiteralExpression(options)) for (const [key, value] of [["method", "GET"], ["cache", "no-store"], ["redirect", "error"]]) {
      if (!options.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText(file) === key && ts.isStringLiteral(p.initializer) && p.initializer.text === value)) errors.push(`fixed ${key}`);
    }
  }
  return errors;
}
