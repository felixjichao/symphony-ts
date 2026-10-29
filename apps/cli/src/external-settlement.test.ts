import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { DurableDecisionStore, DecisionService, validateStoreRecord } from "@symphony/decision";
import { decisionSessionId, formatPrBody, type PersistedDeliveryState, type WorkRecoveryRequest,
  type DurableRetryReservation, type ExternalDeliverySettlementRequest } from "@symphony/domain";
import type { DeliveryGitGhRunner } from "@symphony/agent";
import { prepareExternalSettlement, applyExternalSettlement, runExternalSettlementCli } from "./external-settlement";
import { FileDeliveryStateStorage, withDeliveryAuthority, runDeliverySkillCli } from "./delivery-skill-cli";
import { FileWorkRecoveryStorage, FileRetryReservationStorage, writeDurableJson } from "./recovery-storage";
import { acquireFileAuthority, hostMaintenanceAuthorityPath } from "./file-authority";
import { externalSettlementJournalPath, readExternalSettlementJournal, hasExternalSettlementFence } from "./external-settlement-journal";
import { withDeliveryCleanupAuthority } from "./delivery-cleanup";
import { createHost } from "./host";
import { createStructuredLogger } from "@symphony/observability";
import type { TrackerAdapterProfile } from "@symphony/tracker";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
async function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "external-completion-"))); dirs.push(dir);
  const root = path.join(dir, "work"), cwd = path.join(root, "GH-42"), storeDir = path.join(dir, "decision");
  fs.mkdirSync(cwd, { recursive: true });
  const key = { provider: "github", key: "owner/repo#42" };
  const context = { repo: "owner/repo", issueNumber: 42, workspaceKey: "GH-42", headBranch: "symphony/GH-42", baseBranch: "main" };
  const target = { prNumber: 7, headSha: "b".repeat(40), mergeCommitSha: "c".repeat(40) };
  const storage = new FileDeliveryStateStorage(path.join(cwd, ".symphony", "delivery-state.json"));
  const original: PersistedDeliveryState = { repo: context.repo, issueNumber: 42, workspaceKey: "GH-42",
    spentRepairs: 2, spentWaitSeconds: 321, deadlineTimestampMs: 1234, isPaused: true,
    pauseReason: "manual_intervention_required", pendingCompensation: true, commentPosted: false,
    commentVerifyStatus: "unverified", lastUpdated: "before",
    handoff: { reason: "manual_intervention_required", details: "original diagnostic\n".repeat(20_000),
      repo: context.repo, issueNumber: 42, headBranch: context.headBranch, prNumber: null,
      prUrl: null, headSha: null, spentRepairs: 2, maxRepairs: 3, spentWaitSeconds: 321,
      readyLabel: "symphony-ready", handoffId: "handoff-original", reportDestination: "issue" },
  };
  storage.writeState(original);
  const recoveryFile = path.join(root, ".symphony-host", "recovery.json");
  const retryFile = path.join(root, ".symphony-host", "retries.json");
  const ledger = path.join(root, ".symphony-host", "recovery-ledger.json");
  writeDurableJson(ledger, { schemaVersion: 1, budgets: [], incidents: [] });
  const recovery = new FileWorkRecoveryStorage(recoveryFile);
  const request: WorkRecoveryRequest = { invocationId: "old-invocation", workKey: key, version: "old-version",
    stage: "handoff", action: "compensate", authority: { kind: "internal", authority: "delivery" }, fence: {},
    handoffRef: { handoffId: "handoff-original", headSha: null } };
  recovery.put(request);
  const retries = new FileRetryReservationStorage(retryFile);
  const retry: DurableRetryReservation = { workKey: key, issueId: "42", identifier: "GH-42", issueUrl: null,
    attempt: 2, error: "old", kind: "failure", dueAtUtcMs: 10, token: "old-token", phase: "blocked" };
  retries.put(retry, null);
  const store = new DurableDecisionStore({ storeDir }); await store.open();
  const service = new DecisionService(store);
  const session = await service.createSession(key);
  const old = await service.createReviewTask(session.id, { target: { repository: context.repo, prNumber: 7, headSha: "a".repeat(40) } });
  if (old.kind !== "review") throw new Error("Expected review fixture");
  const claim = await service.claimTask(old.id, { owner: "old-driver" });
  await service.startTask(old.id, { owner: "old-driver", token: claim.lease.token, generation: claim.lease.generation });
  const other = await service.createSession({ provider: "github", key: "other/repo#42" });
  await service.createPlanTask(other.id);
  const unrelated = store.getTasksForSession(other.id);
  await store.close();
  const remote = {
    issue: { number: 42, state: "closed" },
    pr: { number: 7, state: "closed", merged: true, merged_at: "2026-10-29T12:00:00Z", merge_commit_sha: target.mergeCommitSha,
      body: "Manually submitted", head: { sha: target.headSha, ref: context.headBranch, repo: { full_name: context.repo } },
      base: { ref: "main", repo: { full_name: context.repo } } },
  };
  const calls: string[][] = [];
  const runner: DeliveryGitGhRunner = {
    git: async () => { throw new Error("No Git mutation allowed"); },
    exec: async () => { throw new Error("No executor allowed"); },
    gh: async args => {
      calls.push([...args]); expect(args.slice(0, 5)).toEqual(["api", "--hostname", "github.com", "--method", "GET"]);
      const data = args[5]?.includes("/issues/") ? remote.issue : remote.pr;
      return { stdout: JSON.stringify(data), stderr: "", exitCode: 0 };
    },
  };
  const draft = { schemaVersion: 1 as const, workspace: cwd, decisionStore: storeDir, context, target,
    authorization: { operator: "test operator", reason: "Verified manual merge and stopped executors", executorsStopped: true, allowUnmarkedPr: true } };
  const prepared = await prepareExternalSettlement(draft, runner);
  return { dir, root, cwd, storeDir, key, context, target, storage, original, request: prepared, runner,
    remote, calls, old, claim, unrelated, other, recovery, retries, ledger, draft, recoveryFile, retryFile };
}

