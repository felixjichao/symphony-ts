/**
 * GitHub delivery dogfood runner (SPEC §17.8 Real Integration, NEST-94 / #83).
 *
 * The harness only prepares scenarios, launches the real Symphony host / real
 * delivery CLI entry, injects controlled faults, reads GitHub back, and records
 * sanitized evidence. It never implements, repairs, commits, pushes, or merges
 * on the agent's behalf — those always go through the existing real entry points.
 *
 * Default gate stays credential-free: nothing here runs unless the caller opts
 * in with `--yes` and an explicitly authorized dogfood target.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { sanitizeCredentials, type DeliverySubprocessResult } from "@symphony/agent";

import { DefaultDeliveryGitGhRunner } from "../git-gh-runner";
import {
  buildEvidenceManifest,
  classifyDogfoodOutcome,
  decideDogfoodGate,
  parseDogfoodArgs,
  DOGFOOD_READY_LABEL,
  type CheckConclusion,
  type DogfoodArgs,
  type DogfoodFacts,
  type DogfoodScenario,
  type PrState,
  serializeEvidence,
} from "./contracts";

export interface DogfoodIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

const runner = new DefaultDeliveryGitGhRunner();
const POLL_INTERVAL_MS = 15_000;

interface RunContext {
  readonly args: DogfoodArgs;
  readonly repo: string;
  readonly runId: string;
  readonly evidenceDir: string;
  readonly workRoot: string;
  readonly token: string;
  readonly baseBranch: string;
  readonly io: DogfoodIo;
  readonly artifacts: Record<string, string>;
}

function log(io: DogfoodIo, text: string): void {
  io.stdout.write(`${sanitizeCredentials(text)}\n`);
}

async function gh(ctx: RunContext, args: readonly string[]): Promise<DeliverySubprocessResult> {
  return runner.gh(args, ctx.workRoot, 60_000);
}

async function ghJson<T>(ctx: RunContext, args: readonly string[]): Promise<T> {
  const res = await gh(ctx, args);
  if (res.exitCode !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (${res.exitCode}): ${res.stderr}`);
  }
  return JSON.parse(res.stdout) as T;
}

async function ghOk(ctx: RunContext, args: readonly string[]): Promise<void> {
  const res = await gh(ctx, args);
  if (res.exitCode !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (${res.exitCode}): ${res.stderr}`);
  }
}

async function writeArtifact(ctx: RunContext, name: string, content: string): Promise<void> {
  await writeFile(path.join(ctx.evidenceDir, name), sanitizeCredentials(content), "utf8");
  ctx.artifacts[name] = name;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  ctx: RunContext,
  label: string,
  predicate: () => Promise<boolean>,
  timeoutSeconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    log(ctx.io, `dogfood: waiting for ${label}...`);
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

interface IssueRecord {
  readonly number: number;
  readonly state: string;
  readonly url: string;
}
interface PrRecord {
  readonly number: number;
  readonly state: string;
  readonly url: string;
  readonly body: string;
  readonly headRefName: string;
  readonly mergeable: string;
}

async function getIssue(ctx: RunContext, number: number): Promise<IssueRecord> {
  return ghJson<IssueRecord>(ctx, ["issue", "view", String(number), "--repo", ctx.repo, "--json", "number,state,url"]);
}

async function listIssuePrs(ctx: RunContext, issueNumber: number): Promise<PrRecord[]> {
  const all = await ghJson<PrRecord[]>(ctx, [
    "pr", "list", "--repo", ctx.repo, "--state", "all", "--limit", "100",
    "--json", "number,state,url,body,headRefName,mergeable",
  ]);
  const marker = `${ctx.repo}#${issueNumber}`;
  return all.filter((pr) => pr.body.includes(`Fixes ${marker}`) || pr.body.includes(marker));
}

async function readOwnedPr(ctx: RunContext, issueNumber: number): Promise<PrRecord | null> {
  const prs = await listIssuePrs(ctx, issueNumber);
  return prs[0] ?? null;
}

function mapCheckState(raw: string | undefined): "success" | "failure" | "pending" | "unknown" {
  const v = (raw ?? "").toUpperCase();
  if (v === "SUCCESS" || v === "SUCCESSFUL") return "success";
  if (v === "FAILURE" || v === "FAILED" || v === "ERROR" || v === "TIMED_OUT" || v === "CANCELLED" || v === "ACTION_REQUIRED") return "failure";
  if (v === "PENDING" || v === "IN_PROGRESS" || v === "QUEUED" || v === "EXPECTED" || v === "WAITING" || v === "REQUESTED") return "pending";
  return "unknown";
}

interface PrView {
  readonly statusCheckRollup: ReadonlyArray<Record<string, unknown>> | null;
  readonly mergeable: string;
  readonly state: string;
  readonly headRefOid: string;
}

async function readChecks(ctx: RunContext, prNumber: number): Promise<{ checks: CheckConclusion; mergeable: string; view: string }> {
  const view = await ghJson<PrView>(ctx, [
    "pr", "view", String(prNumber), "--repo", ctx.repo, "--json", "statusCheckRollup,mergeable,state,headRefOid",
  ]);
  const rollup = view.statusCheckRollup ?? [];
  const states = rollup.map((entry) => mapCheckState(String(entry["conclusion"] ?? entry["state"] ?? "")));
  let checks: CheckConclusion = "unknown";
  if (states.length > 0) {
    if (states.some((s) => s === "failure")) checks = "failure";
    else if (states.some((s) => s === "pending" || s === "unknown")) checks = "pending";
    else if (states.every((s) => s === "success")) checks = "success";
  }
  return { checks, mergeable: view.mergeable, view: JSON.stringify(view) };
}

async function readRepairObserved(ctx: RunContext, headBranch: string): Promise<boolean> {
  const runs = await ghJson<ReadonlyArray<{ conclusion: string; status: string }>>(ctx, [
    "run", "list", "--repo", ctx.repo, "--branch", headBranch, "--limit", "30", "--json", "conclusion,status",
  ]);
  let sawFailure = false;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const conclusion = (runs[i]!.conclusion ?? "").toUpperCase();
    if (conclusion === "FAILURE") sawFailure = true;
    if (conclusion === "SUCCESS" && sawFailure) return true;
  }
  return false;
}

function prStateOf(pr: PrRecord | null): PrState {
  if (pr === null) return "none";
  const s = pr.state.toUpperCase();
  if (s === "MERGED") return "merged";
  if (s === "OPEN") return "open";
  if (s === "CLOSED") return "closed";
  return "none";
}

interface HostHandle {
  stop(): Promise<number>;
  output(): string;
}

function startHost(ctx: RunContext, workflowPath: string): HostHandle {
  let output = "";
  const child: ChildProcess = spawn(ctx.args.hostBinary, [workflowPath], {
    cwd: ctx.workRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GITHUB_TOKEN: ctx.token,
      SYMPHONY_DELIVERY_BASE: ctx.baseBranch,
      SYMPHONY_DELIVERY_VALIDATE: "npm run gate",
      SYMPHONY_DELIVERY_REPAIR_CMD: "npm run ci:fix",
    },
  });
  const collect = (chunk: Buffer): void => { output += chunk.toString("utf8"); };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const exited = new Promise<number>((resolve) => { child.on("close", (code) => resolve(code ?? 0)); });
  return {
    output: () => output,
    async stop(): Promise<number> {
      if (child.exitCode !== null) return child.exitCode;
      child.kill("SIGINT");
      const timed = await Promise.race([exited, sleep(30_000).then(() => -1)]);
      if (timed === -1) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        return await exited;
      }
      return timed;
    },
  };
}

async function ensureLabel(ctx: RunContext): Promise<void> {
  const res = await gh(ctx, ["label", "create", DOGFOOD_READY_LABEL, "--repo", ctx.repo, "--color", "0e8a16", "--force"]);
  if (res.exitCode !== 0) {
    throw new Error(`failed to ensure '${DOGFOOD_READY_LABEL}' label: ${res.stderr}`);
  }
}

async function createIssue(ctx: RunContext, title: string, body: string): Promise<number> {
  const res = await gh(ctx, ["issue", "create", "--repo", ctx.repo, "--title", title, "--body", body, "--label", DOGFOOD_READY_LABEL]);
  if (res.exitCode !== 0) {
    throw new Error(`failed to create dogfood issue: ${res.stderr}`);
  }
  const url = res.stdout.trim().split("\n").pop() ?? "";
  const number = Number(url.split("/").pop());
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`could not parse issue number from '${url}'`);
  }
  await writeArtifact(ctx, `issue-${number}-create.txt`, res.stdout);
  return number;
}

const DELIVERY_ISSUE_BODY =
  "Add a `subtract(a, b)` export to `src/math.mjs` returning `a - b`, plus a test in `test/math.test.mjs` asserting `subtract(5, 2) === 3`. Run the project's local gate, then deliver end to end with the delivery skill.";

function renderWorkflow(templateDir: string, ctx: RunContext): string {
  const template = readFileSync(path.join(templateDir, "WORKFLOW.md"), "utf8");
  return template.replaceAll("<owner/repo>", ctx.repo).replace("interval_ms: 30000", "interval_ms: 15000");
}

/**
 * Inject a deterministic CI-only fault into the target default branch: a
 * `console.log` in `src/`, which the local gate (unit tests) misses but the CI
 * lint gate rejects. The first head therefore fails CI and must be repaired by a
 * real Codex `ci:fix` run.
 */
