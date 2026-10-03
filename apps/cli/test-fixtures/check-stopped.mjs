// after_run world assertion: always write an explicit result for the parent test.
import fs from "node:fs";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
const world = JSON.parse(fs.readFileSync("world.json", "utf8"));
let dead = false;
try { process.kill(world.pid, 0); } catch (error) { dead = error.code === "ESRCH"; }
fs.writeFileSync("after-run-entered", "entered");
const release = process.argv[2];
while (release && !fs.existsSync(release)) await setTimeout(10);
fs.writeFileSync("after-run.json", JSON.stringify({ pid: world.pid, cwd: process.cwd(), dead }));
if (!dead) process.exitCode = 1;
