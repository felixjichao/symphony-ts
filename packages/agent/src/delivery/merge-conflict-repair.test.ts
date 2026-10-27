import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatPrBody, type DecisionReviewTarget, type DeliveryMergeConflictRepair, type DeliveryReviewGate,
  type PersistedDeliveryState, type UtcTimestampMs } from "@symphony/domain";
import { runDeliverySkill, type RunDeliverySkillOptions } from "./delivery-skill-runner";
import { assertRepairWorkspace, executeMergeConflictRepair } from "./merge-conflict-repair";
import type { DeliveryGitGhRunner, DeliverySubprocessResult } from "./git-gh-runner";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const ok = (value: unknown): DeliverySubprocessResult => ({ stdout: JSON.stringify(value), stderr: "", exitCode: 0 });
const text = (stdout: string): DeliverySubprocessResult => ({ stdout, stderr: "", exitCode: 0 });

function fixture(issueNumber = 186, sharedOrigin?: string, launchCodex = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-repair-")); dirs.push(dir);
  const cwd = path.join(dir, "work"); const origin = sharedOrigin ?? path.join(dir, "origin.git");
  fs.mkdirSync(cwd);
  const context = { repo: "owner/repo", issueNumber, workspaceKey: `GH-${issueNumber}`,
    headBranch: `symphony/GH-${issueNumber}`, baseBranch: "main" };
  const native = (args: readonly string[], at = cwd): DeliverySubprocessResult => {
    const r = spawnSync("git", [...args], { cwd: at, encoding: "utf8" });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status ?? 1 };
  };
  const git = (args: readonly string[], at = cwd) => {
    const r = native(args, at); if (r.exitCode !== 0) throw new Error(r.stderr); return r.stdout.trim();
  };
  if (sharedOrigin) {
    git(["clone", origin, cwd], dir); git(["switch", "main"]);
  } else {
    git(["init", "--bare", origin], dir); git(["init", "-b", "main"]);
  }
  git(["config", "user.name", "Test"]); git(["config", "user.email", "test@example.invalid"]);
  if (!sharedOrigin) {
    fs.writeFileSync(path.join(cwd, "source.txt"), "original\n");
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "Preserve both implementations.\n");
    git(["add", "."]); git(["commit", "-m", "seed"]); git(["remote", "add", "origin", origin]);
  }
  git(["switch", "-c", context.headBranch]);
  fs.writeFileSync(path.join(cwd, "source.txt"), "PR implementation\n");
  fs.writeFileSync(path.join(cwd, "feature.txt"), "retained feature\n");
  git(["add", "."]); git(["commit", "-m", "feature"]); git(["push", "origin", context.headBranch]);
  const originalHead = git(["rev-parse", "HEAD"]);
  const advanceBase = (value = "main changes") => {
    // Separate checkout models another owned PR landing while this executor runs.
    const other = path.join(dir, `base-${Math.random()}`); git(["clone", origin, other], dir);
    git(["switch", "main"], other); git(["config", "user.name", "Other"] , other);
    git(["config", "user.email", "other@example.invalid"], other);
    fs.writeFileSync(path.join(other, "source.txt"), `${value}\n`);
    fs.writeFileSync(path.join(other, "base-only.txt"), `${value}\n`);
    git(["add", "."], other); git(["commit", "-m", value], other); git(["push", "origin", "main"], other);
  };
  git(["push", "origin", "main"]);
  const head = () => git(["rev-parse", `refs/heads/${context.headBranch}`], origin);
  const base = () => git(["rev-parse", "refs/heads/main"], origin);
  let state: PersistedDeliveryState | null = null;
  const states: PersistedDeliveryState[] = [];
  const storage = { readState: () => state, writeState: (value: PersistedDeliveryState) => { state = structuredClone(value); states.push(state); } };
  const calls: string[][] = [];
  const reviews: string[] = []; const approvals: string[] = []; const superseded: string[] = [];
  const targets = new Map<string, DecisionReviewTarget>();
  let merged = false; let paused = false; let repairCount = 0;
  let onApprove = (_sha: string) => {};
  let onRepair = () => {};
  let overridePr = (_args: readonly string[], _pr: Record<string, unknown>) => {};
  let failValidation = false;
  const reviewGate: DeliveryReviewGate = {
    async ensureReviewTask(sessionId, target) {
      reviews.push(target.headSha); targets.set(target.headSha, target);
      return { schemaVersion: 1, id: target.headSha, sessionId, kind: "review", revision: 1, status: "completed",
        lease: null, claimGeneration: 1, lastClaimToken: null, createdAtMs: 1 as UtcTimestampMs, updatedAtMs: 1 as UtcTimestampMs, target };
    },
    async getReviewStatus(taskId) {
      onApprove(taskId);
      return { taskId, status: "completed", result: { schemaVersion: 1, taskId, sessionId: `github:owner/repo#${issueNumber}`,
        kind: "review", revision: 1, createdAtMs: 1 as UtcTimestampMs, verdict: "approve", target: targets.get(taskId)!, findings: [] } };
    },
    async verifyReviewApproval(target) {
      approvals.push(target.headSha);
      return { approved: reviews.includes(target.headSha), reason: "exact-head fixture", headSha: target.headSha, taskId: target.headSha, verdict: "approve" };
    },
    async supersedeReviewTask(taskId) { superseded.push(taskId); },
  };
  const runner: DeliveryGitGhRunner = {
    async git(args, at) {
      calls.push([...args]);
      if (args[0] === "remote" && args[1] === "get-url") return text("https://github.com/owner/repo.git");
      return native(args, at);
    },
    async exec(command, _at, _timeout, env, excludeEnvNames) {
      calls.push(["exec", command]);
      if (command === "validate") return failValidation ? { stdout: "", stderr: "validation failure", exitCode: 1 } : text("");
      expect(excludeEnvNames).toEqual(["GITHUB_TOKEN", "GH_TOKEN"]);
      expect(command).toContain("codex exec --sandbox workspace-write -");
      expect(_at).toBe(cwd);
      expect(_timeout).toBeGreaterThan(0);
      expect(env?.SYMPHONY_REPAIR_PROMPT).toContain(env?.SYMPHONY_REPAIR_CONTEXT);
      expect(env?.SYMPHONY_REPAIR_CAUSE).toBe("merge_conflict");
      const structured = JSON.parse(env!.SYMPHONY_REPAIR_CONTEXT!);
      expect(structured.expectedHeadSha).toBe(head());
      expect(structured.conflicts).toContain("source.txt");
      repairCount++; onRepair();
      if (launchCodex) {
        const bin = path.join(dir, "bin"); fs.mkdirSync(bin);
        const executable = path.join(bin, "codex");
        fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const prompt = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(path.join(dir, "launch.json"))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), prompt }));
