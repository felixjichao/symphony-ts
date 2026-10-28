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

function fixture(issueNumber = 186, sharedOrigin?: string, launchCodex = false, trackedRuntime = false) {
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
    fs.writeFileSync(path.join(cwd, ".gitignore"), ".symphony/\n");
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "Preserve both implementations.\n");
    git(["add", "."]);
    if (trackedRuntime) {
      fs.mkdirSync(path.join(cwd, ".symphony"));
      fs.writeFileSync(path.join(cwd, ".symphony/tracked.json"), "inherited state");
      git(["add", "-f", ".symphony/tracked.json"]);
    }
    git(["commit", "-m", "seed"]); git(["remote", "add", "origin", origin]);
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
        expect(fs.realpathSync(launched.cwd)).toBe(fs.realpathSync(cwd));
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
    readRemoteBranch: async (repository, branch) => ({ repository, branch, sha: branch === "main" ? base() : head() }),
    validationCommand: "validate", requiredChecks: ["gate"], reviewGate, optInLand: true,
    maxRepairAttempts: 3, maxWaitSeconds: 100, nowFn: () => clock, sleepFn: async () => { clock += 1000; } };
  return { cwd, origin, context, native, git, originalHead, advanceBase, head, base, storage, states, calls, reviews, superseded, options,
    repairCount: () => repairCount, paused: () => paused,
    setOnApprove: (fn: typeof onApprove) => { onApprove = fn; }, setOnRepair: (fn: typeof onRepair) => { onRepair = fn; },
    setPr: (fn: typeof overridePr) => { overridePr = fn; }, failValidation: () => { failValidation = true; } };
}

