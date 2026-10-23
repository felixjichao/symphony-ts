import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { demoService } from "../examples/sources";
import { startDemo } from "../examples/server";
import { validateSnapshot } from "../src/validate";
import { mount } from "../src/view";
import { evidenceIdentity, token } from "../src/identity";
import { workDetail } from "../src/detail";
let dom: JSDOM;
beforeEach(() => { dom = new JSDOM("", { url: "http://localhost/" }); vi.stubGlobal("document", dom.window.document); vi.stubGlobal("window", dom.window); });
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

describe("diagnostic identity across snapshot replacement", () => {
  it("keeps only the original anomaly breadcrumb open/focused across polling, insertion, deletion and reordering", async () => {
    const service = demoService("result-mismatch");
    const first = await service.getOperationalSnapshot(); const key = first.work[0]!.key;
    const root = document.createElement("div"); document.body.append(root);
    const view = mount(root); window.history.replaceState(null, "", `#${token(key)}`);
    const assertUnique = () => {
      const ids = [...root.querySelectorAll("[id]")].map(node => node.id);
      expect(new Set(ids).size).toBe(ids.length);
    };
    try {
      view.update({ snapshot: first }); assertUnique();
      const anomaly = [...root.querySelectorAll("article")].find(node => node.firstElementChild?.textContent === "review_result_target_mismatch")!;
      const evidence = [...anomaly.querySelectorAll("article")].find(node => node.firstElementChild?.textContent === "review_result_target")!;
      const raw = evidence.querySelector("details")!; const summary = raw.querySelector("summary")!;
      raw.open = true; summary.focus(); const id = summary.id;
      const assertRestored = () => {
        assertUnique(); expect(document.activeElement?.id).toBe(id);
        const opened = [...root.querySelectorAll("details[open]")]; expect(opened).toHaveLength(1);
        expect(opened[0]?.querySelector("summary")?.id).toBe(id);
        expect(opened[0]?.closest("article")?.firstElementChild?.textContent).toBe("review_result_target");
        expect(opened[0]?.closest("article")?.parentElement?.closest("article")?.firstElementChild?.textContent).toBe("review_result_target_mismatch");
      };
      view.update({ snapshot: await service.getOperationalSnapshot() }); assertRestored();
      const second = await service.getOperationalSnapshot();
      const extra = { source: "decision" as const, code: "inserted_diagnostic", detail: "new evidence", observedAt: 99 };
      const changed = { ...second, work: second.work.map(w => ({ ...w, evidence: [extra, ...w.evidence].reverse() })),
        anomalies: [...second.anomalies].reverse().map(a => ({ ...a, evidence: [extra, ...(a.evidence ?? [])].reverse() })) };
      view.update({ snapshot: changed }); assertRestored();
      const global = { code: "global_diagnostic", severity: "warning" as const, workKey: null, message: "global context", detectedAt: 3, evidence: [{ ...extra, code: "global_fact" }, { ...extra, code: "global_fact" }] };
      view.update({ snapshot: { ...changed, anomalies: [global, { ...global, message: "another global context" }, ...changed.anomalies].map(a => ({ ...a, evidence: a.evidence?.filter(e => e.code !== "inserted_diagnostic") ?? [] })) } });
      assertRestored();
      // Removing the focused fact must not apply its state to the next array element.
      view.update({ snapshot: { ...changed, anomalies: changed.anomalies.map(a => ({ ...a, evidence: a.evidence.filter(e => e.code !== "review_result_target") })) } });
      assertUnique(); expect(root.querySelectorAll("details[open]")).toHaveLength(0); expect(document.activeElement?.id).toBe("detail-heading");
    } finally { view.destroy(); }
  });
  it("keeps global anomaly evidence separate and stable when anomalies reorder and observation times change", async () => {
    const data = await demoService("result-mismatch").getOperationalSnapshot();
    const item = { source: "runtime" as const, code: "global_fact", detail: "context", observedAt: 1 };
    const a = { code: "global", severity: "warning" as const, workKey: null, message: "first context", detectedAt: 1, evidence: [item] };
    const b = { ...a, message: "second context" };
    const root = document.createElement("div"); document.body.append(root); const view = mount(root);
    try {
      view.update({ snapshot: { ...data, anomalies: [a, b] } });
      const raw = root.querySelector<HTMLDetailsElement>("main article details")!; raw.open = true;
      const summary = raw.querySelector("summary")!; summary.focus(); const id = summary.id;
      view.update({ snapshot: { ...data, anomalies: [b, a].map(entry => ({ ...entry, detectedAt: 99, evidence: [{ ...item, observedAt: 99 }] })) } });
      const ids = [...root.querySelectorAll("[id]")].map(node => node.id); expect(new Set(ids).size).toBe(ids.length);
      expect(document.activeElement?.id).toBe(id); expect(root.querySelectorAll("details[open]")).toHaveLength(1);
      expect(root.querySelector("details[open]")?.querySelector("summary")?.id).toBe(id);
      expect(document.activeElement?.closest("article")?.parentElement?.closest("article")?.textContent).toContain("first context");
    } finally { view.destroy(); }
  });
  it("distinguishes absent values from reported null without depending on property insertion order", () => {
    const item = { source: "decision" as const, code: "fact", detail: null, observedAt: 1 };
    expect(evidenceIdentity(item)).not.toBe(evidenceIdentity({ ...item, value: null }));
    expect(evidenceIdentity({ ...item, value: null })).toBe(evidenceIdentity({ value: null, observedAt: 99, detail: null, code: "fact", source: "decision" }));
  });
  it("does not restore ambiguous identical evidence occurrences to a different occurrence", async () => {
    const data = await demoService("result-mismatch").getOperationalSnapshot(); const a = data.work[0]!;
    const item = { source: "decision" as const, code: "duplicate", detail: "identical", observedAt: 1 };
    const root = document.createElement("div"); document.body.append(root); const view = mount(root);
    window.history.replaceState(null, "", `#${token(a.key)}`);
    try {
      view.update({ snapshot: { ...data, work: [{ ...a, evidence: [item, item] }] } });
      const raw = root.querySelector<HTMLDetailsElement>("#detail details")!; raw.open = true; raw.querySelector("summary")!.focus();
      view.update({ snapshot: { ...data, work: [{ ...a, evidence: [item] }] } });
      const ids = [...root.querySelectorAll("[id]")].map(n => n.id); expect(new Set(ids).size).toBe(ids.length);
      expect(root.querySelectorAll("details[open]")).toHaveLength(0); expect(document.activeElement?.id).toBe("detail-heading");
    } finally { view.destroy(); }
  });
});
