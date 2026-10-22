import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { demoService } from "../examples/sources";
import { startDemo } from "../examples/server";
import { validateSnapshot } from "../src/validate";
import { workDetail } from "../src/detail";
let dom: JSDOM;
beforeEach(() => { dom = new JSDOM(); vi.stubGlobal("document", dom.window.document); });
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });
describe("controlled readers → real query/HTTP/proxy → validated Work Detail", () => {
  it.each(["review", "target-mismatch", "result-mismatch", "partial", "conflict", "terminal"] as const)("explains %s without rebuilding projector meaning", async scenario => {
    const host = await startDemo(demoService(scenario));
    try {
      const response = await fetch(`${host.url}/api/operations/snapshot`); expect(response.status).toBe(200);
      const data: unknown = await response.json(); validateSnapshot(data);
      const a = data.work[0]!, b = data.work[1]!; const node = workDetail(a, data);
      expect(node.textContent).toContain(`phase: ${a.phase}`); expect(node.textContent).toContain(a.key.key); expect(node.textContent).not.toContain(b.key.key);
      expect(node.textContent).toContain("Why"); expect(a.evidence.length).toBeGreaterThan(0);
      if (scenario === "review") { expect(a.phase).toBe("review"); expect(node.textContent).toContain("waiting_for_review"); }
      if (scenario === "partial") { expect(node.textContent).toContain("unavailable"); expect(node.textContent).toContain("demo_unavailable"); }
      const code = { "target-mismatch": "review_target_head_mismatch", "result-mismatch": "review_result_target_mismatch", conflict: "conflicting_active_review_tasks", terminal: "execution_on_terminal_work" }[scenario as "target-mismatch" | "result-mismatch" | "conflict" | "terminal"];
      if (code) { expect(data.anomalies.some(item => item.code === code)).toBe(true); expect(node.textContent).toContain(code); }
      if (scenario === "result-mismatch") for (const letter of ["a", "b", "c"]) expect(node.textContent).toContain(letter.repeat(40));
      if (scenario === "conflict") expect(node.textContent).toContain("demo-conflicting-review");
      if (scenario === "terminal") expect(a.phase).toBe("completed");
    } finally { await host.stop(); }
  });
});
