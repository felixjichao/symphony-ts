import { startDemo } from "./server";
import { demoService, type Scenario } from "./sources";
const args = process.argv.slice(2);
const scenario = args.find(a => a.startsWith("--scenario="))?.slice(11) ?? "populated";
if (!["populated", "empty", "unavailable", "stale", "unknown"].includes(scenario)) throw new Error("Unknown demo scenario");
const demo = await startDemo(demoService(scenario as Scenario), { dev: args.includes("--dev"), port: 4173 });
console.log(`演示数据 · ${demo.url} · ${scenario} · Ctrl-C 关闭`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { if (stopping) return; stopping = true; void demo.stop().then(() => { process.exitCode = 0; }); });
