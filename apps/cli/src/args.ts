import path from "node:path";

export interface ParsedCliArgs {
  readonly subcommand?: "repo-bootstrap" | "delivery-skill" | undefined;
  readonly subcommandArgs?: readonly string[] | undefined;
  readonly workflowPath?: string | undefined;
  readonly help?: boolean | undefined;
  readonly version?: boolean | undefined;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  if (argv.length > 0) {
    const first = argv[0];
    if (first === "repo-bootstrap" || first === "bootstrap-repo") {
      return {
        subcommand: "repo-bootstrap",
        subcommandArgs: argv.slice(1),
      };
    }
    if (first === "workspace" && argv[1] === "bootstrap") {
      return {
        subcommand: "repo-bootstrap",
        subcommandArgs: argv.slice(2),
      };
    }
    if (first === "delivery-skill") {
      return {
        subcommand: "delivery-skill",
        subcommandArgs: argv.slice(1),
      };
    }
    if (first === "delivery" && argv[1] === "skill") {
      return {
        subcommand: "delivery-skill",
        subcommandArgs: argv.slice(2),
      };
    }
  }


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
