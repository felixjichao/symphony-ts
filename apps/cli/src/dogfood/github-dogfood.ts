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
import { createHash } from "node:crypto";
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
  readonly removeDir: (dir: string) => Promise<void>;
  readonly pathExists: (target: string) => Promise<boolean>;
  /** Read the real credential without any redaction. Never logged. */
  readonly rawAuthToken: () => Promise<string>;
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly workspaceKeyOf: (identifier: string) => string;
  /** Optional test seam: install signal handlers, returning an uninstall function. */
  readonly installSignals?: ((handler: (signal: NodeJS.Signals) => void) => () => void) | undefined;
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
      const child: ChildProcess = spawn(command, [...args], {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: opts.env,
        // Own process group so SIGINT/SIGKILL can be delivered to the whole
        // Symphony host + Codex subtree, never just the direct child.
        detached: true,
      });
      const collect = (chunk: Buffer): void => { output += chunk.toString("utf8"); };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const exited = new Promise<number>((resolve) => { child.on("close", (code) => resolve(code ?? 0)); });
      child.on("error", () => { /* surfaced through the exit code and later assertions */ });
      return {
        output: () => output,
        async stop(): Promise<number> {
          if (child.exitCode !== null) return child.exitCode;
          signalProcessGroup(child.pid, "SIGINT");
          const timed = await Promise.race([exited, new Promise<number>((r) => setTimeout(() => r(-1), 30_000))]);
          if (timed === -1) {
            signalProcessGroup(child.pid, "SIGKILL");
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
    removeDir: async (dir) => { await rm(dir, { recursive: true, force: true }); },
    pathExists: async (target) => { try { await stat(target); return true; } catch { return false; } },
    rawAuthToken: async () => {
      const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
      if (result.error) {
        throw new DogfoodError("gh CLI is not available (tool/infrastructure failure)", "tool_missing");
      }
      if (result.status !== 0) {
        const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        if (/auth login|not logged|not authenticated|no oauth|authentication/i.test(detail)) {
          throw new DogfoodError("no GitHub credential: run 'gh auth login' or export GITHUB_TOKEN", "missing_credential");
        }
        throw new DogfoodError(`failed to read GitHub credential from gh: ${sanitizeCredentials(detail.trim())}`, "tool_error");
      }
      const token = (result.stdout ?? "").trim();
      if (token === "") throw new DogfoodError("gh returned an empty token", "missing_credential");
      return token;
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

/** Signal a whole detached process group, falling back to the direct PID. */
function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
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
  readonly cancellation: { cancelled: boolean; exitCode: number; promise: Promise<void>; resolve: () => void };
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
    if (ctx.cancellation.cancelled) throw new DogfoodError("cancelled by signal", "cancelled");
    if (await predicate()) return;
    log(ctx, `dogfood: waiting for ${label}...`);
    // Wake promptly on cancellation instead of waiting out the full interval.
    await Promise.race([ctx.deps.sleep(intervalMs), ctx.cancellation.promise]);
  }
  if (ctx.cancellation.cancelled) throw new DogfoodError("cancelled by signal", "cancelled");
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

async function readChecks(ctx: RunContext, prNumber: number): Promise<{ checks: CheckConclusion; mergeable: string; headRefOid: string; mergeSha: string | null }> {
  const view = await ghJson<PrView>(ctx, ["pr", "view", String(prNumber), "--repo", ctx.repo, "--json", "statusCheckRollup,mergeable,state,headRefOid,mergeCommit"]);
  const rollup = view.statusCheckRollup ?? [];
  const states = rollup.map((entry) => mapCheckState(String(entry["conclusion"] ?? entry["state"] ?? "")));
  let checks: CheckConclusion = "unknown";
  if (states.length > 0) {
    if (states.some((s) => s === "failure")) checks = "failure";
    else if (states.some((s) => s === "pending" || s === "unknown")) checks = "pending";
    else if (states.every((s) => s === "success")) checks = "success";
  }
  return { checks, mergeable: view.mergeable, headRefOid: view.headRefOid, mergeSha: view.mergeCommit?.oid ?? null };
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

function uniqueTask(runId: string, scenario: string, verb: string): { name: string; body: string } {
  // Stable, collision-resistant suffix over the full run id and scenario, so
  // distinct runs (even in the same second) and scenarios never share a name.
  const suffix = createHash("sha256").update(`${runId}:${scenario}`).digest("hex").slice(0, 10);
  const name = `${verb}_${suffix}`;
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
  const checks = pr ? await readChecks(ctx, pr.number) : { checks: "unknown" as CheckConclusion, mergeable: "UNKNOWN", headRefOid: "", mergeSha: null };
  const repairObserved = pr ? await readRepairObserved(ctx, pr.headRefName) : false;
  const linkedPrCount = (await listIssuePrs(ctx, input.issueNumber)).length;
  const cleanupEvent = hasCleanupCompletedFor(input.hostLog, identifier);
  const workspaceGone = !(await ctx.deps.pathExists(workspaceDir));
  const sentinelAlive = await ctx.deps.pathExists(path.join(ctx.workspaceRoot, ".dogfood-sentinel"));
  let ciRunMatched = false;
  await writeArtifact(ctx, `issue-${input.issueNumber}-final.json`, JSON.stringify(issue));
  if (pr) {
    await writeArtifact(ctx, `pr-${pr.number}-checks.json`, JSON.stringify(checks));
    const runs = await gh(ctx, ["run", "list", "--repo", ctx.repo, "--branch", pr.headRefName, "--limit", "30", "--json", "databaseId,headSha,conclusion,status,url,workflowName"]);
    await writeArtifact(ctx, `pr-${pr.number}-actions-runs.json`, runs.stdout);
    const mergeView = await gh(ctx, ["pr", "view", String(pr.number), "--repo", ctx.repo, "--json", "mergeCommit,mergedAt,state,headRefOid"]);
    await writeArtifact(ctx, `pr-${pr.number}-merge.json`, mergeView.stdout);
    ciRunMatched = parseRunsMatchHead(runs.stdout, checks.headRefOid);
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
    mergeSha: checks.mergeSha,
    ciRunMatched,
  };
}

/** True when the recorded Actions runs contain a success bound to the head SHA. */
export function parseRunsMatchHead(runsJson: string, headSha: string): boolean {
  if (headSha === "") return false;
  let runs: ReadonlyArray<{ headSha?: string; conclusion?: string }>;
  try {
    runs = JSON.parse(runsJson || "[]") as ReadonlyArray<{ headSha?: string; conclusion?: string }>;
  } catch {
    return false;
  }
  if (!Array.isArray(runs)) return false;
  return runs.some((run) => run.headSha === headSha && (run.conclusion ?? "").toUpperCase() === "SUCCESS");
}

/** Absolute CI-wait deadline persisted by the delivery skill, if present. */
export function parsePersistedDeadline(stateText: string | null): number | null {
  if (stateText === null) return null;
  try {
    const parsed = JSON.parse(stateText) as { deadlineTimestampMs?: unknown };
    return typeof parsed.deadlineTimestampMs === "number" ? parsed.deadlineTimestampMs : null;
  } catch {
    return null;
  }
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
  const task = uniqueTask(ctx.runId, kind, "subtract");
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
    // Always capture the sanitized host log, including on failure/timeout.
    await writeArtifact(ctx, `host-${kind}.log`, hostLog).catch(() => undefined);
  }
  return terminalFacts(ctx, { issueNumber, hostLog, workspaceObserved });
}

async function scenarioReuse(ctx: RunContext, templateDir: string): Promise<DogfoodFacts> {
  await ensureLabel(ctx);
  const task = uniqueTask(ctx.runId, "reuse", "multiply");
  const issueNumber = await createIssue(ctx, `Dogfood: ${task.name}`, task.body);
  const workflowPath = path.join(ctx.workRoot, "WORKFLOW.md");
  await ctx.deps.writeText(workflowPath, await renderWorkflow(templateDir, ctx));
  await prepareCommon(ctx);
  const identifier = issueIdentifier(issueNumber);
  const workspaceDir = path.join(ctx.workspaceRoot, ctx.deps.workspaceKeyOf(identifier));
  const stateFile = path.join(workspaceDir, ".symphony", "delivery-state.json");

  // Bounded pre-merge window: add a required check we can release, preserving
  // and exactly restoring any pre-existing branch protection afterwards. The
  // mutation and its restore are both inside the try/finally.
  const snapshot = await readProtection(ctx);
  let prBefore: PrRecord | null = null;
  let stateBefore: string | null = null;
  let workspaceObserved = false;
  let phase1Log = "";
  let holdApplied = false;
  let phase1: DogfoodHostHandle | null = null;
  try {
    await applyRestartHold(ctx, snapshot);
    holdApplied = true;
    phase1 = await startTrackedHost(ctx, workflowPath);
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
    if (phase1 !== null) {
      await phase1.stop();
      phase1Log = phase1.output();
      await writeArtifact(ctx, "host-reuse-phase1.log", phase1Log).catch(() => undefined);
    }
    if (holdApplied) await restoreProtection(ctx, snapshot);
  }
  await writeArtifact(ctx, `reuse-before-${issueNumber}.json`, JSON.stringify(prBefore));
  await writeArtifact(ctx, `reuse-before-${issueNumber}-state.json`, stateBefore ?? "null");

  const phase2 = await startTrackedHost(ctx, workflowPath);
  // The persisted absolute CI-wait deadline from phase 1 must still be present at
  // restart, proving the resume preserved the budget instead of resetting it.
  const stateAtRestart = await ctx.deps.readText(stateFile);
  await writeArtifact(ctx, `reuse-restart-${issueNumber}-state.json`, stateAtRestart ?? "null");
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
    await writeArtifact(ctx, "host-reuse-phase2.log", phase2Log).catch(() => undefined);
  }
  const hostLog = `${phase1Log}${phase2Log}`;
  await writeArtifact(ctx, "host-reuse.log", hostLog);

  const prAfter = await readOwnedPr(ctx, issueNumber);
  const linkedPrCount = (await listIssuePrs(ctx, issueNumber)).length;
  const checks = prAfter
    ? await readChecks(ctx, prAfter.number)
    : { checks: "unknown" as CheckConclusion, mergeable: "UNKNOWN", headRefOid: "", mergeSha: null };
  const cleanupEvent = hasCleanupCompletedFor(hostLog, identifier);
  const workspaceGone = !(await ctx.deps.pathExists(workspaceDir));
  const sentinelAlive = await ctx.deps.pathExists(path.join(ctx.workspaceRoot, ".dogfood-sentinel"));
  const samePr = prBefore !== null && (prAfter?.number ?? -1) === prBefore.number;
  const sameBranch = prBefore !== null && prAfter !== null && prAfter.headRefName === prBefore.headRefName;
  const deadlineBefore = parsePersistedDeadline(stateBefore);
  const deadlineAtRestart = parsePersistedDeadline(stateAtRestart);
  const budgetPreserved = deadlineBefore !== null && deadlineAtRestart === deadlineBefore;
  const reuseVerified =
    workspaceObserved && samePr && sameBranch && budgetPreserved && linkedPrCount === 1 && stateBefore !== null &&
    prAfter?.state.toUpperCase() === "MERGED" && cleanupEvent && workspaceGone && sentinelAlive;
  let ciRunMatched = false;
  if (prAfter) {
    const runs = await gh(ctx, ["run", "list", "--repo", ctx.repo, "--branch", prAfter.headRefName, "--limit", "30", "--json", "databaseId,headSha,conclusion,status,url,workflowName"]);
    await writeArtifact(ctx, `pr-${prAfter.number}-actions-runs.json`, runs.stdout);
    ciRunMatched = parseRunsMatchHead(runs.stdout, checks.headRefOid);
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
    mergeSha: checks.mergeSha,
    ciRunMatched,
  };
}

const PROTECTION_BOOLEAN_KEYS = [
  "enforce_admins", "required_linear_history", "allow_force_pushes", "allow_deletions",
  "block_creations", "required_conversation_resolution", "lock_branch", "allow_fork_syncing",
] as const;

interface ProtectionSnapshot {
  readonly existed: boolean;
  readonly body: string | null;
}

function asEnabled(value: unknown): boolean {
  if (value !== null && typeof value === "object" && "enabled" in value) {
    return Boolean((value as { enabled?: unknown }).enabled);
  }
  return Boolean(value);
}

/** Map GET `users`/`teams`/`apps` objects to the login/slug form PUT expects. */
function convertRestrictions(value: unknown): { users: string[]; teams: string[]; apps?: string[] } | null {
  if (value === null || value === undefined) return null;
  const record = value as { users?: unknown; teams?: unknown; apps?: unknown };
  const logins = (input: unknown, key: string): string[] =>
    Array.isArray(input) ? input.map((entry) => (typeof entry === "string" ? entry : String((entry as Record<string, unknown>)[key] ?? ""))).filter(Boolean) : [];
  const result: { users: string[]; teams: string[]; apps?: string[] } = {
    users: logins(record.users, "login"),
    teams: logins(record.teams, "slug"),
  };
  const apps = logins(record.apps, "slug");
  if (apps.length > 0) result.apps = apps;
  return result;
}

function convertRequiredStatusChecks(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const record = value as { strict?: unknown; contexts?: unknown; checks?: unknown };
  if (Array.isArray(record.checks)) {
    const checks = record.checks.map((entry) => {
      const check = entry as { context?: unknown; app_id?: unknown };
      const mapped: Record<string, unknown> = { context: String(check.context ?? "") };
      // Preserve the app binding so an app-scoped required check survives restore.
      if (check.app_id !== undefined && check.app_id !== null) mapped["app_id"] = check.app_id;
      return mapped;
    });
    return { strict: Boolean(record.strict), checks, contexts: checks.map((c) => c["context"]) };
  }
  const contexts = Array.isArray(record.contexts) ? record.contexts.map(String) : [];
  return { strict: Boolean(record.strict), contexts };
}

function convertRequiredReviews(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {
    dismiss_stale_reviews: Boolean(record["dismiss_stale_reviews"]),
    require_code_owner_reviews: Boolean(record["require_code_owner_reviews"]),
    required_approving_review_count: Number(record["required_approving_review_count"] ?? 0),
  };
  if (record["dismissal_restrictions"] !== undefined) result["dismissal_restrictions"] = convertRestrictions(record["dismissal_restrictions"]);
  if (record["bypass_pull_request_allowances"] !== undefined) result["bypass_pull_request_allowances"] = convertRestrictions(record["bypass_pull_request_allowances"]);
  if (record["require_last_push_approval"] !== undefined) result["require_last_push_approval"] = Boolean(record["require_last_push_approval"]);
  return result;
}

/**
 * Convert a branch-protection GET body into a valid PUT payload, preserving
 * null semantics and app bindings. `extraContext` adds a required check (used
 * for the restart hold); pass null to restore the original exactly.
 */
export function buildProtectionPutPayload(getBody: string | null, extraContext: string | null): string {
  let body: Record<string, unknown> = {};
  if (getBody !== null && getBody.trim() !== "") {
    body = JSON.parse(getBody) as Record<string, unknown>;
  }
  const payload: Record<string, unknown> = {
    required_status_checks: convertRequiredStatusChecks(body["required_status_checks"] ?? null),
    enforce_admins: body["enforce_admins"] !== undefined ? asEnabled(body["enforce_admins"]) : false,
    required_pull_request_reviews: convertRequiredReviews(body["required_pull_request_reviews"] ?? null),
    restrictions: convertRestrictions(body["restrictions"] ?? null),
  };
  for (const key of PROTECTION_BOOLEAN_KEYS) {
    if (key in body) payload[key] = asEnabled(body[key]);
  }
  if (extraContext !== null) {
    const current = payload["required_status_checks"] as { strict?: boolean; contexts?: string[]; checks?: Array<Record<string, unknown>> } | null;
    const contexts = [...(current?.contexts ?? [])];
    const checks = [...(current?.checks ?? [])];
    if (!contexts.includes(extraContext)) contexts.push(extraContext);
    if (!checks.some((c) => c["context"] === extraContext)) checks.push({ context: extraContext });
    payload["required_status_checks"] = { strict: current?.strict ?? false, contexts, checks };
  }
  return JSON.stringify(payload);
}

/** Read the current branch protection so the hold can restore it exactly. */
async function readProtection(ctx: RunContext): Promise<ProtectionSnapshot> {
  const res = await gh(ctx, ["api", `repos/${ctx.repo}/branches/${ctx.baseBranch}/protection`]);
  if (res.exitCode === 0) return { existed: true, body: res.stdout };
  if (/404|not found/i.test(`${res.stderr}${res.stdout}`)) return { existed: false, body: null };
  throw new DogfoodError(`failed to read branch protection: ${res.stderr}`);
}

async function putProtection(ctx: RunContext, payload: string, label: string): Promise<void> {
  await ctx.deps.writeText(path.join(ctx.workRoot, "protection.json"), payload);
  const res = await ctx.deps.runner.exec(
    `gh api -X PUT repos/${ctx.repo}/branches/${ctx.baseBranch}/protection --input protection.json`,
    ctx.workRoot, 60_000, {},
  );
  if (res.exitCode !== 0) throw new DogfoodError(`failed to ${label}: ${res.stderr}`);
  // Evidence capture is best-effort: the PUT side effect already happened and
  // must never be un-restorable because an artifact write failed.
  await writeArtifact(ctx, "reuse-protection.json", `${label}\n${res.stdout}`).catch(() => undefined);
}

/** Add a required check that cannot be satisfied until the harness removes it. */
async function applyRestartHold(ctx: RunContext, snapshot: ProtectionSnapshot): Promise<void> {
  await putProtection(ctx, buildProtectionPutPayload(snapshot.body, HOLD_CONTEXT), "apply restart hold");
}

/** Restore the exact prior protection (or delete ours when none existed). */
async function restoreProtection(ctx: RunContext, snapshot: ProtectionSnapshot): Promise<void> {
  const expected = buildProtectionPutPayload(snapshot.body, null);
  if (snapshot.existed) {
    await putProtection(ctx, expected, "restore branch protection");
  } else {
    const res = await ctx.deps.runner.exec(
      `gh api -X DELETE repos/${ctx.repo}/branches/${ctx.baseBranch}/protection`,
      ctx.workRoot, 60_000, {},
    );
    if (res.exitCode !== 0 && !/404|not found/i.test(`${res.stderr}${res.stdout}`)) {
      throw new DogfoodError(`failed to remove restart hold: ${res.stderr}`);
    }
  }
  // Read back and confirm the restored shape matches the snapshot.
  const after = await readProtection(ctx);
  if (after.existed !== snapshot.existed) {
    throw new DogfoodError(`branch protection restore mismatch: existed ${after.existed}, expected ${snapshot.existed}`);
  }
  if (snapshot.existed && buildProtectionPutPayload(after.body, null) !== expected) {
    throw new DogfoodError("branch protection restore mismatch: restored payload differs from snapshot");
  }
}

interface LandOutcome {
  readonly exitCode: number;
  readonly code: string | null;
}

/**
 * Extract the structured `{ error }` code emitted by the real `symphony pr`
 * CLI (DeliveryError → JSON on stderr). Pure and exported so a test can drive
 * the real service + CLI and assert the harness reads the same contract.
 */
export function parseStructuredErrorCode(stdout: string, stderr: string): string | null {
  for (const stream of [stderr, stdout]) {
    const text = stream.trim();
    if (text === "") continue;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") return parsed.error;
    } catch { /* not JSON; keep looking */ }
  }
  return null;
}

/** Run the real `symphony pr land` entry and extract its structured refusal code. */
async function runPrLand(ctx: RunContext, args: readonly string[]): Promise<LandOutcome> {
  const res = await ctx.deps.runner.exec(
    `${ctx.args.hostBinary} pr land --json ${args.join(" ")}`,
    ctx.workRoot, 120_000, {},
  ).catch((err: unknown) => ({ exitCode: 1, stdout: "", stderr: String(err) }));
  const code = parseStructuredErrorCode(res.stdout, res.stderr);
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
    ciRunMatched: false,
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
    ciRunMatched: false,
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
    const code = err instanceof DogfoodError ? err.code : "dogfood_error";
    if (code === "missing_credential") {
      io.stdout.write(`SKIPPED: ${sanitizeCredentials(String(err))}\n`);
      return 0;
    }
    // A conflicting credential (or any other configuration failure) after
    // explicit opt-in is a hard error, never a silent skip.
    io.stderr.write(`symphony dogfood: ${sanitizeCredentials(String(err))}\n`);
    return 1;
  }
  if (!tokenExplicit) {
    io.stderr.write("symphony dogfood: warning: using ambient `gh auth` credential; export GITHUB_TOKEN to pin the identity\n");
  }

  // Pin the single selected identity for EVERY GitHub operation — harness gh,
  // preflight, scenario setup, delivery and the host — so no call falls back to
  // a different ambient credential.
  deps.env["GH_TOKEN"] = token;
  deps.env["GITHUB_TOKEN"] = token;

  const cancellation: RunContext["cancellation"] = (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { cancelled: false, exitCode: 0, promise, resolve };
  })();

  const ctx: RunContext = {
    args, deps, repo: gate.repo, runId, evidenceDir, workRoot,
    workspaceRoot: path.join(workRoot, "workspaces"),
    token, tokenExplicit, baseBranch: "main", io, artifacts: {}, hosts: new HostTracker(),
    cancellation,
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

  // SIGINT/SIGTERM request cancellation of the main chain: stop the whole
  // host/Codex subtree, wake any wait, and let the scenario's own finally
  // (branch-protection restore, log capture) run before the exit code is
  // returned. Never call process.exit from here — that would bypass cleanup.
  const onSignal = (signal: NodeJS.Signals): void => {
    if (cancellation.cancelled) return;
    cancellation.cancelled = true;
    cancellation.exitCode = signal === "SIGINT" ? 130 : 143;
    cancellation.resolve();
    void ctx.hosts.stopAll();
  };
  const uninstallSignals = (deps.installSignals ?? defaultInstallSignals)(onSignal);

  let passed = false;
  let result = 1;
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
    passed = verdict.status === "passed";
    result = passed ? 0 : 1;
  } catch (err) {
    const message = sanitizeCredentials(String(err));
    await finalize("failed", message, null).catch(() => undefined);
    io.stderr.write(`symphony dogfood: failed: ${message}\n`);
    result = 1;
  } finally {
    uninstallSignals();
    // Every started host is stopped on success, failure and cancellation.
    await ctx.hosts.stopAll();
    // Only a clean success removes the run working directory. Failed or
    // cancelled runs keep the workspace and persisted delivery state so the
    // flow can be resumed, and keep the captured failure evidence.
    if (passed) await deps.removeDir(workRoot).catch(() => undefined);
  }
  return cancellation.cancelled ? cancellation.exitCode : result;
}

function defaultInstallSignals(handler: (signal: NodeJS.Signals) => void): () => void {
  const onInt = (): void => handler("SIGINT");
  const onTerm = (): void => handler("SIGTERM");
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  return () => {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
  };
}
