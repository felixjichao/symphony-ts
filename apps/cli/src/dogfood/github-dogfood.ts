/**
 * GitHub delivery dogfood runner (SPEC §17.8 Real Integration, NEST-94 / #83).
 *
 * The harness only prepares scenarios, launches the real Symphony host / real
 * delivery CLI entry, injects controlled faults, reads GitHub back, and records
 * sanitized evidence. It never implements, repairs, commits, pushes, or merges
 * on the agent's behalf — those always go through the existing real entry points.
 *
 * Every scenario takes an injected {@link DogfoodDeps} so the default,
 * credential-free gate can exercise the entry-point logic (including the
 * false-positive paths) without touching GitHub or Codex.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { sanitizeCredentials } from "@symphony/agent";
import { deriveWorkspaceKey } from "@symphony/domain";

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
  type PrState,
  serializeEvidence,
} from "./contracts";

export interface DogfoodIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

export interface DogfoodProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DogfoodProcessRunner {
  gh(args: readonly string[], cwd: string, timeoutMs?: number): Promise<DogfoodProcessResult>;
  exec(command: string, cwd: string, timeoutMs?: number, env?: Record<string, string>): Promise<DogfoodProcessResult>;
}

export interface DogfoodHostHandle {
  stop(): Promise<number>;
  output(): string;
}

export interface DogfoodDeps {
  readonly runner: DogfoodProcessRunner;
  readonly startHost: (command: string, args: readonly string[], opts: { cwd: string; env: Record<string, string> }) => DogfoodHostHandle;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly writeText: (file: string, text: string) => Promise<void>;
  readonly readText: (file: string) => Promise<string | null>;
  readonly mkdirp: (dir: string) => Promise<void>;
  readonly pathExists: (target: string) => Promise<boolean>;
  /** Read the real credential without any redaction. Never logged. */
  readonly rawAuthToken: () => Promise<string>;
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly workspaceKeyOf: (identifier: string) => string;
}

const deliveryRunner = new DefaultDeliveryGitGhRunner();
const POLL_INTERVAL_MS = 15_000;
const HOLD_CONTEXT = "symphony-dogfood-hold";

/** Real, production dependencies (spawn, gh, fs). */
export function createRealDogfoodDeps(env: Record<string, string | undefined> = process.env): DogfoodDeps {
  return {
    runner: {
      gh: (args, cwd, timeoutMs) => deliveryRunner.gh(args, cwd, timeoutMs),
      exec: (command, cwd, timeoutMs, extraEnv) => deliveryRunner.exec(command, cwd, timeoutMs, extraEnv),
    },
    startHost: (command, args, opts) => {
      let output = "";
      const child: ChildProcess = spawn(command, [...args], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: opts.env });
      const collect = (chunk: Buffer): void => { output += chunk.toString("utf8"); };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const exited = new Promise<number>((resolve) => { child.on("close", (code) => resolve(code ?? 0)); });
      child.on("error", () => { /* surfaced through the exit code and later assertions */ });
      return {
        output: () => output,
        async stop(): Promise<number> {
          if (child.exitCode !== null) return child.exitCode;
          child.kill("SIGINT");
          const timed = await Promise.race([exited, new Promise<number>((r) => setTimeout(() => r(-1), 30_000))]);
          if (timed === -1) {
            try { child.kill("SIGKILL"); } catch { /* already gone */ }
            return await exited;
          }
          return timed;
        },
      };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    writeText: async (file, text) => { await writeFile(file, text, "utf8"); },
    readText: async (file) => { try { return await readFile(file, "utf8"); } catch { return null; } },
    mkdirp: async (dir) => { await mkdirWithParents(dir); },
    pathExists: async (target) => { try { await stat(target); return true; } catch { return false; } },
    rawAuthToken: async () => {
      const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
      if (result.error || result.status !== 0) {
        throw new DogfoodError("no GitHub credential: set GITHUB_TOKEN or run 'gh auth login'");
      }
      return (result.stdout ?? "").trim();
    },
    env,
    cwd: process.cwd(),
    workspaceKeyOf: (identifier) => deriveWorkspaceKey(identifier),
  };
}

async function mkdirWithParents(dir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
}

export class DogfoodError extends Error {
  readonly code: string;
  constructor(message: string, code = "dogfood_error") {
    super(message);
    this.name = "DogfoodError";
    this.code = code;
  }
}

