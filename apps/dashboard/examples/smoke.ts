/** Optional real Chromium acceptance against the current dist; no browser download. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { startOperationsHttpServer } from "@symphony/observability";
import { demoService, type Scenario } from "./sources";
import { startDemo, close } from "./server";
const modulePath = process.env["SYMPHONY_BROWSER_MODULE"];
if (!modulePath) throw new Error("Set SYMPHONY_BROWSER_MODULE to an installed Playwright module; this command never downloads browsers");
const { chromium } = await import(modulePath);
let scenario: Scenario = "result-mismatch";
const base = demoService();
const service = { ...base, getOperationalSnapshot: () => demoService(scenario).getOperationalSnapshot() };
const demo = await startDemo(service);
let browser;
let recovered: Awaited<ReturnType<typeof startOperationsHttpServer>> | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(process.env["SYMPHONY_CHROMIUM"] ? { executablePath: process.env["SYMPHONY_CHROMIUM"] } : {}) });
  const page = await browser.newPage(); const network: string[] = []; const endpoints: string[] = [];
  page.on("request", (request: { url(): string; method(): string }) => { if (request.url().includes("/api/")) { network.push(request.method()); endpoints.push(new URL(request.url()).pathname); } });
  await page.goto(demo.url); await page.getByText("系统健康:", { exact: false }).first().waitFor();
  await page.getByText("演示数据 · 只读 · 非生产状态面", { exact: true }).waitFor();
  const evidenceDir = process.env["SYMPHONY_BROWSER_EVIDENCE"] ?? ".symphony/evidence/dashboard-169";
  await mkdir(evidenceDir, { recursive: true });
  for (const name of ["Overview", "Work", "Executors", "System"]) {
    const nav = page.getByRole("navigation");
    await nav.getByRole("link", { name, exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction((expected: string) => document.querySelector("#page-heading")?.textContent === expected, name);
    assert.equal(await nav.locator('[aria-current="page"]').innerText(), name);
    await page.waitForFunction(() => document.activeElement?.id === "page-heading");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "page-heading");
    await page.screenshot({ path: `${evidenceDir}/${name.toLowerCase()}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ["Overview", "Work", "Executors", "System"]) {
    await page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
    await page.waitForFunction((expected: string) => document.querySelector("#page-heading")?.textContent === expected, name);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: `${evidenceDir}/narrow-${name.toLowerCase()}.png`, fullPage: true });
  }
  await page.getByRole("navigation").getByRole("link", { name: "Work", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#page-heading")?.textContent === "Work");
  // Exercise native discovery controls on the actual narrow Work page.
  const search = page.locator("#explorer-search"); await search.focus(); await page.keyboard.type("beta");
  await page.waitForFunction(() => document.querySelectorAll("#work tbody tr").length === 1);
  assert.equal(await page.locator("#work tbody tr").count(), 1);
  assert.ok((await page.locator("#work tbody").innerText()).includes("demo/beta#1"));
  await page.locator("#explorer-scope").selectOption("github:demo/alpha");
  await page.getByText("没有工作匹配当前筛选；可重置筛选。", { exact: false }).waitFor();
  await page.screenshot({ path: `${evidenceDir}/narrow-explorer-filtered.png`, fullPage: true });
  await page.locator("#explorer-reset").focus(); await page.keyboard.press("Enter");
  assert.equal(await page.locator("#work tbody tr").count(), 2);
  assert.ok(await page.locator(".explorer-results").evaluate((node: HTMLElement) => node.scrollWidth > node.clientWidth));
  const link = page.locator("tbody a").first(); await link.click(); await page.getByText("已定位 github:", { exact: false }).waitFor();
  const pane = page.locator("#detail");
  await pane.getByRole("heading", { name: "Why", exact: false }).waitFor();
  for (const letter of ["a", "b", "c"]) assert.ok((await pane.innerText()).includes(letter.repeat(40)));
  await pane.getByText("review_result_target_mismatch", { exact: true }).first().waitFor();
  await pane.getByRole("heading", { name: "当前执行 / PR / Review 标识" }).waitFor();
  await page.screenshot({ path: `${evidenceDir}/narrow-current-detail.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${evidenceDir}/current-detail.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const raw = pane.locator("summary").first(); await raw.focus(); await page.keyboard.press("Enter");
  assert.ok(await pane.locator("details[open] pre").count() > 0);
  await page.locator("details").evaluateAll((nodes: HTMLDetailsElement[]) => nodes.forEach(node => { node.open = false; }));
  const anomaly = pane.locator("article").filter({ has: page.locator("h4", { hasText: /^review_result_target_mismatch$/ }) });
  const targetFact = anomaly.locator("article").filter({ has: page.locator("h5", { hasText: /^review_result_target$/ }) });
  const targetSummary = targetFact.locator("summary"); await targetSummary.focus(); await page.keyboard.press("Enter");
  const focusedId = await targetSummary.getAttribute("id");
  const previousNotice = await page.getByRole("status").first().innerText();
  await page.waitForResponse((response: { url(): string }) => response.url().endsWith("/api/operations/snapshot"), { timeout: 25_000 });
  await page.waitForFunction((previous: string) => document.querySelector('[role="status"]')?.textContent !== previous, previousNotice);
  assert.equal(await page.evaluate(() => document.activeElement?.id), focusedId);
  assert.equal(await page.locator("details[open]").count(), 1);
  assert.equal(await targetSummary.evaluate((node: HTMLElement) => document.activeElement === node), true);
  const ids = await page.locator("[id]").evaluateAll((nodes: HTMLElement[]) => nodes.map(node => node.id));
  assert.equal(new Set(ids).size, ids.length);
  await page.getByRole("navigation").getByRole("link", { name: "Work", exact: true }).click();
  await page.locator("tbody a").nth(1).click();
  await pane.getByRole("heading", { name: "Work Detail · github:demo/beta#1", exact: true }).waitFor();
  assert.ok((await pane.innerText()).includes("demo/beta#1") && !(await pane.innerText()).includes("demo/alpha#1"));
  await page.goBack(); await page.goBack(); await pane.getByRole("heading", { name: "Work Detail · github:demo/alpha#1", exact: true }).waitFor();
  await page.goForward(); await page.goForward(); await pane.getByRole("heading", { name: "Work Detail · github:demo/beta#1", exact: true }).waitFor();
  const direct = `#${encodeURIComponent(JSON.stringify(["github", "demo/alpha#1"]))}`;
  for (const [name, expected] of [["review", "waiting_for_review"], ["target-mismatch", "review_target_head_mismatch"], ["partial", "demo_unavailable"], ["conflict", "conflicting_active_review_tasks"], ["terminal", "execution_on_terminal_work"]] as const) {
    scenario = name; await page.goto(`${demo.url}/${direct}`); await page.reload();
    await pane.getByText(expected, { exact: false }).first().waitFor();
    assert.ok(!(await pane.innerText()).includes("demo/beta#1"));
  }
  await page.screenshot({ path: `${evidenceDir}/narrow-detail.png`, fullPage: true });
  for (const hash of ["#%bad", `#${encodeURIComponent(JSON.stringify(["github", "outside/repo#1"]))}`]) {
    await page.goto(`${demo.url}/${hash}`);
    await page.getByText("工作标识无效或不在当前 scope", { exact: true }).waitFor();
    assert.equal(await pane.innerText(), "");
  }
  await page.goto(`${demo.url}/${direct}`);
  await pane.getByText("execution_on_terminal_work", { exact: true }).first().waitFor();
  const address = demo.upstream.address(); assert.ok(address && typeof address !== "string");
  await close(demo.upstream);
  await page.getByText("刷新失败，显示上次成功快照", { exact: false }).waitFor({ timeout: 25_000 });
  recovered = await startOperationsHttpServer(service, { port: address.port });
  await page.getByText("已收到当前快照", { exact: false }).waitFor({ timeout: 25_000 });
  assert.ok(network.length >= 3 && network.every(method => method === "GET") && endpoints.every(path => path === "/api/operations/snapshot"));
  const assets = await readdir(new URL("../dist/assets/", import.meta.url));
  const hashes = await Promise.all(assets.map(async file => ({ file, sha256: createHash("sha256").update(await readFile(new URL(`../dist/assets/${file}`, import.meta.url))).digest("hex") })));
  // Static controlled matrix uses the actual primitive DOM, separate from live snapshots.
  await page.setContent(await readFile(new URL("../../../docs/evidence/dashboard-v2-primitives/showcase.html", import.meta.url), "utf8"));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("searchbox").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.locator("select").evaluate((node: HTMLElement) => node === document.activeElement), true);
  assert.notEqual(await page.locator("select").evaluate((node: HTMLElement) => getComputedStyle(node).outlineStyle), "none");
  assert.equal(await page.locator(".badge").count(), 9);
  assert.equal(await page.locator("code").first().getAttribute("aria-label"), `PR HEAD: ${"a".repeat(40)}`);
  await page.screenshot({ path: `${evidenceDir}/primitives-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${evidenceDir}/primitives-narrow.png`, fullPage: true });
  console.log(JSON.stringify({ mode: "built", evidenceDir, browser: await browser.version(), scenarios: ["primitive matrix", "native keyboard focus outline", "full SHA accessible name", "four destinations", "active navigation", "heading focus", "390px shell overflow", "rendered screenshots", "invalid/out-of-scope WorkKeys", "load", "WorkKey direct route", "back/forward", "three full SHAs", "keyboard raw evidence", "anomaly evidence focus/open retained across real 15s poll", "unique diagnostic IDs", "cross-work isolation", "review", "target-mismatch", "result-mismatch", "partial", "conflict", "terminal", "transport disconnect", "transport recover", "GET only"], network, assets: hashes }, null, 2));
} finally { await browser?.close(); if (recovered) await close(recovered); await demo.stop(); }
