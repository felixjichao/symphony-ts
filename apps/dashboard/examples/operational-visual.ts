/** Deterministic browser evidence for SPEC §13 adjacent / #175. */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { snapshot, work, fresh } from "../tests/fixtures";
import { demoService } from "./sources";
import { startDemo } from "./server";
const output = process.env["SYMPHONY_BROWSER_EVIDENCE"] ?? ".symphony/evidence/operational-views";
const key = work().key;
const data = snapshot({ executors: [{ id: "active-worker", role: "implementer", adapter: "codex", status: "busy", host: "host-a", lastHeartbeatAt: 1, currentWork: key }, { id: "idle-worker", role: null, adapter: "codex", status: "online", host: null, lastHeartbeatAt: null, currentWork: null }], sources: [{ source: "github", instance: "g", freshness: fresh }, { source: "runtime", instance: "r", freshness: { status: "stale", observedAt: 1, lastAttemptAt: 2 } }, { source: "decision", instance: "d", freshness: { status: "unknown", lastAttemptAt: null, reason: "unconfigured" } }, { source: "executor", instance: "e", freshness: { status: "unavailable", observedAt: null, lastAttemptAt: 2, reason: "offline" } }], anomalies: [{ code: "decision_result_without_task", severity: "error", message: "GLOBAL SIGNAL", workKey: null, detectedAt: 1 }, { code: "review_result_target_mismatch", severity: "warning", message: "WORK SIGNAL", workKey: key, detectedAt: 1 }] });
const server = await startDemo({ ...demoService(), getOperationalSnapshot: async () => data });
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const assets: Record<string, string> = {};
for (const name of await readdir(new URL("../dist/assets/", import.meta.url))) assets[name] = hash(await readFile(new URL(`../dist/assets/${name}`, import.meta.url)));
const report = { head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), trackedChanges: execFileSync("git", ["diff", "--name-only"], { encoding: "utf8" }).trim(), harness: hash(await readFile(new URL(import.meta.url))), assets, browser: "", screenshots: {} as Record<string, string>, status: "running", error: null as string | null };
let browser;
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true, ...(process.env["SYMPHONY_CHROMIUM"] ? { executablePath: process.env["SYMPHONY_CHROMIUM"] } : {}) }); report.browser = browser.version();
  const page = await browser.newPage();
  for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "narrow", width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const route of ["executors", "system"]) {
      await page.goto(`${server.url}/#${route}`);
      await page.locator(`#${route} .surface`).first().waitFor();
      const text = await page.locator(`#${route}`).innerText();
      if (route === "executors") { assert.ok(text.includes("active-worker") && text.includes("idle-worker") && text.includes("offline")); }
      else { for (const value of ["fresh", "stale", "unknown", "unavailable", "GLOBAL SIGNAL", "WORK SIGNAL"]) assert.ok(text.includes(value)); }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const name = `${route}-${viewport.name}.png`; report.screenshots[name] = hash(await page.screenshot({ path: `${output}/${name}`, fullPage: true }));
    }
  }
  await page.goto(`${server.url}/#executors`); await page.locator("#executors a").first().click(); await page.locator("#detail-heading").waitFor();
  await page.locator("#nav-system").focus(); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.id === "page-heading");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "page-heading");
  await page.route("**/api/operations/snapshot", route => route.abort());
  await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); });
  await page.getByText(/刷新失败，显示上次成功快照/).waitFor(); assert.ok((await page.locator("#system").innerText()).includes("WORK SIGNAL"));
  report.screenshots["interruption.png"] = hash(await page.screenshot({ path: `${output}/interruption.png`, fullPage: true }));
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = String(error); throw error; }
finally { await browser?.close(); await server.stop(); await writeFile(`${output}/browser.json`, JSON.stringify(report, null, 2) + "\n"); }
