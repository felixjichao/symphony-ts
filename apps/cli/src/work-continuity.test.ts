import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { githubDecisionRoot, type Issue } from "@symphony/domain";
import { DecisionPlanningGate, DecisionService, DurableDecisionStore } from "@symphony/decision";
import { createHost } from "./host";
import { FileRecoveryLedger } from "./recovery-ledger";
import { runRecoveryCli } from "./recovery-cli";
import { createStructuredLogger } from "@symphony/observability";
import type { TrackerAdapterProfile } from "@symphony/tracker";
import { FileDeliveryStateStorage, withDeliveryAuthority, runDeliverySkillCli } from "./delivery-skill-cli";
import { recoverDeliveryHandoff, type DeliveryGitGhRunner } from "@symphony/agent";

it("real host tick scans without workers, reclaims an expired claim once, and fails safe offline", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "host-continuity-"));
  const store = new DurableDecisionStore({ storeDir: path.join(dir, "decision") });
  await store.open();
  let now = 1000;
  const service = new DecisionService(store, { clock: () => now });
  const session = await service.createSession(githubDecisionRoot("owner", "repo", 42));
  const task = await service.createPlanTask(session.id);
  await service.claimTask(task.id, { owner: "web", ttlMs: 1000 });
  let offline = false;
  const issue: Issue = { id: "42", identifier: "GH-42", title: "plan", description: "", state: "open",
    nativeRef: { repo: "owner/repo", number: 42 }, priority: 1, branchName: null,
    url: "https://github.com/owner/repo/issues/42", assigneeId: null, labels: [], blockedBy: [], dispatchable: true, createdAt: 0, updatedAt: 0 };
  const profile: TrackerAdapterProfile = { kind: "fixture", documentation: "fixture", secretProviderKeys: [], secretEnvVars: [],
    defaultActiveStates: ["open"], defaultTerminalStates: ["closed"], createAdapter: () => ({ kind: "fixture",
      fetchIssuesByStates: async states => states.includes("open") ? [issue] : [],
      fetchIssuesByIds: async () => { if (offline) throw new Error("offline"); return [issue]; } }) };
  const workflowPath = path.join(dir, "WORKFLOW.md");
  await fs.writeFile(workflowPath, `---\ntracker:\n  kind: fixture\nworkspace:\n  root: ${dir}/workspaces\ncodex:\n  command: echo unused\n---\nPrompt\n`);
  let tick: (() => void) | undefined;
  const create = () => createHost({ workflowPath, trackerProfiles: [profile], planningGate: new DecisionPlanningGate(service), now: () => now,
    logger: createStructuredLogger({ sinks: [{ write() {} }] }),
    continuityRunner: { gh: async () => ({ exitCode: 1, stdout: "", stderr: "fixture offline" }), git: async () => { throw new Error("unexpected git"); }, exec: async () => { throw new Error("unexpected exec"); } },
    continuityGitHub: { observeWork: async () => ({ workKey: session.root, issue: { state: "open", url: issue.url! }, pullRequest: null, ci: null }) }, scheduler: { schedule: (_delay, callback) => { tick = callback; return callback; }, cancel() {} } });
  let host = await create();
  try {
    await host.start();
    tick!(); await host.loop.settled();
    expect(host.state.running.size).toBe(0);
    expect(service.getTask(task.id)?.status).toBe("claimed");
    expect(host.workContinuity.observations[0]?.diagnosis?.status).toBe("unknown");
    now = 2000;
    tick!(); await host.loop.settled();
    expect(service.getTask(task.id)?.status).toBe("pending");
    expect(host.workContinuity.observations[0]?.result).toBe("applied");
    expect(host.workContinuity.observations[0]?.diagnosis?.status).toBe("external_wait");
    const replacement = await service.claimTask(task.id, { owner: "new-web", ttlMs: 1000 });
    now = 2500;
    await service.blockExecution(task.id, { owner: replacement.lease.owner, token: replacement.lease.token,
      generation: replacement.lease.generation, reason: "auth_required" });
    tick!(); await host.loop.settled();
    expect(host.workContinuity.observations[0]?.diagnosis?.status).toBe("blocked");
    expect(host.state.running.size).toBe(0);
    // Reconstruct the production host from durable files, not a recovery helper.
    const ledgerFile = path.join(dir, "workspaces", ".symphony-host", "recovery-ledger.json");
    const before = new FileRecoveryLedger(ledgerFile).incidents();
    expect(before).toHaveLength(1);
    expect(before[0]?.blockedReason).toBe("auth_required");
    const blockedTask = service.getTask(task.id);
    await host.stop();
    host = await create();
    await host.start(); tick!(); await host.loop.settled();
    expect(new FileRecoveryLedger(ledgerFile).incidents()).toEqual(before);
    expect(service.getTask(task.id)).toEqual(blockedTask);
    expect(host.state.running.size).toBe(0);
    let output = "";
    expect(runRecoveryCli(["show", ledgerFile, before[0]!.id], {
      stdout: { write: text => { output += text; } }, stderr: { write() {} },
    })).toBe(0);
    expect(JSON.parse(output)).toEqual(before[0]);
    now = 4000; offline = true;
    tick!(); await host.loop.settled();
    expect(service.getTask(task.id)?.lease?.owner).toBe("new-web");
    expect(host.workContinuity.observations[0]?.result).toBe("observation_unavailable");
    expect(new FileRecoveryLedger(ledgerFile).incidents()).toEqual(before);
    expect(service.getTask(task.id)).toEqual(blockedTask);
    offline = false;
    tick!(); await host.loop.settled();
    expect(host.workContinuity.observations[0]?.diagnosis?.status).toBe("blocked");
    expect(new FileRecoveryLedger(ledgerFile).incidents()).toEqual(before);
    expect(host.state.running.size).toBe(0);
    await host.stop();
    expect(await host.workContinuity.reconcile()).toEqual([]);
  } finally { await host.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

describe("Delivery filesystem authority", () => {
  it("run, halt, manual recovery and library recovery share the same exclusive lock", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-lock-"));
    const storage = new FileDeliveryStateStorage(path.join(dir, ".symphony", "delivery-state.json"));
    storage.writeState({ repo: "owner/repo", issueNumber: 1, workspaceKey: "GH-1", spentRepairs: 0,
      spentWaitSeconds: 0, isPaused: true, lastUpdated: "now", pendingCompensation: true });
    const runner: DeliveryGitGhRunner = { gh: async () => { throw new Error("must not mutate"); }, git: async () => { throw new Error("must not mutate"); }, exec: async () => { throw new Error("must not mutate"); } };
    const io = { stdout: { write() {} }, stderr: { write() {} } };
    try {
      await withDeliveryAuthority(dir, async () => {
        for (const action of ["run", "halt", "recover-handoff"]) {
          expect(await runDeliverySkillCli([action, "--repo", "owner/repo", "--issue", "1", "--cwd", dir], io, runner)).toBe(1);
        }
        await expect(recoverDeliveryHandoff({ cwd: dir, repo: "owner/repo", issueNumber: 1, stateStorage: storage, runner })).rejects.toMatchObject({ code: "EEXIST" });
        expect(storage.readState()?.pendingCompensation).toBe(true);
      });
      await expect(fs.stat(path.join(dir, ".symphony", "delivery-authority.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});

it("derives current-HEAD CI waits, review execution, accepted results, repair and merge through the host", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "host-stages-"));
  const store = new DurableDecisionStore({ storeDir: path.join(dir, "decision") });
  await store.open();
  const service = new DecisionService(store, { clock: () => 1000 });
  const workKey = githubDecisionRoot("owner", "repo", 42);
  const session = await service.createSession(workKey);
  const plan = await service.createPlanTask(session.id, { requirements: { title: "plan", body: "" } });
  const claim = await service.claimTask(plan.id, { owner: "web" });
  const credentials = { owner: "web", token: claim.task.lease!.token, generation: claim.task.claimGeneration };
  await service.startTask(plan.id, credentials);
  await service.submitResult(plan.id, { ...credentials, result: { schemaVersion: 1, kind: "plan", taskId: plan.id,
    sessionId: session.id, revision: plan.revision, createdAtMs: 1000, verdict: "ready",
    content: { plan: "plan", acceptanceCriteria: [], risks: [], clarifications: [] } } });
  await service.markPlanPublished(plan.id, { commentId: 1 });
  const issue: Issue = { id: "42", identifier: "GH-42", title: "plan", description: "", state: "open",
    nativeRef: { repo: "owner/repo", number: 42 }, priority: 1, branchName: null,
    url: "https://github.com/owner/repo/issues/42", assigneeId: null, labels: [], blockedBy: [], dispatchable: true, createdAt: 0, updatedAt: 0 };
  const profile: TrackerAdapterProfile = { kind: "fixture", documentation: "fixture", secretProviderKeys: [], secretEnvVars: [],
    defaultActiveStates: ["open"], defaultTerminalStates: ["closed"], createAdapter: () => ({ kind: "fixture",
      fetchIssuesByStates: async states => states.includes("open") ? [issue] : [], fetchIssuesByIds: async () => [issue] }) };
  const workflowPath = path.join(dir, "WORKFLOW.md");
  await fs.writeFile(workflowPath, `---\ntracker:\n  kind: fixture\nworkspace:\n  root: ${dir}/workspaces\ncodex:\n  command: echo unused\n---\nPrompt\n`);
  await fs.mkdir(path.join(dir, "workspaces", "GH-42", ".git"), { recursive: true });
  const head = "a".repeat(40);
  let remote: import("@symphony/domain").GitHubObservation = { workKey, issue: { state: "open", url: issue.url! },
    pullRequest: { number: 7, state: "open", url: "https://github.com/owner/repo/pull/7", headSha: head, isDraft: false },
    ci: { headSha: head, status: "pending" } };
  const host = await createHost({ workflowPath, trackerProfiles: [profile], planningGate: new DecisionPlanningGate(service), now: () => 1000,
    logger: createStructuredLogger({ sinks: [{ write() {} }] }), continuityGitHub: { observeWork: async () => remote } });
  try {
    let result = (await host.workContinuity.reconcile())[0]!;
    expect(result.diagnosis?.status).toBe("external_wait");
    remote = { ...remote, ci: { headSha: head, status: "success" } };
    expect((await host.workContinuity.reconcile())[0]?.diagnosis?.next.authority).toEqual({ kind: "internal", authority: "decision" });
    const review = await service.createReviewTask(session.id, { target: { repository: "owner/repo", prNumber: 7, headSha: head } });
    const reviewClaim = await service.claimTask(review.id, { owner: "review-web" });
    result = (await host.workContinuity.reconcile())[0]!;
    expect(result.diagnosis?.owner?.id).toBe("review-web");
    expect(result.diagnosis?.status).toBe("unknown");
    const reviewCredentials = { owner: "review-web", token: reviewClaim.task.lease!.token, generation: reviewClaim.task.claimGeneration };
    await service.startTask(review.id, reviewCredentials);
    await service.submitResult(review.id, { ...reviewCredentials, result: { schemaVersion: 1, kind: "review", taskId: review.id,
      sessionId: session.id, revision: review.revision, createdAtMs: 1000, target: { repository: "owner/repo", prNumber: 7, headSha: head }, verdict: "approve", findings: [] } });
    expect((await host.workContinuity.reconcile())[0]?.diagnosis?.next.authority).toEqual({ kind: "internal", authority: "delivery" });
    remote = { ...remote, ci: { headSha: head, status: "failure" } };
    expect((await host.workContinuity.reconcile())[0]?.diagnosis?.next.description).toContain("repair:");
    remote = { ...remote, ci: { headSha: head, status: "success" } };
    const changes = await service.createReviewTask(session.id, { target: { repository: "owner/repo", prNumber: 7, headSha: head }, forceNewRevision: true });
    const changesClaim = await service.claimTask(changes.id, { owner: "review-web" });
    const changesCredentials = { owner: "review-web", token: changesClaim.task.lease!.token, generation: changesClaim.task.claimGeneration };
    await service.startTask(changes.id, changesCredentials);
    await service.submitResult(changes.id, { ...changesCredentials, result: { schemaVersion: 1, kind: "review", taskId: changes.id,
      sessionId: session.id, revision: changes.revision, createdAtMs: 1000, target: { repository: "owner/repo", prNumber: 7, headSha: head }, verdict: "changes_requested", findings: [] } });
    expect((await host.workContinuity.reconcile())[0]?.diagnosis?.next.description).toContain("repair:");
    remote = { ...remote, pullRequest: { ...remote.pullRequest!, state: "merged" } };
    expect((await host.workContinuity.reconcile())[0]?.diagnosis?.status).toBe("external_wait");
    expect(host.state.running.size).toBe(0);
  } finally { await host.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

it("real host startup and ticks ensure Review and consume a durable result without relaunching coding", async () => {
  const { createFixtureRunner, saveRemote, remote, context } = await import("../test-fixtures/durable-delivery-harness");
  const { DecisionReviewGate } = await import("@symphony/decision");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "host-native-delivery-"));
  saveRemote(dir, { head: "a".repeat(40), merged: false, merges: 0, comments: [], labels: ["symphony-ready"], repairs: 0 });
  const store = new DurableDecisionStore({ storeDir: path.join(dir, "decision") });
  await store.open();
  const service = new DecisionService(store);
  const work = githubDecisionRoot("fixture", "durable", 1);
  const session = await service.createSession(work);
  const plan = await service.createPlanTask(session.id, { requirements: { title: "Fixture", body: "Requirement" } });
  const { lease } = await service.claimTask(plan.id, { owner: "planner" });
  await service.startTask(plan.id, lease);
  await service.submitResult(plan.id, { ...lease, result: { schemaVersion: 1, kind: "plan", taskId: plan.id,
    sessionId: session.id, revision: plan.revision, createdAtMs: Date.now(), verdict: "ready",
    content: { plan: "Implement fixture", acceptanceCriteria: [], risks: [], clarifications: [] } } });
  await service.markPlanPublished(plan.id, { commentId: 1 });
  const issue: Issue = { id: "1", identifier: "GH-1", title: "Fixture", description: "Requirement", state: "open",
    nativeRef: { repo: context.repo, number: 1 }, priority: 1, branchName: null,
    url: `https://github.com/${context.repo}/issues/1`, assigneeId: null, labels: [], blockedBy: [], dispatchable: true, createdAt: 0, updatedAt: 0 };
  const profile: TrackerAdapterProfile = { kind: "fixture", documentation: "fixture", secretProviderKeys: [], secretEnvVars: [],
    defaultActiveStates: ["open"], defaultTerminalStates: ["closed"], createAdapter: () => ({ kind: "fixture",
      fetchIssuesByStates: async states => states.includes("open") ? [issue] : [], fetchIssuesByIds: async () => [issue] }) };
  const workflowPath = path.join(dir, "WORKFLOW.md");
  await fs.writeFile(workflowPath, `---\ntracker:\n  kind: fixture\nworkspace:\n  root: ${dir}/workspaces\ncodex:\n  command: must-never-launch\n---\nPrompt\n`);
  let tick: (() => void) | undefined;
  const create = () => createHost({ workflowPath, trackerProfiles: [profile], planningGate: new DecisionPlanningGate(service),
    continuityReviewGate: new DecisionReviewGate(service), continuityRunner: createFixtureRunner(dir),
    logger: createStructuredLogger({ sinks: [{ write() {} }] }),
    scheduler: { schedule: (_delay, callback) => { tick = callback; return callback; }, cancel() {} },
    continuityGitHub: { observeWork: async () => ({ workKey: work, issue: { state: "open", url: issue.url! },
      pullRequest: { number: 2, state: "open", url: `https://github.com/${context.repo}/pull/2`, headSha: remote(dir).head, isDraft: false },
      ci: { headSha: remote(dir).head, status: "success" } }) } });
  let host = await create();
  try {
    await host.start(); tick!(); await host.loop.settled();
    const review = service.getTasksForSession(session.id).find(t => t.kind === "review");
    expect(review?.status, JSON.stringify(host.workContinuity.observations)).toBe("pending");
    expect(host.state.running.size).toBe(0);
    const claim = await service.claimTask(review!.id, { owner: "reviewer" });
    await service.startTask(review!.id, claim.lease);
    await service.submitResult(review!.id, { ...claim.lease, result: { schemaVersion: 1, taskId: review!.id, sessionId: session.id,
      kind: "review", revision: review!.revision, createdAtMs: Date.now(), target: { repository: context.repo, prNumber: 2, headSha: remote(dir).head }, verdict: "approve", findings: [] } });
    tick!(); await host.loop.settled();
    const storage = new FileDeliveryStateStorage(path.join(dir, "workspaces", "GH-1", ".symphony", "delivery-state.json"));
    expect(storage.readState()?.continuation?.phase).toBe("ready");
    expect(host.workContinuity.observations[0]?.diagnosis?.status).toBe("external_wait");
    await host.stop();
    host = await create();
    await host.start(); tick!(); await host.loop.settled();
    expect(service.getTasksForSession(session.id).filter(t => t.kind === "review")).toHaveLength(1);
    expect(host.state.running.size).toBe(0);
    expect(remote(dir).merges).toBe(0);
  } finally { await host.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
