import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubDeliveryService, type GhRunner } from "@symphony/tracker";
import { formatPrBody, type DeliveryReviewGate, type LandingIntentStorage } from "@symphony/domain";
import { FileLandingIntentStorage } from "./landing-storage";
import { FileDeliveryStateStorage } from "./delivery-skill-cli";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const context = { repo: "fixture/landing", issueNumber: 1, workspaceKey: "GH-1", headBranch: "symphony/GH-1", baseBranch: "main" };
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-intent-")); dirs.push(dir);
  let head = "a".repeat(40), merged = false, merges = 0, approved = true;
  const runner: GhRunner = { async exec(args) {
    const json = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "", exitCode: 0 });
    if (args[0] === "issue") return json({ title: "Fixture", body: "Requirements" });
    if (args[0] === "pr" && args[1] === "view") return json({ number: 2, title: "Fixture", body: formatPrBody({ context }),
      state: merged ? "MERGED" : "OPEN", isDraft: false, mergeable: "MERGEABLE", headRefName: context.headBranch,
      headRefOid: head, baseRefName: "main", url: "https://github.com/fixture/landing/pull/2", isCrossRepository: false,
      headRepositoryOwner: { login: "fixture" }, headRepository: { name: "landing" },
      mergedAt: merged ? "2026-10-22T12:00:00Z" : null, mergeCommit: merged ? { oid: "b".repeat(40) } : null,
      statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }] });
    if (args[0] === "api" && args[1]?.endsWith("/merge")) {
      merges++; merged = true; throw new Error("remote merged, response lost");
    }
    if (args[1] === "graphql") return json({ data: { repository: { pullRequest: { baseRef: { branchProtectionRule: null } } } } });
    if (args[1]?.includes("rules/branches")) return json([]);
    if (args[1]?.includes("required_status_checks")) return json({ contexts: ["gate"], checks: [] });
    throw new Error(`Unexpected GitHub fixture request ${args.join(" ")}`);
  } };
  const gate: DeliveryReviewGate = {
    ensureReviewTask: async () => { throw new Error("land must not create Review"); },
    getReviewStatus: async () => { throw new Error("land must verify exact approval"); },
    verifyReviewApproval: async () => ({ approved, reason: approved ? "approved" : "needs_human", headSha: head }),
  };
  const storage = new FileLandingIntentStorage(dir);
  const service = new GitHubDeliveryService(runner);
  return { dir, storage, service, get merges() { return merges; }, moveHead() { head = "c".repeat(40); }, deny() { approved = false; },
    options: { optIn: true, prNumber: 2, expectedHeadSha: head, reviewGate: gate, landingStorage: storage } };
}
function interrupted(storage: FileLandingIntentStorage, point: "intent" | "effect" | "ack"): LandingIntentStorage {
  return { withExclusive: action => storage.withExclusive(locked => action({ read: () => locked.read(),
    write: async intent => {
      if (point === "effect" && intent.phase === "observed") throw new Error("crash after remote effect");
      await locked.write(intent);
      if (point === "intent" && intent.phase === "intent" || point === "ack" && intent.phase === "observed") throw new Error("crash after durable step");
    } })), read: () => storage.read(), write: intent => storage.write(intent) };
}
describe("pr land native durable acknowledgement", () => {
  it.each(["intent", "effect", "ack"] as const)("recovers %s without an additional merge or Review round", async point => {
    const h = fixture();
    await expect(h.service.landPr(context, { ...h.options, landingStorage: interrupted(h.storage, point) })).rejects.toThrow("crash");
    const restored = new FileLandingIntentStorage(h.dir);
    const result = await h.service.landPr(context, { ...h.options, landingStorage: restored });
    expect(result.merged).toBe(true);
    expect(h.merges).toBe(1);
    expect(restored.read()?.phase).toBe("observed");
    await h.service.landPr(context, { ...h.options, landingStorage: restored });
    expect(h.merges).toBe(1);
  });
  it("refuses a stale HEAD, withdrawn approval and paused state before another effect", async () => {
    for (const change of ["head", "approval", "paused"] as const) {
      const h = fixture();
      await expect(h.service.landPr(context, { ...h.options, landingStorage: interrupted(h.storage, "intent") })).rejects.toThrow();
      if (change === "head") h.moveHead();
      if (change === "approval") h.deny();
      if (change === "paused") {
        const storage = new FileDeliveryStateStorage(path.join(h.dir, ".symphony", "delivery-state.json"));
        storage.writeState({ ...storage.readState()!, isPaused: true });
      }
      await expect(h.service.landPr(context, h.options)).rejects.toThrow();
      expect(h.merges).toBe(0);
    }
  });
});
