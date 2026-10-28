/** Deterministic presentation fixtures for #173; served through the built demo. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import type { WorkProjection } from "@symphony/operations";
import { work, snapshot, fresh } from "../tests/fixtures";
import { demoService } from "./sources";
import { startDemo } from "./server";

const modulePath = process.env["SYMPHONY_BROWSER_MODULE"];
const output = process.env["SYMPHONY_BROWSER_EVIDENCE"];
if (!modulePath || !output) throw new Error("Set SYMPHONY_BROWSER_MODULE and SYMPHONY_BROWSER_EVIDENCE");
const { chromium } = await import(modulePath);
const sha = "a".repeat(40), old = "b".repeat(40);
const target = { repository: "owner/a", prNumber: 2, headSha: old };
const fixed = 1_790_000_000_000;
const base = { workItem: { identifier: "owner/a#1", title: "Representative work", url: "https://github.com/owner/a/issues/1" } };
const cases: readonly { name: string; projection: WorkProjection; expected: readonly string[] }[] = [
  { name: "planning-ready", projection: work({ ...base, phase: "ready", attention: "normal", planning: { sessionStatus: "active", taskStatus: "completed", planVerdict: "ready" }, execution: null, pullRequest: null, ci: null, review: null }), expected: ["phase: ready", "Plan verdict", "ready", "未提供审查信号"] },
  { name: "active-coding", projection: work({ ...base, phase: "coding", attention: "normal", planning: { sessionStatus: "active", taskStatus: "completed", planVerdict: "ready" }, execution: { issueId: "GH-1", attempt: 2, status: "streaming_turn", workspacePath: "/work/owner-a", startedAtMs: fixed, retryInMs: null }, pullRequest: null, ci: null, review: null }), expected: ["phase: coding", "streaming_turn", "/work/owner-a"] },
  { name: "waiting-stale-review", projection: work({ ...base, phase: "review", attention: "waiting", waiting: { reason: "waiting_for_review", since: fixed }, pullRequest: { number: 2, url: "https://github.com/owner/a/pull/2", state: "open", isDraft: false, headSha: sha, mergeable: null }, ci: { status: "success" }, review: { currentHeadSha: sha, taskTarget: target, approval: "approved_stale_head", task: { kind: "review", taskId: "review-1", revision: 1, target, status: "completed", createdAtMs: fixed, updatedAtMs: fixed }, result: { taskId: "review-1", revision: 1, createdAtMs: fixed, outcome: { kind: "review", verdict: "approve", target } } } }), expected: ["waiting_for_review", "approved_stale_head", sha, old] },
  { name: "partial-missing", projection: work({ ...base, phase: "unknown", attention: "degraded", execution: null, pullRequest: null, ci: null, review: null, freshness: { github: fresh, runtime: { status: "unknown", lastAttemptAt: null, reason: "not_observed" }, decision: { status: "unavailable", observedAt: null, lastAttemptAt: fixed, reason: "source_unavailable" } } }), expected: ["phase: unknown", "decision: unavailable", "未提供", "未报告关联 Executor"] },
  { name: "terminal", projection: work({ ...base, phase: "completed", attention: "normal", planning: null, execution: null, pullRequest: null, ci: null, review: null }), expected: ["phase: completed", "attention: normal", "未提供"] },
  { name: "needs-human", projection: work({ ...base, phase: "planning", attention: "needs_human", waiting: { reason: "needs_human", since: fixed }, planning: { sessionStatus: "active", taskStatus: "completed", planVerdict: "needs_human" }, execution: null, pullRequest: null, ci: null, review: null }), expected: ["phase: planning", "attention: needs_human", "needs_human"] },
];
let selected = cases[0]!;
const demo = demoService();
const service = { ...demo, getOperationalSnapshot: async () => snapshot({ work: [selected.projection], generatedAt: fixed, sources: [], executors: [], anomalies: [] }) };
const server = await startDemo(service);
let browser;
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true, ...(process.env["SYMPHONY_CHROMIUM"] ? { executablePath: process.env["SYMPHONY_CHROMIUM"] } : {}) });
  const page = await browser.newPage();
  const route = `#${encodeURIComponent(JSON.stringify(["github", "owner/a#1"]))}`;
  for (const item of cases) {
    selected = item;
    for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "narrow", width: 390, height: 844 }]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`${server.url}/${route}`);
      await page.reload();
      const pane = page.locator("#detail");
      await pane.getByRole("heading", { name: "Work Detail · github:owner/a#1", exact: true }).waitFor();
      const contents = await pane.innerText();
      for (const expected of item.expected) assert.ok(contents.includes(expected), `${item.name}: missing ${expected}`);
      assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), `${item.name}: page overflows ${viewport.name}`);
      await pane.screenshot({ path: `${output}/${item.name}-${viewport.name}.png` });
    }
  }
  console.log(JSON.stringify({ browser: await browser.version(), cases: cases.map(item => item.name), screenshots: cases.length * 2 }));
} finally { await browser?.close(); await server.stop(); }
