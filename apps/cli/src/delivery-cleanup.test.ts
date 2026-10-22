import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { formatPrBody, type Issue, type PersistedDeliveryState } from "@symphony/domain";
import type { TrackerAdapterProfile } from "@symphony/tracker";
import { createStructuredLogger } from "@symphony/observability";
import { createHost } from "./host";
import { FileDeliveryStateStorage, runDeliverySkillCli, withDeliveryAuthority } from "./delivery-skill-cli";
import { beginDeliverySubprocess, deliveryLifecycleAuthorityPath } from "./file-authority";
import { withDeliveryCleanupAuthority } from "./delivery-cleanup";
import { execute, saveRemote } from "../test-fixtures/durable-delivery-harness";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-cleanup-")); dirs.push(dir);
  const cwd = path.join(dir, "workspaces", "GH-42"); await fs.mkdir(cwd, { recursive: true });
  const storage = new FileDeliveryStateStorage(path.join(cwd, ".symphony", "delivery-state.json"));
  const state: PersistedDeliveryState = { repo: "owner/repo", issueNumber: 42, workspaceKey: "GH-42",
    spentRepairs: 2, spentWaitSeconds: 30, deadlineTimestampMs: 1234, isPaused: false, lastUpdated: "now",
    continuation: { intentId: "review", headBranch: "feature", baseBranch: "main", headSha: "a".repeat(40),
      prNumber: 7, optInLand: true, readyLabel: "symphony-ready", maxRepairAttempts: 3, maxWaitSeconds: 300, phase: "repair_pending" },
    landing: { intentId: "merge", context: { repo: "owner/repo", issueNumber: 42, workspaceKey: "GH-42", headBranch: "feature", baseBranch: "main" },
      prNumber: 7, headSha: "a".repeat(40), optIn: true, phase: "intent" } };
  storage.writeState(state);
  return { dir, cwd, storage, state };
}
async function sweep(dir: string, number = 42) {
  const issue: Issue = { id: String(number), identifier: `GH-${number}`, title: "closed by merge", description: "", state: "closed",
    nativeRef: null, priority: 1, branchName: null, url: null, assigneeId: null, labels: [], blockedBy: [], dispatchable: false, createdAt: 0, updatedAt: 0 };
  const profile: TrackerAdapterProfile = { kind: "fixture", documentation: "fixture", secretProviderKeys: [], secretEnvVars: [],
    defaultActiveStates: ["open"], defaultTerminalStates: ["closed"], createAdapter: () => ({ kind: "fixture",
      fetchIssuesByStates: async states => states.includes("closed") ? [issue] : [], fetchIssuesByIds: async () => [issue] }) };
  const workflowPath = path.join(dir, "WORKFLOW.md");
  await fs.writeFile(workflowPath, `---\ntracker:\n  kind: fixture\nworkspace:\n  root: ${dir}/workspaces\ncodex:\n  command: echo unused\n---\nPrompt\n`);
  const host = await createHost({ workflowPath, trackerProfiles: [profile],
    logger: createStructuredLogger({ sinks: [{ write() {} }] }), scheduler: { schedule: () => 1, cancel() {} } });
  try { await host.start(); } finally { await host.stop(); }
}
it("real startup sweep preserves the live Delivery owner across merge auto-close and its acknowledgement gap", async () => {
  const { dir, cwd, storage, state } = await fixture();
  await withDeliveryAuthority(cwd, async () => {
    await sweep(dir);
    expect(storage.readState()).toEqual(state);
    await expect(fs.stat(path.join(cwd, ".symphony", "delivery-authority.lock"))).resolves.toBeDefined();
    await expect(withDeliveryAuthority(cwd, async () => {})).rejects.toMatchObject({ code: "EEXIST" });
  });
  // A dead/finished owner is not evidence that merge or repair was acknowledged.
  await sweep(dir); expect(storage.readState()).toEqual(state);

});
it("keeps an unconfirmed subprocess fenced after its parent action returns", async () => {
  const { dir, cwd, storage, state } = await fixture();
  let close!: () => void;
  await withDeliveryAuthority(cwd, async () => { close = beginDeliverySubprocess(); });
  try { await sweep(dir); expect(storage.readState()).toEqual(state); }
  finally { close(); }
});
it("holds the stable outside mutex throughout deletion, including after the inner lock disappears", async () => {
  const { cwd, storage, state } = await fixture();
  const completed = { ...state }; delete completed.continuation; delete completed.landing;
  storage.writeState(completed);
  await withDeliveryCleanupAuthority(cwd, async () => {
    await fs.rm(cwd, { recursive: true });
    await expect(fs.stat(deliveryLifecycleAuthorityPath(cwd))).resolves.toBeDefined();
    await expect(withDeliveryAuthority(cwd, async () => {})).rejects.toMatchObject({ code: "EEXIST" });
    await expect(fs.stat(cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
it("formal halt preserves recovery steps and target in every intermediate write", async () => {
  const { cwd, storage, state } = await fixture();
  const observed: PersistedDeliveryState[] = [];
  const runner = { git: async () => { throw new Error("unexpected git"); }, exec: async () => { throw new Error("unexpected exec"); },
    gh: async (args: readonly string[]) => {
      observed.push(storage.readState()!);
      return { exitCode: 0, stderr: "", stdout: args.includes("view") ? '{"labels":[]}' : "" };
    } };
  expect(await runDeliverySkillCli(["halt", "--repo", "owner/repo", "--issue", "42", "--cwd", cwd],
    { stdout: { write() {} }, stderr: { write() {} } }, runner)).toBe(0);
  for (const snapshot of [...observed, storage.readState()!]) {
    expect(snapshot).toMatchObject({ continuation: state.continuation, landing: state.landing, workspaceKey: "GH-42",
      spentRepairs: 2, deadlineTimestampMs: 1234, handoff: { headBranch: "feature", prNumber: 7, headSha: state.landing!.headSha } });
  }
});
it.each(["corrupt", "foreign"])("formal halt refuses %s state without writes or remote calls", async kind => {
  const { cwd, storage, state } = await fixture();
  const file = path.join(cwd, ".symphony", "delivery-state.json");
  if (kind === "corrupt") await fs.writeFile(file, "{broken");
  else { const foreign = { ...state, issueNumber: 99 }; delete foreign.landing; storage.writeState(foreign); }
  const before = await fs.readFile(file, "utf8");
  let calls = 0;
  const fail = async () => { calls++; throw new Error("must not call remote"); };
  expect(await runDeliverySkillCli(["halt", "--repo", "owner/repo", "--issue", "42", "--cwd", cwd],
    { stdout: { write() {} }, stderr: { write() {} } }, { git: fail, gh: fail, exec: fail })).toBe(1);
  expect(await fs.readFile(file, "utf8")).toBe(before);
  expect(calls).toBe(0);
});

it.each(["legacy_owner", "unknown_child", "corrupt_state"])("startup refuses %s evidence without a host retry reservation", async kind => {
  const { dir, cwd, storage, state } = await fixture();
  if (kind === "corrupt_state") await fs.writeFile(path.join(cwd, ".symphony", "delivery-state.json"), "{broken");
  else await fs.writeFile(path.join(cwd, ".symphony", "delivery-authority.lock"), JSON.stringify(kind === "legacy_owner" ? { pid: 123 } :
    { pid: process.pid, hostname: os.hostname(), nonce: "old", effectsPending: true }));
  await sweep(dir);
  await expect(fs.stat(cwd)).resolves.toBeDefined();
  if (kind === "corrupt_state") expect(await fs.readFile(path.join(cwd, ".symphony", "delivery-state.json"), "utf8")).toBe("{broken");
  else expect(storage.readState()).toEqual(state);
});

it("cleans the completed state produced by real Delivery and Decision after auto-merge", async () => {
  const { dir } = await fixture();
  const cwd = path.join(dir, "workspaces", "GH-1"); await fs.mkdir(cwd);
  saveRemote(cwd, { head: "a".repeat(40), merged: false, merges: 0, comments: [], labels: ["symphony-ready"], repairs: 0 });
  const delivered = await execute(cwd, "", true, "approve");
  expect(delivered.result).toMatchObject({ status: "completed" });
  const storage = new FileDeliveryStateStorage(path.join(cwd, ".symphony", "delivery-state.json"));
  expect(storage.readState()).toMatchObject({ continuation: { phase: "result_observed", verdict: "approve" },
    landing: { phase: "observed", mergeCommitSha: "c".repeat(40) } });
  // No hand-written ready checkpoint: sweep consumes the unmodified production output.
  await sweep(dir, 1);
  await expect(fs.stat(cwd)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["head", "pr", "branch", "verdict", "no_commit"])("does not settle an unrelated or unverified merge (%s)", async mismatch => {
  const { dir, cwd, storage, state } = await fixture();
  const completed: PersistedDeliveryState = { ...state,
    continuation: { ...state.continuation!, phase: "result_observed", verdict: mismatch === "verdict" ? "changes_requested" : "approve" },
    landing: { ...state.landing!, phase: "observed", mergeCommitSha: "c".repeat(40),
      headSha: mismatch === "head" ? "b".repeat(40) : state.landing!.headSha,
      prNumber: mismatch === "pr" ? 8 : 7,
      context: { ...state.landing!.context, headBranch: mismatch === "branch" ? "other" : "feature" } } };
  if (mismatch === "no_commit") { const landing = { ...completed.landing! }; delete landing.mergeCommitSha;
    storage.writeState({ ...completed, landing });
  } else storage.writeState(completed);
  const file = path.join(cwd, ".symphony", "delivery-state.json");
  const expected = await fs.readFile(file, "utf8");
  await sweep(dir); expect(await fs.readFile(file, "utf8")).toBe(expected);
  await expect(fs.stat(cwd)).resolves.toBeDefined();
});
it.each(["persisted", "legacy", "legacy_unavailable"])("formal halt/recover deduplicates a lost Issue receipt (%s destination)", async mode => {
  const legacy = mode !== "persisted";
  let offline = mode === "legacy_unavailable";
  const { cwd, storage, state } = await fixture();
  const comments: Record<"issue" | "pr", { body: string }[]> = { issue: [], pr: [] };
  const queries: string[] = [];
  const runner = { git: async () => { throw new Error("unexpected git"); }, exec: async () => { throw new Error("unexpected exec"); },
    gh: async (args: readonly string[]) => {
      const kind = args[0] as "issue" | "pr";
      let value: unknown = {};
      if (args[1] === "comment") {
        comments[kind].push({ body: args[args.indexOf("--body") + 1]! });
        throw new Error("Remote accepted report; response lost");
      }
      if (args.includes("comments")) {
        queries.push(kind);
        if (offline) return { exitCode: 1, stderr: "comments unavailable", stdout: "" };
        value = { comments: comments[kind] };
      }
      else if (args.includes("body,headRefOid,headRefName,baseRefName")) value = {
        body: formatPrBody({ context: state.landing!.context }), headRefOid: state.landing!.headSha,
        headRefName: "feature", baseRefName: "main" };
      else value = { state: "OPEN", labels: [] };
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(value) };
    } };
  const io = { stdout: { write() {} }, stderr: { write() {} } };
  const args = ["--repo", "owner/repo", "--issue", "42", "--cwd", cwd];
  expect(await runDeliverySkillCli(["halt", ...args], io, runner)).toBe(1);
  expect(comments.issue).toHaveLength(1); expect(comments.pr).toHaveLength(0);
  expect(storage.readState()?.handoff).toMatchObject({ prNumber: 7, reportDestination: "issue" });
  if (legacy) {
    const old = storage.readState()!;
    const handoff = { ...old.handoff! }; delete handoff.reportDestination;
    storage.writeState({ ...old, handoff });
  }
  if (offline) {
    expect(await runDeliverySkillCli(["recover-handoff", ...args], io, runner)).toBe(1);
    expect(storage.readState()?.handoff?.reportDestination).toBeUndefined();
    expect(comments.issue).toHaveLength(1); expect(comments.pr).toHaveLength(0);
    offline = false;
  }
  expect(await runDeliverySkillCli(["recover-handoff", ...args], io, runner)).toBe(0);
  expect(await runDeliverySkillCli(["recover-handoff", ...args], io, runner)).toBe(0);
  expect(queries).toContain("issue");
  if (!legacy) expect(queries).not.toContain("pr");
  expect(comments.issue).toHaveLength(1); expect(comments.pr).toHaveLength(0);
  expect(storage.readState()).toMatchObject({ pendingCompensation: false, handoff: { prNumber: 7, reportDestination: "issue" } });
});
