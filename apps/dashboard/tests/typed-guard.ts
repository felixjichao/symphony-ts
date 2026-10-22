import ts from "typescript";
/** Reject constructing authoritative projection values even through typed aliases. */
export function projectionWrites(program: ts.Program, browserRoot: string): string[] {
  const checker = program.getTypeChecker(); const errors: string[] = [];
  const forbidden = /^(WorkProjection|OperationalSnapshot|OperationalSnapshotSummary|ReviewProjection|WorkWaiting)$/;
  for (const file of program.getSourceFiles().filter(f => f.fileName.startsWith(browserRoot) && !f.isDeclarationFile)) {
    const walk = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const type = checker.getContextualType(node);
        if (type && (forbidden.test(type.aliasSymbol?.name ?? "") || forbidden.test(type.getSymbol()?.name ?? ""))) errors.push(`${file.fileName}: constructing ${checker.typeToString(type)}`);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
        const owner = checker.getTypeAtLocation(node.left.expression);
        if (forbidden.test(owner.aliasSymbol?.name ?? "") || forbidden.test(owner.getSymbol()?.name ?? "")) errors.push("projection write");
      }
      ts.forEachChild(node, walk);
    }; walk(file);
  }
  return errors;
}