it("settles the exact work without inventing approval, changing budgets or replaying effects", async () => {
  const f = await fixture(), ledger = fs.readFileSync(f.ledger);
  const done = await applyExternalSettlement(f.request, f.runner);
  expect(done.phase).toBe("complete");
  expect(done.originalDelivery).toEqual(f.original);
  expect(f.storage.readState()).toEqual({ ...f.original, externalSettlement: done.receipt });
  expect(f.recovery.load()).toEqual([]); expect(f.retries.load()).toEqual([]);
  expect(fs.readFileSync(f.ledger)).toEqual(ledger);
  const store = new DurableDecisionStore({ storeDir: f.storeDir }); await store.open();
  try {
    validateStoreRecord(store.getState());
    const service = new DecisionService(store);
    expect(service.getTask(f.old.id)?.status).toBe("cancelled");
    expect(service.getResult(f.old.id)).toBeNull(); expect(store.getReceipt(f.old.id)).toBeNull();
    expect(store.getTasksForSession(f.other.id)).toEqual(f.unrelated);
    expect(store.getSession(decisionSessionId(f.key))?.status).toBe("completed");
    await expect(service.reopenSession(decisionSessionId(f.key))).rejects.toThrow("separately authorized new round");
    await expect(service.submitResult(f.old.id, { owner: "old-driver", token: f.claim.lease.token,
      generation: f.claim.lease.generation, result: { schemaVersion: 1, taskId: f.old.id,
        sessionId: f.old.sessionId, revision: f.old.revision, kind: "review", target: f.old.target,
        verdict: "approve", findings: [], createdAtMs: Date.now() } })).rejects.toThrow("cancelled");
  } finally { await store.close(); }
  const calls = f.calls.length;
  const io = { stdout: { write() {} }, stderr: { write() {} } };
  expect(await runDeliverySkillCli(["recover-handoff", "--cwd", f.cwd, "--repo", "owner/repo", "--issue", "42"], io, f.runner)).toBe(1);
  expect(f.calls).toHaveLength(calls);
});