/** Tracks every started host so all of them are stopped on every exit path. */
class HostTracker {
  private readonly hosts = new Set<DogfoodHostHandle>();
  add(host: DogfoodHostHandle): DogfoodHostHandle {
    this.hosts.add(host);
    return host;
  }
  async stopAll(): Promise<void> {
    for (const host of [...this.hosts]) {
      try { await host.stop(); } catch { /* shutdown cannot mask the original result */ }
      this.hosts.delete(host);
    }
  }
}

interface RunContext {
  readonly args: DogfoodArgs;
  readonly deps: DogfoodDeps;
  readonly repo: string;
  readonly runId: string;
  readonly evidenceDir: string;
  readonly workRoot: string;
  readonly workspaceRoot: string;
  readonly token: string;
  readonly tokenExplicit: boolean;
  readonly baseBranch: string;
  readonly io: DogfoodIo;
  readonly artifacts: Record<string, string>;
  readonly hosts: HostTracker;
}

function log(ctx: RunContext, text: string): void {
  ctx.io.stdout.write(`${sanitizeCredentials(text)}\n`);
}

function gh(ctx: RunContext, args: readonly string[]): Promise<DogfoodProcessResult> {
  return ctx.deps.runner.gh(args, ctx.workRoot, 60_000);
}

async function ghJson<T>(ctx: RunContext, args: readonly string[]): Promise<T> {
  const res = await gh(ctx, args);
  if (res.exitCode !== 0) throw new DogfoodError(`gh ${args.join(" ")} failed (${res.exitCode}): ${res.stderr}`);
  return JSON.parse(res.stdout) as T;
}

async function ghOk(ctx: RunContext, args: readonly string[]): Promise<void> {
  const res = await gh(ctx, args);
  if (res.exitCode !== 0) throw new DogfoodError(`gh ${args.join(" ")} failed (${res.exitCode}): ${res.stderr}`);
}

async function writeArtifact(ctx: RunContext, name: string, content: string): Promise<void> {
  await ctx.deps.writeText(path.join(ctx.evidenceDir, name), sanitizeCredentials(content));
  ctx.artifacts[name] = name;
}

async function waitFor(
  ctx: RunContext,
  label: string,
  predicate: () => Promise<boolean>,
  timeoutSeconds: number,
  intervalMs: number = POLL_INTERVAL_MS,
): Promise<void> {
  const deadline = ctx.deps.now() + timeoutSeconds * 1000;
  while (ctx.deps.now() < deadline) {
    if (await predicate()) return;
    log(ctx, `dogfood: waiting for ${label}...`);
    await ctx.deps.sleep(intervalMs);
  }
  throw new DogfoodError(`timed out waiting for ${label}`, "dogfood_timeout");
}