const context = JSON.parse(process.env.SYMPHONY_REPAIR_CONTEXT);
fs.writeFileSync("source.txt", "PR implementation\\n" + execFileSync("git", ["show", context.observedBaseSha + ":source.txt"], { encoding: "utf8" }).trim() + "\\n");
execFileSync("git", ["add", "source.txt"]);
`, { mode: 0o755 });
        const result = spawnSync("/bin/sh", ["-c", command], { cwd: _at, timeout: _timeout,
          env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
        const launched = JSON.parse(fs.readFileSync(path.join(dir, "launch.json"), "utf8"));
        expect(launched.args).toEqual(["exec", "--sandbox", "workspace-write", "-"]);
        expect(launched.cwd).toBe(cwd);
        expect(launched.prompt).toContain(env!.SYMPHONY_REPAIR_CONTEXT);
        return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? 1 };
      }
      fs.writeFileSync(path.join(cwd, "source.txt"), `PR implementation\n${git(["show", `${structured.observedBaseSha}:source.txt`])}\n`);
      git(["add", "source.txt"]);
      return text("");
    },
    async gh(args) {
      calls.push([...args]);
      if (args[0] === "issue") {
        if (args[1] === "edit") paused = true;
        return ok({ state: merged ? "CLOSED" : "OPEN", title: "feature", body: "requirements", labels: paused ? [] : [{ name: "symphony-ready" }] });
      }
      if (args[0] === "api") return ok({ title: "feature", body: formatPrBody({ context }), base: { sha: base(), ref: "main" }, head: { sha: head() } });
      if (args[1] === "merge") {
        expect(args).toContain("--match-head-commit"); expect(args.at(-1)).toBe(head());
        expect(reviews).toContain(head()); expect(approvals).toContain(head());
        expect(native(["merge-base", "--is-ancestor", base(), head()]).exitCode).toBe(0);
        expect(state?.landing?.phase).toBe("intent"); merged = true; return text("");
      }
      const pr: Record<string, unknown> = { number: issueNumber + 1, url: `https://github.com/owner/repo/pull/${issueNumber + 1}`,
        title: "feature", body: formatPrBody({ context }), state: merged ? "MERGED" : "OPEN", isDraft: false,
        headRefOid: head(), baseRefOid: base(), headRefName: context.headBranch, baseRefName: "main",
        mergeable: native(["merge-base", "--is-ancestor", base(), head()]).exitCode === 0 ? "MERGEABLE" : "CONFLICTING",
        mergeCommit: merged ? { oid: "f".repeat(40) } : null,
        statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }] };
      overridePr(args, pr);
      return args[1] === "list" ? ok([pr]) : ok(pr);
    },
  };
  let clock = Date.now();
  const options: RunDeliverySkillOptions = { ...context, cwd, runner, stateStorage: storage, resumeStageOnly: true,
    validationCommand: "validate", requiredChecks: ["gate"], reviewGate, optInLand: true,
    maxRepairAttempts: 3, maxWaitSeconds: 100, nowFn: () => clock, sleepFn: async () => { clock += 1000; } };
  return { cwd, origin, context, native, git, originalHead, advanceBase, head, base, storage, states, calls, reviews, superseded, options,
    repairCount: () => repairCount, paused: () => paused,
    setOnApprove: (fn: typeof onApprove) => { onApprove = fn; }, setOnRepair: (fn: typeof onRepair) => { onRepair = fn; },
    setPr: (fn: typeof overridePr) => { overridePr = fn; }, failValidation: () => { failValidation = true; } };
}