it.each(["prepared", "decision", "delivery", "retired", "complete"] as const)("resumes durable %s interruption and retains a receipt after workspace cleanup", async phase => {
  const f = await fixture();
  await expect(applyExternalSettlement(f.request, f.runner, at => { if (at === phase) throw new Error("interrupted"); })).rejects.toThrow("interrupted");
  await applyExternalSettlement(f.request, f.runner);
  const before = fs.readFileSync(path.join(f.storeDir, "store.json"));
  await applyExternalSettlement(f.request, f.runner);
  expect(fs.readFileSync(path.join(f.storeDir, "store.json"))).toEqual(before);
  await withDeliveryCleanupAuthority(f.cwd, async () => { fs.rmSync(f.cwd, { recursive: true }); });
  expect(fs.existsSync(f.cwd)).toBe(false);
  expect((await applyExternalSettlement(f.request, f.runner)).phase).toBe("complete");
  expect(fs.existsSync(f.cwd)).toBe(false);
  expect(readExternalSettlementJournal(f.root, f.key)?.originalDelivery).toEqual(f.original);
});

it.each(["host", "delivery", "decision"] as const)("refuses a live %s authority", async kind => {
  const f = await fixture();
  if (kind === "host") {
    const lock = acquireFileAuthority(hostMaintenanceAuthorityPath(f.root));
    try { await expect(applyExternalSettlement(f.request, f.runner)).rejects.toThrow("locked"); }
    finally { lock.release(); }
  } else if (kind === "delivery") {
    await withDeliveryAuthority(f.cwd, async () => { await expect(applyExternalSettlement(f.request, f.runner)).rejects.toThrow("locked"); });
  } else {
    const store = new DurableDecisionStore({ storeDir: f.storeDir }); await store.open();
    try { await expect(applyExternalSettlement(f.request, f.runner)).rejects.toThrow("locked"); }
    finally { await store.close(); }
  }
  expect(f.storage.readState()).toEqual(f.original);
  expect(fs.existsSync(externalSettlementJournalPath(f.root, f.key))).toBe(false);
});

it.each(["head", "merge", "issue", "fork", "branch", "foreign-marker", "unmarked"])("rejects changed remote %s without changing native facts", async change => {
  const f = await fixture();
  if (change === "head") f.remote.pr.head.sha = "d".repeat(40);
  if (change === "merge") f.remote.pr.merge_commit_sha = "d".repeat(40);
  if (change === "issue") f.remote.issue.state = "open";
  if (change === "fork") f.remote.pr.head.repo.full_name = "foreign/repo";
  if (change === "branch") f.remote.pr.base.ref = "other";
  if (change === "foreign-marker") f.remote.pr.body = formatPrBody({ context: { ...f.context, issueNumber: 99 } });
  const request = change === "unmarked" ? { ...f.request, authorization: { ...f.request.authorization, allowUnmarkedPr: false } } : f.request;
  const before = fs.readFileSync(path.join(f.storeDir, "store.json"));
  await expect(applyExternalSettlement(request, f.runner)).rejects.toThrow();
  expect(fs.readFileSync(path.join(f.storeDir, "store.json"))).toEqual(before);
  expect(f.storage.readState()).toEqual(f.original);
  expect(fs.existsSync(externalSettlementJournalPath(f.root, f.key))).toBe(false);
});

