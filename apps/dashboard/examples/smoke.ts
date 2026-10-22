/** Optional real Chromium acceptance against the current dist; no browser download. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
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
  await page.goto(demo.url); await page.getByText("系统健康:", { exact: false }).waitFor();
  await page.getByText("演示数据 · 只读 · 非生产状态面", { exact: true }).waitFor();
  const link = page.locator("tbody a").first(); await link.click(); await page.getByText("已定位 github:", { exact: false }).waitFor();
  const details = page.locator("summary").first(); await details.focus(); await page.keyboard.press("Enter");
  assert.ok(await page.locator("details[open] pre").first().innerText().then((text: string) => text.includes("a".repeat(40))));
  const pane = page.locator("#detail");
  await pane.getByRole("heading", { name: "Why", exact: false }).waitFor();
  for (const letter of ["a", "b", "c"]) assert.ok((await pane.innerText()).includes(letter.repeat(40)));
  await pane.getByText("review_result_target_mismatch", { exact: true }).first().waitFor();
  const raw = pane.locator("summary").first(); await raw.focus(); await page.keyboard.press("Enter");
  assert.ok(await pane.locator("details[open] pre").count() > 0);
  await page.locator("tbody a").nth(1).click();
  assert.ok((await pane.innerText()).includes("demo/beta#1") && !(await pane.innerText()).includes("demo/alpha#1"));
  await page.goBack(); await pane.getByRole("heading", { name: "Work Detail · github:demo/alpha#1", exact: true }).waitFor();
  await page.goForward(); await pane.getByRole("heading", { name: "Work Detail · github:demo/beta#1", exact: true }).waitFor();
  const direct = `#${encodeURIComponent(JSON.stringify(["github", "demo/alpha#1"]))}`;
  for (const [name, expected] of [["review", "waiting_for_review"], ["target-mismatch", "review_target_head_mismatch"], ["partial", "demo_unavailable"], ["conflict", "conflicting_active_review_tasks"], ["terminal", "execution_on_terminal_work"]] as const) {
    scenario = name; await page.goto(`${demo.url}/${direct}`); await page.reload();
    await pane.getByText(expected, { exact: false }).first().waitFor();
    assert.ok(!(await pane.innerText()).includes("demo/beta#1"));
  }
  const address = demo.upstream.address(); assert.ok(address && typeof address !== "string");
  await close(demo.upstream);
  await page.getByText("刷新失败，显示上次成功快照", { exact: false }).waitFor({ timeout: 25_000 });
  recovered = await startOperationsHttpServer(service, { port: address.port });
  await page.getByText("已收到当前快照", { exact: false }).waitFor({ timeout: 25_000 });
  assert.ok(network.length >= 3 && network.every(method => method === "GET") && endpoints.every(path => path === "/api/operations/snapshot"));
  const assets = await readdir(new URL("../dist/assets/", import.meta.url));
  const hashes = await Promise.all(assets.map(async file => ({ file, sha256: createHash("sha256").update(await readFile(new URL(`../dist/assets/${file}`, import.meta.url))).digest("hex") })));
  console.log(JSON.stringify({ mode: "built", browser: await browser.version(), scenarios: ["load", "WorkKey direct route", "back/forward", "three full SHAs", "keyboard raw evidence", "cross-work isolation", "review", "target-mismatch", "result-mismatch", "partial", "conflict", "terminal", "transport disconnect", "transport recover", "GET only"], network, assets: hashes }, null, 2));
} finally { await browser?.close(); if (recovered) await close(recovered); await demo.stop(); }