/** Parse `key="value"` structured fields from one host log line. */
export function parseStructuredLogLine(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * True only when the host logged `workspace_cleanup` `completed` for this exact
 * issue. The logger renders structured fields as `key="value"`, not JSON.
 */
export function hasCleanupCompletedFor(logText: string, identifier: string): boolean {
  for (const line of logText.split(/\r?\n/)) {
    const kv = parseStructuredLogLine(line);
    if (kv["event"] === "workspace_cleanup" && kv["outcome"] === "completed" && kv["issue_identifier"] === identifier) {
      return true;
    }
  }
  return false;
}

interface IssueRecord { readonly number: number; readonly state: string; readonly url: string; }
interface PrRecord {
  readonly number: number;
  readonly state: string;
  readonly url: string;
  readonly body: string;
  readonly headRefName: string;
  readonly mergeable: string;
}
interface PrView {
  readonly statusCheckRollup: ReadonlyArray<Record<string, unknown>> | null;
  readonly mergeable: string;
  readonly state: string;
  readonly headRefOid: string;
  readonly mergeCommit: { readonly oid: string } | null;
}

function issueIdentifier(issueNumber: number): string {
  return `GH-${issueNumber}`;
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
  return (await listIssuePrs(ctx, issueNumber))[0] ?? null;
}

function mapCheckState(raw: string | undefined): "success" | "failure" | "pending" | "unknown" {
  const v = (raw ?? "").toUpperCase();
  if (v === "SUCCESS" || v === "SUCCESSFUL") return "success";
  if (v === "FAILURE" || v === "FAILED" || v === "ERROR" || v === "TIMED_OUT" || v === "CANCELLED" || v === "ACTION_REQUIRED") return "failure";
  if (v === "PENDING" || v === "IN_PROGRESS" || v === "QUEUED" || v === "EXPECTED" || v === "WAITING" || v === "REQUESTED") return "pending";
  return "unknown";
}

async function readChecks(ctx: RunContext, prNumber: number): Promise<{ checks: CheckConclusion; mergeable: string }> {
  const view = await ghJson<PrView>(ctx, ["pr", "view", String(prNumber), "--repo", ctx.repo, "--json", "statusCheckRollup,mergeable,state,headRefOid,mergeCommit"]);
  const rollup = view.statusCheckRollup ?? [];
  const states = rollup.map((entry) => mapCheckState(String(entry["conclusion"] ?? entry["state"] ?? "")));
  let checks: CheckConclusion = "unknown";
  if (states.length > 0) {
    if (states.some((s) => s === "failure")) checks = "failure";
    else if (states.some((s) => s === "pending" || s === "unknown")) checks = "pending";
    else if (states.every((s) => s === "success")) checks = "success";
  }
  return { checks, mergeable: view.mergeable };
}

async function readRepairObserved(ctx: RunContext, headBranch: string): Promise<boolean> {
  const runs = await ghJson<ReadonlyArray<{ conclusion: string; status: string }>>(ctx, [
    "run", "list", "--repo", ctx.repo, "--branch", headBranch, "--limit", "30", "--json", "conclusion,status",
  ]);
  let sawFailure = false;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const conclusion = (runs[i]?.conclusion ?? "").toUpperCase();
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

async function ensureLabel(ctx: RunContext): Promise<void> {
  const res = await gh(ctx, ["label", "create", DOGFOOD_READY_LABEL, "--repo", ctx.repo, "--color", "0e8a16", "--force"]);
  if (res.exitCode !== 0) throw new DogfoodError(`failed to ensure '${DOGFOOD_READY_LABEL}' label: ${res.stderr}`);
}

async function createIssue(ctx: RunContext, title: string, body: string): Promise<number> {
  const res = await gh(ctx, ["issue", "create", "--repo", ctx.repo, "--title", title, "--body", body, "--label", DOGFOOD_READY_LABEL]);
  if (res.exitCode !== 0) throw new DogfoodError(`failed to create dogfood issue: ${res.stderr}`);
  const url = res.stdout.trim().split("\n").pop() ?? "";
  const number = Number(url.split("/").pop());
  if (!Number.isSafeInteger(number) || number <= 0) throw new DogfoodError(`could not parse issue number from '${url}'`);
  await writeArtifact(ctx, `issue-${number}-create.txt`, res.stdout);
  return number;
}

async function renderWorkflow(templateDir: string, ctx: RunContext): Promise<string> {
  const template = await ctx.deps.readText(path.join(templateDir, "WORKFLOW.md"));
  if (template === null) throw new DogfoodError(`missing WORKFLOW.md template at ${templateDir}`);
  return template.replaceAll("<owner/repo>", ctx.repo).replace("interval_ms: 30000", "interval_ms: 15000");
}

function uniqueTask(runId: string, verb: string): { name: string; body: string } {
  const suffix = runId.replace(/[^a-zA-Z0-9]/g, "").slice(-6);
  const name = `${verb}${suffix}`;
  const body =
    `Add a \`${name}(a, b)\` export to \`src/math.mjs\` returning \`a - b\`, plus a test in ` +
    "`test/math.test.mjs` asserting it is correct. Run the project's local gate, then deliver end to end with the delivery skill.";
  return { name, body };
}

async function startTrackedHost(ctx: RunContext, workflowPath: string): Promise<DogfoodHostHandle> {
  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx.deps.env)) {
    if (value !== undefined) baseEnv[key] = value;
  }
  const env: Record<string, string> = {
    ...baseEnv,
    GITHUB_TOKEN: ctx.token,
    GH_TOKEN: ctx.token,
    SYMPHONY_DELIVERY_BASE: ctx.baseBranch,
    SYMPHONY_DELIVERY_VALIDATE: "npm run gate",
    SYMPHONY_DELIVERY_REPAIR_CMD: "npm run ci:fix",
  };
  const host = ctx.deps.startHost(ctx.args.hostBinary, [workflowPath], { cwd: ctx.workRoot, env });
  return ctx.hosts.add(host);
}

async function prepareCommon(ctx: RunContext): Promise<void> {
  await ctx.deps.mkdirp(ctx.workspaceRoot);
  await ctx.deps.writeText(path.join(ctx.workspaceRoot, ".dogfood-sentinel"), "sentinel\n");
}