it.each(["delivery", "decision", "recovery", "retry", "authorization"])("fences a new %s owner/snapshot", async change => {
  const f = await fixture();
  if (change === "delivery") f.storage.writeState({ ...f.original, spentWaitSeconds: 322 });
  if (change === "decision") {
    const store = new DurableDecisionStore({ storeDir: f.storeDir }); await store.open();
    try { await new DecisionService(store).heartbeatTask(f.old.id, { owner: "old-driver", token: f.claim.lease.token, generation: f.claim.lease.generation }); }
    finally { await store.close(); }
  }
  if (change === "recovery") {
    f.recovery.remove(f.recovery.load()[0]!);
    f.recovery.put({ invocationId: "new-invocation", workKey: f.key, stage: "coding", version: "new", action: "dispatch", authority: { kind: "internal", authority: "orchestrator" }, fence: {} });
  }
  if (change === "retry") {
    const old = f.retries.load()[0]!; f.retries.put({ ...old, token: "new-token" }, old.token);
  }
  const request = change === "authorization" ? { ...f.request, authorization: { ...f.request.authorization, executorsStopped: false } } : f.request;
  await expect(applyExternalSettlement(request, f.runner)).rejects.toThrow();
  expect(fs.existsSync(externalSettlementJournalPath(f.root, f.key))).toBe(false);
});

it("blocks cleanup while prepared, rejects a replaced invocation, and leaves historical facts intact", async () => {
  const f = await fixture();
  await expect(applyExternalSettlement(f.request, f.runner, phase => { if (phase === "prepared") throw new Error("stopped"); })).rejects.toThrow();
  await expect(withDeliveryCleanupAuthority(f.cwd, async () => {})).rejects.toThrow("incomplete");
  const old = f.recovery.load()[0]!;
  f.recovery.remove(old); f.recovery.put({ ...old, invocationId: "new-owner" });
  await expect(applyExternalSettlement(f.request, f.runner)).rejects.toThrow("New recovery owner");
  expect(f.recovery.load()[0]?.invocationId).toBe("new-owner");
  expect(f.storage.readState()).toEqual(f.original);
});

it("uses explicit CLI preparation/preview/apply and rejects unknown or credential-bearing provider failures", async () => {
  const f = await fixture();
  const file = path.join(f.dir, "request.json"); fs.writeFileSync(file, JSON.stringify(f.draft));
  const output: string[] = [], errors: string[] = [];
  const io = { stdout: { write: (s: string) => output.push(s) }, stderr: { write: (s: string) => errors.push(s) } };
  expect(await runExternalSettlementCli(["prepare-external", "--request", file], io, f.runner)).toBe(0);
  const request = JSON.parse(output.pop()!) as ExternalDeliverySettlementRequest;
  fs.writeFileSync(file, JSON.stringify(request));
  expect(await runExternalSettlementCli(["settle-external", "--request", file], io, f.runner)).toBe(0);
  expect(f.storage.readState()).toEqual(f.original);
  expect(await runExternalSettlementCli(["settle-external", "--request", file, "--unknown"], io, f.runner)).toBe(1);
  const bad: DeliveryGitGhRunner = { ...f.runner, gh: async () => { throw new Error("private-token-do-not-print"); } };
  expect(await runExternalSettlementCli(["settle-external", "--request", file, "--apply"], io, bad)).toBe(1);
  expect(errors.join("")).not.toContain("private-token");
  expect(await runDeliverySkillCli(["settle-external", "--request", file, "--apply"], io, f.runner)).toBe(0);
});

