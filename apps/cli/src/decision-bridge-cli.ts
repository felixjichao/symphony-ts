import { DecisionBridge } from "@symphony/decision";

export interface DecisionBridgeCliIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  readonly on?: ((event: string, listener: (...args: unknown[]) => void) => unknown) | undefined;
  readonly removeListener?: ((event: string, listener: (...args: unknown[]) => void) => unknown) | undefined;
}

export interface DecisionBridgeParsedArgs {
  readonly storeDir?: string | undefined;
  readonly port?: number | undefined;
  readonly authToken?: string | undefined;
  readonly ttlSeconds?: number | undefined;
  readonly help?: boolean | undefined;
}

export function parseDecisionBridgeArgs(argv: readonly string[]): DecisionBridgeParsedArgs {
  let storeDir: string | undefined;
  let port: number | undefined;
  let authToken: string | undefined;
  let ttlSeconds: number | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "--store") {
      const next = argv[++i];
      if (next !== undefined && !next.startsWith("-")) {
        storeDir = next;
      }
    } else if (arg === "--port") {
      const next = argv[++i];
      if (next !== undefined && /^\d+$/.test(next)) {
        port = Number(next);
      }
    } else if (arg === "--token") {
      const next = argv[++i];
      if (next !== undefined && !next.startsWith("-")) {
        authToken = next;
      }
    } else if (arg === "--ttl") {
      const next = argv[++i];
      if (next !== undefined && /^\d+$/.test(next)) {
        ttlSeconds = Number(next);
      }
    }
  }

  return { storeDir, port, authToken, ttlSeconds, help };
}

export async function runDecisionBridgeCli(
  argv: readonly string[],
  io: DecisionBridgeCliIo = process,
  options: { stopSignal?: Promise<void> } = {}
): Promise<number> {
  const parsed = parseDecisionBridgeArgs(argv);

  if (parsed.help) {
    io.stdout.write(
      "Usage: symphony decision bridge --store <dir> [options]\n\n" +
      "Options:\n" +
      "  --store <dir>      Path to durable decision store directory (required)\n" +
      "  --port <port>      Loopback port to bind (default: 4040)\n" +
      "  --token <token>    Bearer authorization token (optional, or DECISION_BRIDGE_TOKEN env)\n" +
      "  --ttl <seconds>    Default task claim TTL in seconds (default: 120)\n" +
      "  -h, --help         Show this help message\n"
    );
    return 0;
  }

  if (!parsed.storeDir || parsed.storeDir.trim() === "") {
    io.stderr.write("Error: missing required argument --store <dir>\n");
    return 1;
  }

  const token = parsed.authToken ?? process.env.DECISION_BRIDGE_TOKEN;

  let bridge: DecisionBridge;
  try {
    bridge = new DecisionBridge({
      storeDir: parsed.storeDir,
      port: parsed.port ?? 4040,
      host: "127.0.0.1",
      authToken: token,
      defaultClaimTtlMs: parsed.ttlSeconds !== undefined ? parsed.ttlSeconds * 1000 : undefined,
    });
  } catch (err: unknown) {
    io.stderr.write(`Failed to configure decision bridge: ${(err as Error).message}\n`);
    return 1;
  }

  try {
    const { host, port } = await bridge.start();
    io.stdout.write(`Decision bridge listening on http://${host}:${port} (store: ${parsed.storeDir})\n`);

    let finish!: () => void;
    const shutdownPromise = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const cleanup = async () => {
      try {
        await bridge.stop();
        io.stdout.write("Decision bridge stopped gracefully\n");
      } catch (err: unknown) {
        io.stderr.write(`Error during bridge shutdown: ${(err as Error).message}\n`);
      }
      finish();
    };

    const sigintHandler = () => { void cleanup(); };
    const sigtermHandler = () => { void cleanup(); };

    if (io.on) {
      io.on("SIGINT", sigintHandler);
      io.on("SIGTERM", sigtermHandler);
    } else {
      process.once("SIGINT", sigintHandler);
      process.once("SIGTERM", sigtermHandler);
    }

    if (options.stopSignal) {
      void options.stopSignal.then(() => cleanup());
    }

    await shutdownPromise;

    if (io.removeListener) {
      io.removeListener("SIGINT", sigintHandler);
      io.removeListener("SIGTERM", sigtermHandler);
    }

    return 0;
  } catch (err: unknown) {
    io.stderr.write(`Failed to start decision bridge: ${(err as Error).message}\n`);
    try {
      await bridge.stop();
    } catch {
      // Best-effort
    }
    return 1;
  }
}
