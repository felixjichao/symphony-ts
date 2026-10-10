import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDeliverySkill, type DeliveryGitGhRunner } from "@symphony/agent";
import { DecisionBridge, DecisionBridgeClient, DecisionReviewGate } from "@symphony/decision";
import { formatPrBody, type DecisionContextBundle, type UtcTimestampMs } from "@symphony/domain";

const repo = "fixture/delivery";
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const target = { repository: repo, prNumber: 85, headSha };
const sessionId = `github:${repo}#80`;
const patch = "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n";
const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });
const json = (value: unknown) => ok(JSON.stringify(value));

// Only git/GitHub and coding-agent effects are fixtures. Decision state, HTTP,
// restart recovery and the delivery entry path use their production implementations.
class FixtureRunner implements DeliveryGitGhRunner {
  calls: string[][] = [];
  diffAttempts = 0;
  constructor(readonly recovery: "fetch" | "compare" | "unavailable" = "fetch") {}
  async git(args: readonly string[]) {
    this.calls.push(["git", ...args]);
    if (args[0] === "branch") return ok("symphony/GH-80");
    if (args[0] === "remote") return ok(`https://github.com/${repo}.git`);
    if (args[0] === "rev-parse") return ok(headSha);
    if (args[0] === "show") return ok("# Repository rules");
    if (args[0] === "diff" && args[1]?.includes("...")) {
      this.diffAttempts++;
      return this.recovery === "fetch" && this.diffAttempts > 1
        ? ok(patch) : { stdout: "", stderr: "missing base object", exitCode: 1 };
    }
    return ok();
  }
  async gh(args: readonly string[]) {
    this.calls.push(["gh", ...args]);
    if (args[0] === "api") {
      if (args[1]?.includes("pulls/")) return json({ base: { sha: baseSha }, head: { sha: headSha } });
      if (args[1]?.includes("compare/")) return this.recovery === "unavailable"
        ? { stdout: "", stderr: "compare unavailable", exitCode: 1 } : ok(patch);
      if (args[1]?.includes("required_status_checks")) return { stdout: "", stderr: "404", exitCode: 1 };
      return json([]);
    }
    if (args[0] === "issue" && args[1] === "view") {
      return json({ state: "OPEN", title: "Fixture issue", body: "Review changes", labels: this.calls.some(c => c.includes("--remove-label")) ? [] : [{ name: "symphony-ready" }] });
    }
    const body = formatPrBody({ context: { repo, issueNumber: 80, workspaceKey: "GH-80", headBranch: "symphony/GH-80", baseBranch: "main" }, body: "Fixture" });
    const pr = { number: 85, url: `https://github.com/${repo}/pull/85`, title: "Fixture", body, headRefOid: headSha, baseRefName: "main", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }] };
    if (args[0] === "pr" && args[1] === "list") return json([pr]);
    if (args[0] === "pr" && args[1] === "view") return json(pr);
    return ok();
  }
  async exec() { return ok(); }
}

async function deliver(cwd: string, runner: FixtureRunner, reviewGate: DecisionReviewGate, repairFn?: (feedback: string) => Promise<boolean>) {
  return runDeliverySkill({ cwd, runner, reviewGate, repo, issueNumber: 80, workspaceKey: "GH-80", headBranch: "symphony/GH-80", baseBranch: "main", validationCommand: "fixture validation", readyLabel: "symphony-ready", optInLand: true, requiredChecks: ["gate"], maxRepairAttempts: 2, maxWaitSeconds: 15, ...(repairFn ? { repairFn } : {}) });
}