async function injectRepairFault(ctx: RunContext): Promise<void> {
  const existing = await gh(ctx, ["api", `repos/${ctx.repo}/contents/src/legacy.mjs?ref=${ctx.baseBranch}`]);
  const content = Buffer.from(
    'export function legacyGreeting() {\n  console.log("legacy debug output");\n  return "legacy";\n}\n',
    "utf8",
  ).toString("base64");
  const args = [
    "api", "-X", "PUT", `repos/${ctx.repo}/contents/src/legacy.mjs`,
    "-f", "message=dogfood: seed CI-only lint fault",
    "-f", `content=${content}`,
    "-f", `branch=${ctx.baseBranch}`,
  ];
  if (existing.exitCode === 0) {
    const parsed = JSON.parse(existing.stdout) as { sha: string };
    args.push("-f", `sha=${parsed.sha}`);
  }
  const res = await gh(ctx, args);
  if (res.exitCode !== 0) {
    throw new Error(`failed to inject repair fault: ${res.stderr}`);
  }
  await writeArtifact(ctx, "repair-fault.json", res.stdout);
}

async function factsForIssue(ctx: RunContext, issueNumber: number, hostLog: string): Promise<DogfoodFacts> {
  const issue = await getIssue(ctx, issueNumber);
  const pr = await readOwnedPr(ctx, issueNumber);
  const checks = pr ? await readChecks(ctx, pr.number) : { checks: "unknown" as CheckConclusion, mergeable: "UNKNOWN", view: "" };
  const repairObserved = pr ? await readRepairObserved(ctx, pr.headRefName) : false;
  const linkedPrCount = (await listIssuePrs(ctx, issueNumber)).length;
  await writeArtifact(ctx, `issue-${issueNumber}-final.json`, JSON.stringify(issue));
  if (pr) await writeArtifact(ctx, `pr-${pr.number}-checks.json`, checks.view);
  return {
    issueClosed: issue.state.toUpperCase() === "CLOSED",
    ownedPrState: prStateOf(pr),
    linkedPrCount,
    checks: checks.checks,
    mergeable: checks.mergeable.toUpperCase() === "MERGEABLE",
    repairObserved,
    foreignPrOpen: false,
    conflicting: false,
    workspaceCleanupObserved: hostLog.includes('"event":"workspace_cleanup"') && hostLog.includes('"outcome":"completed"'),
  };
}

