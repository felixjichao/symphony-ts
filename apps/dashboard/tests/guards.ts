/** Restricted presentation language guard, not a proof of arbitrary JS semantics. */
import ts from "typescript";
const sensitive = /\b(ci|review|pullRequest|task|result|outcome|target|headSha|anomalies|evidence|execution|planning|freshness|freshnessStatus|observedAt|lastAttemptAt|field|value|role|ruleId|severity|code)\b/;
const globalMembers: Record<string, readonly string[]> = {
  window: ["location", "addEventListener", "removeEventListener"],
  globalThis: [], self: [],
};
function referenceName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = referenceName(node.left), right = referenceName(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}
function isNullOrKindTest(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return isNullOrKindTest(node.expression);
  if (!ts.isBinaryExpression(node)) return false;
  if (![ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) return false;
  if (node.right.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node.right) && node.right.text === "undefined")) return true;
  return ts.isPropertyAccessExpression(node.left) && node.left.name.text === "kind" && ts.isStringLiteral(node.right) && node.right.text === "review";
}
const semantics = new Set(["phase", "attention", "health", "approval", "reason", "degradedWork", "anomalyCount", "freshnessStatus", "severity", "code"]);
export function browserErrors(name: string, source: string): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const errors: string[] = [];
  const tainted = new Set<string>();
  const isSensitive = (node: ts.Node): boolean => {
    let found = false;
    const read = (part: ts.Node) => {
      if (ts.isFunctionExpression(part) || ts.isArrowFunction(part) || ts.isMethodDeclaration(part)) return;
      if (ts.isIdentifier(part) && (sensitive.test(part.text) || tainted.has(part.text))) {
        const domValue = name === "explorer.ts" && part.text === "value" && ts.isPropertyAccessExpression(part.parent) && part.parent.name === part && /^(input|search|scopeFilter|phase|attention|github|runtime|decision)$/.test(part.parent.expression.getText(file));
        if (!domValue) found = true;
      }
      if (ts.isElementAccessExpression(part) && sensitive.test(referenceName(part.argumentExpression) ?? "")) found = true;
      ts.forEachChild(part, read);
    };
    read(node); return found;
  };
  // Reach a fixed point over bindings, including destructuring and later writes.
  const markBinding = (binding: ts.BindingName) => {
    if (ts.isIdentifier(binding)) tainted.add(binding.text);
    else for (const element of binding.elements) if (ts.isBindingElement(element)) markBinding(element.name);
  };
  let previousSize = -1;
  while (previousSize !== tainted.size) {
    previousSize = tainted.size;
    const propagate = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer && (isSensitive(node.name) || !(ts.isCallExpression(node.initializer) && ["el", "workDetail", "evidenceList", "anomalyCards", "anomalySummary"].includes(node.initializer.expression.getText(file))) && isSensitive(node.initializer))) markBinding(node.name);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && isSensitive(node.right)) tainted.add(node.left.text);
      ts.forEachChild(node, propagate);
    };
    propagate(file);
  }
  const visit = (node: ts.Node) => {
    if (name === "primitives.ts" && ts.isIdentifier(node) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) && /^(ci|review|pullRequest|task|result|outcome|target|headSha|anomalies|evidence|execution|planning|phase|waiting|health|approval|severity|observedAt|lastAttemptAt)$/.test(node.text)) errors.push("lower-level fact/conclusion in primitive");

    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier)) {
        const value = specifier.text;
        if (!value.startsWith("./") && !(value === "@symphony/operations" && ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)) errors.push("browser import boundary");
        if (value.startsWith("./") && !/^\.\/(identity|presentation|transport|validate|polling|view|dom|detail|evidence|anomaly|routing|primitives|overview|explorer|style\.css)$/.test(value)) errors.push("unapproved local module");
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
    // Only this reviewed selection predicate may compare supplied freshness for filtering.
    const filterPredicate = '(!query || [w.key.provider, w.key.key, w.workItem.identifier, w.workItem.title ?? ""].some(v => v.toLocaleLowerCase().includes(query))) && (!scopeFilter.value || (w.key.provider === scopeFilter.value || scope(w) === scopeFilter.value)) && (!phase.value || w.phase === phase.value) && (!attention.value || w.attention === attention.value) && (!github.value || w.freshness.github.status === github.value) && (!runtime.value || w.freshness.runtime.status === runtime.value) && (!decision.value || w.freshness.decision.status === decision.value)';
    let ancestor: ts.Node | undefined = node;
    while (ancestor && !(ts.isArrowFunction(ancestor) && ancestor.body.getText(file) === filterPredicate)) ancestor = ancestor.parent;
    const selection = name === "explorer.ts" && ancestor !== undefined;
    if (!["validate.ts", "identity.ts", "presentation.ts"].includes(name)) {
      // These shape/identity/format helpers are separately fingerprinted, never arbitrary extensions.
      const registered: Record<string, readonly string[]> = { "primitives.ts": ["attentionBadge", "freshnessIndicator", "presentationState", "workIdentity", "shaIdentity", "surface", "denseTable", "denseList", "searchControl", "filterControl"], "detail.ts": ["workDetail", "rows", "card", "sourceLink"], "evidence.ts": ["evidenceList"], "anomaly.ts": ["anomalyCards", "anomalySummary"], "overview.ts": ["overview"], "dom.ts": ["el"] };
      if (registered[name] && ts.isFunctionDeclaration(node) && !registered[name]?.includes(node.name?.text ?? "")) errors.push("unregistered presentation helper");
      if (name === "view.ts" && ts.isFunctionDeclaration(node) && !["el", "reviewDetails", "workTable", "mount"].includes(node.name?.text ?? "")) errors.push("unregistered presentation helper");
      if (name === "view.ts" && ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && node.name.getText(file) !== "locate" && node.name.getText(file) !== "navigate") errors.push("unregistered presentation callback");
      const condition = ts.isConditionalExpression(node) ? node.condition : ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) ? node.expression : ts.isForStatement(node) ? node.condition : ts.isSwitchStatement(node) ? node.expression : undefined;
      if (condition && isSensitive(condition) && !isNullOrKindTest(condition)) errors.push(`source-dependent control flow: ${condition.getText(file)}`);
      if (!selection && ts.isPrefixUnaryExpression(node) && isSensitive(node.operand) && !isNullOrKindTest(node.operand)) errors.push("source truthiness/computation");
      if (!selection && ts.isCallExpression(node) && (node.arguments.some(isSensitive) || isSensitive(node.expression)) && !["el", "rows", "card", "sourceLink", "list.append", "conclusion.append", "grid.append", "prCard.append", "JSON.stringify", "details.append", "row.append", "reviewCell.append", "section.append", "card.append", "fields.append", "raw.append", "evidenceList", "anomalyCards", "anomalySummary", "scopedEvidence", "scopedAnomalies", "evidenceGroups", "diagnosticIds", "entries.map", "selected.map", "entries.entries", "selected.entries", "overviewGroups", "renderOverview", "context.append", "globalSources", "scopedSources", "scopedExecutors", "freshness", "timestamp", "attentionBadge", "shaIdentity", "freshnessIndicator", "Object.entries", "String", "page.append", "counts.append", "sources.append", "executors.append", "item.append", "main.replaceChildren"].includes(node.expression.getText(file)) && !(name === "explorer.ts" && node.expression.getText(file) === "identity.append")) errors.push(`source passed to unapproved helper: ${node.getText(file)}`);
      if (ts.isReturnStatement(node) && node.expression && isSensitive(node.expression)) errors.push(`returning source-derived value: ${node.expression.getText(file)}`);
      if (ts.isPropertyAssignment(node) && semantics.has(node.name.getText(file))) errors.push("constructing derived field");
      if (ts.isBinaryExpression(node)) {
        const text = node.getText(file);
        const nullCheck = isNullOrKindTest(node);
        const kindCheck = ts.isPropertyAccessExpression(node.left) && node.left.name.text === "kind" && ts.isStringLiteral(node.right);
        const fallback = node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && (node.right.kind === ts.SyntaxKind.NullKeyword || ts.isArrayLiteralExpression(node.right) && node.right.elements.length === 0 || ts.isStringLiteral(node.right) && ["未提供 CI 信号", "未报告原因", "detail 未提供", "未报告角色", "未报告标题"].includes(node.right.text) || name === "explorer.ts" && ts.isStringLiteral(node.right) && node.right.text === "未知");
        const assignment = node.operatorToken.kind === ts.SyntaxKind.EqualsToken;
        if (assignment && ts.isPropertyAccessExpression(node.left) && semantics.has(node.left.name.text)) errors.push("assigning derived field");
        if (!selection && isSensitive(node) && !nullCheck && !kindCheck && !fallback && !assignment) errors.push(`source computation: ${text}`);
      }
      if ((ts.isPropertyAccessExpression(node) && ["anomalies", "evidence"].includes(node.name.text)) || (ts.isElementAccessExpression(node) && ["anomalies", "evidence"].includes(referenceName(node.argumentExpression) ?? ""))) {
        // Only direct reads at reviewed renderer selection calls are allowed.
        const parent = node.parent;
        const permitted = ts.isCallExpression(parent) && ["evidenceList", "anomalyCards", "anomalySummary"].includes(parent.expression.getText(file));
        const optionalEvidence = ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && ts.isArrayLiteralExpression(parent.right) && parent.right.elements.length === 0 && ts.isCallExpression(parent.parent) && parent.parent.expression.getText(file) === "evidenceList";
        if (!permitted && !optionalEvidence) errors.push("anomaly/evidence consumption");
      }
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
