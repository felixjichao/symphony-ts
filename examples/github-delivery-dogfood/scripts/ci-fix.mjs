// Real Codex repair entry for the delivery dogfood.
//
// The delivery skill invokes this with the failing-check diagnostics in
// SYMPHONY_CI_FAILURE_DIAGNOSTICS. A bounded non-interactive Codex session fixes
// the code. It must not touch the CI workflow or delete tests; the delivery
// skill re-runs validation and only consumes CI after a new commit/SHA.
import { spawnSync } from "node:child_process";

const diagnostics = process.env.SYMPHONY_CI_FAILURE_DIAGNOSTICS ?? "";
if (diagnostics.trim() === "") {
  console.error("ci:fix: no SYMPHONY_CI_FAILURE_DIAGNOSTICS provided");
  process.exit(1);
}

const prompt = [
  "The repository's CI failed. Fix the underlying code so CI passes.",
  "Do not modify .github/workflows/* or delete/weaken tests to hide the failure.",
  "After fixing, run `npm test` and `npm run lint` locally.",
  "",
  "CI failure diagnostics:",
  diagnostics,
].join("\n");

const result = spawnSync(
  "codex",
  ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", prompt],
  { stdio: "inherit", env: process.env },
);

if (result.error) {
  console.error(`ci:fix: failed to launch codex: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