async function scenarioHostDriven(ctx: RunContext, templateDir: string, kind: "happy" | "repair"): Promise<DogfoodFacts> {
  await ensureLabel(ctx);
  if (kind === "repair") {
    await injectRepairFault(ctx);
  }
  const title = kind === "repair" ? "Dogfood: add subtract() (CI-only seeded fault)" : "Dogfood: add subtract()";
  const issueNumber = await createIssue(ctx, title, DELIVERY_ISSUE_BODY);
  const workflowPath = path.join(ctx.workRoot, "WORKFLOW.md");
  await writeFile(workflowPath, renderWorkflow(templateDir, ctx), "utf8");

  const host = startHost(ctx, workflowPath);
  const closed = await waitFor(
    ctx,
    `issue #${issueNumber} closed`,
    async () => (await getIssue(ctx, issueNumber)).state.toUpperCase() === "CLOSED",
    ctx.args.timeoutSeconds,
  );
  const hostLog = host.output();
  await writeArtifact(ctx, `host-${kind}.log`, hostLog);
  await host.stop();
  if (!closed) log(ctx.io, `dogfood: host did not reach terminal state for issue #${issueNumber}`);
  return factsForIssue(ctx, issueNumber, hostLog);
}

async function scenarioReuse(ctx: RunContext, templateDir: string): Promise<DogfoodFacts> {
  await ensureLabel(ctx);
  const issueNumber = await createIssue(ctx, "Dogfood: restart reuse", DELIVERY_ISSUE_BODY);
  const workflowPath = path.join(ctx.workRoot, "WORKFLOW.md");
  await writeFile(workflowPath, renderWorkflow(templateDir, ctx), "utf8");

  // Phase 1: run until a PR exists, then gracefully stop (simulated restart).
  const host1 = startHost(ctx, workflowPath);
  await waitFor(ctx, `PR for issue #${issueNumber}`, async () => (await readOwnedPr(ctx, issueNumber)) !== null, ctx.args.timeoutSeconds);
  const log1 = host1.output();
  await writeArtifact(ctx, "host-reuse-phase1.log", log1);
  await host1.stop();
  const before = await readOwnedPr(ctx, issueNumber);
  await writeArtifact(ctx, `reuse-before-${issueNumber}.json`, JSON.stringify(before));

  // Phase 2: restart the host; it must resume from GitHub facts and reuse the PR.
  const host2 = startHost(ctx, workflowPath);
  await waitFor(
    ctx,
    `issue #${issueNumber} closed after restart`,
    async () => (await getIssue(ctx, issueNumber)).state.toUpperCase() === "CLOSED",
    ctx.args.timeoutSeconds,
  );
  const log2 = host2.output();
  await writeArtifact(ctx, "host-reuse-phase2.log", log2);
  await host2.stop();
  return factsForIssue(ctx, issueNumber, log1 + log2);
}

