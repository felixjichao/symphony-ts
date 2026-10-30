/* global process, console, fetch, document, innerWidth, innerHeight, scrollTo */
/** Explicit foreground Chromium acceptance. Run with node --import tsx. No browser downloads. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const evidenceDir = process.env.SYMPHONY_BROWSER_EVIDENCE ?? ".symphony/evidence/dashboard-v2-closeout";
await mkdir(evidenceDir, { recursive: true });
const network = [], errors = [], results = [], screenshots = [];
page.on("request", request => { if (request.url().includes("/api/")) network.push({ method: request.method(), path: new URL(request.url()).pathname }); });
page.on("pageerror", error => errors.push(error.message));
const route = `#${encodeURIComponent(JSON.stringify([statusKeys[0].provider, statusKeys[0].key]))}`;
async function capture(file) {
  const output = path.join(evidenceDir, file);
  // Some local Chromium builds repeat viewport tiles with captureBeyondViewport.
  // Render the whole document in one viewport before capture instead.
  const viewport = page.viewportSize();
  const height = await page.evaluate(() => Math.max(innerHeight, document.documentElement.scrollHeight));
  try {
    await page.setViewportSize({ width: viewport.width, height });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: output, fullPage: false });
  } finally {
    await page.setViewportSize(viewport);
  }
  screenshots.push({ file, viewport, captureHeight: height, sha256: createHash("sha256").update(await readFile(output)).digest("hex") });
}
const iso = value => value == null ? "未报告" : new Date(value).toISOString();
const workHref = key => `#${encodeURIComponent(JSON.stringify([key.provider, key.key]))}`;
async function assertWorkAssociation(node, key, label) {
  const links = node.locator("a");
  assert.equal(await links.count(), key ? 1 : 0, `${label}: association count`);
  if (key) {
    assert.equal(await links.getAttribute("href"), workHref(key), `${label}: full WorkKey href`);
    assert.ok((await links.innerText()).includes(`${key.provider}:${key.key}`), `${label}: full WorkKey text`);
  }
}
async function assertSource(node, source, label) {
  const text = await node.innerText(), value = source.freshness;
  assert.ok(text.includes(`${source.source} / ${source.instance}`), `${label}: source/instance`);
  const badge = node.locator(".badge");
  assert.equal(await badge.count(), 1, `${label}: one source badge`);
  assert.ok((await badge.getAttribute("class")).split(/\s+/).includes(`freshness-${value.status}`), `${label}: freshness class`);
  const shown = await badge.innerText();
  for (const expected of [value.status, `观测 ${iso(value.observedAt)}`, `尝试 ${iso(value.lastAttemptAt)}`, ...("reason" in value ? [value.reason ?? "未报告原因"] : [])]) {
    assert.ok(shown.includes(expected), `${label}: ${expected}`);
  }
  await assertWorkAssociation(node, source.workKey, label);
}
async function assertDetailExecutors(snapshot, work) {
  const cards = page.locator("#detail .detail-card").filter({ has: page.locator("h4") });
  let associatedCount = 0;
  for (const item of snapshot.executors) {
    const associated = item.currentWork?.provider === work.key.provider && item.currentWork?.key === work.key.key;
    const card = cards.filter({ has: page.getByRole("heading", { name: item.id, exact: true }) });
    assert.equal(await card.count(), associated ? 1 : 0, `${work.key.key}: executor ${item.id} isolation`);
    if (associated) {
      associatedCount++;
      assert.deepEqual(await card.locator("dd").allTextContents(), [item.role ?? "未提供", item.adapter, item.status, item.host ?? "未提供", iso(item.lastHeartbeatAt)], `${item.id}: detail fields`);
    }
  }
  if (associatedCount === 0) assert.ok((await page.locator("#detail").innerText()).includes("未报告关联 Executor"));
}
let site, tracker, proc, dir;
try {
  for (const scenario of statusScenarios) {
    site = await startStatusSurface({ workKeys: statusKeys, assets }, statusFacts(scenario));
    await page.goto(`${site.url}/${route}`);
    await page.locator("#detail-heading").waitFor();
    assert.ok((await page.locator("header").innerText()).includes("当前生产只读观测"));
    const snapshot = await fetch(`${site.url}/api/operations/snapshot`).then(response => response.json());
    await page.locator("#nav-overview").click();
    await page.locator("#overview").waitFor({ state: "visible" });
    assert.ok((await page.locator("#overview").innerText()).includes(`系统健康: ${snapshot.health}`));
    const shownCounts = await page.locator("#overview dd").allTextContents();
    assert.deepEqual(shownCounts, [snapshot.summary.active, snapshot.summary.waiting, snapshot.summary.needsHuman, snapshot.summary.retrying, snapshot.summary.degradedWork, snapshot.summary.anomalyCount].map(String));
    const overview = page.locator("#overview");
    for (const source of snapshot.sources) {
      const row = overview.locator("p").filter({ hasText: `${source.source} / ${source.instance} ·` });
      assert.equal(await row.count(), 1, `${scenario}: Overview source identity`);
      await assertSource(row, source, `${scenario}: Overview`);
    }
    for (const item of snapshot.executors) {
      const row = overview.locator("p").filter({ hasText: `${item.id} · ${item.role ?? "未报告角色"} ·` });
      assert.equal(await row.count(), 1, `${scenario}: Overview executor identity`);
      const shown = await row.innerText();
      assert.ok(shown.includes(`${item.adapter} · ${item.status} · 心跳 ${iso(item.lastHeartbeatAt)}`));
      await assertWorkAssociation(row, item.currentWork, `${scenario}: Overview executor ${item.id}`);
    }
    if (scenario === "failed") {
      assert.equal(snapshot.work[0].attention, "failed"); assert.equal(snapshot.work[1].attention, "normal");
      assert.equal(snapshot.work[0].review.task.status, "failed"); assert.equal(snapshot.work[0].review.result, null);
      assert.ok(snapshot.work[0].evidence.some(item => item.source === "decision" && item.code === "review_task_failed" && item.value === "failed" && item.freshnessStatus === "fresh"));
      assert.equal(await overview.locator(".attention-failed").count(), 1);
      const failure = overview.locator("article").filter({ has: page.locator(".attention-failed") });
      await assertWorkAssociation(failure, statusKeys[0], "failed: Overview identity");
    }
    // Read the projected source/executor fields through the actual production HTTP surface.
    await page.locator("#nav-system").click();
    await page.locator("#system").waitFor({ state: "visible" });
    assert.ok((await page.locator("#system").innerText()).includes(`系统健康: ${snapshot.health}`));
    assert.ok((await page.locator("#system-transport").innerText()).includes("上次请求成功"));
    const sourceRows = page.getByRole("heading", { name: "来源状态", exact: true }).locator("..").locator("li > article");
    assert.equal(await sourceRows.count(), snapshot.sources.length, `${scenario}: System source count`);
    for (let i = 0; i < snapshot.sources.length; i++) await assertSource(sourceRows.nth(i), snapshot.sources[i], `${scenario}: System`);
    if (scenario === "active-inventory" || scenario === "stale-inventory") {
      const index = snapshot.sources.findIndex(source => source.workKey?.key === statusKeys[1].key);
      await sourceRows.nth(index).locator("a").click();
      await page.waitForFunction(key => document.querySelector("#detail-heading")?.textContent?.includes(key), statusKeys[1].key);
      await assertDetailExecutors(snapshot, snapshot.work[1]);
      await page.goBack(); await page.locator("#system").waitFor({ state: "visible" });
    }
    await page.locator("#nav-executors").click();
    await page.locator("#executors").waitFor({ state: "visible" });
    const executorRows = page.getByRole("heading", { name: "Executor inventory", exact: true }).locator("..").locator("li > article");
    assert.equal(await executorRows.count(), snapshot.executors.length, `${scenario}: inventory row count`);
    for (let i = 0; i < snapshot.executors.length; i++) {
      const item = snapshot.executors[i], row = executorRows.nth(i);
      assert.equal(await row.locator("h3").innerText(), item.id);
      const fields = row.locator("p");
      assert.equal(await fields.nth(0).innerText(), `角色: ${item.role ?? "未报告角色"} · Adapter: ${item.adapter} · 状态: ${item.status}`);
      assert.equal(await fields.nth(1).innerText(), `Host: ${item.host ?? "未报告"} · 心跳: ${iso(item.lastHeartbeatAt)}`);
      await assertWorkAssociation(fields.nth(2), item.currentWork, `${scenario}: executor ${item.id}`);
      if (item.currentWork === null) assert.equal(await fields.nth(2).innerText(), "当前 Work: 未报告");
    }
    if (scenario === "active-inventory" || scenario === "stale-inventory") {
      await executorRows.nth(2).locator("a").click();
      await page.waitForFunction(key => document.querySelector("#detail-heading")?.textContent?.includes(key), statusKeys[1].key);
      await assertDetailExecutors(snapshot, snapshot.work[1]);
      await page.goBack(); await page.locator("#executors").waitFor({ state: "visible" });
    }
    const executorSources = snapshot.sources.filter(source => source.source === "executor");
    const executorSourceRows = page.getByRole("heading", { name: "Executor 来源状态", exact: true }).locator("..").locator("p:has(.badge)");
    assert.equal(await executorSourceRows.count(), executorSources.length, `${scenario}: executor source count`);
    for (let i = 0; i < executorSources.length; i++) await assertSource(executorSourceRows.nth(i), executorSources[i], `${scenario}: executor source`);
    if (snapshot.executors.length === 0) assert.ok((await page.locator("#executors").innerText()).includes("当前快照清单为空"));
    if (["empty-inventory", "unknown-inventory", "unavailable-inventory"].includes(scenario)) await capture(`${scenario}-executors-desktop.png`);
    await page.goto(`${site.url}/${route}`); await page.locator("#detail-heading").waitFor();
    const first = snapshot.work[0]; const text = await page.locator("#detail").innerText();
    for (const expected of [first.phase, first.attention, first.key.key, first.freshness.github.status, first.freshness.runtime.status, first.waiting?.reason].filter(Boolean)) assert.ok(text.includes(expected), `${scenario}: ${expected}`);
    assert.ok(!(text.includes(statusKeys[1].key)));
    await assertDetailExecutors(snapshot, first);
    if (scenario === "failed") assert.ok((await page.locator("#detail .detail-conclusion").innerText()).includes("attention: failed"));
    for (const anomaly of snapshot.anomalies.filter(item => item.workKey?.key === first.key.key)) assert.ok(text.includes(anomaly.code));
    if (scenario === "result-mismatch") for (const letter of ["a", "b", "c"]) assert.ok(text.includes(letter.repeat(40)));
    await page.locator("#nav-work").click();
    await page.locator("#work").waitFor({ state: "visible" });
    if (scenario === "failed") {
      const row = page.locator("#work tbody tr").filter({ has: page.locator(".attention-failed") });
      assert.equal(await row.count(), 1);
      await assertWorkAssociation(row, statusKeys[0], "failed: Work row identity");
    }
    await page.locator("#work tbody a").nth(1).click();
    await page.waitForFunction(key => document.querySelector("#detail-heading")?.textContent?.includes(key), statusKeys[1].key);
    assert.ok((await page.locator("#detail").innerText()).includes(statusKeys[1].key));
    await assertDetailExecutors(snapshot, snapshot.work[1]);
    await page.goBack(); await page.goBack(); await page.waitForFunction(key => document.querySelector("#detail-heading")?.textContent?.includes(key), statusKeys[0].key);
    assert.ok((await page.locator("#detail").innerText()).includes(statusKeys[0].key));
    await page.reload(); await page.locator("#detail-heading").waitFor();
    const summary = page.locator("#detail summary").first(); await summary.focus(); await page.keyboard.press("Enter");
    const focused = await summary.getAttribute("id");
    if (scenario === "result-mismatch") {
      await page.waitForResponse(response => response.url().endsWith("/api/operations/snapshot"), { timeout: 25000 });
      await page.waitForFunction(id => document.activeElement?.id === id && document.getElementById(id)?.parentElement?.open, focused);
      const ids = await page.locator("[id]").evaluateAll(nodes => nodes.map(node => node.id)); assert.equal(new Set(ids).size, ids.length);
    }
    results.push({ scenario, phase: first.phase, attention: first.attention, health: snapshot.health,
      sourceChecks: { overview: snapshot.sources.length, system: snapshot.sources.length, executor: executorSources.length },
      sourceStates: snapshot.sources,
      executorChecks: { inventory: snapshot.executors.length, detailWorkKeys: statusKeys.length },
      executorInventory: snapshot.executors,
      ...(scenario === "failed" ? { failureEvidence: first.evidence.filter(item => item.code === "review_task_failed"), isolatedOtherAttention: snapshot.work[1].attention } : {}), result: "passed" });
    await site.stop(); site = undefined;
  }
  site = await startStatusSurface({ workKeys: statusKeys, assets }, statusFacts("result-mismatch"));
  for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "narrow", width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    // Start on a different destination so activating Overview changes the hash
    // and exercises the same heading-focus behavior as subsequent navigation.
    await page.goto(`${site.url}/#system`);
    for (const name of ["overview", "work", "executors", "system"]) {
      await page.locator(`#nav-${name}`).focus(); await page.keyboard.press("Enter");
      await page.waitForFunction(expected => document.querySelector("#page-heading")?.textContent?.toLowerCase() === expected, name);
      assert.equal(await page.evaluate(() => document.activeElement?.id), "page-heading");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await capture(`${name}-${viewport.name}.png`);
    }
    await page.goto(`${site.url}/${route}`); await page.locator("#detail-heading").waitFor();
    await capture(`detail-${viewport.name}.png`);
  }
  await site.stop(); site = undefined;
  for (const scenario of ["failed", "active-inventory", "stale-inventory"]) {
    site = await startStatusSurface({ workKeys: statusKeys, assets }, statusFacts(scenario));
    for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "narrow", width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const destinations = scenario === "failed" ? ["overview", "detail"] : ["executors", "system"];
      for (const destination of destinations) {
        await page.goto(`${site.url}/${destination === "detail" ? route : `#${destination}`}`);
        await page.locator(destination === "detail" ? "#detail-heading" : `#${destination}`).waitFor({ state: "visible" });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${scenario}/${destination}/${viewport.name}: overflow`);
        if (scenario === "failed") assert.ok((await page.locator(`#${destination}`).innerText()).includes("failed"));
        await capture(`${scenario}-${destination}-${viewport.name}.png`);
      }
    }
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
  const fixtureSha256 = createHash("sha256").update(await readFile(fileURLToPath(new URL("../src/status-fixtures.ts", import.meta.url)))).digest("hex");
  console.log(JSON.stringify({ fixtureSha256, sourceTree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim(), harnessSha256: createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"), evidenceDir, sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), workingTree: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }).trim(), browser: await browser.version(), mode: "controlled production composition + actual executable empty scope", externalLive: "not run", coverage: { sourceFields: ["source", "instance", "WorkKey", "freshness.status", "observedAt", "lastAttemptAt", "reason"], executorFields: ["id", "role", "adapter", "status", "host", "lastHeartbeatAt", "currentWork"], surfaces: ["Overview", "System", "Executors", "Work Detail association", "Work failed attention"], failedFact: "fresh failed ReviewTask without result", screenshotCount: screenshots.length }, screenshots, results, assets: hashes, networkRequests: network.length, getOnly: true, pageErrors: errors }, null, 2));
} finally {
  await browser.close(); await site?.stop(); await proc?.close(); await tracker?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
}
