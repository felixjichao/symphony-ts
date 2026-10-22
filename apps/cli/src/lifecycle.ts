import { runRecoveryCli } from "./recovery-cli";
/** Executable lifecycle (SPEC §17.7 / §18.1). Host owns resources; shell owns signals/status. */
import pkg from "../package.json";
import { runRepositoryBootstrapCli } from "@symphony/workspace";
import { runDeliveryCli } from "./delivery-cli";
import { parseCliArgs, resolveWorkflowPath } from "./args";
import { runDeliverySkillCli } from "./delivery-skill-cli";
import { runGithubDogfoodCli } from "./dogfood";
import { runDecisionBridgeCli } from "./decision-bridge-cli";
import { runPlanningCli } from "./planning-cli";
import { createHost, type CreateHostOptions, type SymphonyHost } from "./host";

export interface LifecycleProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

export interface RunCliOptions {
  readonly process?: LifecycleProcess;
  readonly hostOptions?: CreateHostOptions;
  /** Resource boundary for shell fault tests; executable always uses createHost. */
  readonly createHost?: (options: CreateHostOptions) => Promise<Pick<SymphonyHost, "start" | "stop" | "failure">>;
}

export async function runCli(argv: readonly string[], options: RunCliOptions = {}): Promise<number> {
  const shell = options.process ?? process;
  let exitCode = 0;
  const fail = (phase: string): void => {
    exitCode = 1;
    // Arbitrary thrown values can contain credentials; structured host diagnostics
    // carry the safe details. Never echo an untrusted exception here.
    try { shell.stderr.write(`symphony: ${phase} failed\n`); } catch { /* Operator sink failure cannot prevent cleanup. */ }
  };
  let host: Pick<SymphonyHost, "start" | "stop" | "failure">;
  try {
    const args = parseCliArgs(argv);
    if (args.subcommand === "recovery") return runRecoveryCli(args.subcommandArgs ?? [], shell);
    if (args.subcommand === "decision-bridge") {
      return await runDecisionBridgeCli(args.subcommandArgs ?? [], {
        stdout: shell.stdout,
        stderr: shell.stderr,
        on: typeof shell.on === "function" ? shell.on.bind(shell) : undefined,
        removeListener: typeof shell.removeListener === "function" ? shell.removeListener.bind(shell) : undefined,
      });
    }
    if (args.subcommand === "repo-bootstrap") {
      return await runRepositoryBootstrapCli(args.subcommandArgs ?? [], {
        stdout: shell.stdout,
        stderr: shell.stderr,
      });
    }
    if (args.subcommand === "delivery-skill") {
      return await runDeliverySkillCli(args.subcommandArgs ?? [], {
        stdout: shell.stdout,
        stderr: shell.stderr,
      });
    }
    if (args.subcommand === "delivery") {
      return await runDeliveryCli(args.subcommandArgs ?? [], {
        stdout: shell.stdout,
        stderr: shell.stderr,
      });
    }
    if (args.subcommand === "dogfood") {
      return await runGithubDogfoodCli(args.subcommandArgs ?? [], {
        stdout: shell.stdout,
        stderr: shell.stderr,
      });
    }
    if (args.subcommand === "plan") {
      return await runPlanningCli(args.subcommandArgs ?? [], {
        stdout: shell.stdout,
        stderr: shell.stderr,
      });
    }
    if (args.help) {
      shell.stdout.write(
        "Usage: symphony [workflow-path]\n" +
        "       symphony recovery list|show|authorize <ledger-file> [incident-id]\n" +
        "       symphony repo-bootstrap --repo <url> [options]\n" +
        "       symphony workspace bootstrap --repo <url> [options]\n" +
        "       symphony delivery-skill [run|halt] [options]\n" +
        "       symphony pr <action> [options]\n" +
        "       symphony dogfood github --target <owner/repo> [options]\n" +
        "       symphony decision bridge --store <dir> [options]\n" +
        "       symphony plan <action> [options]\n\n" +
        "Commands:\n" +
        "  repo-bootstrap       Bootstrap git repository in workspace and create issue branch\n" +
        "  workspace bootstrap  Alias for repo-bootstrap\n" +
        "  delivery-skill       Execute delivery + land workflow skill or halt dispatch\n" +
        "  pr                   GitHub delivery primitives (ensure, read, checks, land, verify)\n" +
        "  dogfood              Opt-in real GitHub + real Codex end-to-end dogfood harness\n" +
        "  decision bridge      Localhost Web Agent Bridge for Decision Plane tasks/sessions\n" +
        "  plan                 Pre-execution planning gate (start, clarify, replan, retry, status, sync)\n\n" +
        "Options:\n" +
        "  --enable-planning       Enable Decision Plane planning gate for dispatch\n" +
        "  --no-planning           Explicitly disable Decision Plane planning gate\n" +
        "  --decision-store <dir>  Path to durable decision store directory\n" +
        "  --decision-bridge-url <url> Decision bridge URL for remote gate checks\n" +
        "  --decision-bridge-token <token> Decision bridge authentication token\n" +
        "  -h, --help           Show this help message\n" +
        "  -v, --version        Show version information\n"
      );
      return 0;
    }

    if (args.version) {
      shell.stdout.write(`${pkg.version}\n`);
      return 0;
    }
    const workflowPath = resolveWorkflowPath(args.workflowPath, options.hostOptions?.cwd);
    host = await (options.createHost ?? createHost)({
      ...options.hostOptions,
      workflowPath,
      ...(args.enablePlanning !== undefined ? { enablePlanning: args.enablePlanning } : {}),
      ...(args.decisionStoreDir !== undefined ? { decisionStoreDir: args.decisionStoreDir } : {}),
      ...(args.decisionBridgeUrl !== undefined ? { decisionBridgeUrl: args.decisionBridgeUrl } : {}),
      ...(args.decisionBridgeToken !== undefined ? { decisionBridgeToken: args.decisionBridgeToken } : {}),
    });
  } catch {
    fail("startup");
    return exitCode;
  }

  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (failed: boolean): Promise<void> => {
    if (failed) fail("lifecycle");
    if (shutdownPromise !== undefined) return shutdownPromise;
    // Assign before invoking the resource boundary, including synchronous throws.
    let settle!: () => void;
    shutdownPromise = new Promise<void>((resolve) => { settle = resolve; });
    void (async () => {
      try { await host.stop(); } catch { fail("shutdown"); }
      finally { finish(); settle(); }
    })();
    return shutdownPromise;
  };
  const signal = (): void => { void shutdown(false); };
  const fatal = (): void => { void shutdown(true); };
  const listeners = [
    ["SIGINT", signal], ["SIGTERM", signal],
    ["uncaughtException", fatal], ["unhandledRejection", fatal],
  ] as const;
  try {
    try {
      for (const [event, listener] of listeners) shell.on(event, listener);
    } catch {
      await shutdown(true);
      return exitCode;
    }
    void host.failure.then(fatal);
    try { await host.start(); } catch { await shutdown(true); }
    await finished;
    await shutdownPromise;
    return exitCode;
  } finally {
    for (const [event, listener] of listeners) shell.removeListener(event, listener);
  }
}
