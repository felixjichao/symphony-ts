/** Controlled static showcase generated from the actual primitives, outside browser graph. */
import { JSDOM } from "jsdom";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { attentionBadge, freshnessIndicator, presentationState, shaIdentity, workIdentity, surface, denseTable, denseList, searchControl, filterControl } from "../src/primitives";
const dom = new JSDOM("<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><title>Dashboard presentation primitives · #170</title></head><body><h1>Operator Console · Presentation primitives</h1><p>Controlled supplied values · no live facts or derived validity</p></body></html>");
globalThis.document = dom.window.document;
const conclusions = surface("Derived conclusions · supplied attention");
for (const state of ["normal", "waiting", "degraded", "needs_human", "failed"] as const) conclusions.append(attentionBadge(state), " ");
const facts = surface("Supplied facts · source freshness and independent identities");
facts.append(denseList([
  freshnessIndicator({ status: "fresh", observedAt: 1, lastAttemptAt: 2 }),
  freshnessIndicator({ status: "stale", observedAt: 1, lastAttemptAt: 2 }),
  freshnessIndicator({ status: "unknown", lastAttemptAt: null, reason: "not observed" }),
  freshnessIndicator({ status: "unavailable", observedAt: 1, lastAttemptAt: 2, reason: "offline" }),
  workIdentity({ provider: "github", key: "felixjichao/symphony-ts#170" }, "GH-170"),
  shaIdentity("PR HEAD", "a".repeat(40)), shaIdentity("Review task target HEAD", "b".repeat(40)),
  shaIdentity("Result / approval target HEAD", "c".repeat(40)), shaIdentity("Unknown HEAD", null),
]));
const diagnostics = surface("Diagnostics · explicit presentation states");
for (const state of ["empty", "unknown", "unavailable", "degraded"] as const) diagnostics.append(presentationState(state, "Caller-supplied explanation"));
const structures = surface("Structures and keyboard controls");
structures.append(searchControl("Search work"), filterControl("Attention", ["All supplied states", "waiting"]));
const table = denseTable("Dense observations", ["Identity", "Supplied value"]);
const body = document.createElement("tbody"), row = document.createElement("tr");
for (const text of ["GH-170", "unknown"]) { const cell = document.createElement("td"); cell.textContent = text; row.append(cell); }
row.setAttribute("aria-selected", "true");
body.append(row); table.append(body); structures.append(table, surface("Card · supplied diagnostic context", "article"));
document.body.append(conclusions, facts, diagnostics, structures);
const style = document.createElement("style"); style.textContent = await readFile(new URL("../src/style.css", import.meta.url), "utf8"); document.head.append(style);
const directory = new URL("../../../docs/evidence/dashboard-v2-primitives/", import.meta.url);
await mkdir(directory, { recursive: true }); await writeFile(new URL("showcase.html", directory), dom.serialize());
