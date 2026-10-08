import { describe, expect, it } from "vitest";
import {
  type DecisionTask, type DecisionTaskStatus, type DecisionSession, type DecisionResult,
  type DecisionReviewTarget, type DecisionLease, type ExecutorBinding,
  githubDecisionRoot, decisionSessionId, decisionTaskId, parseDecisionTask,
  parseDecisionResult, parseDecisionSession, parseExecutorBinding, parseDecisionLease,
  parseDecisionReviewTarget, claimDecisionTask, startDecisionTask, completeDecisionTask,
  failDecisionTask, cancelDecisionTask, supersedeDecisionTask, releaseExpiredDecisionTask,
  validateDecisionResultForTask, isDecisionReviewApproved, rebindDecisionSession,
  breakDecisionBinding, completeDecisionSession, reopenDecisionSession,
} from "./index";

const root = githubDecisionRoot("Owner", "Repo", 94);
const sessionId = decisionSessionId(root);
const target: DecisionReviewTarget = { repository: "owner/repo", prNumber: 100, headSha: "a".repeat(40) };
const lease: DecisionLease = { owner: "worker", token: "claim-1", generation: 1, expiresAtMs: 100 };
const binding: ExecutorBinding = { schemaVersion: 1, adapter: "executor", externalSessionRef: "opaque", resumeUri: null, generation: 1 };
function session(): DecisionSession {
  return { schemaVersion: 1, id: sessionId, root, status: "active", binding: null, bindingGeneration: 0, createdAtMs: 0, updatedAtMs: 0 };
}
function task(kind: "plan" | "review" = "review", revision = 1, reviewTarget = target, id = sessionId): DecisionTask {
  const common = { schemaVersion: 1 as const, sessionId: id, revision, status: "pending" as const, lease: null, claimGeneration: 0, lastClaimToken: null, createdAtMs: 0, updatedAtMs: 0 };
  return kind === "plan"
    ? { ...common, kind, id: decisionTaskId({ sessionId: id, revision, kind }) }
    : { ...common, kind, target: reviewTarget, id: decisionTaskId({ sessionId: id, revision, kind, target: reviewTarget }) };
}
function result(t: DecisionTask = task()): DecisionResult {
  const common = { schemaVersion: 1 as const, taskId: t.id, sessionId: t.sessionId, revision: t.revision, createdAtMs: 3 };
  return t.kind === "plan"
    ? { ...common, kind: "plan", verdict: "ready", content: { plan: "Implement contracts", acceptanceCriteria: ["Reject stale approvals"], risks: [], clarifications: [] } }
    : { ...common, kind: "review", target: t.target, verdict: "approve", findings: [] };
}
function running(t = task()): DecisionTask { return startDecisionTask(claimDecisionTask(t, lease, 1), lease, 2); }
function completed(t = task(), r = result(t)): DecisionTask { return completeDecisionTask(running(t), r, lease, 4); }
const statuses: readonly DecisionTaskStatus[] = ["pending", "claimed", "running", "completed", "failed", "cancelled", "superseded"];
function inStatus(status: DecisionTaskStatus): DecisionTask {
  switch (status) {
    case "pending": return task();
    case "claimed": return claimDecisionTask(task(), lease, 1);
    case "running": return running();
    case "completed": return completed();
    case "failed": return failDecisionTask(running(), lease, 4);
    case "cancelled": return cancelDecisionTask(running(), 4);
    case "superseded": return supersedeDecisionTask(completed(), 5);
  }
}