it("survives a real maintenance process SIGKILL after the native Decision transaction", async () => {
  const f = await fixture();
  const requestFile = path.join(f.dir, "authorization.json"); fs.writeFileSync(requestFile, JSON.stringify(f.request));
  const script = path.join(f.dir, "child.mjs");
  const moduleUrl = pathToFileURL(fileURLToPath(new URL("./external-settlement.ts", import.meta.url))).href;
  fs.writeFileSync(script, `import fs from 'node:fs';
import {applyExternalSettlement} from ${JSON.stringify(moduleUrl)};
const request=JSON.parse(fs.readFileSync(process.env.EXTERNAL_REQUEST,'utf8'));
const remote=${JSON.stringify(f.remote)};
const runner={git:async()=>{throw Error('forbidden')},exec:async()=>{throw Error('forbidden')},gh:async args=>({stdout:JSON.stringify(args[5].includes('/issues/')?remote.issue:remote.pr),stderr:'',exitCode:0})};
await applyExternalSettlement(request,runner,async phase=>{if(phase==='decision'){process.send('committed');await new Promise(()=>{});}});
`);
  const child = fork(script, [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, EXTERNAL_REQUEST: requestFile } });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve()); child.once("error", reject);
      child.once("exit", () => reject(new Error("Maintenance exited before checkpoint")));
    });
    child.kill("SIGKILL"); await closed;
    expect(readExternalSettlementJournal(f.root, f.key)?.phase).toBe("prepared");
    expect(f.storage.readState()).toEqual(f.original);
    expect((await applyExternalSettlement(f.request, f.runner)).phase).toBe("complete");
    expect(f.recovery.load()).toEqual([]);
  } finally { child.kill("SIGKILL"); await closed; }
}, 10_000);

it("active host and reloaded roots exclude maintenance until native shutdown completes", async () => {
  const f = await fixture();
  const workflowPath = path.join(f.dir, "WORKFLOW.md"), nextRoot = path.join(f.dir, "next-root");
  const writeWorkflow = (root: string) => fs.writeFileSync(workflowPath, `---\ntracker:\n  kind: fixture\nworkspace:\n  root: ${root}\ncodex:\n  command: echo unused\n---\nPrompt\n`);
  writeWorkflow(f.root);
  const profile: TrackerAdapterProfile = { kind: "fixture", documentation: "test", secretProviderKeys: [], secretEnvVars: [],
    defaultActiveStates: ["open"], defaultTerminalStates: ["closed"],
    createAdapter: () => ({ kind: "fixture", fetchIssuesByStates: async () => [], fetchIssuesByIds: async () => [] }) };
  let tick: (() => void) | undefined;
  const host = await createHost({ workflowPath, cwd: f.dir, enablePlanning: false, trackerProfiles: [profile],
    logger: createStructuredLogger({ sinks: [] }), scheduler: { schedule: () => 1, cancel() {} },
    watcherScheduler: { schedule: callback => { tick = callback; return 1; }, cancel() {} } });
  try {
    await host.start();
    await expect(applyExternalSettlement(f.request, f.runner)).rejects.toThrow("locked");
    const lock = acquireFileAuthority(hostMaintenanceAuthorityPath(nextRoot));
    try {
      writeWorkflow(nextRoot); tick?.();
      expect(host.effective.serviceConfig.workspace.root).toBe(f.root);
    } finally { lock.release(); }
    fs.appendFileSync(workflowPath, "\n");
    tick?.();
    expect(host.effective.serviceConfig.workspace.root).toBe(nextRoot);
    expect(() => acquireFileAuthority(hostMaintenanceAuthorityPath(f.root))).toThrow("locked");
    expect(() => acquireFileAuthority(hostMaintenanceAuthorityPath(nextRoot))).toThrow("locked");
  } finally { await host.stop(); }
  const fresh = await prepareExternalSettlement(f.draft, f.runner);
  const done = await applyExternalSettlement(fresh, f.runner);
  expect(done.phase).toBe("complete");
});

