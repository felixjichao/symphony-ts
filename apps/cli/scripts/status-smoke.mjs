/* global process, console, fetch, document */
/** Explicit foreground Chromium acceptance. Run with node --import tsx. No browser downloads. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { startStatusSurface } from "../src/status.ts";
import { statusFacts, statusKeys, statusScenarios } from "../src/status-fixtures.ts";
import { httpsTracker, startProcess, workflow } from "../src/process.test-helpers.ts";
const modulePath = process.env.SYMPHONY_BROWSER_MODULE;
assert.ok(modulePath, "Set SYMPHONY_BROWSER_MODULE to an installed Playwright module");
const { chromium } = await import(modulePath);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const assets = fileURLToPath(new URL("../dist/status-assets", import.meta.url));
const browser = await chromium.launch({ headless: true, ...(process.env.SYMPHONY_CHROMIUM ? { executablePath: process.env.SYMPHONY_CHROMIUM } : {}) });
const page = await browser.newPage();
const network = [], errors = [], results = [];
page.on("request", request => { if (request.url().includes("/api/")) network.push({ method: request.method(), path: new URL(request.url()).pathname }); });
page.on("pageerror", error => errors.push(error.message));
const route = `#${encodeURIComponent(JSON.stringify([statusKeys[0].provider, statusKeys[0].key]))}`;
let site, tracker, proc, dir;
try {
  for (const scenario of statusScenarios) {
    site = await startStatusSurface({ workKeys: statusKeys, assets }, statusFacts(scenario));
    await page.goto(`${site.url}/${route}`);
    await page.locator("#detail-heading").waitFor();
    assert.ok((await page.locator("header").innerText()).includes("当前生产只读观测"));
    const snapshot = await fetch(`${site.url}/api/operations/snapshot`).then(response => response.json());
    assert.ok((await page.locator("#overview").innerText()).includes(`系统健康: ${snapshot.health}`));
    const shownCounts = await page.locator("#overview dd").allTextContents();
    assert.deepEqual(shownCounts, [snapshot.summary.active, snapshot.summary.waiting, snapshot.summary.needsHuman, snapshot.summary.retrying, snapshot.summary.degradedWork, snapshot.summary.anomalyCount].map(String));
    const first = snapshot.work[0]; const text = await page.locator("#detail").innerText();
    for (const expected of [first.phase, first.attention, first.key.key, first.freshness.github.status, first.freshness.runtime.status, first.waiting?.reason].filter(Boolean)) assert.ok(text.includes(expected), `${scenario}: ${expected}`);
    assert.ok(!(text.includes(statusKeys[1].key)));
    for (const anomaly of snapshot.anomalies.filter(item => item.workKey?.key === first.key.key)) assert.ok(text.includes(anomaly.code));
    if (scenario === "result-mismatch") for (const letter of ["a", "b", "c"]) assert.ok(text.includes(letter.repeat(40)));
    await page.locator("tbody a").nth(1).click();
    await page.waitForFunction(key => document.querySelector("#detail-heading")?.textContent?.includes(key), statusKeys[1].key);
    assert.ok((await page.locator("#detail").innerText()).includes(statusKeys[1].key));
    await page.goBack(); await page.waitForFunction(key => document.querySelector("#detail-heading")?.textContent?.includes(key), statusKeys[0].key);
    assert.ok((await page.locator("#detail").innerText()).includes(statusKeys[0].key));
    await page.reload(); await page.locator("#detail-heading").waitFor();
    const summary = page.locator("#detail summary").first(); await summary.focus(); await page.keyboard.press("Enter");
    const focused = await summary.getAttribute("id");
    if (scenario === "result-mismatch") {
      await page.waitForResponse(response => response.url().endsWith("/api/operations/snapshot"), { timeout: 25000 });
      await page.waitForFunction(id => document.activeElement?.id === id && document.getElementById(id)?.parentElement?.open, focused);
      const ids = await page.locator("[id]").evaluateAll(nodes => nodes.map(node => node.id)); assert.equal(new Set(ids).size, ids.length);
    }
    results.push({ scenario, phase: first.phase, attention: first.attention, health: snapshot.health, result: "passed" });
    await site.stop(); site = undefined;
  }
  site = await startStatusSurface({ workKeys: statusKeys, assets }, statusFacts("review"));
  const url = site.url; const port = Number(new URL(url).port);
  await page.goto(`${url}/${route}`); await page.locator("#detail-heading").waitFor();
  await site.stop(); site = undefined;
  await page.getByText("刷新失败，显示上次成功快照", { exact: false }).waitFor({ timeout: 25000 });
  assert.ok((await page.locator("#detail").innerText()).includes(statusKeys[0].key));
  site = await startStatusSurface({ workKeys: statusKeys, assets, port }, statusFacts("completed"));
  await page.waitForFunction(() => document.querySelector("#detail")?.textContent?.includes("phase: completed"), undefined, { timeout: 25000 });
  results.push({ scenario: "transport-interruption-recovery", result: "passed" });
  await site.stop(); site = undefined;
  // Actual installed executable, different cwd, native host/HTTP/static build. Only external tracker is controlled.
  dir = await mkdtemp(path.join(os.tmpdir(), "status-binary-smoke-")); tracker = await httpsTracker();
  const workflowPath = path.join(dir, "WORKFLOW.md"); await writeFile(workflowPath, workflow(path.join(dir, "work"), tracker.url));
  proc = startProcess([workflowPath, "--status", "--no-planning"], dir, undefined, { DECISION_BRIDGE_URL: "", DECISION_STORE_DIR: "", SYMPHONY_PLANNING_ENABLED: "0" });
  await proc.waitForOutput('event="status_surface"');
  const match = /http:\/\/127\.0\.0\.1:\d+/.exec(proc.stderr); assert.ok(match, proc.stderr);
  await page.goto(match[0]); await page.getByText("当前生产只读观测", { exact: false }).waitFor();
  const binarySnapshot = await fetch(`${match[0]}/api/operations/snapshot`).then(response => response.json());
  assert.deepEqual(binarySnapshot.work, []); assert.ok(tracker.requests.length > 0);
  await proc.close(); assert.equal((await proc.result).code, 0); proc = undefined;
  results.push({ scenario: "built-executable-different-cwd-empty-scope", result: "passed" });
  assert.ok(network.length > 20 && network.every(item => item.method === "GET" && item.path === "/api/operations/snapshot"));
  assert.deepEqual(errors, []);
  const hashes = await Promise.all((await readdir(`${assets}/assets`)).map(async file => ({ file, sha256: createHash("sha256").update(await readFile(`${assets}/assets/${file}`)).digest("hex") })));
  console.log(JSON.stringify({ sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), workingTree: "Production code at sourceCommit; evidence regenerated separately", browser: await browser.version(), mode: "controlled production composition + actual executable empty scope", externalLive: "not run", results, assets: hashes, networkRequests: network.length, getOnly: true, pageErrors: errors }, null, 2));
} finally {
  await browser.close(); await site?.stop(); await proc?.close(); await tracker?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
}