describe("Decision identity and v1 persistence", () => {
  it("uses an Issue root across PRs, replacement PRs and executors", () => {
    expect(sessionId).toBe("github:owner/repo#94");
    const tasks = [task("plan"), task(), task("review", 2), task("review", 1, { ...target, prNumber: 101 }), task("review", 1, { ...target, repository: "other/repo" }), task("review", 1, { ...target, headSha: "b".repeat(40) }), task("review", 1, target, "github:owner/repo#95")];
    expect(new Set(tasks.map(t => t.id)).size).toBe(tasks.length);
    expect(tasks.slice(0, -1).every(t => t.sessionId === sessionId)).toBe(true);
    expect(decisionSessionId({ provider: "work-items", key: "project:abc#1" })).toBe("work-items:project:abc#1");
    expect(() => githubDecisionRoot("owner", "repo", 0)).toThrow();
    expect(() => githubDecisionRoot("owner/evil", "repo", 1)).toThrow();
  });
  it("round-trips every independent record and all verdicts through JSON", () => {
    const records: readonly (readonly [unknown, (v: unknown) => unknown])[] = [
      [session(), parseDecisionSession], [binding, parseExecutorBinding], [lease, parseDecisionLease],
      [target, parseDecisionReviewTarget], ...statuses.map(s => [inStatus(s), parseDecisionTask] as const),
      [task("plan"), parseDecisionTask],
    ];
    for (const [value, parse] of records) expect(parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    for (const kind of ["plan", "review"] as const) {
      const verdicts = kind === "plan" ? ["ready", "needs_clarification", "needs_human"] : ["approve", "changes_requested", "needs_human"];
      for (const verdict of verdicts) {
        const value = { ...result(task(kind)), verdict };
        expect(parseDecisionResult(JSON.parse(JSON.stringify(value)))).toEqual(value);
        expect(completeDecisionTask(running(task(kind)), parseDecisionResult(value), lease, 4).status).toBe("completed");
      }
    }
  });
  it("rejects unknown fields, missing fields and versions on every record", () => {
    for (const [value, parse] of [[session(), parseDecisionSession], [task(), parseDecisionTask], [result(), parseDecisionResult], [binding, parseExecutorBinding]] as const) {
      expect(() => parse({ ...value, schemaVersion: 2 })).toThrow();
      expect(() => parse({ ...value, unknown: true })).toThrow();
      const { schemaVersion: _version, ...missing } = value;
      expect(() => parse(missing)).toThrow();
    }
    expect(() => parseDecisionTask({ ...task(), target: { ...target, extra: true } })).toThrow();
    expect(() => parseDecisionSession({ ...session(), root: { ...root, extra: true } })).toThrow();
    expect(() => parseDecisionResult({ ...result(task("plan")), content: { plan: "x", acceptanceCriteria: [], risks: [], clarifications: [], extra: 1 } })).toThrow();
    expect(() => parseDecisionResult({ ...result(), findings: [{ severity: "blocker", message: "x", location: null, extra: 1 }] })).toThrow();
    expect(() => parseDecisionTask({ ...inStatus("claimed"), lease: { ...lease, extra: true } })).toThrow();
    expect(() => parseDecisionSession({ ...session(), binding: { ...binding, extra: true }, bindingGeneration: 1 })).toThrow();
  });
  it("rejects malformed scalars, nested content, identity and lifecycle shapes", () => {
    for (const value of [null, [], "task", 1, new Date()]) expect(() => parseDecisionTask(value)).toThrow();
    for (const revision of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => parseDecisionTask({ ...task(), revision })).toThrow();
    for (const headSha of ["abc", "g".repeat(40), "A".repeat(40), "a".repeat(41)]) expect(() => parseDecisionReviewTarget({ ...target, headSha })).toThrow();
    for (const patch of [{ status: "completed" }, { status: "failed" }, { id: "wrong" }, { sessionId: "pr:100", id: "wrong" }, { status: "unknown" }, { kind: "accept" }, { lease }, { updatedAtMs: -1 }, { createdAtMs: 2 }, { claimGeneration: 1 }]) expect(() => parseDecisionTask({ ...task(), ...patch })).toThrow();
    for (const patch of [{ verdict: "ready" }, { taskId: "wrong" }, { findings: [null] }, { findings: [{ severity: "error", message: "x", location: null }] }, { findings: [{ severity: "blocker", message: "", location: null }] }]) expect(() => parseDecisionResult({ ...result(), ...patch })).toThrow();
    expect(() => parseDecisionResult({ ...result(task("plan")), content: { plan: "x", acceptanceCriteria: [1], risks: [], clarifications: [] } })).toThrow();
    expect(() => parseDecisionSession({ ...session(), id: "github:owner/repo#95" })).toThrow();
    expect(() => parseExecutorBinding({ ...binding, generation: 0 })).toThrow();
    expect(() => parseDecisionSession({ ...session(), binding, bindingGeneration: 2 })).toThrow();
    expect(() => parseDecisionSession({ ...session(), status: "broken-binding", binding, bindingGeneration: 1 })).toThrow();
  });
});

describe("Decision task transition table", () => {
  const operations = [
    { name: "claim", allowed: ["pending"], next: "claimed", run: (t: DecisionTask) => claimDecisionTask(t, lease, 6) },
    { name: "start", allowed: ["claimed"], next: "running", run: (t: DecisionTask) => startDecisionTask(t, lease, 6) },
    { name: "complete", allowed: ["running"], next: "completed", run: (t: DecisionTask) => completeDecisionTask(t, result(t), lease, 6) },
    { name: "fail", allowed: ["claimed", "running"], next: "failed", run: (t: DecisionTask) => failDecisionTask(t, lease, 6) },
    { name: "cancel", allowed: ["pending", "claimed", "running"], next: "cancelled", run: (t: DecisionTask) => cancelDecisionTask(t, 6) },
    { name: "supersede", allowed: statuses.filter(s => s !== "superseded"), next: "superseded", run: (t: DecisionTask) => supersedeDecisionTask(t, 6) },
    { name: "release expiry", allowed: ["claimed", "running"], next: "pending", run: (t: DecisionTask) => releaseExpiredDecisionTask(t, 100) },
  ];
  for (const operation of operations) for (const status of statuses) {
    it(`${status} → ${operation.name}: ${operation.allowed.includes(status) ? "legal" : "illegal"}`, () => {
      const t = inStatus(status);
      const snapshot = JSON.stringify(t);
      if (operation.allowed.includes(status)) expect(operation.run(t).status).toBe(operation.next);
      else expect(() => operation.run(t)).toThrow();
      expect(JSON.stringify(t)).toBe(snapshot);
    });
  }
  it("requires a live claim, rejects late results and fences old claim generations", () => {
    expect(() => releaseExpiredDecisionTask(running(), 99)).toThrow();
    for (const now of [100, 101]) {
      expect(() => startDecisionTask(inStatus("claimed"), lease, now)).toThrow();
      expect(() => completeDecisionTask(running(), result(), lease, now)).toThrow();
      expect(() => failDecisionTask(running(), lease, now)).toThrow();
    }
    const pending = releaseExpiredDecisionTask(running(), 100);
    expect(() => claimDecisionTask(pending, { ...lease, expiresAtMs: 200 }, 101)).toThrow();
    expect(() => claimDecisionTask(pending, { ...lease, generation: 2, expiresAtMs: 200 }, 101)).toThrow();
    const nextLease = { ...lease, token: "claim-2", generation: 2, expiresAtMs: 200 };
    const claimed = claimDecisionTask(pending, nextLease, 101);
    expect(() => startDecisionTask(claimed, lease, 102)).toThrow();
    const next = startDecisionTask(claimed, nextLease, 102);
    expect(() => completeDecisionTask(next, { ...result(), createdAtMs: 103 }, lease, 104)).toThrow();
    expect(completeDecisionTask(next, { ...result(), createdAtMs: 103 }, nextLease, 104).status).toBe("completed");
    for (const patch of [{ token: "foreign" }, { owner: "foreign" }, { generation: 2 }, { expiresAtMs: 101 }]) expect(() => completeDecisionTask(running(), result(), { ...lease, ...patch }, 4)).toThrow();
    expect(() => completeDecisionTask(running(), { ...result(), createdAtMs: 5 }, lease, 4)).toThrow();
    expect(() => startDecisionTask(inStatus("claimed"), lease, 0)).toThrow();
  });
});

describe("Exact revision review authorization", () => {
  it("approves only the exact session/repository/PR/HEAD", () => {
    const t = completed(); const r = result();
    if (r.kind !== "review") throw new Error("Expected review fixture");
    const current = { ...target, sessionId };
    expect(isDecisionReviewApproved(t, r, current)).toBe(true);
    for (const patch of [{ headSha: "b".repeat(40) }, { prNumber: 101 }, { repository: "other/repo" }, { sessionId: "github:owner/repo#95" }, { headSha: "abc" }]) expect(isDecisionReviewApproved(t, r, { ...current, ...patch })).toBe(false);
    for (const status of statuses.filter(s => s !== "completed")) expect(isDecisionReviewApproved(inStatus(status), r, current)).toBe(false);
    for (const verdict of ["changes_requested", "needs_human"] as const) expect(isDecisionReviewApproved(t, { ...r, verdict }, current)).toBe(false);
    expect(isDecisionReviewApproved(t, { ...r, createdAtMs: 5 }, current)).toBe(false);
    expect(isDecisionReviewApproved(completed(task("plan")), result(task("plan")), current)).toBe(false);
  });
  it("SHA A → B → A cannot resurrect superseded approval; history remains intact", () => {
    const r = result(); const a = completed();
    const b = task("review", 2, { ...target, headSha: "b".repeat(40) });
    expect(isDecisionReviewApproved(a, r, { ...target, headSha: "b".repeat(40), sessionId })).toBe(false);
    const stale = supersedeDecisionTask(a, 5);
    expect(isDecisionReviewApproved(stale, r, { ...target, sessionId })).toBe(false);
    expect(() => completeDecisionTask(stale, r, lease, 6)).toThrow();
    expect(b.sessionId).toBe(a.sessionId);
    expect(parseDecisionResult(r)).toEqual(r);
  });
  it("rejects mismatched kinds, revisions, tasks and targets at submission", () => {
    for (const other of [task("plan"), task("review", 2), task("review", 1, { ...target, prNumber: 101 }), task("review", 1, { ...target, repository: "other/repo" }), task("review", 1, { ...target, headSha: "b".repeat(40) }), task("review", 1, target, "github:owner/repo#95")]) {
      expect(() => validateDecisionResultForTask(task(), result(other))).toThrow();
      expect(() => completeDecisionTask(running(), result(other), lease, 4)).toThrow();
    }
    expect(() => validateDecisionResultForTask({ ...task(), createdAtMs: 4, updatedAtMs: 4 }, result())).toThrow();
  });
});

describe("Session lifecycle and executor continuity", () => {
  it("binds, loses binding, rebinds and retains generation without changing decisions", () => {
    const bound = rebindDecisionSession(session(), binding, 1);
    const broken = breakDecisionBinding(bound, 2);
    expect(broken.binding).toBeNull(); expect(broken.bindingGeneration).toBe(1);
    for (const generation of [0, 1, 3]) expect(() => rebindDecisionSession(broken, { ...binding, generation }, 3)).toThrow();
    const rebound = rebindDecisionSession(broken, { ...binding, adapter: "another-executor", externalSessionRef: "replacement", resumeUri: "opaque:resume", generation: 2 }, 3);
    expect(rebound.status).toBe("active"); expect(rebound.id).toBe(sessionId);
    expect(isDecisionReviewApproved(completed(), result(), { ...target, sessionId: rebound.id })).toBe(true);
    expect(() => breakDecisionBinding(session(), 1)).toThrow();
    expect(() => breakDecisionBinding(broken, 3)).toThrow();
    expect(session().bindingGeneration).toBe(0);
  });
  it("completes only with terminal tasks and explicitly reopens the same root", () => {
    for (const status of statuses) {
      if (["pending", "claimed", "running"].includes(status)) expect(() => completeDecisionSession(session(), [inStatus(status)], 6)).toThrow();
      else expect(completeDecisionSession(session(), [inStatus(status)], 6).status).toBe("completed");
    }
    const done = completeDecisionSession(session(), [completed()], 6);
    expect(() => completeDecisionSession(done, [], 7)).toThrow();
    expect(() => rebindDecisionSession(done, binding, 7)).toThrow();
    expect(() => breakDecisionBinding(done, 7)).toThrow();
    expect(reopenDecisionSession(done, 7)).toEqual({ ...done, status: "active", updatedAtMs: 7 });
    expect(() => reopenDecisionSession(session(), 1)).toThrow();
    expect(() => completeDecisionSession(session(), [task("plan", 1, target, "github:owner/repo#95")], 6)).toThrow();
    const broken = breakDecisionBinding(rebindDecisionSession(session(), binding, 1), 2);
    expect(completeDecisionSession(broken, [], 3).status).toBe("completed");
    expect(() => rebindDecisionSession(broken, { ...binding, generation: 2 }, 1)).toThrow();
  });
});


describe("Session transition table", () => {
  const active = rebindDecisionSession(session(), binding, 1);
  const broken = breakDecisionBinding(active, 2);
  const done = completeDecisionSession(active, [], 2);
  const sessions = [active, broken, done];
  const operations = [
    { name: "rebind", allowed: ["active", "broken-binding"], next: "active", run: (s: DecisionSession) => rebindDecisionSession(s, { ...binding, generation: 2 }, 3) },
    { name: "break", allowed: ["active"], next: "broken-binding", run: (s: DecisionSession) => breakDecisionBinding(s, 3) },
    { name: "complete", allowed: ["active", "broken-binding"], next: "completed", run: (s: DecisionSession) => completeDecisionSession(s, [], 3) },
    { name: "reopen", allowed: ["completed"], next: "active", run: (s: DecisionSession) => reopenDecisionSession(s, 3) },
  ];
  for (const s of sessions) for (const op of operations) {
    it(`${s.status} → ${op.name}`, () => {
      const original = JSON.stringify(s);
      if (op.allowed.includes(s.status)) expect(op.run(s).status).toBe(op.next);
      else expect(() => op.run(s)).toThrow();
      expect(JSON.stringify(s)).toBe(original);
    });
  }
  it("rejects non-JSON object fields and unsupported nested shapes", () => {
    const hidden = { ...binding };
    Object.defineProperty(hidden, "adapter", { value: "executor", enumerable: false });
    expect(() => parseExecutorBinding(hidden)).toThrow();
    const accessor = { ...binding };
    Object.defineProperty(accessor, "adapter", { get: () => "executor", enumerable: true });
    expect(() => parseExecutorBinding(accessor)).toThrow();
    expect(() => parseExecutorBinding({ ...binding, resumeUri: undefined })).toThrow();
    expect(() => parseDecisionSession({ ...session(), status: "broken-binding" })).toThrow();
    expect(() => parseDecisionLease({ ...lease, expiresAtMs: Infinity })).toThrow();
    expect(() => parseDecisionLease({ ...lease, owner: "" })).toThrow();
    expect(() => parseDecisionReviewTarget({ ...target, repository: "OWNER/repo" })).toThrow();
    expect(() => parseDecisionReviewTarget({ ...target, prNumber: 0 })).toThrow();
    expect(() => parseDecisionResult({ ...result(), findings: [{ severity: "suggestion", message: "Consider simplification", location: 1 }] })).toThrow();
    const review = result();
    if (review.kind !== "review") throw new Error("Expected review fixture");
    expect(parseDecisionResult({ ...review, findings: [{ severity: "suggestion", message: "Consider simplification", location: "file.ts:1" }] }).kind).toBe("review");
  });
});