describe("#192 transient delivery failures (real Git)", () => {
  it("T1 retries the same Review task after a timeout and lands without pausing", async () => {
    const f = fixture();
    const gate = f.options.reviewGate!;
    const reads: string[] = [];
    const result = await runDeliverySkill({ ...f.options, reviewGate: { ...gate,
      async getReviewStatus(id) {
        reads.push(id);
        if (reads.length === 1) throw new Error("ETIMEDOUT");
        return gate.getReviewStatus(id);
      },
    } });
    expect(result.status, result.handoffMarkdown).toBe("completed");
    expect(reads).toEqual([f.originalHead, f.originalHead]);
    expect(f.reviews).toEqual([f.originalHead]);
    expect(f.paused()).toBe(false);
  });

  it.each([false, true])("T2/T4 observes a delayed PR projection after one push (transport error=%s)", async transport => {
    const f = fixture(); f.advanceBase();
    let observations = 0;
    let pushes = 0;
    f.setPr((args, pr) => {
      if (pushes && args.some(a => a.includes("baseRefOid")) && observations++ < 1) pr.headRefOid = f.originalHead;
    });
    const result = await runDeliverySkill({ ...f.options, runner: { ...f.options.runner,
      async git(args, cwd, timeout) {
        const result = await f.options.runner.git(args, cwd, timeout);
        if (args[0] === "push") {
          pushes++;
          if (transport) return { stdout: "", stderr: "connection reset", exitCode: 1 };
        }
        return result;
      },
      async gh(args, cwd, timeout) {
        if (transport && pushes && args.some(a => a.includes("baseRefOid")) && observations++ === 0) {
          return { stdout: "", stderr: "connection reset", exitCode: 1 };
        }
        return f.options.runner.gh(args, cwd, timeout);
      },
    } });
    expect(result.status, result.handoffMarkdown).toBe("completed");
    expect(pushes).toBe(1); expect(f.repairCount()).toBe(1);
    expect(f.reviews).toContain(f.head()); expect(f.paused()).toBe(false);
  });

  it.each(["timeout", "auth", "corrupt", "identity", "session"])("T7/T8 rejects %s without replay or unsafe approval", async kind => {
    const f = fixture(); const gate = f.options.reviewGate!;
    let reads = 0;
    const result = await runDeliverySkill({ ...f.options, reviewGate: { ...gate,
      async getReviewStatus(id) {
        reads++;
        if (kind === "identity" || kind === "session") {
          const status = await gate.getReviewStatus(id);
          return { ...status, ...(kind === "identity" ? { taskId: "foreign" } : {}),
            ...(kind === "session" && status.result ? { result: { ...status.result, sessionId: "foreign" } } : {}) };
        }
        throw new Error(kind === "timeout" ? "ETIMEDOUT" : kind === "auth" ? "HTTP 403 forbidden" : "corrupted result");
      },
    } });
    expect(result.status).toBe("blocked");
    expect(reads).toBe(kind === "timeout" ? 3 : 1);
    expect(f.reviews).toEqual([f.originalHead]);
    expect(f.calls.filter(a => a[1] === "edit" && a.includes("--remove-label"))).toHaveLength(1);
    expect(f.calls.some(a => a[0] === "pr" && a[1] === "merge")).toBe(false);
  });

  it("T7 keeps the Review failure budget and operation across native stage yields", async () => {
    const f = fixture(); const gate = f.options.reviewGate!;
    const keys: Array<string | undefined> = [];
    const options = { ...f.options, yieldOnWait: true, reviewGate: { ...gate,
      async ensureReviewTask(session, target, context, options) {
        keys.push(options?.operationKey);
        return gate.ensureReviewTask(session, target, context, options);
      },
      async getReviewStatus() { throw new Error("fetch failed"); },
    } } satisfies RunDeliverySkillOptions;
    expect((await runDeliverySkill(options)).status).toBe("waiting");
    expect(f.storage.readState()?.isPaused).toBe(false);
    const deadline = f.storage.readState()?.deadlineTimestampMs;
    expect((await runDeliverySkill(options)).status).toBe("waiting");
    expect((await runDeliverySkill(options)).status).toBe("blocked");
    expect(new Set(keys).size).toBe(1);
    expect(f.storage.readState()?.continuation?.reviewReadFailures).toBe(3);
    expect(f.storage.readState()?.deadlineTimestampMs).toBe(deadline);
  });

  it.each(["stale", "third", "owner", "auth"])("T7/T8 push observation %s stops with one push and executor", async kind => {
    const f = fixture(); f.advanceBase(); let pushed = false; let observations = 0;
    f.setPr((args, pr) => {
      if (!pushed || !args.some(a => a.includes("baseRefOid"))) return;
      observations++;
      if (kind === "stale") pr.headRefOid = f.originalHead;
      if (kind === "third") pr.headRefOid = "e".repeat(40);
      if (kind === "owner") pr.body = "foreign";
    });
    const result = await runDeliverySkill({ ...f.options, runner: { ...f.options.runner,
      async git(args, cwd, timeout) {
        const result = await f.options.runner.git(args, cwd, timeout);
        if (args[0] === "push") pushed = true;
        return result;
      },
      async gh(args, cwd, timeout) {
        if (kind === "auth" && pushed && args.some(a => a.includes("baseRefOid"))) {
          observations++;
          return { stdout: "", stderr: "HTTP 403 forbidden", exitCode: 1 };
        }
        return f.options.runner.gh(args, cwd, timeout);
      },
    } });
    expect(result.status).toBe("blocked");
    expect(observations).toBe(kind === "stale" ? 3 : 1);
    expect(f.calls.filter(a => a[0] === "push")).toHaveLength(1);
    expect(f.repairCount()).toBe(1);
    expect(f.calls.some(a => a[0] === "pr" && a[1] === "merge")).toBe(false);
    if (kind === "stale") expect(result.handoffMarkdown).toContain("exhausted 3/3");
  });

  it("T8 HEAD movement during a transient Review read requires a fresh task and current-SHA CI", async () => {
    const f = fixture(); const gate = f.options.reviewGate!;
    const keys: Array<string | undefined> = []; let failed = false;
    const result = await runDeliverySkill({ ...f.options, reviewGate: { ...gate,
      async ensureReviewTask(session, target, context, options) {
        keys.push(options?.operationKey);
        return gate.ensureReviewTask(session, target, context, options);
      },
      async getReviewStatus(id) {
        if (!failed) {
          failed = true;
          fs.writeFileSync(path.join(f.cwd, "new-head.txt"), "new implementation");
          f.git(["add", "new-head.txt"]); f.git(["commit", "-m", "new head"]);
          f.git(["push", "origin", f.context.headBranch]);
          throw new Error("ETIMEDOUT");
        }
        return gate.getReviewStatus(id);
      },
    } });
    expect(result.status, result.handoffMarkdown).toBe("completed");
    expect(f.reviews).toEqual([f.originalHead, f.head()]);
    expect(new Set(keys).size).toBe(2);
    expect(f.superseded).toEqual([f.originalHead]);
    expect(f.paused()).toBe(false);
  });

  it("#192 host stages resolved work when the workspace-write executor cannot write Git metadata", async () => {
    const f = fixture(); f.advanceBase(); let executorCalls = 0;
    const result = await runDeliverySkill({ ...f.options, repairFn: () => {
      executorCalls++;
      fs.writeFileSync(path.join(f.cwd, "source.txt"), "PR implementation\nmain changes\n");
      // Actual Codex workspace-write protects .git; leave the resolved file unstaged.
      expect(f.git(["diff", "--name-only", "--diff-filter=U"])).toContain("source.txt");
      return true;
    } });
    expect(result.status, result.handoffMarkdown).toBe("completed");
    expect(executorCalls).toBe(1); expect(result.spentRepairs).toBe(1);
    expect(f.git(["rev-parse", "HEAD^2"])).toBe(f.base());
    expect(f.git(["show", "HEAD:source.txt"])).toBe("PR implementation\nmain changes");
  });

  it("T6 waits for new-SHA CI instead of reusing old CI and approval", async () => {
    const f = fixture(); let advanced = false; let pending = 0;
    f.setOnApprove(() => { if (!advanced) { advanced = true; f.advanceBase(); } });
    f.setPr((args, pr) => {
      if (pr.headRefOid !== f.originalHead && args.includes("headRefOid,statusCheckRollup,mergeable,state") && pending++ < 2) {
        expect(f.reviews).toEqual([f.originalHead]);
        pr.statusCheckRollup = [];
      }
    });
    const result = await runDeliverySkill(f.options);
    expect(result.status, result.handoffMarkdown).toBe("completed");
    expect(pending).toBeGreaterThanOrEqual(3);
    expect(f.reviews).toEqual([f.originalHead, f.head()]);
    expect(f.paused()).toBe(false);
  });

  it("T8 rejects an authoritative remote third SHA even when PR projection stays old", async () => {
    const f = fixture(); f.advanceBase(); let pushed = false;
    const result = await runDeliverySkill({ ...f.options,
      readRemoteBranch: async (repo, branch) => pushed && branch === f.context.headBranch
        ? { repository: repo, branch, sha: "e".repeat(40) } : f.options.readRemoteBranch!(repo, branch),
      runner: { ...f.options.runner, async git(args, cwd, timeout) {
        const result = await f.options.runner.git(args, cwd, timeout);
        if (args[0] === "push") pushed = true;
        return result;
      } },
    });
    expect(result.status).toBe("blocked");
    expect(result.handoffMarkdown).toContain("remote_head_changed");
    expect(f.calls.filter(a => a[0] === "push")).toHaveLength(1);
    expect(f.calls.some(a => a[0] === "pr" && a[1] === "merge")).toBe(false);
  });

  it("T7 post-push observation keeps the original total deadline and repair count", async () => {
    const f = fixture(); f.advanceBase(); let pushed = false;
    f.setPr((args, pr) => { if (pushed && args.some(a => a.includes("baseRefOid"))) pr.headRefOid = f.originalHead; });
    const result = await runDeliverySkill({ ...f.options, maxWaitSeconds: 1,
      runner: { ...f.options.runner, async git(args, cwd, timeout) {
        const result = await f.options.runner.git(args, cwd, timeout);
        if (args[0] === "push") pushed = true;
        return result;
      } },
    });
    expect(result.status).toBe("blocked");
    expect(result.handoffMarkdown).toContain("deadline_exhausted");
    expect(result.spentRepairs).toBe(1);
    expect(new Set(f.states.map(s => s.deadlineTimestampMs)).size).toBe(1);
    expect(f.calls.filter(a => a[0] === "push")).toHaveLength(1);
  });

  it("T5 refuses pre-staged runtime for a merge before spending budget", async () => {
    const f = fixture(); f.advanceBase();
    fs.mkdirSync(path.join(f.cwd, ".symphony"));
    fs.writeFileSync(path.join(f.cwd, ".symphony/runtime.json"), "staged runtime");
    f.git(["add", "-f", ".symphony/runtime.json"]);
    const before = f.git(["diff", "--cached"]);
    const result = await runDeliverySkill(f.options);
    expect(result.status).toBe("blocked");
    expect(result.handoffMarkdown).toContain("staged_delivery_state");
    expect(result.spentRepairs).toBe(0);
    expect(f.git(["diff", "--cached"])).toBe(before);
    expect(f.repairCount()).toBe(0);
  });

  it("staging failure cannot be mistaken for a successful source commit", async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.cwd, "new-file.txt"), "implementation");
    const result = await runDeliverySkill({ ...f.options, resumeStageOnly: false, runner: { ...f.options.runner,
      async git(args, cwd, timeout) {
        if (args[0] === "add") return { stdout: "", stderr: "index.lock exists", exitCode: 1 };
        return f.options.runner.git(args, cwd, timeout);
      },
    } });
    expect(result.status).toBe("blocked");
    expect(result.handoffMarkdown).toContain("source staging failed");
    expect(f.git(["rev-parse", "HEAD"])).toBe(f.originalHead);
    expect(f.calls.some(a => a[0] === "push" || a[0] === "commit")).toBe(false);
  });

  it.each([false, true])("T3 commits a real merge with ignored runtime files (tracked=%s)", async tracked => {
    const f = fixture(186, undefined, false, tracked); f.advanceBase();
    fs.mkdirSync(path.join(f.cwd, ".symphony"), { recursive: true });
    fs.writeFileSync(path.join(f.cwd, ".symphony/runtime.json"), "runtime");
    if (tracked) fs.writeFileSync(path.join(f.cwd, ".symphony/tracked.json"), "local runtime update");
    const result = await runDeliverySkill(f.options);
    expect(result.status, result.handoffMarkdown).toBe("completed");
    expect(f.git(["show", "HEAD:source.txt"])).toBe("PR implementation\nmain changes");
    expect(f.git(["rev-parse", "HEAD^2"])).toBe(f.base());
    expect(f.git(["ls-tree", "-r", "--name-only", "HEAD"])).not.toContain(".symphony/runtime.json");
    expect(f.git(["diff", "HEAD^", "HEAD", "--", ".symphony"])).toBe("");
    if (tracked) {
      expect(f.git(["show", "HEAD:.symphony/tracked.json"])).toBe("inherited state");
      expect(fs.readFileSync(path.join(f.cwd, ".symphony/tracked.json"), "utf8")).toBe("local runtime update");
    }
    expect(fs.readFileSync(path.join(f.cwd, ".symphony/runtime.json"), "utf8")).toBe("runtime");
  });
});

