import { expect, it } from "vitest";
import { runDeliverySkill, type DeliveryGitGhRunner } from "@symphony/agent";
import { formatPrBody } from "@symphony/domain";
import { DefaultDeliveryGitGhRunner } from "./git-gh-runner";

// Explicit opt-in: only branch-rule discovery reads the real GitHub API.
// Git, PRs, classic protection and all mutations remain isolated fixtures.
const repo = process.env["SYMPHONY_TEST_GH_RULES_REPO"];
it.skipIf(!repo)("discovers active rules through the installed gh and reaches CI policy evaluation", async () => {
  const context = { repo: repo!, issueNumber: 80, workspaceKey: "GH-80", headBranch: "symphony/GH-80", baseBranch: "main" };
  const actualRunner = new DefaultDeliveryGitGhRunner();
  let sawRules = false;
  let sawCi = false;
  const runner: DeliveryGitGhRunner = {
    async git(args) {
      return { stdout: args[0] === "branch" ? context.headBranch : args[0] === "remote" ? `https://github.com/${context.repo}.git` : args[0] === "rev-parse" ? "sha" : "", stderr: "", exitCode: 0 };
    },
    async exec() { return { stdout: "", stderr: "", exitCode: 0 }; },
    async gh(args, cwd) {
      if (args[0] === "api" && args[1]?.includes("rules/branches")) {
        sawRules = true;
        const response = await actualRunner.gh(args, cwd);
        expect(response.exitCode, response.stderr).toBe(0);
        return response;
      }
      let payload: unknown;
      if (args[0] === "api") payload = { contexts: [], checks: [] };
      else if (args[0] === "issue" && args[1] === "view") payload = { state: "OPEN", labels: [] };
      else if (args[0] === "pr" && args[1] === "list") payload = [{ number: 86, url: `https://github.com/${context.repo}/pull/86`, state: "OPEN", headRefOid: "sha", body: formatPrBody({ ...context, description: "fixture" }) }];
      else if (args[0] === "pr" && args[1] === "view") {
        sawCi = true;
        payload = { state: "OPEN", headRefOid: "sha", statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }] };
      } else throw new Error(`Unexpected mutation: ${args.slice(0, 2).join(" ")}`);
      return { stdout: JSON.stringify(payload), stderr: "", exitCode: 0 };
    },
  };
  const result = await runDeliverySkill({ ...context, cwd: process.cwd(), runner, optInLand: false });
  expect(sawRules).toBe(true);
  expect(sawCi).toBe(true);
  expect(result.status).toBe("ready_to_land");
}, 15_000);
