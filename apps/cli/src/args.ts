import path from "node:path";
import { parseStatusWork, type StatusOptions } from "./status";

export interface ParsedCliArgs {
  readonly subcommand?: "recovery" | "repo-bootstrap" | "delivery" | "delivery-skill" | "dogfood" | "decision-bridge" | "plan" | undefined;
  readonly subcommandArgs?: readonly string[] | undefined;
  readonly status?: StatusOptions | undefined;
  readonly workflowPath?: string | undefined;
  readonly enablePlanning?: boolean | undefined;
  readonly decisionStoreDir?: string | undefined;
  readonly decisionBridgeUrl?: string | undefined;
  readonly decisionBridgeToken?: string | undefined;
  readonly help?: boolean | undefined;
  readonly version?: boolean | undefined;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  if (argv.length > 0) {
    const first = argv[0];
    if (first === "recovery") return { subcommand: "recovery", subcommandArgs: argv.slice(1) };
    if (first === "plan" || first === "planning") {
      return {
        subcommand: "plan",
        subcommandArgs: argv.slice(1),
      };
    }
    if (first === "decision" && argv[1] === "plan") {
      return {
        subcommand: "plan",
        subcommandArgs: argv.slice(2),
      };
    }
    if (first === "decision" && argv[1] === "bridge") {
      return {
        subcommand: "decision-bridge",
        subcommandArgs: argv.slice(2),
      };
    }
    if (first === "decision-bridge") {
      return {
        subcommand: "decision-bridge",
        subcommandArgs: argv.slice(1),
      };
    }
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
    if (first === "dogfood") {
      return {
        subcommand: "dogfood",
        subcommandArgs: argv.slice(1),
      };
    }
    if (first === "pr" || first === "delivery") {
      return {
        subcommand: "delivery",
        subcommandArgs: argv.slice(1),
      };
    }
  }


  let workflowPath: string | undefined;
  let enablePlanning: boolean | undefined;
  let decisionStoreDir: string | undefined;
  let decisionBridgeUrl: string | undefined;
  let decisionBridgeToken: string | undefined;
  let statusEnabled = false;
  let statusPort: number | undefined;
  const statusWork: ReturnType<typeof parseStatusWork>[] = [];
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--status") {
      statusEnabled = true;
    } else if (arg === "--status-port" || arg === "--status-work") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new TypeError(`Missing ${arg} value`);
      if (arg === "--status-work") statusWork.push(parseStatusWork(value));
      else {
        if (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) > 65535) throw new TypeError("Invalid status port");
        statusPort = Number(value);
      }
    } else if (arg.startsWith("--status")) {
      throw new TypeError("Unknown status option");
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else if (arg === "--enable-planning" || arg === "--planning") {
      enablePlanning = true;
    } else if (arg === "--no-planning") {
      enablePlanning = false;
    } else if (arg === "--decision-store" && i + 1 < argv.length) {
      decisionStoreDir = argv[++i];
    } else if (arg === "--decision-bridge-url" && i + 1 < argv.length) {
      decisionBridgeUrl = argv[++i];
    } else if (arg === "--decision-bridge-token" && i + 1 < argv.length) {
      decisionBridgeToken = argv[++i];
    } else if (!arg.startsWith("-")) {
      if (workflowPath === undefined) {
        workflowPath = arg;
      }
    }
  }

  if (!statusEnabled && (statusPort !== undefined || statusWork.length)) throw new TypeError("Status options require --status");
  return {
    ...(statusEnabled ? { status: { workKeys: statusWork, ...(statusPort === undefined ? {} : { port: statusPort }) } } : {}),
    ...(workflowPath !== undefined ? { workflowPath } : {}),
    ...(enablePlanning !== undefined ? { enablePlanning } : {}),
    ...(decisionStoreDir !== undefined ? { decisionStoreDir } : {}),
    ...(decisionBridgeUrl !== undefined ? { decisionBridgeUrl } : {}),
    ...(decisionBridgeToken !== undefined ? { decisionBridgeToken } : {}),
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
