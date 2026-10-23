import ts from "typescript";
/** Reject constructing authoritative projection values even through typed aliases. */
export function projectionWrites(program: ts.Program, browserRoot: string): string[] {
  const checker = program.getTypeChecker(); const errors: string[] = [];
  const businessTypes = /^(WorkPhase|WaitingReason|AttentionState|SystemHealth|ReviewApprovalState|SourceFreshnessStatus|OperationalAnomalyCode|OperationalAnomalySeverity)$/;
  const businessLiterals = new Set(["planning", "ready", "coding", "ci", "review", "repair", "landing", "completed", "unknown", "normal", "waiting", "degraded", "needs_human", "failed", "healthy", "unavailable", "approved_current_head", "approved_stale_head", "changes_requested", "pending", "not_approved", "waiting_for_ci", "waiting_for_review", "waiting_for_plan", "waiting_for_executor", "retry_backoff", "needs_clarification", "blocked_by_dependency", "fresh", "stale", "warning", "error", "review_target_head_mismatch", "review_approval_head_mismatch", "review_result_target_mismatch", "execution_on_terminal_work", "decision_active_task_without_session", "decision_active_task_on_completed_session", "decision_result_without_task", "conflicting_active_review_tasks"]);
  const forbidden = /^(WorkProjection|OperationalSnapshot|OperationalSnapshotSummary|ReviewProjection|WorkWaiting|SourceFreshness|FreshSourceFreshness|StaleSourceFreshness|UnavailableSourceFreshness|UnknownSourceFreshness|OperationalAnomaly|ProjectionEvidence)$/;
  const protectedType = (type: ts.Type): boolean => forbidden.test(type.aliasSymbol?.name ?? "") || forbidden.test(type.getSymbol()?.name ?? "") || (type.isUnion() && type.types.some(protectedType));
  for (const file of program.getSourceFiles().filter(f => f.fileName.startsWith(browserRoot) && !f.isDeclarationFile)) {
    const walk = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
        const signature = checker.getSignatureFromDeclaration(node);
        if (signature) {
          const result = checker.getReturnTypeOfSignature(signature);
          const members = result.isUnion() ? result.types : [result];
          const conclusions = members.length > 0 && members.every(t => t.isStringLiteral() && businessLiterals.has(t.value));
          if (businessTypes.test(result.aliasSymbol?.name ?? "") || conclusions) errors.push("helper returns domain conclusion");
        }
      }
      if (ts.isObjectLiteralExpression(node)) {
        const type = checker.getContextualType(node);
        if (type && protectedType(type)) errors.push(`${file.fileName}: constructing ${checker.typeToString(type)}`);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
        const owner = checker.getTypeAtLocation(node.left.expression);
        if (protectedType(owner)) errors.push("projection write");
      }
      ts.forEachChild(node, walk);
    }; walk(file);
  }
  return errors;
}