async function createForeignBranchAndPr(ctx: RunContext): Promise<PrRecord> {
  const base = await ghJson<{ object: { sha: string } }>(ctx, ["api", `repos/${ctx.repo}/git/ref/heads/${ctx.baseBranch}`]);
  const branch = `dogfood-foreign-${ctx.runId}`;
  await ghOk(ctx, ["api", "-X", "POST", `repos/${ctx.repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${base.object.sha}`]);
  const content = Buffer.from(`foreign ${ctx.runId}\n`, "utf8").toString("base64");
  await ghOk(ctx, ["api", "-X", "PUT", `repos/${ctx.repo}/contents/foreign-${ctx.runId}.txt`, "-f", `message=foreign ${ctx.runId}`, "-f", `content=${content}`, "-f", `branch=${branch}`]);
  await ghOk(ctx, ["pr", "create", "--repo", ctx.repo, "--head", branch, "--base", ctx.baseBranch, "--title", `foreign ${ctx.runId}`, "--body", "Not managed by Symphony. Must never be auto-merged."]);
  const prs = await ghJson<PrRecord[]>(ctx, ["pr", "list", "--repo", ctx.repo, "--head", branch, "--state", "all", "--json", "number,state,url,body,headRefName,mergeable"]);
  const pr = prs[0];
  if (pr === undefined) throw new Error("failed to locate foreign PR after creation");
  return pr;
}

async function scenarioForeign(ctx: RunContext): Promise<DogfoodFacts> {
  await ensureLabel(ctx);
  const issueNumber = await createIssue(ctx, "Dogfood: foreign PR safety", "Safety scenario: a foreign pull request must never be auto-merged.");
  const pr = await createForeignBranchAndPr(ctx);
  await writeArtifact(ctx, `foreign-pr-${pr.number}.json`, JSON.stringify(pr));
  const land = await runner.exec(
    `${ctx.args.hostBinary} pr land --repo ${ctx.repo} --issue ${issueNumber} --workspace-key dogfood-foreign-${ctx.runId} --head ${pr.headRefName} --base ${ctx.baseBranch} --pr ${pr.number} --opt-in`,
    ctx.workRoot, 120_000, {},
  ).catch((err: unknown) => ({ exitCode: 1, stdout: "", stderr: String(err) }));
  await writeArtifact(ctx, `foreign-land-${pr.number}.txt`, `exit=${land.exitCode}\n${land.stdout}\n${land.stderr}`);
  const after = await ghJson<PrRecord[]>(ctx, ["pr", "list", "--repo", ctx.repo, "--head", pr.headRefName, "--state", "all", "--json", "number,state,url,body,headRefName,mergeable"]);
  const finalPr = after[0] ?? pr;
  const issue = await getIssue(ctx, issueNumber);
  return {
    issueClosed: issue.state.toUpperCase() === "CLOSED",
    ownedPrState: "none",
    linkedPrCount: 0,
    checks: "unknown",
    mergeable: false,
    repairObserved: false,
    foreignPrOpen: finalPr.state.toUpperCase() === "OPEN",
    conflicting: false,
    workspaceCleanupObserved: false,
  };
}

