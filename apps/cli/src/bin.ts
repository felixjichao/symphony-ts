import pkg from "../package.json";
import { parseCliArgs } from "./args";
import { createHost } from "./host";

function printUsage(): void {
  process.stdout.write(`Usage: symphony [workflow-path]

Options:
  -h, --help     Show this help message
  -v, --version  Show version information
`);
}

function printVersion(): void {
  process.stdout.write(`${pkg.version}\n`);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const { workflowPath, help, version } = parseCliArgs(argv);

  if (help) {
    printUsage();
    process.exit(0);
  }

  if (version) {
    printVersion();
    process.exit(0);
  }

  try {
    const host = await createHost(workflowPath !== undefined ? { workflowPath } : {});

    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void host.stop().then(() => {
        process.exit(0);
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`symphony: shutdown error: ${msg}\n`);
        process.exit(1);
      });
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await host.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`symphony: error: ${message}\n`);
    process.exit(1);
  }
}

void main();