describe("#186 bounded pinned-base conflict repair", () => {
  it("CLI/host default dispatches Codex in the same workspace without a repository repair command", async () => {
    const f = fixture(186, undefined, true); f.advanceBase();
    // These are the shared production defaults used by delivery-skill CLI and
    // continuity host; a repository's CI repair command cannot resolve this merge.
    const result = await runDeliverySkill({ ...f.options, repairCommand: "must-not-run-ci-fix" });
    expect(result.status, result.handoffMarkdown).toBe("completed");
    expect(result.spentRepairs).toBe(1);
    expect(f.repairCount()).toBe(1);
    expect(f.reviews).toContain(f.head());
  });

  it("green + approve -> base advances -> repair -> new CI/review -> fenced merge", async () => {
    const f = fixture(); let advanced = false;
    f.setOnApprove(() => { if (!advanced) { advanced = true; f.advanceBase(); } });
    const result = await runDeliverySkill(f.options);
    expect(result.status, result.handoffMarkdown).toBe("completed"); expect(result.spentRepairs).toBe(1);
    expect(f.repairCount()).toBe(1); expect(f.paused()).toBe(false);
    expect(f.reviews).toEqual([f.originalHead, f.head()]); expect(f.superseded).toEqual([f.originalHead]);
    expect(f.git(["rev-list", "--parents", "-n", "1", "HEAD"])).toBe(`${f.head()} ${f.originalHead} ${f.base()}`);
    expect(f.git(["show", "HEAD:feature.txt"])).toBe("retained feature");
    expect(f.git(["show", "HEAD:base-only.txt"])).toBe("main changes");
    expect(f.states.find(s => s.mergeConflictRepair?.phase === "reserved")?.spentRepairs).toBe(1);
    expect(f.states.filter(s => s.mergeConflictRepair && s.mergeConflictRepair.phase !== "pushed").every(s => !s.landing && !s.isPaused)).toBe(true);
    const push = f.calls.findIndex(a => a[0] === "push");
    expect(f.calls.slice(push + 1).some(a => a.includes("headRefOid,statusCheckRollup,mergeable,state"))).toBe(true);
    expect(f.calls.flat()).not.toContain("--force");
  });

  it("base moves again during repair: re-observes, repairs pinned parents twice, reviews every HEAD", async () => {
    const f = fixture(); f.advanceBase(); const pinned = f.base();
    f.setOnRepair(() => { if (f.repairCount() === 1) f.advanceBase("second main change"); });
    const result = await runDeliverySkill(f.options);
    expect(result.status).toBe("completed"); expect(result.spentRepairs).toBe(2);
    expect(f.reviews).toHaveLength(3);
    expect(new Set(f.states.map(s => s.mergeConflictRepair?.operationId).filter(Boolean)).size).toBe(2);
    expect(f.git(["rev-parse", "HEAD~1^2"])).toBe(pinned);
    expect(f.git(["rev-parse", "HEAD^2"])).toBe(f.base());
  });

  it("multiple owned PR workspaces repair independently", async () => {
    const first = fixture(186); const second = fixture(187, first.origin); first.advanceBase();
    const results = await Promise.all([runDeliverySkill(first.options), runDeliverySkill(second.options)]);
    expect(results.map(r => r.status)).toEqual(["completed", "completed"]);
    expect(first.storage.readState()?.mergeConflictRepair?.operationId).not.toBe(second.storage.readState()?.mergeConflictRepair?.operationId);
    expect(first.repairCount()).toBe(1); expect(second.repairCount()).toBe(1);
  });

  it.each(["UNKNOWN", "read_failure", "draft", "closed", "ownership", "head_drift", "unknown_merge"])("does not repair %s", async kind => {
    const f = fixture(); f.advanceBase();
    f.setPr((args, pr) => {
      if (!args.includes("headRefOid,mergeable,state,isDraft,body,statusCheckRollup")) return;
      if (kind === "read_failure") pr.mergeable = undefined;
      if (kind === "UNKNOWN") pr.mergeable = "UNKNOWN";
      if (kind === "draft") pr.isDraft = true;
      if (kind === "closed") pr.state = "CLOSED";
      if (kind === "ownership") pr.body = "foreign";
      if (kind === "head_drift") pr.headRefOid = "e".repeat(40);
    });
    if (kind === "unknown_merge") f.setPr((args, pr) => { if (args.some(a => a.includes("mergeCommit"))) pr.mergeCommit = undefined; });
    const result = await runDeliverySkill(f.options);
    expect(result.status).toBe("blocked"); expect(result.spentRepairs).toBe(0); expect(f.repairCount()).toBe(0);
    expect(f.calls.some(a => a[0] === "merge")).toBe(false);
  });

  it.each(["dirty", "staged", "merge", "rebase"])("preserves pre-existing %s state", async kind => {
    const f = fixture(); f.advanceBase();
    if (kind === "dirty" || kind === "staged") {
      fs.writeFileSync(path.join(f.cwd, "source.txt"), "operator work\n");
      if (kind === "staged") f.git(["add", "source.txt"]);
    } else if (kind === "merge") { f.git(["fetch", "origin", "main"]); f.native(["merge", "--no-commit", f.base()]); }
    else fs.mkdirSync(path.join(f.cwd, ".git/rebase-merge"));
    const before = f.git(["status", "--porcelain"]);
    const result = await runDeliverySkill(f.options);
    expect(result.status).toBe("blocked"); expect(result.spentRepairs).toBe(0); expect(f.repairCount()).toBe(0);
    expect(f.git(["status", "--porcelain"])).toBe(before);
  });

  it.each(["budget", "validation", "no_progress", "executor_failure", "deadline"])("bounded handoff for %s", async kind => {
    const f = fixture(); f.advanceBase();
    let options = f.options;
    if (kind === "budget") options = { ...options, maxRepairAttempts: 0 };
    if (kind === "validation") f.failValidation();
    if (kind === "no_progress") options = { ...options, repairFn: () => true };
    if (kind === "executor_failure") options = { ...options, repairFn: () => false };
    if (kind === "deadline") options = { ...options, maxWaitSeconds: 0 };
    const result = await runDeliverySkill(options);
    expect(result.status).toBe("blocked"); expect(f.paused()).toBe(true);
    expect(result.spentRepairs).toBe(["budget", "deadline"].includes(kind) ? 0 : 1);
    expect(f.calls.some(a => a[0] === "push" || a[1] === "merge")).toBe(false);
    expect(result.handoffMarkdown).toContain(kind === "deadline" ? "ci_wait_timeout" : "merge_conflict");
  });

  it("legacy landing intent is cleared only after owned OPEN/null merge receipt", async () => {
    const f = fixture(); f.advanceBase();
    f.storage.writeState({ ...f.context, spentRepairs: 0, spentWaitSeconds: 0, isPaused: false, lastUpdated: "now",
      landing: { intentId: "legacy", context: f.context, prNumber: 187, headSha: f.head(), phase: "intent", optIn: true } });
    expect((await runDeliverySkill(f.options)).status).toBe("completed");
    expect(f.repairCount()).toBe(1);
  });

  it("restart after pushed receipt before CI checkpoint reconciles without executor/push replay", async () => {
    const f = fixture(); f.advanceBase();
    expect((await runDeliverySkill({ ...f.options, yieldOnWait: true })).status).toBe("waiting");
    const saved = f.storage.readState()!; const operation = saved.mergeConflictRepair!;
    f.storage.writeState({ ...saved, continuation: { ...saved.continuation!, phase: "repair_pending", headSha: operation.expectedHeadSha } });
    f.calls.splice(0);
    const result = await runDeliverySkill(f.options);
    expect(result.status, result.handoffMarkdown).toBe("completed"); expect(result.spentRepairs).toBe(1); expect(f.repairCount()).toBe(1);
    expect(f.calls.some(a => a[0] === "push" || a[0] === "merge" || a[0] === "exec")).toBe(false);
  });

  it.each(["reserved", "merging", "executing", "validating", "committing"] as const)("restart never replays uncertain %s operation", async phase => {
    const f = fixture(); f.advanceBase();
    const operation: DeliveryMergeConflictRepair = { cause: "merge_conflict", operationId: "prior", attempt: 1,
      prNumber: 187, expectedHeadSha: f.head(), baseSha: f.base(), phase };
    f.storage.writeState({ ...f.context, mergeConflictRepair: operation, spentRepairs: 1, spentWaitSeconds: 50,
      deadlineTimestampMs: Date.now() + 20_000, isPaused: false, lastUpdated: "now" });
    const result = await runDeliverySkill(f.options);
    expect(result.status).toBe("blocked"); expect(result.spentRepairs).toBe(1); expect(f.repairCount()).toBe(0);
    expect(result.handoffMarkdown).toContain("no replay");
    expect(f.storage.readState()?.deadlineTimestampMs).toBe(f.states[0]?.deadlineTimestampMs);
    expect(f.calls.some(a => ["merge", "push", "commit", "exec"].includes(a[0]!))).toBe(false);
  });

  it("push receipts reconcile remote success; unknown push result never replays", async () => {
    const f = fixture(); f.advanceBase();
    await runDeliverySkill({ ...f.options, yieldOnWait: true });
    const saved = f.storage.readState()!; const operation = saved.mergeConflictRepair!;
    // Model remote readback after push completion was lost.
    let record: DeliveryMergeConflictRepair = { ...operation, phase: "pushing" };
    const helper = { context: f.context, cwd: f.cwd, runner: f.options.runner, operation: record,
      save: async (r: DeliveryMergeConflictRepair) => { record = r; }, timeout: () => 10_000,
      validationCommand: "validate", validationTimeoutMs: 10_000, assertIdentity: async () => {} };
    f.calls.splice(0);
    expect(await executeMergeConflictRepair(helper, true)).toBe(f.head());
    expect(record.phase).toBe("pushed");
    f.setPr((_args, pr) => { pr.headRefOid = operation.expectedHeadSha; });
    await expect(executeMergeConflictRepair(helper, true)).rejects.toThrow("push_outcome_unverified");
    expect(f.calls.some(a => a[0] === "push")).toBe(false);
  });

  it("HEAD drift during the executor preserves the merge commit and refuses push", async () => {
    const f = fixture(); f.advanceBase();
    f.setPr((args, pr) => { if (f.repairCount() > 0 && args.some(a => a.includes("mergeCommit"))) pr.headRefOid = "e".repeat(40); });
    const result = await runDeliverySkill(f.options);
    expect(result.status).toBe("blocked"); expect(result.handoffMarkdown).toContain("remote_head_changed");
    expect(result.spentRepairs).toBe(1); expect(f.calls.some(a => a[0] === "push")).toBe(false);
    expect(f.git(["rev-parse", "HEAD"])).not.toBe(f.originalHead);
  });

  it.each(["read", "parse", "review"])("evidence %s failure never dispatches conflict repair", async kind => {
    const f = fixture(); f.advanceBase();
    const original = f.options.runner;
    const runner = { ...original, gh: async (args: readonly string[], cwd: string) => {
      if (args.includes("headRefOid,mergeable,state,isDraft,body,statusCheckRollup") && kind !== "review") {
        return kind === "parse" ? text("{malformed") : { stdout: "", stderr: "offline", exitCode: 1 };
      }
      return original.gh(args, cwd);
    } };
    const reviewGate = kind === "review" ? { ...f.options.reviewGate!, verifyReviewApproval: async () => ({ approved: false, reason: "receipt unavailable" }) } : f.options.reviewGate;
    const result = await runDeliverySkill({ ...f.options, runner, reviewGate });
    expect(result.status).toBe("blocked"); expect(result.spentRepairs).toBe(0); expect(f.repairCount()).toBe(0);
    expect(f.storage.readState()?.landing).toBeUndefined();
  });

  it("committed receipt resumes the single normal push without rerunning repair", async () => {
    const f = fixture(); f.advanceBase();
    await runDeliverySkill({ ...f.options, yieldOnWait: true });
    const saved = f.storage.readState()!; const operation = saved.mergeConflictRepair!;
    // Reconstruct the pre-push world with an acknowledged local commit receipt.
    f.git(["update-ref", `refs/heads/${f.context.headBranch}`, operation.expectedHeadSha], f.origin);
    f.storage.writeState({ ...saved, mergeConflictRepair: { ...operation, phase: "committed" },
      continuation: { ...saved.continuation!, headSha: operation.expectedHeadSha, phase: "repair_pending" } });
    f.calls.splice(0);
    expect((await runDeliverySkill(f.options)).status).toBe("completed");
    expect(f.repairCount()).toBe(1); expect(f.calls.filter(a => a[0] === "push")).toHaveLength(1);
    expect(f.storage.readState()?.spentRepairs).toBe(1);
  });

  it("a later CI/review commit does not replay or recover an old pushed conflict receipt", async () => {
    const f = fixture(); f.advanceBase();
    await runDeliverySkill({ ...f.options, yieldOnWait: true });
    const saved = f.storage.readState()!;
    fs.writeFileSync(path.join(f.cwd, "followup.txt"), "CI fix\n");
    f.git(["add", "followup.txt"]); f.git(["commit", "-m", "later CI repair"]); f.git(["push", "origin", f.context.headBranch]);
    f.storage.writeState({ ...saved, spentRepairs: 2, continuation: { ...saved.continuation!, headSha: f.head(), phase: "ci" } });
    f.calls.splice(0);
    const result = await runDeliverySkill(f.options);
    expect(result.status).toBe("completed"); expect(result.spentRepairs).toBe(2);
    expect(f.repairCount()).toBe(1); expect(f.calls.some(a => ["push", "merge", "commit", "exec"].includes(a[0]!))).toBe(false);
  });

  it("workspace inspector rejects unreadable state", async () => {
    const f = fixture();
    const runner = { ...f.options.runner, git: async () => ({ stdout: "", stderr: "unreadable", exitCode: 1 }) };
    await expect(assertRepairWorkspace(runner, f.cwd, f.head())).rejects.toThrow("local_head_mismatch");
  });
});
