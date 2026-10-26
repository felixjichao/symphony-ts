/** Reproducible controlled Overview artifacts, using the actual mounted page. */
import { JSDOM } from "jsdom";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mount } from "../src/view";
import { snapshot, work, fresh } from "../tests/fixtures";
const directory = new URL("../../../docs/evidence/dashboard-v2-overview/", import.meta.url);
await mkdir(directory, { recursive: true });
const style = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
for (const scenario of ["healthy", "attention", "empty", "observation-failure"] as const) {
  const dom = new JSDOM("<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><title>Overview controlled evidence · #171</title></head><body><div id='app'></div></body></html>", { url: "http://localhost/#overview" });
  globalThis.document = dom.window.document; globalThis.window = dom.window as unknown as Window & typeof globalThis;
  const root = document.getElementById("app")!; const view = mount(root);
  const data = snapshot({ summary: { active: scenario === "empty" ? 0 : 1, waiting: scenario === "attention" ? 1 : 0, needsHuman: scenario === "attention" ? 1 : 0, retrying: 0 }, work: scenario === "empty" ? [] : scenario === "attention" ? [work({ attention: "needs_human" }), work({ key: { provider: "github", key: "demo#2" }, attention: "degraded" }), work({ key: { provider: "github", key: "demo#3" }, waiting: { reason: "waiting_for_executor", since: null } })] : [work()], sources: [{ source: "executor", instance: "controlled", freshness: scenario === "observation-failure" ? { status: "unavailable", observedAt: null, lastAttemptAt: 2, reason: "offline" } : fresh }] });
  view.update({ snapshot: data, receivedAt: 10, ...(scenario === "observation-failure" ? { error: "Controlled HTTP 502; last successful snapshot retained" } : {}) });
  const css = document.createElement("style"); css.textContent = style; document.head.append(css);
  await writeFile(new URL(`${scenario}.html`, directory), dom.serialize());
  view.destroy(); dom.window.close();
}

// Optional rendering with an already installed browser; never downloads or changes policy.
if (process.env["SYMPHONY_BROWSER_MODULE"]) {
  const { chromium } = await import(process.env["SYMPHONY_BROWSER_MODULE"]);
  const browser = await chromium.launch({ headless: true, ...(process.env["SYMPHONY_CHROMIUM"] ? { executablePath: process.env["SYMPHONY_CHROMIUM"] } : {}) });
  try {
    const page = await browser.newPage();
    for (const scenario of ["healthy", "attention", "empty", "observation-failure"]) {
      await page.goto(new URL(`${scenario}.html`, directory).href);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        if (!await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)) throw new Error(`Overview overflow: ${scenario}/${width}`);
        await page.keyboard.press("Tab");
        if (await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle) === "none") throw new Error("Missing keyboard focus outline");
        await page.screenshot({ path: new URL(`${scenario}-${width}.png`, directory).pathname, fullPage: true });
      }
    }
  } finally { await browser.close(); }
}
