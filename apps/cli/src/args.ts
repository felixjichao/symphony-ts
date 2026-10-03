import path from "node:path";

export interface ParsedCliArgs {
  readonly workflowPath?: string | undefined;
  readonly help?: boolean | undefined;
  readonly version?: boolean | undefined;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  let workflowPath: string | undefined;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else if (!arg.startsWith("-")) {
      if (workflowPath === undefined) {
        workflowPath = arg;
      }
    }
  }

  return {
    ...(workflowPath !== undefined ? { workflowPath } : {}),
    ...(help ? { help: true } : {}),
    ...(version ? { version: true } : {}),
  };
}

export function resolveWorkflowPath(rawPath?: string | undefined, cwd: string = process.cwd()): string {
  if (rawPath !== undefined && rawPath.trim() !== "") {
    return path.resolve(cwd, rawPath);
  }
  return path.resolve(cwd, "WORKFLOW.md");
}
