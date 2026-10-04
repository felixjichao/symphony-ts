// CI-only lint gate: rejects console.log in src/. The local `gate` script runs
// only the unit tests, so a src/ file with console.log passes locally but fails
// CI — the deterministic fault the repair scenario relies on.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const srcDir = path.resolve(process.cwd(), "src");
const offenders = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      const lines = readFileSync(full, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (line.includes("console.log(")) {
          offenders.push(`${path.relative(process.cwd(), full)}:${index + 1}: console.log is not allowed in src/`);
        }
      });
    }
  }
}

walk(srcDir);

if (offenders.length > 0) {
  console.error("lint failed:");
  for (const offender of offenders) console.error(`  ${offender}`);
  process.exit(1);
}
console.log("lint ok");