interface TerminalFactsInput {
  readonly issueNumber: number;
  readonly hostLog: string;
  readonly workspaceObserved: boolean;
}

async function terminalFacts(ctx: RunContext, input: TerminalFactsInput): Promise<DogfoodFacts> {
  const identifier = issueIdentifier(input.issueNumber);
  const workspaceDir = path.join(ctx.workspaceRoot, ctx.deps.workspaceKeyOf(identifier));
  const issue = await getIssue(ctx, input.issueNumber);
  const pr = await readOwnedPr(ctx, input.issueNumber);
  const checks = pr ? await readChecks(ctx, pr.number) : { checks: "unknown" as CheckConclusion, mergeable: "UNKNOWN" };
  const repairObserved = pr ? await readRepairObserved(ctx, pr.headRefName) : false;
  const linkedPrCount = (await listIssuePrs(ctx, input.issueNumber)).length;
  const cleanupEvent = hasCleanupCompletedFor(input.hostLog, identifier);
  const workspaceGone = !(await ctx.deps.pathExists(workspaceDir));
  const sentinelAlive = await ctx.deps.pathExists(path.join(ctx.workspaceRoot, ".dogfood-sentinel"));
  let mergeSha: string | null = null;
  await writeArtifact(ctx, `issue-${input.issueNumber}-final.json`, JSON.stringify(issue));
  if (pr) {
    await writeArtifact(ctx, `pr-${pr.number}-checks.json`, JSON.stringify(checks));
    const runs = await gh(ctx, ["run", "list", "--repo", ctx.repo, "--branch", pr.headRefName, "--limit", "30", "--json", "databaseId,headSha,conclusion,status,url,workflowName"]);
    await writeArtifact(ctx, `pr-${pr.number}-actions-runs.json`, runs.stdout);
    const mergeView = await gh(ctx, ["pr", "view", String(pr.number), "--repo", ctx.repo, "--json", "mergeCommit,mergedAt,state,headRefOid"]);
    await writeArtifact(ctx, `pr-${pr.number}-merge.json`, mergeView.stdout);
    mergeSha = (await ghJson<PrView>(ctx, ["pr", "view", String(pr.number), "--repo", ctx.repo, "--json", "statusCheckRollup,mergeable,state,headRefOid,mergeCommit"])).mergeCommit?.oid ?? null;
  }
  return {
    issueClosed: issue.state.toUpperCase() === "CLOSED",
    ownedPrState: prStateOf(pr),
    linkedPrCount,
    checks: checks.checks,
    mergeable: checks.mergeable.toUpperCase() === "MERGEABLE",
    repairObserved,
    foreignPrOpen: false,
    conflicting: false,
    workspaceCleanupObserved: cleanupEvent && input.workspaceObserved && workspaceGone && sentinelAlive,
    safetyRefusalCode: null,
    reuseVerified: false,
    mergeSha,
  };
}

async function injectRepairFault(ctx: RunContext): Promise<void> {
  const existing = await gh(ctx, ["api", `repos/${ctx.repo}/contents/src/legacy.mjs?ref=${ctx.baseBranch}`]);
  const content = Buffer.from('export function legacyGreeting() {\n  console.log("legacy debug output");\n  return "legacy";\n}\n', "utf8").toString("base64");
  const args = ["api", "-X", "PUT", `repos/${ctx.repo}/contents/src/legacy.mjs`, "-f", "message=dogfood: seed CI-only lint fault", "-f", `content=${content}`, "-f", `branch=${ctx.baseBranch}`];
  if (existing.exitCode === 0) {
    const parsed = JSON.parse(existing.stdout) as { sha: string };
    args.push("-f", `sha=${parsed.sha}`);
  }
  const res = await gh(ctx, args);
  if (res.exitCode !== 0) throw new DogfoodError(`failed to inject repair fault: ${res.stderr}`);
  await writeArtifact(ctx, "repair-fault.json", res.stdout);
}