describe("#188 authoritative branch and no-op regression (isolated real Git)", () => {
  it("#171 shape: stale PR base and origin/main are HEAD's direct parent; uses remote tip and correct parents", async () => {
    const f = fixture(171);
    const oldBase = f.git(["rev-parse", "HEAD^"]);
    expect(f.git(["rev-parse", "origin/main"])).toBe(oldBase);
    f.advanceBase();
    f.setPr((_args, pr) => { pr.baseRefOid = oldBase; });
    const result = await runDeliverySkill(f.options);
    expect(result.status, result.handoffMarkdown).toBe("completed");
    expect(result.spentRepairs).toBe(1);
    expect(f.git(["rev-list", "--parents", "-n", "1", "HEAD"])).toBe(`${f.head()} ${f.originalHead} ${f.base()}`);
    expect(f.storage.readState()?.mergeConflictRepair?.baseSha).toBe(f.base());
    expect(f.calls.some(a => a[0] === "fetch" && a.at(-1) === oldBase)).toBe(false);
  });

  it("already-contained + conflicting is bounded, preserves HEAD, and consumes no budget even on resume", async () => {
    const f = fixture();
    f.setPr((_args, pr) => { pr.mergeable = "CONFLICTING"; });
    let reads = 0;
    const options = { ...f.options, readRemoteBranch: async (repository: string, branch: string) => {
      reads++; return { repository, branch, sha: f.base() };
    } };
    for (let run = 0; run < 2; run++) {
      const result = await runDeliverySkill({ ...options, resume: run > 0 });
      expect(result.status).toBe("blocked");
      expect(result.handoffMarkdown).toContain("already_contained");
      expect(result.spentRepairs).toBe(0);
    }
    expect(reads).toBe(4);
    expect(f.git(["rev-parse", "HEAD"])).toBe(f.originalHead);
    expect(f.calls.some(a => ["merge", "commit", "push", "exec"].includes(a[0]!))).toBe(false);
    expect(f.storage.readState()?.mergeConflictRepair).toBeUndefined();
  });

  it.each(["unavailable", "sha", "repo", "branch", "missing_reader", "base_identity", "head_identity", "head_drift"])("rejects %s before reservation", async kind => {
    const f = fixture(); f.advanceBase();
    f.setPr((args, pr) => {
      if (!args.some(a => a.includes("baseRefOid"))) return;
      if (kind === "base_identity") pr.baseRefName = "other";
      if (kind === "head_identity") pr.headRefName = "other";
      if (kind === "head_drift") pr.headRefOid = "e".repeat(40);
    });
    const result = await runDeliverySkill({ ...f.options,
      readRemoteBranch: kind === "missing_reader" ? undefined : async (repository, branch) => {
        if (kind === "unavailable") throw new Error("remote unavailable");
        return { repository: kind === "repo" ? "other/repo" : repository,
          branch: kind === "branch" ? "other" : branch, sha: kind === "sha" ? "bad" : f.base() };
      } });
    expect(result.status).toBe("blocked"); expect(result.spentRepairs).toBe(0);
    expect(f.calls.some(a => ["merge", "push", "commit"].includes(a[0]!))).toBe(false);
  });

  it("real clean merge needs no coding executor, still validates and reviews the new HEAD", async () => {
    const f = fixture();
    f.git(["switch", "main"]);
    fs.writeFileSync(path.join(f.cwd, "independent.txt"), "base addition\n");
    f.git(["add", "."]); f.git(["commit", "-m", "independent base"]); f.git(["push", "origin", "main"]);
    f.git(["switch", f.context.headBranch]);
    const result = await runDeliverySkill(f.options);
    expect(result.status, result.handoffMarkdown).toBe("completed");
    expect(f.repairCount()).toBe(0); expect(result.spentRepairs).toBe(1);
    expect(f.git(["rev-parse", "HEAD^2"])).toBe(f.base());
    expect(f.reviews).toContain(f.head());
    expect(f.calls.some(a => a[0] === "exec" && a[1] === "validate")).toBe(true);
  });

  it("non-conflict git failure is classified before requiring MERGE_HEAD", async () => {
    const f = fixture(); f.advanceBase();
    const runner = { ...f.options.runner, git: async (args: readonly string[], cwd: string, timeout?: number) => {
      if (args[0] === "merge") return { stdout: "", stderr: "fatal: failure", exitCode: 128 };
      return f.options.runner.git(args, cwd, timeout);
    } };
    const result = await runDeliverySkill({ ...f.options, runner });
    expect(result.handoffMarkdown).toContain("merge_conflict_merge_failed");
    expect(f.calls.some(a => a[0] === "rev-parse" && a.includes("MERGE_HEAD"))).toBe(false);
    expect(f.repairCount()).toBe(0);
  });

  it("actual no-op merge has no MERGE_HEAD and is never mistaken for a successful repair", async () => {
    const f = fixture();
    const operation: DeliveryMergeConflictRepair = { cause: "merge_conflict", operationId: "noop", attempt: 1,
      prNumber: 187, expectedHeadSha: f.originalHead, baseSha: f.base(), phase: "reserved" };
    await expect(executeMergeConflictRepair({ context: f.context, cwd: f.cwd, runner: f.options.runner,
      readRemoteBranch: f.options.readRemoteBranch, operation, save: async () => {}, timeout: () => 10_000,
      validationCommand: "validate", validationTimeoutMs: 10_000, assertIdentity: async () => {},
    })).rejects.toThrow("noop_after_reservation");
    expect(f.calls.some(a => a.includes("MERGE_HEAD"))).toBe(false);
    expect(f.calls.some(a => ["commit", "push", "exec"].includes(a[0]!))).toBe(false);
    expect(f.git(["rev-parse", "HEAD"])).toBe(f.originalHead);
  });

  it("local HEAD drift after fetch prevents reservation", async () => {
    const f = fixture(); f.advanceBase(); let fetched = false;
    const runner = { ...f.options.runner, git: async (args: readonly string[], cwd: string, timeout?: number) => {
      if (args[0] === "fetch") fetched = true;
      if (fetched && args[0] === "rev-parse" && args[1] === "HEAD") return text("e".repeat(40));
      return f.options.runner.git(args, cwd, timeout);
    } };
    const result = await runDeliverySkill({ ...f.options, runner });
    expect(result.status).toBe("blocked"); expect(result.spentRepairs).toBe(0);
    expect(result.handoffMarkdown).toContain("local_head_mismatch");
    expect(f.calls.some(a => a[0] === "merge")).toBe(false);
  });

  it("base drift between reservation and merge refuses the wrong target", async () => {
    const f = fixture(); f.advanceBase(); let reads = 0;
    const result = await runDeliverySkill({ ...f.options, readRemoteBranch: async (repository, branch) => ({
      repository, branch, sha: ++reads === 1 ? f.base() : "e".repeat(40),
    }) });
    expect(result.status).toBe("blocked"); expect(result.handoffMarkdown).toContain("target_drift_before_merge");
    expect(f.calls.some(a => a[0] === "merge")).toBe(false);
    expect(f.git(["rev-parse", "HEAD"])).toBe(f.originalHead);
  });

  it.each([false, true])("historical merging no-op recovery requires exact native authorization (authorized=%s)", async authorized => {
    const f = fixture(171); const oldBase = f.base(); f.advanceBase();
    const operation: DeliveryMergeConflictRepair = { cause: "merge_conflict", operationId: "historical-171", attempt: 1,
      prNumber: 172, expectedHeadSha: f.head(), baseSha: oldBase, phase: "merging" };
    f.storage.writeState({ ...f.context, mergeConflictRepair: operation, spentRepairs: 1, spentWaitSeconds: 7,
      deadlineTimestampMs: Date.now() + 100_000, isPaused: false, lastUpdated: "now" });
    const result = await runDeliverySkill({ ...f.options, conflictRecoveryAuthorization: authorized ? {
      operationId: operation.operationId, attempt: 1, expectedHeadSha: f.head(), executorStopped: true,
    } : undefined });
    expect(result.status, result.handoffMarkdown).toBe(authorized ? "completed" : "blocked");
    expect(result.spentRepairs).toBe(authorized ? 2 : 1);
    expect(f.repairCount()).toBe(authorized ? 1 : 0);
    if (authorized) expect(f.states.some(s => s.mergeConflictRepair?.phase === "reconciled")).toBe(true);
    else expect(result.handoffMarkdown).toContain("exact native authorization");
  });

  it("stale native authorization with no pending operation cannot start ordinary delivery", async () => {
    const f = fixture(); f.advanceBase();
    const result = await runDeliverySkill({ ...f.options, conflictRecoveryAuthorization: {
      operationId: "missing", attempt: 1, expectedHeadSha: f.head(), executorStopped: true,
    } });
    expect(result.status).toBe("blocked"); expect(result.handoffMarkdown).toContain("stale_native_authorization");
    expect(f.calls).toHaveLength(0); expect(f.storage.readState()).toBeNull();
  });

  it("restart after authorized retirement before checkpoint does not replay or refund the historical attempt", async () => {
    const f = fixture(); const expectedHeadSha = f.head();
    f.storage.writeState({ ...f.context, spentRepairs: 1, spentWaitSeconds: 0,
      isPaused: false, deadlineTimestampMs: Date.now() + 100_000, lastUpdated: "now",
      mergeConflictRepair: { cause: "merge_conflict", operationId: "retired", attempt: 1, prNumber: 187,
        expectedHeadSha, baseSha: f.base(), phase: "reconciled", outcome: "authorized_no_local_or_remote_effect" },
      continuation: { intentId: "prior", headBranch: f.context.headBranch, baseBranch: "main", headSha: expectedHeadSha,
        prNumber: 187, optInLand: true, readyLabel: "symphony-ready", maxRepairAttempts: 3, maxWaitSeconds: 100,
        validationCommand: "validate", phase: "repair_pending" } });
    f.calls.splice(0);
    const result = await runDeliverySkill(f.options);
    expect(result.status, result.handoffMarkdown).toBe("completed"); expect(result.spentRepairs).toBe(1);
    expect(f.calls.some(a => ["merge", "push", "commit", "exec"].includes(a[0]!))).toBe(false);
    expect(f.storage.readState()?.mergeConflictRepair?.phase).toBe("reconciled");
    expect(f.states.some(s => s.continuation?.phase === "ci")).toBe(true);
  });

  it.each(["operation", "attempt", "head", "dirty", "merge", "remote"])("recovery refuses stale authorization or uncertain %s facts", async kind => {
    const f = fixture(); const oldBase = f.base(); f.advanceBase();
    if (kind === "dirty") fs.writeFileSync(path.join(f.cwd, "source.txt"), "operator changes\n");
    if (kind === "merge") { f.git(["fetch", "origin", "main"]); f.native(["merge", "--no-commit", f.base()]); }
    if (kind === "remote") f.setPr((_args, pr) => { pr.headRefOid = "e".repeat(40); });
    f.storage.writeState({ ...f.context, spentRepairs: 1, spentWaitSeconds: 0, isPaused: false, lastUpdated: "now",
      mergeConflictRepair: { cause: "merge_conflict", operationId: "old", attempt: 1, prNumber: 187,
        expectedHeadSha: f.originalHead, baseSha: oldBase, phase: "merging" } });
    const before = f.git(["status", "--porcelain"]);
    const result = await runDeliverySkill({ ...f.options, conflictRecoveryAuthorization: {
      operationId: kind === "operation" ? "other" : "old", attempt: kind === "attempt" ? 2 : 1,
      expectedHeadSha: kind === "head" ? "f".repeat(40) : f.originalHead, executorStopped: true,
    } });
    expect(result.status).toBe("blocked"); expect(result.spentRepairs).toBe(1);
    expect(f.git(["status", "--porcelain"])).toBe(before);
    expect(f.calls.some(a => ["merge", "push", "commit", "exec"].includes(a[0]!))).toBe(false);
  });
});

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
      readRemoteBranch: f.options.readRemoteBranch,
      save: async (r: DeliveryMergeConflictRepair) => { record = r; }, timeout: () => 10_000,
      validationCommand: "validate", validationTimeoutMs: 10_000, assertIdentity: async () => {} };
    f.calls.splice(0);
    expect(await executeMergeConflictRepair(helper, true)).toBe(f.head());
    expect(record.phase).toBe("pushed");
    f.setPr((_args, pr) => { pr.headRefOid = operation.expectedHeadSha; });
    await expect(executeMergeConflictRepair(helper, true)).rejects.toThrow("push_not_confirmed");
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
