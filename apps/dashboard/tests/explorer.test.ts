// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createExplorer } from "../src/explorer";
import { token } from "../src/identity";
import { snapshot, work, fresh } from "./fixtures";

const a = work({ attention: "normal", workItem: { identifier: "a#1", title: "Alpha", url: null } });
const b = work({ key: { provider: "github", key: "owner/b#1" }, workItem: { identifier: "b#1", title: "Beta", url: null }, phase: "review", attention: "needs_human", freshness: { github: { status: "stale", observedAt: 1, lastAttemptAt: 2 }, runtime: { status: "unknown", lastAttemptAt: null, reason: "source_not_configured" }, decision: { status: "unavailable", observedAt: null, lastAttemptAt: 2, reason: "unreachable" } }, review: { currentHeadSha: "a".repeat(40), taskTarget: null, task: null, result: null, approval: "approved_stale_head" } });
function setup() { const explorer = createExplorer(); const root = explorer.update(snapshot({ work: [a, b] })); document.body.append(root); return { explorer, root }; }
function change(root: HTMLElement, id: string, value: string) { const input = root.querySelector<HTMLSelectElement>(`#explorer-${id}`)!; input.value = value; input.dispatchEvent(new Event("change")); }
function rows(root: HTMLElement) { return [...root.querySelectorAll("tbody tr")]; }
describe("Work Explorer", () => {
  it("orders by supplied attention, preserves full WorkKey routes and review/freshness distinctions", () => {
    const { root } = setup(); expect(rows(root).map(row => row.id)).toEqual([`work-${token(b.key)}`, `work-${token(a.key)}`]);
    expect(rows(root)[0]?.querySelector("a")?.getAttribute("href")).toBe(`#${token(b.key)}`);
    expect(root.textContent).toContain("不表示当前 HEAD 获批"); for (const state of ["fresh", "stale", "unknown", "unavailable"]) expect(root.textContent).toContain(state);
    expect(root.querySelector('code[aria-label="Review current HEAD: ' + "a".repeat(40) + '"]')).not.toBeNull(); root.remove();
  });
  it.each([["scope", "github:owner/b"], ["phase", "review"], ["attention", "needs_human"], ["github", "stale"], ["runtime", "unknown"], ["decision", "unavailable"]])("filters %s", (id, value) => {
    const { root } = setup(); change(root, id!, value!); expect(rows(root)).toHaveLength(1); expect(rows(root)[0]?.id).toBe(`work-${token(b.key)}`); root.remove();
  });
  it("combines search and filters, retains them across updates, and resets", () => {
    const { explorer, root } = setup(); const search = root.querySelector<HTMLInputElement>("#explorer-search")!; search.focus(); search.value = "BETA"; search.dispatchEvent(new Event("input")); change(root, "phase", "review");
    explorer.update(snapshot({ work: [a, b] })); expect(search.value).toBe("BETA"); expect(document.activeElement).toBe(search); expect(rows(root)).toHaveLength(1);
    change(root, "github", "fresh"); expect(root.textContent).toContain("没有工作匹配当前筛选"); root.querySelector<HTMLButtonElement>("#explorer-reset")!.click(); expect(rows(root)).toHaveLength(2); expect(search.value).toBe(""); root.remove();
  });
  it("distinguishes empty snapshot from zero matches and exposes keyboard scroll region", () => {
    const { explorer, root } = setup(); const search = root.querySelector<HTMLInputElement>("#explorer-search")!; search.value = "missing"; search.dispatchEvent(new Event("input")); expect(root.textContent).toContain("没有工作匹配当前筛选");
    explorer.update(snapshot({ work: [] })); expect(root.textContent).toContain("当前快照没有已知工作"); expect(root.querySelector(".explorer-results")?.getAttribute("tabindex")).toBe("0"); root.remove();
  });
  it("shows current-HEAD approval as supplied without comparing SHA values", () => {
    const explorer = createExplorer(); const root = explorer.update(snapshot({ work: [work({ review: { currentHeadSha: "a".repeat(40), taskTarget: { repository: "owner/a", prNumber: 1, headSha: "b".repeat(40) }, task: null, result: null, approval: "approved_current_head" } })] }));
    expect(root.textContent).toContain("当前 HEAD 获批（观察投影，非合并授权）"); expect(root.textContent).toContain("b".repeat(40));
  });
  it("keeps a projection visible with unavailable sources", () => { const { root } = setup(); expect(rows(root)).toHaveLength(2); expect(fresh.status).toBe("fresh"); root.remove(); });
});
