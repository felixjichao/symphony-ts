import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { loadEffectiveWorkflow, loadWorkflow, renderPrompt } from "@symphony/config";
import {
  createTrackerAdapterRegistry,
  normalizeGitHubIssue,
} from "@symphony/tracker";
import { createWorkspaceManager } from "@symphony/workspace";
import { parseDeliverySkillArgs } from "./delivery-skill-cli";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const exampleFile = path.join(root, "examples/github-delivery/WORKFLOW.md");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Copy the shipped profile into `dir`, substituting the repo placeholders. */
function copyProfile(dir: string, repo = "example-org/example-repo"): string {
  const example = fs.readFileSync(exampleFile, "utf8");
  const workflowFile = path.join(dir, "WORKFLOW.md");
  fs.writeFileSync(workflowFile, example.replaceAll("<owner/repo>", repo));
  return workflowFile;
}

it("loads the shipped profile, resolves it as a GitHub service config, and renders an autonomous prompt", () => {
  // Raw parse: the shipped file is a well-formed WORKFLOW.md with every section.
  const raw = loadWorkflow({ path: exampleFile });
  for (const section of ["tracker", "polling", "workspace", "hooks", "agent", "codex"]) {
    expect(raw.config[section]).toBeTypeOf("object");
  }
  expect(raw.promptTemplate).toContain("symphony delivery-skill run");

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-profile-config-"));
  try {
    const workflowFile = copyProfile(temp);
    const registry = createTrackerAdapterRegistry();
    const eff = loadEffectiveWorkflow({
      path: workflowFile,
      env: { GITHUB_TOKEN: "test-token" },
      trackerExtension: registry.createConfigExtension(),
    });

    expect(eff.serviceConfig.tracker.kind).toBe("github");
    expect(eff.serviceConfig.tracker.requiredLabels).toEqual(["symphony-ready"]);
    expect(eff.serviceConfig.tracker.activeStates).toEqual(["open"]);
    expect(eff.serviceConfig.tracker.terminalStates).toEqual(["closed"]);
    expect(eff.serviceConfig.agent.maxTurns).toBe(20);
    expect(path.isAbsolute(eff.serviceConfig.workspace.root)).toBe(true);

    const issue = normalizeGitHubIssue(
      { number: 80, title: "Delivery", body: "Implement delivery", state: "open" },
      "example-org/example-repo",
    );
    expect(issue).not.toBeNull();
    const prompt = renderPrompt(raw.promptTemplate, { issue: issue! });

    // AC-2: the prompt drives unattended delivery and must not ask a human to merge.
    expect(prompt).toContain("delivery-skill run");
    expect(prompt).toContain("--opt-in");
    expect(prompt).toContain("--repair-cmd");
    expect(prompt).toContain("--resume");
    expect(prompt).toContain("delivery-state.json");
    expect(prompt).toContain("--repo example-org/example-repo");
    expect(prompt).toContain("--issue 80");
    expect(prompt).not.toMatch(/manual merge|please merge|review and merge/i);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

it("documents a bootstrap hook that populates the workspace and a delivery command that parses", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-profile-run-"));
  try {
    const seed = path.join(temp, "seed");
    const workspaceRoot = path.join(temp, "workspaces");
    const workspace = path.join(workspaceRoot, "GH-80");
    fs.mkdirSync(seed, { recursive: true });
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: seed, encoding: "utf8" }).trim();
    git(["init", "-b", "main"]);
    git(["config", "user.name", "fixture"]);
    git(["config", "user.email", "fixture@example.test"]);
    const skill = fs.readFileSync(path.join(root, "skills/github-delivery/SKILL.md"), "utf8");
    fs.mkdirSync(path.join(seed, "skills/github-delivery"), { recursive: true });
    fs.writeFileSync(path.join(seed, "skills/github-delivery/SKILL.md"), skill);
    git(["add", "."]);
    git(["commit", "-m", "fixture"]);

    const workflowFile = copyProfile(temp);
    const workflow = loadWorkflow({ path: workflowFile });
    const hooks = workflow.config["hooks"] as { after_create: string };
    const cli = path.join(root, "apps/cli/dist/bin/symphony.js");
    // Redirect only the example repository transport to a local fixture; the documented
    // hook and the real bootstrap CLI run unchanged, without credentials.
    const setup = `export GIT_CONFIG_COUNT=1\nexport GIT_CONFIG_KEY_0=${quote(`url.${seed}.insteadOf`)}\nexport GIT_CONFIG_VALUE_0=${quote("https://github.com/example-org/example-repo.git")}\nsymphony() { ${quote(process.execPath)} ${quote(cli)} "$@"; }\n`;
    const manager = createWorkspaceManager({ workspace: { root: workspaceRoot } });
    const created = await manager.createWorkspace("GH-80", {
      hooks: {
        afterCreate: setup + hooks.after_create,
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 30_000,
      },
    });
    expect(created.path).toBe(workspace);
    expect(
      execFileSync("git", ["branch", "--show-current"], { cwd: workspace, encoding: "utf8" }).trim(),
    ).toBe("symphony/GH-80");
    expect(
      fs.readFileSync(path.join(workspace, ".agents/skills/github-delivery/SKILL.md"), "utf8"),
    ).toBe(skill);

    const issue = normalizeGitHubIssue(
      { number: 80, title: "Delivery", body: "Implement delivery", state: "open" },
      "example-org/example-repo",
    );
    const prompt = renderPrompt(workflow.promptTemplate, { issue: issue! });
    const script = prompt.match(/```sh\n([\s\S]*?)\n\s*```/)?.[1];
    expect(script).toBeDefined();
    const argvFile = path.join(temp, "argv");
    const capture = `symphony() { printf '%s\\n' "$@" > ${quote(argvFile)}; }\n`;
    const runScript = () => {
      execFileSync("sh", ["-c", capture + script], { cwd: workspace });
      const argv = fs.readFileSync(argvFile, "utf8").trimEnd().split("\n");
      expect(argv.shift()).toBe("delivery-skill");
      return parseDeliverySkillArgs(argv);
    };

    const parsed = runScript();
    expect(parsed.headBranch).toBe("symphony/GH-80");
    expect(parsed.workspaceKey).toBe("GH-80");
    expect(parsed.repo).toBe("example-org/example-repo");
    expect(parsed.issueNumber).toBe(80);
    expect(parsed.validationCommand).toBe("npm run gate");
    expect(parsed.repairCommand).toBe("npm run ci:fix");
    expect(parsed.baseBranch).toBe("main");
    expect(parsed.optInLand).toBe(true);
    expect(parsed.resume).toBe(false);

    // A paused delivery (previous CI blocker) makes the same command resume.
    fs.mkdirSync(path.join(workspace, ".symphony"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".symphony/delivery-state.json"),
      JSON.stringify({ isPaused: true }),
    );
    expect(runScript().resume).toBe(true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
