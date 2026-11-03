/* global process, URL, document, getComputedStyle, navigator, window */

import { chromium } from "playwright";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const evidence = process.env.SYMPHONY_BROWSER_EVIDENCE || "/tmp/symphony-hud-evidence";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.SYMPHONY_CHROMIUM ? { executablePath: process.env.SYMPHONY_CHROMIUM } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route("https://chatgpt.com/", route => route.fulfill({ contentType: "text/html", body: `<style>input[type=checkbox], input[type=checkbox]:disabled { appearance:none!important; display:none!important; opacity:0!important; visibility:hidden!important; width:0!important; height:0!important; pointer-events:none!important; } </style><main>ChatGPT fixture</main>` }));
  await page.goto("https://chatgpt.com/");
  await page.evaluate(() => {
    let release;
    const identityGate = new Promise(resolve => { release = resolve; });
    window.releaseIdentity = release;
    Object.defineProperty(navigator, "locks", { value: {
      request: async (_name, _options, callback) => { await identityGate; return callback({}); },
    } });
  });
  await page.addScriptTag({ content: await readFile(new URL("../dist/symphony-decision-driver.user.js", import.meta.url), "utf8") });
  const input = page.locator("#symphony-allow-new-tasks");
  assert.equal(await input.isDisabled(), true);
  const disabledGeometry = await input.evaluate(el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return { width: r.width, height: r.height, display: s.display, opacity: s.opacity, visibility: s.visibility }; });
  assert.ok(disabledGeometry.width >= 18 && disabledGeometry.height >= 18 && disabledGeometry.display !== "none" && disabledGeometry.opacity === "1" && disabledGeometry.visibility === "visible");
  await page.evaluate(() => window.releaseIdentity());
  const toggle = page.getByRole("checkbox", { name: "Allow new tasks" });
  await toggle.waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector("#symphony-allow-new-tasks").disabled);
  assert.equal(await toggle.isChecked(), false);
  const geometry = await toggle.evaluate(el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return { width: r.width, height: r.height, display: s.display, opacity: s.opacity, visibility: s.visibility, pointerEvents: s.pointerEvents }; });
  assert.ok(geometry.width >= 18 && geometry.height >= 18 && geometry.display !== "none" && geometry.opacity === "1" && geometry.visibility === "visible" && geometry.pointerEvents === "auto");
  assert.match(await page.locator("#symphony-driver-hud").innerText(), /Allow new tasks: Off/);
  await toggle.click();
  assert.equal(await toggle.isChecked(), true);
  assert.match(await page.locator("#symphony-driver-hud").innerText(), /Allow new tasks: On/);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await toggle.evaluate(el => document.activeElement === el), true);
  assert.notEqual(await toggle.evaluate(el => getComputedStyle(el).outlineStyle), "none");
  await page.keyboard.press("Space");
  assert.equal(await toggle.isChecked(), false);
  const hud = await page.locator("#symphony-driver-hud").boundingBox();
  assert.ok(hud && hud.x >= 0 && hud.x + hud.width <= 390);
  await page.screenshot({ path: `${evidence}/hud-narrow.png` });
  await writeFile(`${evidence}/report.json`, JSON.stringify({ head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), disabledGeometry, geometry, result: "passed" }, null, 2));
} finally { await browser.close(); }
