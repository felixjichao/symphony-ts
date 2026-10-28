/** Deterministic presentation fixtures for #173 / #174; served through the built demo. */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import type { OperationalSnapshot, WorkProjection } from "@symphony/operations";
import { work, snapshot, fresh } from "../tests/fixtures";
import { demoService } from "./sources";
import { startDemo } from "./server";

const output = process.env["SYMPHONY_BROWSER_EVIDENCE"] ?? ".symphony/evidence/work-detail-why";
const sha = "a".repeat(40), old = "b".repeat(40);
const target = { repository: "owner/a", prNumber: 2, headSha: old };
const fixed = 1_790_000_000_000;
const base = { evidence: [{ source: "decision" as const, code: "review_task_running", detail: "Review task observed", observedAt: fixed, instance: "decision-store", role: "supporting" as const, freshnessStatus: "fresh" as const }], workItem: { identifier: "owner/a#1", title: "Representative work", url: "https://github.com/owner/a/issues/1" } };
const cases: readonly { name: string; projection: WorkProjection; expected: readonly string[] }[] = [
  { name: "planning-ready", projection: work({ ...base, phase: "ready", attention: "normal", planning: { sessionStatus: "active", taskStatus: "completed", planVerdict: "ready" }, execution: null, pullRequest: null, ci: null, review: null }), expected: ["phase: ready", "Plan verdict", "ready", "未提供审查信号"] },
  { name: "active-coding", projection: work({ ...base, phase: "coding", attention: "normal", planning: { sessionStatus: "active", taskStatus: "completed", planVerdict: "ready" }, execution: { issueId: "GH-1", attempt: 2, status: "streaming_turn", workspacePath: "/work/owner-a", startedAtMs: fixed, retryInMs: null }, pullRequest: null, ci: null, review: null }), expected: ["phase: coding", "streaming_turn", "/work/owner-a"] },
  { name: "waiting-stale-review", projection: work({ ...base, phase: "review", attention: "waiting", waiting: { reason: "waiting_for_review", since: fixed }, pullRequest: { number: 2, url: "https://github.com/owner/a/pull/2", state: "open", isDraft: false, headSha: sha, mergeable: null }, ci: { status: "success" }, review: { currentHeadSha: sha, taskTarget: target, approval: "approved_stale_head", task: { kind: "review", taskId: "review-1", revision: 1, target, status: "completed", createdAtMs: fixed, updatedAtMs: fixed }, result: { taskId: "review-1", revision: 1, createdAtMs: fixed, outcome: { kind: "review", verdict: "approve", target } } } }), expected: ["waiting_for_review", "approved_stale_head", sha, old, "Review task observed", "decision-store", "supporting"] },
  { name: "partial-missing", projection: work({ ...base, phase: "unknown", attention: "degraded", execution: null, pullRequest: null, ci: null, review: null, freshness: { github: fresh, runtime: { status: "unknown", lastAttemptAt: null, reason: "not_observed" }, decision: { status: "unavailable", observedAt: null, lastAttemptAt: fixed, reason: "source_unavailable" } } }), expected: ["phase: unknown", "decision: unavailable", "未提供", "未报告关联 Executor"] },
  { name: "terminal", projection: work({ ...base, phase: "completed", attention: "normal", planning: null, execution: null, pullRequest: null, ci: null, review: null }), expected: ["phase: completed", "attention: normal", "未提供"] },
  { name: "needs-human", projection: work({ ...base, phase: "planning", attention: "needs_human", waiting: { reason: "needs_human", since: fixed }, planning: { sessionStatus: "active", taskStatus: "completed", planVerdict: "needs_human" }, execution: null, pullRequest: null, ci: null, review: null }), expected: ["phase: planning", "attention: needs_human", "needs_human"] },
];
// SPEC §13 adjacent / #174: run supplied diagnostics through the built product.
const diagnosticCases: { name: string; data: OperationalSnapshot; expected: readonly string[]; forbidden?: readonly string[] }[] = cases.map(item => ({
  name: item.name, data: snapshot({ work: [item.projection], generatedAt: fixed, sources: [], executors: [], anomalies: [] }), expected: item.expected,
}));
for (const [scenario, expected] of [
  ["review", ["waiting_for_review", sha, "demo-review / 1"]],
  ["target-mismatch", ["review_target_head_mismatch", sha, old]],
  ["result-mismatch", ["review_result_target_mismatch", sha, old, "c".repeat(40)]],
  ["partial", ["decision: unavailable", "demo_unavailable"]],
  ["conflict", ["conflicting_active_review_tasks", "demo-conflicting-review"]],
  ["terminal", ["phase: completed", "execution_on_terminal_work", "streaming_turn"]],
] as const) diagnosticCases.push({ name: `read-model-${scenario}`, data: await demoService(scenario).getOperationalSnapshot(), expected });
diagnosticCases.push({
  name: "stale-approval", data: snapshot({ work: [cases[2]!.projection], anomalies: [{
    code: "review_approval_head_mismatch", severity: "error", workKey: cases[2]!.projection.key,
    message: "Supplied approval targets an older HEAD", detectedAt: fixed, evidence: base.evidence,
  }] }), expected: ["approved_stale_head", "旧 HEAD / 陈旧批准", "review_approval_head_mismatch", sha, old],
});
for (const source of ["github", "runtime", "decision"] as const) diagnosticCases.push({
  name: `${source}-failure`, data: snapshot({ work: [work({ ...base, freshness: {
    github: { status: "stale", observedAt: fixed, lastAttemptAt: fixed },
    runtime: { status: "unknown", lastAttemptAt: null, reason: "not_observed" }, decision: fresh,
    [source]: { status: "unavailable", observedAt: null, lastAttemptAt: fixed, reason: `${source}_failure` },
  } })] }), expected: [`${source}: unavailable`, `${source}_failure`],
});
const local = work().key, foreign = { provider: "other", key: local.key };
const roles = ["supporting", "superseding", "discarded_freshness", "historical"] as const;
diagnosticCases.push({
  name: "contradiction-isolation", data: snapshot({ work: [work({ ...base,
    planning: { sessionStatus: "completed", taskStatus: "running", planVerdict: null },
    evidence: [...roles.map(role => ({ ...base.evidence[0]!, role, detail: `Supplied ${role} fact` })), { ...base.evidence[0]!, workKey: foreign, detail: "FOREIGN EVIDENCE" }],
  }), work({ key: foreign, evidence: [{ ...base.evidence[0]!, detail: "FOREIGN WORK" }] })],
  sources: [{ source: "decision", instance: "LOCAL SOURCE", workKey: local, freshness: fresh }, { source: "decision", instance: "FOREIGN SOURCE", workKey: foreign, freshness: fresh }],
  executors: [{ id: "FOREIGN EXECUTOR", role: null, adapter: "demo", host: null, status: "busy", currentWork: foreign, lastHeartbeatAt: fixed }],
  anomalies: [{ code: "decision_active_task_on_completed_session", severity: "error", workKey: local, message: "Active task on completed session", detectedAt: fixed,
    evidence: [{ ...base.evidence[0]!, workKey: foreign, detail: "FOREIGN NESTED" }] },
    { code: "foreign_anomaly", severity: "error", workKey: foreign, message: "FOREIGN ANOMALY", detectedAt: fixed },
    { code: "global_diagnostic", severity: "warning", workKey: null, message: "GLOBAL DIAGNOSTIC", detectedAt: fixed }],
  }), expected: ["decision_active_task_on_completed_session", "severity: error", "LOCAL SOURCE", "证据归属不一致", ...roles.map(role => `Supplied ${role} fact`)],
  forbidden: ["FOREIGN", "GLOBAL DIAGNOSTIC"],
});
let selected = diagnosticCases[0]!;
const demo = demoService();
const service = { ...demo, getOperationalSnapshot: async () => selected.data };
const server = await startDemo(service);
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const assets: Record<string, string> = {};
for (const name of await readdir(new URL("../dist/assets/", import.meta.url))) assets[name] = hash(await readFile(new URL(`../dist/assets/${name}`, import.meta.url)));
assets["index.html"] = hash(await readFile(new URL("../dist/index.html", import.meta.url)));
const report = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  trackedChanges: execFileSync("git", ["diff", "--name-only"], { encoding: "utf8" }).trim().split("\n").filter(Boolean),
  startedAt: new Date().toISOString(), browser: "", assets,
  harnessSha256: hash(await readFile(new URL(import.meta.url))),
  cases: [] as { name: string; viewport: string; expected: readonly string[]; forbidden: readonly string[]; screenshot: string; sha256: string }[],
  checks: [] as string[], artifacts: {} as Record<string, string>, status: "running", error: null as string | null,
};
let browser;
try {
  await mkdir(output, { recursive: true });
  const fixtures = Buffer.from(JSON.stringify(diagnosticCases, null, 2) + "\n");
  await writeFile(`${output}/fixtures.json`, fixtures);
  report.artifacts["fixtures.json"] = hash(fixtures);
  browser = await chromium.launch({ headless: true, ...(process.env["SYMPHONY_CHROMIUM"] ? { executablePath: process.env["SYMPHONY_CHROMIUM"] } : {}) });
  report.browser = browser.version();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const item of diagnosticCases) {
    selected = item;
    const route = `#${encodeURIComponent(JSON.stringify([item.data.work[0]!.key.provider, item.data.work[0]!.key.key]))}`;
    for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "narrow", width: 390, height: 844 }]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`${server.url}/${route}`);
      await page.reload();
      const pane = page.locator("#detail");
      await pane.getByRole("heading", { name: `Work Detail · ${item.data.work[0]!.key.provider}:${item.data.work[0]!.key.key}`, exact: true }).waitFor();
      const contents = await pane.innerText();
      for (const expected of item.expected) assert.ok(contents.includes(expected), `${item.name}: missing ${expected}`);
      for (const forbidden of item.forbidden ?? []) assert.ok(!(await pane.textContent())?.includes(forbidden), `${item.name}: leaked ${forbidden}`);
      assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), `${item.name}: page overflows ${viewport.name}`);
      const screenshot = `${item.name}-${viewport.name}.png`;
      const data = await pane.screenshot({ path: `${output}/${screenshot}` });
      report.cases.push({ name: item.name, viewport: viewport.name, expected: item.expected, forbidden: item.forbidden ?? [], screenshot, sha256: hash(data) });
    }
  }
  // Real keyboard activation and real polling replacement, without evaluating UI helpers.
  const raw = page.locator("#detail details").first();
  const summary = raw.locator("summary");
  assert.equal(await raw.getAttribute("open"), null);
  await summary.focus(); await page.keyboard.press("Enter");
  assert.equal(await raw.getAttribute("open"), "");
  const focusId = await summary.getAttribute("id");
  selected = { ...selected, data: { ...selected.data, generatedAt: fixed + 1 } };
  await page.waitForResponse(response => response.url().endsWith("/api/operations/snapshot") && response.ok(), { timeout: 20_000 });
  await page.waitForFunction(() => document.body.textContent?.includes(new Date(1_790_000_000_001).toISOString()));
  assert.equal(await page.evaluate(() => document.activeElement?.id), focusId);
  assert.equal(await raw.getAttribute("open"), "");
  report.artifacts["keyboard-refresh.png"] = hash(await raw.screenshot({ path: `${output}/keyboard-refresh.png` }));
  report.checks.push("keyboard Enter opens raw evidence", "actual polling retains disclosure and focus");
  await page.getByRole("link", { name: "System", exact: true }).click();
  await page.getByRole("heading", { name: "全局异常（未关联 WorkKey）", exact: true }).waitFor();
  const system = await page.locator("main").innerText();
  assert.ok(system.includes("GLOBAL DIAGNOSTIC"));
  assert.ok(!system.includes("Active task on completed session"));
  report.artifacts["global-system.png"] = hash(await page.screenshot({ path: `${output}/global-system.png`, fullPage: true }));
  report.checks.push("global diagnostics rendered separately in System");
  assert.deepEqual(errors, [], "browser page errors");
  report.status = "passed";
  console.log(JSON.stringify({ browser: report.browser, cases: diagnosticCases.length, screenshots: report.cases.length + 2, status: report.status }));
} catch (error) {
  report.status = "failed"; report.error = String(error); throw error;
} finally {
  await browser?.close(); await server.stop();
  await writeFile(`${output}/browser.json`, JSON.stringify(report, null, 2) + "\n");
}