it("preserves existing accepted Decision results and immutable submission receipts", async () => {
  const f = await fixture();
  const store = new DurableDecisionStore({ storeDir: f.storeDir }); await store.open();
  const service = new DecisionService(store);
  await service.cancelTask(f.old.id);
  const task = await service.createPlanTask(decisionSessionId(f.key));
  const claim = await service.claimTask(task.id, { owner: "planner" });
  const credentials = { owner: "planner", token: claim.lease.token, generation: claim.lease.generation };
  await service.startTask(task.id, credentials);
  await service.submitResult(task.id, { ...credentials, result: { schemaVersion: 1, kind: "plan", taskId: task.id,
    sessionId: task.sessionId, revision: task.revision, createdAtMs: Date.now(), verdict: "ready",
    content: { plan: "original", acceptanceCriteria: [], risks: [], clarifications: [] } } });
  const originalResult = store.getResult(task.id), originalReceipt = store.getReceipt(task.id);
  await store.close();
  const request = await prepareExternalSettlement(f.draft, f.runner);
  await applyExternalSettlement(request, f.runner);
  await store.open();
  try {
    expect(store.getResult(task.id)).toEqual(originalResult);
    expect(store.getReceipt(task.id)).toEqual(originalReceipt);
    expect(store.getTask(task.id)?.status).toBe("completed");
  } finally { await store.close(); }
});

it("refuses unknown request fields and malformed external completion without trusting its marker", async () => {
  const f = await fixture();
  await expect(applyExternalSettlement({ ...f.request, extra: true } as ExternalDeliverySettlementRequest, f.runner)).rejects.toThrow("missing or unknown field");
  const done = await applyExternalSettlement(f.request, f.runner);
  fs.writeFileSync(path.join(f.cwd, ".symphony", "delivery-state.json"), JSON.stringify({ ...f.storage.readState(), spentRepairs: 0 }));
  expect(() => f.storage.readState()).toThrow("source changed");
  expect(done.originalDelivery.spentRepairs).toBe(2);
  await expect(withDeliveryCleanupAuthority(f.cwd, async () => {})).rejects.toThrow();
});

it("retains host admission fencing for a reopened issue after native workspace cleanup", async () => {
  const f = await fixture();
  await applyExternalSettlement(f.request, f.runner);
  await withDeliveryCleanupAuthority(f.cwd, async () => fs.rmSync(f.cwd, { recursive: true }));
  const workflowPath = path.join(f.dir, "WORKFLOW.md");
  fs.writeFileSync(workflowPath, `---\ntracker:\n  kind: fixture\nworkspace:\n  root: ${f.root}\ncodex:\n  command: echo unused\n---\nPrompt\n`);
  const profile: TrackerAdapterProfile = { kind: "fixture", documentation: "test", secretProviderKeys: [], secretEnvVars: [],
    defaultActiveStates: ["open"], defaultTerminalStates: ["closed"],
    createAdapter: () => ({ kind: "fixture", fetchIssuesByStates: async () => [], fetchIssuesByIds: async () => [] }) };
  let dispatchHookCalls = 0;
  const host = await createHost({ workflowPath, cwd: f.dir, enablePlanning: false, trackerProfiles: [profile],
    logger: createStructuredLogger({ sinks: [] }), canDispatch: () => { dispatchHookCalls++; return true; } });
  try {
    const result = host.authority.dispatchIssue({ id: "42", identifier: "GH-42", title: "Reopened", description: null,
      nativeRef: { repo: "owner/repo", number: 42 }, url: "https://github.com/owner/repo/issues/42",
      state: "open", priority: 1, branchName: null, assigneeId: null, labels: [], blockedBy: [],
      dispatchable: true, createdAt: 1000, updatedAt: null });
    expect(result.kind).toBe("not_eligible");
    expect(dispatchHookCalls).toBe(0);
    expect(fs.existsSync(f.cwd)).toBe(false);
  } finally { await host.stop(); }
});


it("does not interpret custom tracker providers as Decision work roots", async () => {
  const f = await fixture();
  expect(hasExternalSettlementFence(f.root, { provider: "github_mock", key: "id-SEC-01" })).toBe(false);
  expect(hasExternalSettlementFence(f.root, { provider: "profile_a", key: "TASK-A" })).toBe(false);
});

