// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { executors } from "../src/executors";
import { system } from "../src/system";
import { mount } from "../src/view";
import { token } from "../src/identity";
import { fresh, snapshot, work } from "./fixtures";

describe("Executors and System / #175", () => {
  it("shows supplied executor fields and full WorkKey links, including idle and nullable metadata", () => {
    const key = work().key, other = { provider: "other", key: key.key };
    const page = executors(snapshot({ executors: [
      { id: "one", role: "implementer", adapter: "codex", status: "busy", host: "host-a", lastHeartbeatAt: 1, currentWork: key },
      { id: "two", role: null, adapter: "other", status: "online", host: null, lastHeartbeatAt: null, currentWork: other },
      { id: "idle", role: null, adapter: "codex", status: "online", host: null, lastHeartbeatAt: null, currentWork: null },
    ] }));
    expect(page.textContent).toContain("host-a"); expect(page.textContent).toContain("未报告"); expect(page.textContent).toContain("idle");
    expect([...page.querySelectorAll('a')].map(a => a.hash)).toEqual([`#${token(key)}`, `#${token(other)}`]);
  });
  it.each(["fresh", "stale", "unknown", "unavailable"] as const)("retains %s empty inventory source", status => {
    const freshness = status === "fresh" || status === "stale" ? { status, observedAt: 1, lastAttemptAt: 2 } : status === "unknown" ? { status, lastAttemptAt: null, reason: "unconfigured" } : { status, observedAt: null, lastAttemptAt: 2, reason: "offline" };
    const page = executors(snapshot({ sources: [{ source: "executor", instance: "e", freshness }] }));
    expect(page.querySelector(`.freshness-${status}`)).not.toBeNull();
    expect(page.textContent).toContain("清单为空");
  });
  it("shows missing coverage, partial failures, all source states and distinct anomaly scopes", () => {
    expect(executors(snapshot({ sources: [] })).textContent).toContain("未提供 executor 来源状态");
    const key = work().key, other = { provider: "other", key: key.key };
    const data = snapshot({ health: "healthy", sources: [
      { source: "github", instance: "g", freshness: fresh, workKey: key },
      { source: "runtime", instance: "r", freshness: { status: "stale", observedAt: 1, lastAttemptAt: 2 } },
      { source: "decision", instance: "d", freshness: { status: "unknown", lastAttemptAt: null, reason: "unconfigured" } },
      { source: "executor", instance: "e", freshness: { status: "unavailable", observedAt: null, lastAttemptAt: 2, reason: "offline" }, workKey: other },
    ], anomalies: [
      { code: "decision_result_without_task", severity: "error", message: "GLOBAL", workKey: null, detectedAt: 1 },
      { code: "review_result_target_mismatch", severity: "warning", message: "WORK", workKey: other, detectedAt: 1 },
    ] });
    const page = system(data, { snapshot: data, receivedAt: 10, error: "HTTP 502" });
    for (const status of ["fresh", "stale", "unknown", "unavailable"]) expect(page.querySelector(`.freshness-${status}`)).not.toBeNull();
    expect(page.textContent).toContain("系统健康: healthy"); expect(page.textContent).toContain("offline"); expect(page.textContent).toContain("HTTP 502");
    expect(page.textContent?.indexOf("GLOBAL")).toBeLessThan(page.textContent!.indexOf("Work 范围异常"));
    expect(page.textContent?.indexOf("WORK")).toBeGreaterThan(page.textContent!.indexOf("Work 范围异常"));
    expect([...page.querySelectorAll("a")].some(a => a.hash === `#${token(other)}`)).toBe(true);
  });
  it("updates transport independently while keeping the last snapshot", () => {
    const root = document.createElement("div"); document.body.append(root); const view = mount(root); const data = snapshot();
    try { view.update({ snapshot: data, receivedAt: 10 }); const page = root.querySelector("#system"); view.update({ snapshot: data, receivedAt: 10, error: "offline" }); expect(root.querySelector("#system")).toBe(page); expect(page?.textContent).toContain("offline"); expect(page?.textContent).toContain("1970-01-01T00:00:00.010Z"); } finally { view.destroy(); root.remove(); }
  });
});
