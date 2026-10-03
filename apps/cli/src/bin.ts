import { runCli } from "./lifecycle";

process.exitCode = await runCli(process.argv.slice(2));