async function runTerminalHostScenario(ctx: RunContext, templateDir: string, kind: "happy" | "repair"): Promise<DogfoodFacts> {
  await ensureLabel(ctx);
  if (kind === "repair") await injectRepairFault(ctx);
  const task = uniqueTask(ctx.runId, "subtract");
  const issueNumber = await createIssue(ctx, `Dogfood: ${task.name}`, task.body);
  const workflowPath = path.join(ctx.workRoot, "WORKFLOW.md");
  await ctx.deps.writeText(workflowPath, await renderWorkflow(templateDir, ctx));
  await prepareCommon(ctx);

  const identifier = issueIdentifier(issueNumber);
  const workspaceDir = path.join(ctx.workspaceRoot, ctx.deps.workspaceKeyOf(identifier));
  const host = await startTrackedHost(ctx, workflowPath);
  let workspaceObserved = false;
  let hostLog = "";
  try {
    await waitFor(ctx, `workspace for ${identifier}`, async () => {
      workspaceObserved ||= await ctx.deps.pathExists(workspaceDir);
      return workspaceObserved;
    }, 300, 5000);
    await waitFor(ctx, `${identifier} closed with terminal cleanup`, async () => {
      const issue = await getIssue(ctx, issueNumber);
      if (issue.state.toUpperCase() !== "CLOSED") return false;
      if (!hasCleanupCompletedFor(host.output(), identifier)) return false;
      return !(await ctx.deps.pathExists(workspaceDir));
    }, ctx.args.timeoutSeconds);
  } finally {
    await host.stop();
    hostLog = host.output();
  }
  await writeArtifact(ctx, `host-${kind}.log`, hostLog);
  return terminalFacts(ctx, { issueNumber, hostLog, workspaceObserved });
}

async function scenarioReuse(ctx: RunContext, templateDir: string): Promise<DogfoodFacts> {
  await ensureLabel(ctx);
  const task = uniqueTask(ctx.runId, "multiply");
  const issueNumber = await createIssue(ctx, `Dogfood: ${task.name}`, task.body);
  const workflowPath = path.join(ctx.workRoot, "WORKFLOW.md");
  await ctx.deps.writeText(workflowPath, await renderWorkflow(templateDir, ctx));
  await prepareCommon(ctx);
  const identifier = issueIdentifier(issueNumber);
  const workspaceDir = path.join(ctx.workspaceRoot, ctx.deps.workspaceKeyOf(identifier));
  const stateFile = path.join(workspaceDir, ".symphony", "delivery-state.json");

  // Bounded pre-merge window: hold a required check so the first head cannot be
  // merged until we deliberately release it after the graceful restart.
  await createRestartHold(ctx);
  let prBefore: PrRecord | null = null;
  let stateBefore: string | null = null;
  let workspaceObserved = false;
  let phase1Log = "";
  const phase1 = await startTrackedHost(ctx, workflowPath);
  try {
    await waitFor(ctx, "workspace created", async () => {
      workspaceObserved ||= await ctx.deps.pathExists(workspaceDir);
      return workspaceObserved;
    }, 300, 5000);
    await waitFor(ctx, `PR for ${identifier}`, async () => {
      const pr = await readOwnedPr(ctx, issueNumber);
      if (pr !== null && pr.state.toUpperCase() === "MERGED") {
        throw new DogfoodError("PR merged before the bounded restart window; reuse not proven", "no_restart_window");
      }
      return pr !== null;
    }, ctx.args.timeoutSeconds, 5000);
    prBefore = await readOwnedPr(ctx, issueNumber);
    if (prBefore === null || prBefore.state.toUpperCase() !== "OPEN") {
      throw new DogfoodError(`no pre-merge restart window (pr state=${prBefore?.state ?? "none"})`, "no_restart_window");
    }
    await waitFor(ctx, "persisted delivery state", async () => {
      stateBefore = await ctx.deps.readText(stateFile);
      return stateBefore !== null;
    }, 120, 3000);
  } finally {
    await phase1.stop();
    phase1Log = phase1.output();
    await clearRestartHold(ctx);
  }
  await writeArtifact(ctx, `reuse-before-${issueNumber}.json`, JSON.stringify(prBefore));
  await writeArtifact(ctx, `reuse-before-${issueNumber}-state.json`, stateBefore ?? "null");

  const phase2 = await startTrackedHost(ctx, workflowPath);
  let phase2Log = "";
  try {
    await waitFor(ctx, `${identifier} closed after restart`, async () => {
      const issue = await getIssue(ctx, issueNumber);
      if (issue.state.toUpperCase() !== "CLOSED") return false;
      if (!hasCleanupCompletedFor(phase2.output(), identifier)) return false;
      return !(await ctx.deps.pathExists(workspaceDir));
    }, ctx.args.timeoutSeconds);
  } finally {
    await phase2.stop();
    phase2Log = phase2.output();
  }
  const hostLog = `${phase1Log}${phase2Log}`;
  await writeArtifact(ctx, "host-reuse.log", hostLog);

  const prAfter = await readOwnedPr(ctx, issueNumber);
  const linkedPrCount = (await listIssuePrs(ctx, issueNumber)).length;
  const checks = prAfter ? await readChecks(ctx, prAfter.number) : { checks: "unknown" as CheckConclusion, mergeable: "UNKNOWN" };
  const cleanupEvent = hasCleanupCompletedFor(hostLog, identifier);
  const workspaceGone = !(await ctx.deps.pathExists(workspaceDir));
  const sentinelAlive = await ctx.deps.pathExists(path.join(ctx.workspaceRoot, ".dogfood-sentinel"));
  const samePr = prBefore !== null && (prAfter?.number ?? -1) === prBefore.number;
  const reuseVerified =
    workspaceObserved && samePr && linkedPrCount === 1 && stateBefore !== null &&
    prAfter?.state.toUpperCase() === "MERGED" && cleanupEvent && workspaceGone && sentinelAlive;
  if (prAfter) {
    const runs = await gh(ctx, ["run", "list", "--repo", ctx.repo, "--branch", prAfter.headRefName, "--limit", "30", "--json", "databaseId,headSha,conclusion,status,url,workflowName"]);
    await writeArtifact(ctx, `pr-${prAfter.number}-actions-runs.json`, runs.stdout);
  }
  const issue = await getIssue(ctx, issueNumber);
  return {
    issueClosed: issue.state.toUpperCase() === "CLOSED",
    ownedPrState: prStateOf(prAfter),
    linkedPrCount,
    checks: checks.checks,
    mergeable: checks.mergeable.toUpperCase() === "MERGEABLE",
    repairObserved: false,
    foreignPrOpen: false,
    conflicting: false,
    workspaceCleanupObserved: cleanupEvent && workspaceObserved && workspaceGone && sentinelAlive,
    safetyRefusalCode: null,
    reuseVerified,
    mergeSha: null,
  };
}