async function scenarioConflict(ctx: RunContext): Promise<DogfoodFacts> {
  await ensureLabel(ctx);
  const issueNumber = await createIssue(ctx, "Dogfood: conflicting PR safety", "Safety scenario: a conflicting owned PR must not be auto-merged.");
  const base = await ghJson<{ object: { sha: string } }>(ctx, ["api", `repos/${ctx.repo}/git/ref/heads/${ctx.baseBranch}`]);
  const workspaceKey = `dogfood-conflict-${ctx.runId}`;
  const branch = `symphony/${workspaceKey}`;
  await ghOk(ctx, ["api", "-X", "POST", `repos/${ctx.repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${base.object.sha}`]);
  const branchContent = Buffer.from(`branch side ${ctx.runId}\n`, "utf8").toString("base64");
  await ghOk(ctx, ["api", "-X", "PUT", `repos/${ctx.repo}/contents/conflict.txt`, "-f", "message=branch side", "-f", `content=${branchContent}`, "-f", `branch=${branch}`]);
  const ensure = await runner.exec(
    `${ctx.args.hostBinary} pr ensure --repo ${ctx.repo} --issue ${issueNumber} --workspace-key ${workspaceKey} --head ${branch} --base ${ctx.baseBranch}`,
    ctx.workRoot, 120_000, {},
  ).catch((err: unknown) => ({ exitCode: 1, stdout: "", stderr: String(err) }));
  await writeArtifact(ctx, `conflict-ensure-${issueNumber}.txt`, `exit=${ensure.exitCode}\n${ensure.stdout}\n${ensure.stderr}`);
  // Diverge the base branch to force a real merge conflict.
  const baseContent = Buffer.from(`base side ${ctx.runId}\n`, "utf8").toString("base64");
  await ghOk(ctx, ["api", "-X", "PUT", `repos/${ctx.repo}/contents/conflict.txt`, "-f", "message=base side", "-f", `content=${baseContent}`, "-f", `branch=${ctx.baseBranch}`]);
  const pr = await readOwnedPr(ctx, issueNumber);
  if (pr === null) throw new Error("owned conflict PR was not created");
  const view = await ghJson<PrView>(ctx, ["pr", "view", String(pr.number), "--repo", ctx.repo, "--json", "statusCheckRollup,mergeable,state,headRefOid"]);
  const land = await runner.exec(
    `${ctx.args.hostBinary} pr land --repo ${ctx.repo} --issue ${issueNumber} --workspace-key ${workspaceKey} --head ${branch} --base ${ctx.baseBranch} --pr ${pr.number} --opt-in`,
    ctx.workRoot, 120_000, {},
  ).catch((err: unknown) => ({ exitCode: 1, stdout: "", stderr: String(err) }));
  await writeArtifact(ctx, `conflict-land-${pr.number}.txt`, `exit=${land.exitCode}\n${land.stdout}\n${land.stderr}`);
  const after = await readOwnedPr(ctx, issueNumber);
  const issue = await getIssue(ctx, issueNumber);
  return {
    issueClosed: issue.state.toUpperCase() === "CLOSED",
    ownedPrState: prStateOf(after),
    linkedPrCount: (await listIssuePrs(ctx, issueNumber)).length,
    checks: "unknown",
    mergeable: view.mergeable.toUpperCase() === "MERGEABLE",
    repairObserved: false,
    foreignPrOpen: false,
    conflicting: view.mergeable.toUpperCase() === "CONFLICTING",
    workspaceCleanupObserved: false,
  };
}

const USAGE = [
  "Usage: symphony dogfood github --target <owner/repo> [options]",
  "",
  "Options:",
  "  --scenario <happy|repair|reuse|foreign|conflict>  Scenario to run (default happy)",
  "  --target <owner/repo>    Authorized isolated dogfood repository",
  "  --template <dir>         Target template directory (default examples/github-delivery-dogfood)",
  "  --workflow <path>        Host WORKFLOW.md (default: rendered from template)",
  "  --host <binary>          symphony binary (default: symphony)",
  "  --evidence-dir <dir>     Evidence output directory (default: dogfood-artifacts)",
  "  --run-id <id>            Explicit run id (default: timestamp)",
  "  --timeout <seconds>      Per-scenario timeout (default: 1800)",
  "  --yes                    Explicit opt-in (required to run)",
  "  --keep                   Keep artifacts instead of only the manifest",
  "  --json                   Machine-readable summary",
].join("\n");

