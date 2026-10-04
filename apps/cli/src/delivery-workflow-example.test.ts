import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { loadWorkflow, renderPrompt } from "@symphony/config";
import { normalizeGitHubIssue } from "@symphony/tracker";
import { createWorkspaceManager } from "@symphony/workspace";
import { parseDeliverySkillArgs } from "./delivery-skill-cli";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

it("runs the documented bootstrap hook then renders a null GitHub branch into valid delivery CLI arguments", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-example-"));
  try {
    const seed = path.join(temp, "seed");
    const workspaceRoot = path.join(temp, "workspaces");
    const workspace = path.join(workspaceRoot, "GH-80");
    fs.mkdirSync(seed);
    const git = (args: string[]) => execFileSync("git", args, { cwd: seed, encoding: "utf8" }).trim();
    git(["init", "-b", "main"]);
    git(["config", "user.name", "fixture"]);
    git(["config", "user.email", "fixture@example.test"]);
    const skill = fs.readFileSync(path.join(root, "skills/github-delivery/SKILL.md"), "utf8");
    fs.mkdirSync(path.join(seed, "skills/github-delivery"), { recursive: true });
    fs.writeFileSync(path.join(seed, "skills/github-delivery/SKILL.md"), skill);
    git(["add", "."]);
    git(["commit", "-m", "fixture"]);

    const yaml = skill.match(/```yaml\n([\s\S]*?)\n```/)?.[1];
    const template = skill.match(/````liquid\n([\s\S]*?)\n````/)?.[1];
    expect(yaml).toBeDefined();
    expect(template).toBeDefined();
    const workflowFile = path.join(temp, "WORKFLOW.md");
    fs.writeFileSync(workflowFile, `---\n${yaml}\n---\n${template}\n`);
    const workflow = loadWorkflow({ path: workflowFile });
    const hooks = workflow.config["hooks"] as { after_create: string };
    const cli = path.join(root, "apps/cli/dist/bin/symphony.js");
    // Redirect only the example repository transport to a local fixture; the
    // documented hook and real bootstrap CLI run unchanged, without credentials.
    const setup = `export GIT_CONFIG_COUNT=1\nexport GIT_CONFIG_KEY_0=${quote(`url.${seed}.insteadOf`)}\nexport GIT_CONFIG_VALUE_0=https://github.com/felixjichao/symphony-ts.git\nsymphony() { ${quote(process.execPath)} ${quote(cli)} "$@"; }\n`;
    const manager = createWorkspaceManager({ workspace: { root: workspaceRoot } });
    const created = await manager.createWorkspace("GH-80", { hooks: { afterCreate: setup + hooks.after_create, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 10_000 } });
    expect(created.path).toBe(workspace);
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: workspace, encoding: "utf8" }).trim()).toBe("symphony/GH-80");
    expect(fs.readFileSync(path.join(workspace, ".agents/skills/github-delivery/SKILL.md"), "utf8")).toBe(skill);

    const issue = normalizeGitHubIssue({ number: 80, title: "Delivery", body: "Implement delivery", state: "open" }, "felixjichao/symphony-ts");
    expect(issue?.branchName).toBeNull();
    const prompt = renderPrompt(workflow.promptTemplate, { issue: issue! });
    const script = prompt.match(/```sh\n([\s\S]*?)\n\s*```/)?.[1];
    expect(script).toBeDefined();
    const argvFile = path.join(temp, "argv");
    const capture = `symphony() { printf '%s\\n' "$@" > ${quote(argvFile)}; }\n`;
    execFileSync("sh", ["-c", capture + script], { cwd: workspace });
    const argv = fs.readFileSync(argvFile, "utf8").trimEnd().split("\n");
    expect(argv.shift()).toBe("delivery-skill");
    const parsed = parseDeliverySkillArgs(argv);
    expect(parsed.headBranch).toBe("symphony/GH-80");
    expect(parsed.workspaceKey).toBe("GH-80");
    expect(parsed.repo).toBe("felixjichao/symphony-ts");
    expect(parsed.issueNumber).toBe(80);
    expect(parsed.validationCommand).toBe("npm run gate");
    expect(parsed.optInLand).toBe(true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
