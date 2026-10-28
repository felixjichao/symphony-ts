/** #192 / SPEC §8/§9/§14 adjacent, §17/§18: actual CLI authority + file
 * storage + real Git; only GitHub, independent reviewer and executor are injected. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatPrBody, type DecisionReviewTarget, type DeliveryReviewGate, type UtcTimestampMs } from "@symphony/domain";
import type { DeliveryGitGhRunner } from "@symphony/agent";
import { runDeliverySkillCli, FileDeliveryStateStorage } from "./delivery-skill-cli";

const context = { repo: "owner/repo", issueNumber: 192, workspaceKey: "GH-192", headBranch: "symphony/GH-192", baseBranch: "main" };
const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });
const json = (v: unknown) => ok(JSON.stringify(v));

describe("#192 CLI source isolation and transient observations", () => {
  it.each(["initial", "ci", "review", "conflict"])("T5 %s delivery commits source, preserves staged runtime and finishes", async stage => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-cli-192-"));
    const cwd = path.join(root, "work"); fs.mkdirSync(cwd);
    const native = (args: readonly string[]) => {
      const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? 1 };
    };
    const git = (args: readonly string[]) => {
      const result = native(args); if (result.exitCode) throw new Error(result.stderr); return result.stdout.trim();
    };
    try {
      git(["init", "--bare", path.join(root, "remote.git")]); git(["init", "-b", context.headBranch]);
      git(["config", "user.name", "Test"]); git(["config", "user.email", "test@example.invalid"]);
      fs.writeFileSync(path.join(cwd, "source.txt"), "seed\n");
      fs.writeFileSync(path.join(cwd, ".gitignore"), ".symphony/\n");
      git(["add", "."]); git(["commit", "-m", "seed"]);
      let base = git(["rev-parse", "HEAD"]);
      git(["remote", "add", "origin", path.join(root, "remote.git")]);
      if (stage === "conflict") {
        git(["switch", "-c", "main"]);
        fs.writeFileSync(path.join(cwd, "source.txt"), "main implementation\n");
        git(["add", "source.txt"]); git(["commit", "-m", "main changes"]); git(["push", "origin", "main"]);
        base = git(["rev-parse", "HEAD"]); git(["switch", context.headBranch]);
      }
      fs.mkdirSync(path.join(cwd, ".symphony"));
      fs.writeFileSync(path.join(cwd, ".symphony/runtime.json"), "staged runtime\n");
      if (stage !== "conflict") git(["add", "-f", ".symphony/runtime.json"]);
      fs.writeFileSync(path.join(cwd, "source.txt"), "implementation\n");
      const calls: string[][] = []; const reviews: string[] = [];
      let repaired = false; let merged = false; let transientReads = 0;
      let conflictPushes = 0; let projectionReads = 0; let refReads = 0; let executorCalls = 0;
      const head = () => git(["rev-parse", "HEAD"]);
      const runner: DeliveryGitGhRunner = {
        async git(args) {
          calls.push([...args]);
          if (args[0] === "remote" && args[1] === "get-url") return ok("https://github.com/owner/repo.git");
          const result = native(args);
          if (args[0] === "push" && stage === "conflict" && git(["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ").length === 3) {
            conflictPushes++;
            return { stdout: "", stderr: "connection reset after successful push", exitCode: 1 };
          }
          return result;
        },
        async exec(command, _cwd, _timeout, env) {
          if (command === "repair") {
            repaired = true;
            fs.writeFileSync(path.join(cwd, "source.txt"), "repaired implementation\n");
          } else if (env?.SYMPHONY_REPAIR_CAUSE === "merge_conflict") {
            executorCalls++; repaired = true;
            fs.writeFileSync(path.join(cwd, "source.txt"), "implementation\nmain implementation\n");
            expect(git(["diff", "--name-only", "--diff-filter=U"])).toBe("source.txt");
          } else expect(command).toBe("validate");
          return ok();
        },
        async gh(args) {
          calls.push([...args]);
          if (args[0] === "issue") return json({ state: merged ? "CLOSED" : "OPEN", title: "test", body: "requirements", labels: [{ name: "symphony-ready" }] });
          if (args[0] === "run") return args[1] === "list" ? json([{ databaseId: 1, conclusion: "FAILURE", name: "gate" }]) : ok("gate failed");
          if (args[0] === "api" && args[1]?.includes("/git/ref/heads/")) {
            if (conflictPushes && refReads++ === 0) return { stdout: "", stderr: "ETIMEDOUT", exitCode: 1 };
            const branch = decodeURIComponent(args[1].split("/git/ref/heads/")[1]!);
            return json({ ref: `refs/heads/${branch}`, object: { type: "commit", sha: git(["--git-dir", path.join(root, "remote.git"), "rev-parse", `refs/heads/${branch}`]) } });
          }
          if (args[0] === "api") return json({ base: { sha: base, ref: "main" }, head: { sha: head() } });
          if (args[1] === "merge") { expect(args).toContain(head()); merged = true; return ok(); }
          const remote = native(["--git-dir", path.join(root, "remote.git"), "rev-parse", `refs/heads/${context.headBranch}`]);
          const pr = { number: 193, url: "https://github.com/owner/repo/pull/193", state: merged ? "MERGED" : "OPEN",
            isDraft: false, body: formatPrBody({ context }), headRefOid: remote.exitCode === 0 ? remote.stdout.trim() : head(), baseRefOid: base,
            headRefName: context.headBranch, baseRefName: "main", mergeable: stage === "conflict" && native(["merge-base", "--is-ancestor", base, head()]).exitCode !== 0 ? "CONFLICTING" : "MERGEABLE", mergeCommit: merged ? { oid: "f".repeat(40) } : null,
            statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: stage === "ci" && !repaired ? "FAILURE" : "SUCCESS",
              detailsUrl: "https://github.com/owner/repo/actions/runs/1/job/1" }] };
          if (conflictPushes && args.some(a => a.includes("baseRefOid")) && projectionReads++ === 0) pr.headRefOid = reviews[0]!;
          return args[1] === "list" ? json([pr]) : json(pr);
        },
      };
      const targets = new Map<string, DecisionReviewTarget>();
      const gate: DeliveryReviewGate = {
        async ensureReviewTask(sessionId, target) {
          reviews.push(target.headSha); targets.set(target.headSha, target);
          return { schemaVersion: 1, id: target.headSha, sessionId, kind: "review", revision: 1, status: "completed", lease: null,
            claimGeneration: 1, lastClaimToken: null, createdAtMs: 1 as UtcTimestampMs, updatedAtMs: 1 as UtcTimestampMs, target };
        },
        async getReviewStatus(taskId) {
          if (stage === "initial" && transientReads++ === 0) throw new Error("ETIMEDOUT");
          return { taskId, status: "completed", result: { schemaVersion: 1, taskId, sessionId: "github:owner/repo#192", kind: "review", revision: 1,
            createdAtMs: 1 as UtcTimestampMs, target: targets.get(taskId)!, verdict: stage === "review" && !repaired ? "changes_requested" : "approve",
            findings: stage === "review" && !repaired ? [{ severity: "blocker", message: "repair source", location: "source.txt:1" }] : [] } };
        },
        async verifyReviewApproval(target) { return { approved: true, reason: "exact head", headSha: target.headSha, taskId: target.headSha, verdict: "approve" }; },
      };
      let stdout = ""; let stderr = "";
      const code = await runDeliverySkillCli(["run", "--repo", context.repo, "--issue", "192", "--cwd", cwd,
        "--validate", "validate", "--repair-cmd", "repair", "--required-checks", "gate", "--opt-in", "--max-wait", "60"],
      { stdout: { write: v => { stdout += v; } }, stderr: { write: v => { stderr += v; } } }, runner, gate);
      expect(code, stderr + stdout).toBe(0);
      expect(merged).toBe(true); expect(repaired).toBe(stage !== "initial");
      expect(git(["show", "HEAD:source.txt"])).toBe(stage === "conflict" ? "implementation\nmain implementation" : stage === "initial" ? "implementation" : "repaired implementation");
      expect(git(["ls-tree", "-r", "--name-only", "HEAD"])).not.toContain(".symphony/");
      if (stage === "conflict") {
        expect(conflictPushes).toBe(1); expect(executorCalls).toBe(1);
        expect(git(["rev-parse", "HEAD^1"])).toBe(reviews[0]);
        expect(git(["rev-parse", "HEAD^2"])).toBe(base);
        expect(native(["rev-parse", "--verify", "MERGE_HEAD"]).exitCode).not.toBe(0);
        expect(calls.some(a => a[0] === "add" && a.some(value => value.includes("source.txt")))).toBe(true);
        expect(fs.readFileSync(path.join(cwd, ".symphony/runtime.json"), "utf8")).toBe("staged runtime\n");
        expect(reviews).toHaveLength(2);
        expect(git(["diff", "--cached", "--name-only"])).toBe("");
      } else {
        expect(git(["show", ":.symphony/runtime.json"])).toBe("staged runtime");
        expect(git(["diff", "--cached", "--name-only"])).toBe(".symphony/runtime.json");
      }
      expect(reviews.at(-1)).toBe(head());
      expect(calls.some(a => a.includes("--remove-label") || a[1] === "comment")).toBe(false);
      expect((await new FileDeliveryStateStorage(path.join(cwd, ".symphony/delivery-state.json")).readState())?.isPaused).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});