async function resolveToken(): Promise<string> {
  const fromEnv = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  const res = await runner.exec("gh auth token", process.cwd(), 30_000, {});
  if (res.exitCode !== 0 || res.stdout.trim() === "") {
    throw new Error("no GitHub credential: set GITHUB_TOKEN or run 'gh auth login'");
  }
  return res.stdout.trim();
}

async function preflight(ctx: RunContext, templateDir: string): Promise<void> {
  const auth = await runner.exec("gh auth status", ctx.workRoot, 30_000, {});
  if (auth.exitCode !== 0) throw new Error("gh is not authenticated");
  const repo = await runner.exec(`gh repo view ${ctx.repo} --json nameWithOwner`, ctx.workRoot, 30_000, {});
  if (repo.exitCode !== 0) throw new Error(`dogfood target ${ctx.repo} is not accessible: ${repo.stderr}`);
  const codex = await runner.exec("codex login status", ctx.workRoot, 30_000, {});
  if (codex.exitCode !== 0) throw new Error("codex is not authenticated (real Codex unavailable)");
  const host = await runner.exec(`${ctx.args.hostBinary} --version`, ctx.workRoot, 30_000, {});
  if (host.exitCode !== 0) throw new Error(`symphony host binary '${ctx.args.hostBinary}' is not runnable: ${host.stderr}`);
  await access(path.join(templateDir, "WORKFLOW.md"));
}

function scenarioLabel(scenario: DogfoodScenario): DogfoodScenario {
  return scenario;
}

export async function runGithubDogfoodCli(argv: readonly string[], io: DogfoodIo): Promise<number> {
  let args: DogfoodArgs;
  try {
    args = parseDogfoodArgs(argv);
  } catch (err) {
    io.stderr.write(`symphony dogfood: invalid argument: ${String(err)}\n`);
    return 1;
  }
  if (args.help) {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const gate = decideDogfoodGate(args);
  if (gate.kind === "skip") {
    io.stdout.write(`SKIPPED: ${gate.message}\n`);
    return 0;
  }
  if (gate.kind === "error") {
    io.stderr.write(`symphony dogfood: ${gate.message}\n`);
    return 1;
  }

  const runId = args.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
  const evidenceDir = path.resolve(args.evidenceDir, runId);
  const workRoot = path.join(evidenceDir, "work");
  await mkdir(workRoot, { recursive: true });
  const templateDir = path.resolve(args.templatePath);

  let token: string;
  try {
    token = await resolveToken();
  } catch (err) {
    io.stdout.write(`SKIPPED: ${sanitizeCredentials(String(err))}\n`);
    return 0;
  }

  const ctx: RunContext = {
    args, repo: gate.repo, runId, evidenceDir, workRoot, token,
    baseBranch: "main", io, artifacts: {},
  };

  const startedAtMs = Date.now();
  const finalize = async (status: "passed" | "failed", reason: string, facts: DogfoodFacts | null): Promise<void> => {
    const manifest = buildEvidenceManifest({
      runId, scenario: scenarioLabel(args.scenario), target: gate.repo, startedAtMs, finishedAtMs: Date.now(),
      status, reason, facts, artifacts: ctx.artifacts,
    });
    await writeFile(path.join(evidenceDir, "manifest.json"), serializeEvidence(manifest, sanitizeCredentials), "utf8");
    if (args.json) io.stdout.write(`${serializeEvidence(manifest, sanitizeCredentials)}\n`);
  };

  try {
    await preflight(ctx, templateDir);
    log(io, `dogfood: run ${runId} scenario=${args.scenario} target=${gate.repo}`);
    let facts: DogfoodFacts;
    switch (args.scenario) {
      case "happy":
      case "repair":
        facts = await scenarioHostDriven(ctx, templateDir, args.scenario);
        break;
      case "reuse":
        facts = await scenarioReuse(ctx, templateDir);
        break;
      case "foreign":
        facts = await scenarioForeign(ctx);
        break;
      case "conflict":
        facts = await scenarioConflict(ctx);
        break;
    }
    const verdict = classifyDogfoodOutcome(args.scenario, facts);
    await finalize(verdict.status, verdict.reason, facts);
    if (!args.json) io.stdout.write(`dogfood: ${verdict.status} (${verdict.reason})\n`);
    return verdict.status === "passed" ? 0 : 1;
  } catch (err) {
    const message = sanitizeCredentials(String(err));
    await finalize("failed", message, null).catch(() => undefined);
    io.stderr.write(`symphony dogfood: failed: ${message}\n`);
    return 1;
  }
}