async function createRestartHold(ctx: RunContext): Promise<void> {
  const payload = JSON.stringify({
    required_status_checks: { strict: false, contexts: [HOLD_CONTEXT] },
    enforce_admins: false,
    required_pull_request_reviews: null,
    restrictions: null,
  });
  await ctx.deps.writeText(path.join(ctx.workRoot, "restart-hold.json"), payload);
  const res = await ctx.deps.runner.exec(
    `gh api -X PUT repos/${ctx.repo}/branches/${ctx.baseBranch}/protection --input restart-hold.json`,
    ctx.workRoot, 60_000, {},
  );
  if (res.exitCode !== 0) throw new DogfoodError(`failed to create restart hold: ${res.stderr}`);
  await writeArtifact(ctx, "reuse-hold.json", res.stdout || "hold created");
}

async function clearRestartHold(ctx: RunContext): Promise<void> {
  // Best-effort: the hold must never survive the run, but clearing a missing
  // protection is not an error.
  await ctx.deps.runner.exec(
    `gh api -X DELETE repos/${ctx.repo}/branches/${ctx.baseBranch}/protection`,
    ctx.workRoot, 60_000, {},
  );
}

interface LandOutcome {
  readonly exitCode: number;
  readonly code: string | null;
}

/** Run the real `symphony pr land` entry and extract its structured refusal code. */
async function runPrLand(ctx: RunContext, args: readonly string[]): Promise<LandOutcome> {
  const res = await ctx.deps.runner.exec(
    `${ctx.args.hostBinary} pr land --json ${args.join(" ")}`,
    ctx.workRoot, 120_000, {},
  ).catch((err: unknown) => ({ exitCode: 1, stdout: "", stderr: String(err) }));
  let code: string | null = null;
  for (const stream of [res.stderr, res.stdout]) {
    const text = stream.trim();
    if (text === "") continue;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") { code = parsed.error; break; }
    } catch { /* not JSON; keep looking */ }
  }
  await writeArtifact(ctx, "land-result.txt", `exit=${res.exitCode}\ncode=${code ?? "none"}\n${res.stdout}\n${res.stderr}`);
  return { exitCode: res.exitCode, code };
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
  if (pr === undefined) throw new DogfoodError("failed to locate foreign PR after creation");
  return pr;
}

