// Supplemental shell exit-code evidence only; not the production executable.
import { runCli } from "../src/index";
const phase = process.argv[2];
let fatal!: (error: unknown) => void;
const failure = new Promise<unknown>((resolve) => { fatal = resolve; });
let timer: ReturnType<typeof setInterval>;
process.exitCode = await runCli([], { createHost: async () => ({
  failure,
  async start() {
    timer = setInterval(() => {}, 1000);
    process.stdout.write("harness-ready\n");
    if (phase === "startup") throw new Error("injected startup fault");
    if (phase === "fatal") fatal(new Error("injected lifecycle fault"));
    if (phase === "uncaught") setImmediate(() => { throw new Error("injected uncaught fault"); });
    if (phase === "rejection") void Promise.reject(new Error("injected rejection"));
  },
  async stop() {
    clearInterval(timer);
    if (phase === "shutdown") throw new Error("injected shutdown fault");
  },
}) });