describe("delivery review durable recovery", () => {
  it.each(["needs_human", "changes_requested"] as const)("consumes persisted %s after closing and reopening the store and bridge", async verdict => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-recovery-"));
    const storeDir = path.join(cwd, "decisions");
    let bridge = new DecisionBridge({ storeDir, port: 0 });
    try {
      let address = await bridge.start();
      const gate = new DecisionReviewGate(new DecisionBridgeClient(`http://127.0.0.1:${address.port}`));
      const task = await gate.ensureReviewTask(sessionId, target);
      const service = bridge.getService();
      const { lease } = await service.claimTask(task.id, { owner: "fixture-reviewer" });
      await service.startTask(task.id, lease);
      await service.submitResult(task.id, { ...lease, result: { schemaVersion: 1, taskId: task.id, sessionId, kind: "review", revision: task.revision, createdAtMs: Date.now() as UtcTimestampMs, target, verdict, findings: [{ severity: "blocker", message: "Persisted finding", location: "src/index.ts:1" }] } });
      await bridge.stop();
      bridge = new DecisionBridge({ storeDir, port: 0 });
      address = await bridge.start();
      const reopenedGate = new DecisionReviewGate(new DecisionBridgeClient(`http://127.0.0.1:${address.port}`));
      const runner = new FixtureRunner();
      const feedback: string[] = [];
      const result = await deliver(cwd, runner, reopenedGate, async value => { feedback.push(value); return false; });
      expect(result.status).toBe("blocked");
      if (verdict === "needs_human") {
        expect(result.reason, result.handoffMarkdown).toBe("review_needs_human");
        expect(result.handoffMarkdown).toContain("Persisted finding");
        expect(feedback).toEqual([]);
      } else {
        expect(feedback).toEqual(["[BLOCKER] src/index.ts:1: Persisted finding"]);
        expect(result.spentRepairs).toBe(1);
      }
      expect(bridge.getService().getTasksForSession(sessionId).map(t => t.id)).toEqual([task.id]);
      expect(bridge.getService().getTask(task.id)?.status).toBe("completed");
      expect(runner.calls.some(c => c[0] === "gh" && c[1] === "pr" && c[2] === "merge")).toBe(false);
      expect(runner.calls.some(c => c.includes("--remove-label"))).toBe(true);
    } finally {
      await bridge.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it.each(["fetch", "compare", "unavailable"] as const)("missing base object uses only fixed SHA recovery: %s", async recovery => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-fixed-base-"));
    const bridge = new DecisionBridge({ storeDir: path.join(cwd, "decisions"), port: 0 });
    try {
      const { port } = await bridge.start();
      const gate = new DecisionReviewGate(new DecisionBridgeClient(`http://127.0.0.1:${port}`));
      const runner = new FixtureRunner(recovery);
      let captured: DecisionContextBundle | undefined;
      const ensure = gate.ensureReviewTask.bind(gate);
      gate.ensureReviewTask = async (id, reviewTarget, context) => {
        captured = context;
        const task = await ensure(id, reviewTarget, context);
        const service = bridge.getService();
        const { lease } = await service.claimTask(task.id, { owner: "fixture-reviewer" });
        await service.startTask(task.id, lease);
        await service.submitResult(task.id, { ...lease, result: { schemaVersion: 1, taskId: task.id, sessionId: id, kind: "review", revision: task.revision, createdAtMs: Date.now() as UtcTimestampMs, target: reviewTarget, verdict: "needs_human", findings: [] } });
        return task;
      };
      const result = await deliver(cwd, runner, gate);
      expect(runner.calls.filter(c => c[0] === "git" && c[1] === "diff" && c.some(a => a.includes("..."))), result.handoffMarkdown).toEqual([["git", "diff", `${baseSha}...${headSha}`], ["git", "diff", `${baseSha}...${headSha}`]]);
      expect(runner.calls.filter(c => c[0] === "git" && c[1] === "fetch")).toEqual([["git", "fetch", "origin", baseSha]]);
      const compares = runner.calls.filter(c => c[0] === "gh" && c[2]?.includes("compare/"));
      expect(compares).toEqual(recovery === "fetch" ? [] : [["gh", "api", `repos/${repo}/compare/${baseSha}...${headSha}`, "--header", "Accept: application/vnd.github.v3.diff"]]);
      expect(runner.calls.some(c => c[0] === "gh" && c[1] === "pr" && c[2] === "diff")).toBe(false);
      expect(result.reason).toBe(recovery === "unavailable" ? "manual_intervention_required" : "review_needs_human");
      expect(captured !== undefined).toBe(recovery !== "unavailable");
      if (captured) expect(captured.strategy === "materialized" ? captured.diff?.patch : undefined).toBe(patch);
      expect(runner.calls.some(c => c[0] === "gh" && c[1] === "pr" && c[2] === "merge")).toBe(false);
    } finally {
      await bridge.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
