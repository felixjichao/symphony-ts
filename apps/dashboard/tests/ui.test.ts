// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { SourceFreshness } from "@symphony/operations";
import { mount } from "../src/view";
import { findWork, token } from "../src/identity";
import { ordered } from "../src/presentation";
import { snapshot, work, freeze, fresh } from "./fixtures";
let destroy = () => {};
afterEach(() => { destroy(); document.body.replaceChildren(); window.location.hash = ""; });
function setup() { const root = document.createElement("div"); document.body.append(root); const view = mount(root); destroy = view.destroy; return { root, view }; }
describe("read-only dashboard component", () => {
  it("renders loading without made-up zero counts, then preserves deliberately inconsistent semantics", () => {
    const { root, view } = setup(); view.update({}); expect(root.textContent).toContain("加载快照"); expect(root.querySelector("dl")).toBeNull();
    const data = freeze(snapshot()); view.update({ snapshot: data, receivedAt: 8 });
    expect(root.textContent).toContain("系统健康: healthy"); expect(root.querySelector("td:nth-child(2)")?.textContent).toBe("coding");
    expect(root.querySelector("td:nth-child(4)")?.textContent).toBe("success"); expect(root.textContent).toContain("批准状态未知");
    expect([...root.querySelectorAll("dd")].map(e => e.textContent)).toEqual(["7", "3", "2", "0", "4", "9"]);
    view.update({ snapshot: freeze(snapshot({ work: [work({ ci: { status: "failure" }, pullRequest: { number: 1, url: "", state: "open", isDraft: false, headSha: "a".repeat(40), mergeable: null } })] })) });
    expect(root.querySelector("td:nth-child(2)")?.textContent).toBe("coding"); expect(root.textContent).toContain("批准状态未知");
  });
  it.each(["needs_human", "failed", "degraded", "waiting", "normal"] as const)("shows supplied %s attention", attention => {
    const { root, view } = setup(); view.update({ snapshot: snapshot({ work: [work({ attention })] }) }); expect(root.querySelector("td:nth-child(6)")?.textContent).toBe(attention);
  });
  it.each(["waiting_for_ci", "waiting_for_review"] as const)("shows %s without inventing a wait start", reason => {
    const { root, view } = setup(); view.update({ snapshot: snapshot({ work: [work({ waiting: { reason, since: null } })] }) }); expect(root.textContent).toContain(`${reason} · 自 未报告`);
  });
  it("distinguishes no active work, no known work, and optional legacy counts", () => {
    const { root, view } = setup(); view.update({ snapshot: snapshot({ summary: { active: 0, waiting: 0, retrying: 0, needsHuman: 0 }, work: [work({ phase: "completed" })] }) });
    expect(root.textContent).toContain("completed"); expect(root.textContent).toContain("该版本未提供"); expect(root.textContent).not.toContain("没有已知工作");
    view.update({ snapshot: snapshot({ work: [] }) }); expect(root.textContent).toContain("没有已知工作");
  });
  it.each<SourceFreshness>([fresh, { status: "stale", observedAt: 1, lastAttemptAt: 2 }, { status: "unknown", lastAttemptAt: null, reason: "source_not_configured" }, { status: "unavailable", observedAt: null, lastAttemptAt: 2, reason: "unreachable" }])("shows source $status on system/work and empty executor inventory", f => {
    const { root, view } = setup(); view.update({ snapshot: snapshot({ health: "unavailable", work: [work({ freshness: { github: f, runtime: f, decision: f } })], sources: [{ source: "executor", instance: "demo", freshness: f }] }) });
    expect(root.textContent).toContain(`系统健康: unavailable`); expect(root.textContent).toContain(`Executor 来源: ${f.status}`); expect(root.textContent).toContain(`GitHub: ${f.status}`); expect(root.textContent).toContain("清单为空");
  });
  it("retains the last snapshot on observational failure, then recovers", () => {
    const { root, view } = setup(); const data = snapshot(); view.update({ snapshot: data, receivedAt: 5 }); view.update({ snapshot: data, receivedAt: 5, error: "HTTP 502" });
    expect(root.textContent).toContain("刷新失败，显示上次成功快照"); expect(root.textContent).toContain("HTTP 502"); expect(root.querySelectorAll("tbody tr")).toHaveLength(1);
    view.update({ snapshot: snapshot(), receivedAt: 10 }); expect(root.textContent).not.toContain("刷新失败");
  });
  it("preserves exact identifiers, keyboard detail focus, and open state across refresh", () => {
    const { root, view } = setup(); const sha = "b".repeat(40); const target = { repository: "owner/a", prNumber: 2, headSha: sha };
    view.update({ snapshot: snapshot({ work: [work({ review: { currentHeadSha: "a".repeat(40), taskTarget: target, task: { kind: "review", taskId: "task-one", revision: 3, target, status: "running", createdAtMs: 1, updatedAtMs: 2 }, result: { taskId: "task-two", revision: 4, createdAtMs: 2, outcome: { kind: "review", verdict: "approve", target } }, approval: "approved_stale_head" } })] }) });
    const detail = root.querySelector("details")!; detail.open = true; const summary = detail.querySelector("summary")!; summary.focus();
    expect(detail.textContent).toContain(sha); expect(detail.textContent).toContain("task-one"); expect(detail.textContent).toContain("task-two"); expect(root.textContent).toContain("不表示当前 HEAD 获批");
    view.update({ snapshot: snapshot() }); expect(root.querySelector("details")?.open).toBe(true); expect(document.activeElement?.tagName).toBe("SUMMARY");
  });
  it("uses complete WorkKey for routes, lookup and stable attention order across repositories", () => {
    const a = work({ attention: "waiting" }); const b = work({ key: { provider: "github", key: "other/b#1" }, attention: "needs_human" });
    expect(findWork([a, b], token(b.key))).toBe(b); expect(findWork([a], token(b.key))).toBeUndefined(); expect(findWork([a], "%bad")).toBeUndefined();
    expect(ordered(freeze([a, b]))).toEqual([b, a]);
    const { root, view } = setup(); window.location.hash = token(b.key); view.update({ snapshot: snapshot({ work: [a, b] }) }); expect(root.textContent).toContain("已定位 github:other/b#1");
    window.location.hash = "%bad"; window.dispatchEvent(new Event("hashchange")); expect(root.textContent).toContain("工作标识无效");
  });
  it("never interprets supplied issue/title strings as markup", () => { const { root, view } = setup(); view.update({ snapshot: snapshot({ work: [work({ workItem: { identifier: "<script>", title: "<img src=x onerror=alert(1)>", url: "javascript:alert(1)" } })] }) }); expect(root.querySelector("script,img")).toBeNull(); });
});
