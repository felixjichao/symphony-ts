/** Executable lifecycle (SPEC §17.7 / §18.1). Host owns resources; shell owns signals/status. */
import pkg from "../package.json";
import { runRepositoryBootstrapCli } from "@symphony/workspace";
import { parseCliArgs, resolveWorkflowPath } from "./args";
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
    if (args.subcommand === "repo-bootstrap") {
      return await runRepositoryBootstrapCli(args.subcommandArgs ?? [], {
        stdout: shell.stdout,
        stderr: shell.stderr,
      });
    }
    if (args.help) {
      shell.stdout.write(
        "Usage: symphony [workflow-path]\n" +
        "       symphony repo-bootstrap --repo <url> [options]\n" +
        "       symphony workspace bootstrap --repo <url> [options]\n\n" +
        "Commands:\n" +
        "  repo-bootstrap       Bootstrap git repository in workspace and create issue branch\n" +
        "  workspace bootstrap  Alias for repo-bootstrap\n\n" +
        "Options:\n" +
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
    host = await (options.createHost ?? createHost)({ ...options.hostOptions, workflowPath });
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
