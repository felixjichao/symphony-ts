import fs from "node:fs";
import path from "node:path";
import { DecisionReviewGate, DecisionService, DurableDecisionStore } from "@symphony/decision";
import { formatPrBody, type PersistedDeliveryState, type UtcTimestampMs } from "@symphony/domain";
import { runDeliverySkill, recoverDeliveryHandoff, type DeliveryGitGhRunner } from "@symphony/agent";
import { FileDeliveryStateStorage, withDeliveryAuthority } from "../src/delivery-skill-cli";

export const repo = "fixture/durable";
export const session = `github:${repo}#1`;
export const context = { repo, issueNumber: 1, workspaceKey: "GH-1", headBranch: "symphony/GH-1", baseBranch: "main" };
export interface Remote { head: string; merged: boolean; merges: number; comments: { body: string }[]; labels: string[]; repairs: number }
export function remote(dir: string): Remote { return JSON.parse(fs.readFileSync(path.join(dir, "remote.json"), "utf8")); }
export function saveRemote(dir: string, value: Remote) { fs.writeFileSync(path.join(dir, "remote.json"), JSON.stringify(value)); }
const kill = () => process.kill(process.pid, "SIGKILL");
const ok = (value = "") => ({ stdout: value, stderr: "", exitCode: 0 });
const json = (value: unknown) => ok(JSON.stringify(value));
export async function execute(dir: string, fault = "", merge = false, verdict: "approve" | "changes_requested" | "needs_human" | "pending" = "pending") {
  if (fault === "lock_clean" || fault === "lock_ambiguous") {
    const { withDeliveryAuthority } = await import("../src/delivery-skill-cli");
    const { beginDeliverySubprocess } = await import("../src/file-authority");
    await withDeliveryAuthority(dir, async () => { if (fault === "lock_ambiguous") beginDeliverySubprocess(); kill(); });
  }
  const store = new DurableDecisionStore({ storeDir: path.join(dir, "decision") });
  await store.open();
  const service = new DecisionService(store);
  const baseGate = new DecisionReviewGate(service);
  const storage = new class extends FileDeliveryStateStorage {
    override writeState(state: PersistedDeliveryState): void {
      super.writeState(state);
      if (fault === "review_intent" && state.continuation?.phase === "review_intent"
        || fault === "review_ack" && state.continuation?.phase === "review_wait"
        || fault === "merge_intent" && state.landing?.phase === "intent"
        || fault === "merge_ack" && state.landing?.phase === "observed"
        || fault === "repair_pending" && state.continuation?.phase === "repair_pending") kill();
    }
    // The production exclusive capability normally constructs a locked base
    // storage. Keep the injection at the persisted-step boundary inside its lock.
    override async withExclusive<T>(action: (storage: import("@symphony/agent").DeliveryStateStorage) => Promise<T>): Promise<T> {
      return withDeliveryAuthority(dir, (): Promise<T> => action(this));
    }
  }(path.join(dir, ".symphony", "delivery-state.json"), true);
  const runner = createFixtureRunner(dir, fault);
  const gate: import("@symphony/domain").DeliveryReviewGate = {
    async ensureReviewTask(s, target, materialized, options) {
      const task = await baseGate.ensureReviewTask(s, target, materialized, options);
      if (verdict !== "pending" && task.status === "pending") {
        const { lease } = await service.claimTask(task.id, { owner: "fixture" });
        await service.startTask(task.id, lease);
        await service.submitResult(task.id, { ...lease, result: { schemaVersion: 1, taskId: task.id,
          sessionId: s, kind: "review", revision: task.revision, createdAtMs: Date.now() as UtcTimestampMs,
          target, verdict, findings: [] } });
      }
      if (fault === "review_effect") kill();
      return task;
    },
    getReviewStatus: id => baseGate.getReviewStatus(id),
    verifyReviewApproval: target => baseGate.verifyReviewApproval(target),
  };
  try {
    const result = fault === "recover_handoff"
      ? await recoverDeliveryHandoff({ cwd: dir, ...context, runner, stateStorage: storage })
      : await runDeliverySkill({ cwd: dir, ...context, runner, stateStorage: storage, reviewGate: gate,
        optInLand: merge, requiredChecks: ["gate"], maxWaitSeconds: 3600, resumeStageOnly: true, yieldOnWait: true,
        repairCommand: "fixture repair", validationCommand: "must never rerun initial validation" });
    return { result, tasks: service.getTasksForSession(session) };
  } finally { await store.close(); }
}
if (process.env["DURABLE_FIXTURE_DIR"]) {
  await execute(process.env["DURABLE_FIXTURE_DIR"], process.env["DURABLE_FAULT"] ?? "",
    process.env["DURABLE_MERGE"] === "1", (process.env["DURABLE_VERDICT"] ?? "pending") as "approve" | "pending");
}

export function createFixtureRunner(dir: string, fault = ""): DeliveryGitGhRunner {
  return {
    async git(args) {
      if (["push", "commit", "add"].includes(args[0] ?? "")) throw new Error("Stage recovery replayed coding");
      if (args[0] === "branch") return ok(context.headBranch);
      if (args[0] === "remote") return ok(`https://github.com/${repo}.git`);
      if (args[0] === "diff") return ok("diff --git a/src/a.ts b/src/a.ts\n-old\n+new\n");
      return ok();
    },
    async exec() { const r = remote(dir); r.repairs++; saveRemote(dir, r); throw new Error("arbitrary repair replay"); },
    async gh(args) {
      const r = remote(dir);
      const pr = { number: 2, url: `https://github.com/${repo}/pull/2`, title: "fixture", body: formatPrBody({ context }),
        headRefOid: r.head, headRefName: context.headBranch, baseRefName: "main", state: r.merged ? "MERGED" : "OPEN",
        mergeCommit: r.merged ? { oid: "c".repeat(40) } : null, mergeable: "MERGEABLE", isDraft: false,
        statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }], comments: r.comments };
      if (args[0] === "issue" && args[1] === "view") return json({ state: r.merged ? "CLOSED" : "OPEN", title: "Fixture", body: "Requirement", labels: r.labels.map(name => ({ name })), comments: r.comments });
      if (args[0] === "issue" && args[1] === "edit") { r.labels = []; saveRemote(dir, r); return ok(); }
      if (args[1] === "comment") {
        r.comments.push({ body: args[args.indexOf("--body") + 1] ?? "" }); saveRemote(dir, r);
        if (fault === "handoff_effect") kill();
        return ok();
      }
      if (args[0] === "api") {
        if (args[1]?.includes("required_status_checks")) return json({ contexts: [], checks: [] });
        if (args[1]?.includes("pulls/")) return json({ base: { sha: "b".repeat(40) }, head: { sha: r.head } });
        return json([]);
      }
      if (args[1] === "merge") {
        r.merged = true; r.merges++; saveRemote(dir, r);
        if (fault === "merge_effect") kill();
        return { ...ok(), exitCode: 124 }; // lost/timeout acknowledgement after remote success
      }
      if (args[1] === "list") return json([pr]);
      if (args[1] === "view") return json(pr);
      throw new Error(`Unexpected fixture command: ${args.join(" ")}`);
    },
  };
}