async function scenarioForeign(ctx: RunContext): Promise<DogfoodFacts> {
  await ensureLabel(ctx);
  const issueNumber = await createIssue(ctx, "Dogfood: foreign PR safety", "Safety scenario: a foreign pull request must never be auto-merged.");
  const pr = await createForeignBranchAndPr(ctx);
  await writeArtifact(ctx, `foreign-pr-${pr.number}.json`, JSON.stringify(pr));
  const land = await runPrLand(ctx, [
    "--repo", ctx.repo, "--issue", String(issueNumber),
    "--workspace-key", `dogfood-foreign-${ctx.runId}`,
    "--head", pr.headRefName, "--base", ctx.baseBranch, "--pr", String(pr.number), "--opt-in",
  ]);
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
    safetyRefusalCode: land.exitCode === 1 ? land.code : null,
    reuseVerified: false,
    mergeSha: null,
  };
}

async function scenarioConflict(ctx: RunContext): Promise<DogfoodFacts> {
  await ensureLabel(ctx);
  const issueNumber = await createIssue(ctx, "Dogfood: conflicting PR safety", "Safety scenario: a conflicting owned PR must not be auto-merged.");
  const workspaceKey = `dogfood-conflict-${ctx.runId}`;
  const branch = `symphony/${workspaceKey}`;
  const base = await ghJson<{ object: { sha: string } }>(ctx, ["api", `repos/${ctx.repo}/git/ref/heads/${ctx.baseBranch}`]);
  await ghOk(ctx, ["api", "-X", "POST", `repos/${ctx.repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${base.object.sha}`]);
  const branchContent = Buffer.from(`branch side ${ctx.runId}\n`, "utf8").toString("base64");
  await ghOk(ctx, ["api", "-X", "PUT", `repos/${ctx.repo}/contents/conflict.txt`, "-f", "message=branch side", "-f", `content=${branchContent}`, "-f", `branch=${branch}`]);
  const ensure = await ctx.deps.runner.exec(
    `${ctx.args.hostBinary} pr ensure --json --repo ${ctx.repo} --issue ${issueNumber} --workspace-key ${workspaceKey} --head ${branch} --base ${ctx.baseBranch}`,
    ctx.workRoot, 120_000, {},
  ).catch((err: unknown) => ({ exitCode: 1, stdout: "", stderr: String(err) }));
  await writeArtifact(ctx, `conflict-ensure-${issueNumber}.txt`, `exit=${ensure.exitCode}\n${ensure.stdout}\n${ensure.stderr}`);
  if (ensure.exitCode !== 0) throw new DogfoodError(`failed to ensure owned conflict PR: ${ensure.stderr}`);
  const ensured = JSON.parse(ensure.stdout) as { number: number };
  // Diverge the base branch to force a real merge conflict.
  const baseContent = Buffer.from(`base side ${ctx.runId}\n`, "utf8").toString("base64");
  await ghOk(ctx, ["api", "-X", "PUT", `repos/${ctx.repo}/contents/conflict.txt`, "-f", "message=base side", "-f", `content=${baseContent}`, "-f", `branch=${ctx.baseBranch}`]);
  // GitHub computes mergeability asynchronously; wait for the conflict to appear.
  await waitFor(ctx, `PR #${ensured.number} to become conflicting`, async () => {
    const view = await ghJson<PrView>(ctx, ["pr", "view", String(ensured.number), "--repo", ctx.repo, "--json", "statusCheckRollup,mergeable,state,headRefOid,mergeCommit"]);
    return view.mergeable.toUpperCase() === "CONFLICTING";
  }, 300, 5000);
  const land = await runPrLand(ctx, [
    "--repo", ctx.repo, "--issue", String(issueNumber), "--workspace-key", workspaceKey,
    "--head", branch, "--base", ctx.baseBranch, "--pr", String(ensured.number), "--opt-in",
  ]);
  const after = await readOwnedPr(ctx, issueNumber);
  const issue = await getIssue(ctx, issueNumber);
  const view = await ghJson<PrView>(ctx, ["pr", "view", String(ensured.number), "--repo", ctx.repo, "--json", "statusCheckRollup,mergeable,state,headRefOid,mergeCommit"]);
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
    safetyRefusalCode: land.exitCode === 1 ? land.code : null,
    reuseVerified: false,
    mergeSha: null,
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

/**
 * Resolve one explicit credential. Conflicting GH_TOKEN/GITHUB_TOKEN values are
 * rejected rather than guessed. The raw value is never routed through the
 * redacting subprocess runner and never logged.
 */
export async function resolveToken(deps: DogfoodDeps): Promise<{ token: string; explicit: boolean }> {
  const candidates = [deps.env["SYMPHONY_DOGFOOD_TOKEN"], deps.env["GITHUB_TOKEN"], deps.env["GH_TOKEN"]]
    .filter((v): v is string => v !== undefined && v.trim() !== "");
  const distinct = new Set(candidates);
  if (distinct.size > 1) {
    throw new DogfoodError("conflicting GITHUB_TOKEN/GH_TOKEN values; refusing to guess the credential identity", "credential_conflict");
  }
  if (candidates.length > 0) return { token: candidates[0]!.trim(), explicit: true };
  const raw = (await deps.rawAuthToken()).trim();
  if (raw === "") throw new DogfoodError("no GitHub credential available", "missing_credential");
  return { token: raw, explicit: false };
}

async function preflight(ctx: RunContext, templateDir: string): Promise<void> {
  const auth = await ctx.deps.runner.exec("gh auth status", ctx.workRoot, 30_000, {});
  if (auth.exitCode !== 0) throw new DogfoodError("gh is not authenticated");
  const repo = await ctx.deps.runner.exec(`gh repo view ${ctx.repo} --json nameWithOwner`, ctx.workRoot, 30_000, {});
  if (repo.exitCode !== 0) throw new DogfoodError(`dogfood target ${ctx.repo} is not accessible: ${repo.stderr}`);
  const codex = await ctx.deps.runner.exec("codex login status", ctx.workRoot, 30_000, {});
  if (codex.exitCode !== 0) throw new DogfoodError("codex is not authenticated (real Codex unavailable)");
  const host = await ctx.deps.runner.exec(`${ctx.args.hostBinary} --version`, ctx.workRoot, 30_000, {});
  if (host.exitCode !== 0) throw new DogfoodError(`symphony host binary '${ctx.args.hostBinary}' is not runnable: ${host.stderr}`);
  if (!(await ctx.deps.pathExists(path.join(templateDir, "WORKFLOW.md")))) {
    throw new DogfoodError(`dogfood template '${templateDir}' does not contain WORKFLOW.md`);
  }
}

export async function runGithubDogfoodCli(
  argv: readonly string[],
  io: DogfoodIo,
  deps: DogfoodDeps = createRealDogfoodDeps(),
): Promise<number> {
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
  await deps.mkdirp(workRoot);
  const templateDir = path.resolve(args.templatePath);

  let token: string;
  let tokenExplicit = false;
  try {
    const resolved = await resolveToken(deps);
    token = resolved.token;
    tokenExplicit = resolved.explicit;
  } catch (err) {
    io.stdout.write(`SKIPPED: ${sanitizeCredentials(String(err))}\n`);
    return 0;
  }
  if (!tokenExplicit) {
    io.stderr.write("symphony dogfood: warning: using ambient `gh auth` credential; export GITHUB_TOKEN to pin the identity\n");
  }

  const ctx: RunContext = {
    args, deps, repo: gate.repo, runId, evidenceDir, workRoot,
    workspaceRoot: path.join(workRoot, "workspaces"),
    token, tokenExplicit, baseBranch: "main", io, artifacts: {}, hosts: new HostTracker(),
  };

  const startedAtMs = deps.now();
  const finalize = async (status: "passed" | "failed", reason: string, facts: DogfoodFacts | null): Promise<void> => {
    const manifest = buildEvidenceManifest({
      runId, scenario: args.scenario, target: gate.repo, startedAtMs, finishedAtMs: deps.now(),
      status, reason, facts, artifacts: ctx.artifacts,
    });
    await deps.writeText(path.join(evidenceDir, "manifest.json"), serializeEvidence(manifest, sanitizeCredentials));
    if (args.json) io.stdout.write(`${serializeEvidence(manifest, sanitizeCredentials)}\n`);
  };

  try {
    await preflight(ctx, templateDir);
    log(ctx, `dogfood: run ${runId} scenario=${args.scenario} target=${gate.repo}`);
    let facts: DogfoodFacts;
    switch (args.scenario) {
      case "happy":
      case "repair":
        facts = await runTerminalHostScenario(ctx, templateDir, args.scenario);
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
  } finally {
    // Every started host is stopped on success, failure and cancellation.
    await ctx.hosts.stopAll();
    await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