it("retains settlement authority across root reload and restart with planning disabled", async () => {
  const f = await fixture();
  await applyExternalSettlement(f.request, f.runner);
  const workflowPath = path.join(f.dir, "WORKFLOW.md"), nextRoot = path.join(f.dir, "next-root");
  const writeWorkflow = (root: string) => fs.writeFileSync(workflowPath, `---\ntracker:\n  kind: fixture\nworkspace:\n  root: ${root}\ncodex:\n  command: echo unused\n---\nPrompt\n`);
  writeWorkflow(f.root);
  const profile: TrackerAdapterProfile = { kind: "fixture", documentation: "test", secretProviderKeys: [], secretEnvVars: [],
    defaultActiveStates: ["open"], defaultTerminalStates: ["closed"],
    createAdapter: () => ({ kind: "fixture", fetchIssuesByStates: async () => [], fetchIssuesByIds: async () => [] }) };
  const issue = { id: "42", identifier: "GH-42", title: "Reopened", description: null,
    nativeRef: { repo: "owner/repo", number: 42 }, url: "https://github.com/owner/repo/issues/42", state: "open",
    priority: 1, branchName: null, assigneeId: null, labels: [], blockedBy: [], dispatchable: true, createdAt: 1000, updatedAt: null };
  let tick: (() => void) | undefined, hooks = 0;
  const options = { workflowPath, cwd: f.dir, enablePlanning: false, trackerProfiles: [profile],
    logger: createStructuredLogger({ sinks: [] }), canDispatch: () => { hooks++; return false; },
    scheduler: { schedule: () => 1, cancel() {} },
    watcherScheduler: { schedule: (callback: () => void) => { tick = callback; return 1; }, cancel() {} } };
  const host = await createHost(options);
  try {
    await host.start();
    expect(host.authority.dispatchIssue(issue).kind).toBe("not_eligible");
    writeWorkflow(nextRoot); tick?.();
    expect(host.effective.serviceConfig.workspace.root).toBe(nextRoot);
    expect(host.authority.dispatchIssue(issue).kind).toBe("not_eligible");
    expect(hooks).toBe(0);
  } finally { await host.stop(); }
  const restarted = await createHost({ ...options, decisionStoreDir: f.storeDir,
    env: { DECISION_BRIDGE_URL: "http://127.0.0.1:1" } });
  const writer = new DurableDecisionStore({ storeDir: f.storeDir }); await writer.open();
  try {
    // Read terminal Decision authority without attempting a second writer lease.
    expect(restarted.authority.dispatchIssue(issue).kind).toBe("not_eligible");
    expect(hooks).toBe(0);
    // A distinct WorkKey remains eligible for the caller's admission hook.
    restarted.authority.dispatchIssue({ ...issue, id: "43", identifier: "GH-43", nativeRef: { repo: "owner/repo", number: 43 },
      url: "https://github.com/owner/repo/issues/43" });
    expect(hooks).toBe(1);
    fs.writeFileSync(path.join(f.storeDir, "store.json"), "corrupt");
    restarted.authority.dispatchIssue({ ...issue, id: "44", identifier: "GH-44", nativeRef: { repo: "owner/repo", number: 44 },
      url: "https://github.com/owner/repo/issues/44" });
    expect(hooks).toBe(1);
  } finally { await writer.close(); await restarted.stop(); }
});

it("previews through the built executable without a dynamic-import/top-level-await cycle", async () => {
  const f = await fixture();
  const file = path.join(f.dir, "authorized-preview.json");
  fs.writeFileSync(file, JSON.stringify(f.request));
  const bin = fileURLToPath(new URL("../dist/bin/symphony.js", import.meta.url));
  const result = spawnSync(process.execPath, [bin, "delivery-skill", "settle-external", "--request", file],
    { encoding: "utf8", timeout: 3000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.signal).toBeNull();
  expect(JSON.parse(result.stdout)).toMatchObject({ mode: "preview", request: f.request });
  expect(result.stderr).not.toContain("unsettled top-level await");
  expect(f.storage.readState()).toEqual(f.original);
  expect(readExternalSettlementJournal(f.root, f.key)).toBeNull();
});
