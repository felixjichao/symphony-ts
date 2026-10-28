// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { OperationalAnomaly, ProjectionEvidence, WorkProjection, SourceFreshness } from "@symphony/operations";
import { workDetail } from "../src/detail";
import { mount } from "../src/view";
import { evidenceGroups, token } from "../src/identity";
import { validateSnapshot } from "../src/validate";
import { freeze, fresh, snapshot, work } from "./fixtures";
const sha = "a".repeat(40), old = "b".repeat(40), resultSha = "c".repeat(40);
const target = { repository: "owner/a", prNumber: 2, headSha: old };
function reviewWork(): WorkProjection {
  return work({ phase: "review", attention: "waiting", waiting: { reason: "waiting_for_review", since: 1 }, pullRequest: { number: 2, url: "", state: "open", isDraft: false, headSha: sha, mergeable: null }, review: { currentHeadSha: sha, taskTarget: target, approval: "approved_stale_head", task: { kind: "review", taskId: "same-task", revision: 3, target, status: "running", createdAtMs: 1, updatedAtMs: 2 }, result: { taskId: "same-task", revision: 3, createdAtMs: 4, outcome: { kind: "review", verdict: "approve", target: { ...target, headSha: resultSha } } } } });
}
function crumb(overrides: Partial<ProjectionEvidence> = {}): ProjectionEvidence { return { source: "decision", code: "review_task_running", observedAt: 1, detail: "task fact", role: "supporting", field: "status", value: "running", taskId: "same-task", revision: 3, target, ...overrides }; }
afterEach(() => { document.body.replaceChildren(); window.history.replaceState(null, "", "/"); });
describe("Work Detail diagnostic surface", () => {
  it.each([
    ["planning", "waiting", "waiting_for_plan"], ["ready", "normal", null], ["coding", "normal", null],
    ["ci", "waiting", "waiting_for_ci"], ["review", "waiting", "waiting_for_review"],
    ["coding", "waiting", "retry_backoff"], ["planning", "needs_human", "needs_human"],
    ["completed", "normal", null],
  ] as const)("renders supplied %s current context", (phase, attention, reason) => {
    const w = work({ phase, attention, waiting: reason === null ? null : { reason, since: 1 }, planning: { sessionStatus: null, taskStatus: null, planVerdict: "ready" }, execution: { issueId: "issue-1", attempt: 2, status: "streaming_turn", workspacePath: "/work/a", startedAtMs: 1, retryInMs: 3000 }, ci: { status: "pending" }, review: null });
    const node = workDetail(w, snapshot());
    for (const value of [phase, attention, "ready", "issue-1", "/work/a", "3000", "pending", "未提供审查信号"]) expect(node.textContent).toContain(value);
    if (reason !== null) expect(node.textContent).toContain(reason);
  });
  it("shows missing sections and preserves source links without accepting executable URLs", () => {
    const node = workDetail(work({ workItem: { identifier: "one", title: null, url: "javascript:alert(1)" }, execution: null, pullRequest: null, ci: null, review: null }), snapshot({ sources: [], executors: [] }));
    expect(node.querySelector("a")).toBeNull();
    for (const value of ["未提供", "未报告关联 Executor", "未提供 Work 专属来源状态", "未提供全局来源状态"]) expect(node.textContent).toContain(value);
    const linked = workDetail(work({ workItem: { identifier: "one", title: "Title", url: "https://example.com/issue" } }), snapshot());
    expect(linked.querySelector("a")?.href).toBe("https://example.com/issue");
  });
  it("keeps all exact targets and supplied contradictory conclusions independently visible", () => {
    const w = reviewWork(); const node = workDetail(freeze(w), freeze(snapshot())); document.body.append(node);
    for (const text of [sha, old, resultSha, "当前 PR HEAD", "ReviewTask target HEAD", "结果 / approval target HEAD", "投影 taskTarget", "same-task", "approve", "不表示当前 HEAD 获批", "phase: review", "attention: waiting", "waiting_for_review"]) expect(node.textContent).toContain(text);
    const inconsistent = workDetail(work({ ...w, phase: "completed", attention: "normal", ci: { status: "failure" }, review: { ...w.review!, approval: "approved_current_head" } }), snapshot());
    expect(inconsistent.textContent).toContain("phase: completed · attention: normal"); expect(inconsistent.textContent).toContain("当前 HEAD 获批"); expect(inconsistent.textContent).toContain("failure");
    const fallback = workDetail(work({ review: { ...w.review!, task: null } }), snapshot());
    expect(fallback.textContent).toContain("可能来自 result fallback"); expect(fallback.textContent).toContain(old);
  });
  it.each(["pending", "approved_current_head"] as const)("renders matching exact-HEAD review with %s supplied approval", approval => {
    const w = reviewWork(); const matching = { ...target, headSha: sha };
    const node = workDetail(work({ ...w, review: { ...w.review!, approval, taskTarget: matching, task: { ...w.review!.task!, kind: "review", target: matching }, result: { ...w.review!.result!, outcome: { kind: "review", verdict: "approve", target: matching } } }, evidence: [crumb({ target: matching })] }), snapshot());
    expect(node.textContent).toContain(sha); expect(node.textContent).not.toContain(old); expect(node.textContent).toContain("review_task_running");
  });
  it.each(["review_target_head_mismatch", "review_result_target_mismatch", "review_approval_head_mismatch", "execution_on_terminal_work", "decision_active_task_without_session", "decision_active_task_on_completed_session", "conflicting_active_review_tasks", "decision_result_without_task", "future_unknown_code"])("renders supplied %s with all contextual evidence", code => {
    const w = reviewWork(); const anomaly: OperationalAnomaly = { code, severity: "error", workKey: w.key, message: "<img src=x onerror=alert(1)> operational context", detectedAt: 3, evidence: [crumb(), crumb({ taskId: "second-task", target: { ...target, headSha: resultSha } })] };
    const node = workDetail(w, snapshot({ anomalies: [anomaly] }));
    for (const text of [code, "severity: error", "operational context", "same-task", "second-task", old, resultSha, "supporting", "field", "running"]) expect(node.textContent).toContain(text);
    expect(node.querySelector("img")).toBeNull();
  });
  it.each<SourceFreshness>([fresh, { status: "stale", observedAt: 1, lastAttemptAt: 2 }, { status: "unknown", lastAttemptAt: null, reason: "not_observed" }, { status: "unavailable", observedAt: null, lastAttemptAt: 2, reason: "partial_failure" }])("shows $status as supplied without inferring anomaly or trustworthy current facts", f => {
    const w = work({ freshness: { github: fresh, decision: f, runtime: f }, evidence: [crumb({ role: "discarded_freshness", freshnessStatus: f.status })] });
    const node = workDetail(w, snapshot({ sources: [{ source: "executor", instance: "global inventory", freshness: f }] }));
    expect(node.textContent).toContain(`decision: ${f.status}`); expect(node.textContent).toContain(`executor / global inventory: ${f.status}`); expect(node.textContent).toContain("discarded_freshness"); expect(node.textContent).toContain("当前快照未报告异常");
  });
  it("isolates evidence, anomalies, sources and executors by full WorkKey, including embedded foreign evidence", () => {
    const a = reviewWork(), b = { provider: "other", key: a.key.key };
    const node = workDetail(work({ ...a, evidence: [crumb(), crumb({ workKey: b, detail: "FOREIGN CRUMB" })] }), freeze(snapshot({ sources: [{ source: "decision", instance: "FOREIGN SOURCE", workKey: b, freshness: fresh }], anomalies: [{ code: "foreign", severity: "error", message: "FOREIGN ANOMALY", workKey: b, detectedAt: 1 }, { code: "global", severity: "warning", message: "GLOBAL ANOMALY", workKey: null, detectedAt: 1 }, { code: "local", severity: "error", message: "LOCAL ANOMALY", workKey: a.key, detectedAt: 1, evidence: [crumb({ workKey: b, detail: "FOREIGN NESTED" })] }], executors: [{ id: "FOREIGN EXECUTOR", role: "reviewer", adapter: "same-task", host: null, status: "busy", currentWork: b, lastHeartbeatAt: 1 }, { id: "LOCAL EXECUTOR", role: null, adapter: "same-task", host: null, status: "busy", currentWork: a.key, lastHeartbeatAt: 1 }] })));
    expect(node.textContent).not.toContain("FOREIGN"); expect(node.textContent).not.toContain("GLOBAL ANOMALY"); expect(node.textContent).toContain("证据归属不一致"); expect(node.textContent).toContain("LOCAL EXECUTOR"); expect(node.textContent).toContain("LOCAL ANOMALY");
  });
  it("preserves legacy/empty evidence and groups without modifying inputs or inventing supporting roles", () => {
    const items = freeze([crumb({ role: undefined }), crumb({ source: "github", role: "historical" })]); const before = JSON.stringify(items);
    expect(evidenceGroups(items).map(([label]) => label)).toEqual(["decision / role 未提供", "github / historical"]); expect(JSON.stringify(items)).toBe(before);
    const node = workDetail(work(), snapshot()); expect(node.textContent).toContain("未提供证据"); expect(node.textContent).toContain("当前快照未报告异常");
  });
  it("supports direct routes, switching, retained error snapshots, refresh focus, removal and invalid routes", () => {
    const root = document.createElement("div"); document.body.append(root); const view = mount(root); const a = work({ ...reviewWork(), evidence: [crumb()] }), b = work({ key: { provider: "github", key: "other/b#1" }, review: null, evidence: [crumb({ detail: "B ONLY" })] });
    window.history.replaceState(null, "", `#${token(a.key)}`);
    const data = snapshot({ work: [a, b] }); view.update({ snapshot: data }); expect(root.querySelector("#detail")?.textContent).toContain(sha);
    const summary = root.querySelector<HTMLElement>("#detail summary")!; summary.focus(); summary.parentElement!.setAttribute("open", "");
    view.update({ snapshot: snapshot({ work: [a, b] }) }); expect(document.activeElement?.id).toBe(summary.id); expect(root.querySelector<HTMLDetailsElement>("#detail details")?.open).toBe(true);
    window.history.replaceState(null, "", `#${token(b.key)}`); window.dispatchEvent(new Event("hashchange")); expect(document.activeElement?.id).toBe("detail-heading"); expect(root.querySelector("#detail")?.textContent).toContain("B ONLY"); expect(root.querySelector("#detail")?.textContent).not.toContain(sha);
    view.update({ snapshot: data, error: "network", receivedAt: 1 }); expect(root.textContent).toContain("刷新失败"); expect(root.querySelector("#detail")?.textContent).toContain("B ONLY");
    const raw = root.querySelector<HTMLDetailsElement>("#detail details")!; raw.open = true;
    const rawSummary = raw.querySelector("summary")!; rawSummary.focus();
    view.update({ snapshot: snapshot({ work: [a, work({ ...b, evidence: [] })] }) });
    expect(document.activeElement?.id).toBe("detail-heading");
    view.update({ snapshot: snapshot({ work: [a] }) }); expect(root.querySelector("#detail")?.textContent).toBe(""); expect(root.textContent).toContain("不在当前 scope");
    window.history.replaceState(null, "", "#%bad"); window.dispatchEvent(new Event("hashchange")); expect(root.querySelector("#detail")?.textContent).toBe(""); view.destroy();
  });
  it("accepts unknown anomaly codes and extra fields but rejects malformed consumed diagnostic data", () => {
    const good = snapshot({ work: [work({ evidence: [crumb()] })], anomalies: [{ code: "future-code", severity: "warning", workKey: null, message: "context", detectedAt: 1 }] }); expect(() => validateSnapshot(good)).not.toThrow();
    for (const malformed of [{ source: "unknown" }, { code: 42 }, { observedAt: "yesterday" }, { target: { ...target, headSha: 8 } }, { value: {} }, { workKey: { provider: "github" } }, { role: "inferred" }]) expect(() => validateSnapshot(snapshot({ work: [work({ evidence: [{ ...crumb(), ...malformed } as ProjectionEvidence] })] }))).toThrow("Invalid snapshot shape");
    for (const malformed of [{ severity: "fatal" }, { workKey: {} }, { detectedAt: null }, { evidence: [{}] }]) expect(() => validateSnapshot({ ...good, anomalies: [{ ...good.anomalies[0], ...malformed }] })).toThrow();
  });
});
