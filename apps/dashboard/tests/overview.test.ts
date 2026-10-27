// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { overview } from "../src/overview";
import { overviewGroups, token } from "../src/identity";
import { snapshot, work, freeze, fresh } from "./fixtures";
import { mount } from "../src/view";
describe("attention-first Overview / #171", () => {
  it("groups only supplied attention, waiting and explicit WorkKey associations", () => {
    const entries = ["normal", "waiting", "degraded", "failed", "needs_human"].map((attention, i) => work({ key: { provider: "github", key: `repo#${i}` }, attention: attention as ReturnType<typeof work>["attention"] }));
    const associated = work({ key: { provider: "github", key: "other/repo#0" } });
    const data = freeze(snapshot({ work: [...entries, associated], anomalies: [{ code: "review_result_target_mismatch", severity: "warning", message: "Associated signal", workKey: associated.key, detectedAt: 1 }] }));
    expect(overviewGroups(data).map(([, group]) => group.map(w => w.key.key))).toEqual([["repo#3", "repo#4"], ["other/repo#0", "repo#2"], ["repo#1"], ["repo#0"]]);
    const page = overview(data);
    expect(page.textContent).toContain("Associated signal");
    expect(page.querySelector("a")?.hash).toBe(`#${token(entries[3]!.key)}`);
    expect(data.work[0]?.attention).toBe("normal");
  });
  it("preserves inconsistent supplied conclusions and summary counts", () => {
    const data = freeze(snapshot({ work: [work({ ci: { status: "failure" }, phase: "completed", freshness: { github: { status: "unavailable", observedAt: null, lastAttemptAt: 1, reason: "offline" }, runtime: fresh, decision: fresh } })] }));
    expect(overviewGroups(data)[3]?.[1]).toHaveLength(1);
    const text = overview(data).textContent;
    expect(text).toContain("系统健康: healthy"); expect(text).toContain("normal"); expect(text).toContain("completed");
    expect([...overview(data).querySelectorAll("dd")].map(n => n.textContent)).toEqual(["7", "3", "2", "0", "4", "9"]);
  });
  it.each(["waiting_for_ci", "waiting_for_review", "waiting_for_executor"] as const)("shows supplied %s independently from attention", reason => {
    const data = snapshot({ work: [work({ waiting: { reason, since: null } })] });
    expect(overviewGroups(data)[2]?.[1]).toHaveLength(1);
    expect(overview(data).textContent).toContain(`等待: ${reason} · 自 未报告`);
  });
  it.each(["fresh", "stale", "unknown", "unavailable"] as const)("retains source posture for empty %s snapshot", status => {
    const supplied = status === "fresh" || status === "stale" ? { status, observedAt: 1, lastAttemptAt: 2 } : status === "unknown" ? { status, lastAttemptAt: null, reason: "not configured" } : { status, observedAt: null, lastAttemptAt: 2, reason: "offline" };
    const page = overview(snapshot({ work: [], sources: [{ source: "executor", instance: "test", freshness: supplied }] }));
    expect(page.textContent).toContain("没有已知工作"); expect(page.querySelector(`.freshness-${status}`)).not.toBeNull();
  });
  it("shows global anomalies and supplied executor ownership without assigning either to other work", () => {
    const data = snapshot({ anomalies: [{ code: "decision_result_without_task", severity: "error", message: "global signal", workKey: null, detectedAt: 1 }], executors: [{ id: "worker", adapter: "codex", role: "implementer", host: null, status: "busy", currentWork: work().key, lastHeartbeatAt: 1 }] });
    const page = overview(data);
    expect(page.textContent).toContain("global signal"); expect(page.textContent).toContain("worker · implementer · codex · busy");
    expect(overviewGroups(data)[1]?.[1]).toHaveLength(0);
  });
  it("retains generated time and distinct last successful receipt on refresh failure", () => {
    const root = document.createElement("div"); document.body.append(root); const view = mount(root, "production"); const data = snapshot();
    try {
      view.update({ snapshot: data, receivedAt: 10 }); const page = root.querySelector("#overview");
      view.update({ snapshot: data, receivedAt: 10, error: "HTTP 502" });
      expect(root.querySelector("#overview")).toBe(page);
      expect(root.textContent).toContain("上次成功响应 1970-01-01T00:00:00.010Z");
      expect(page?.textContent).toContain("快照生成 1970-01-01T00:00:00.005Z");
      expect(root.textContent).toContain("HTTP 502"); expect(root.textContent).toContain("当前生产只读观测");
    } finally { view.destroy(); root.remove(); }
  });
});
