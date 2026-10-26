// @vitest-environment jsdom
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { attentionBadge, freshnessIndicator, presentationState, shaIdentity, workIdentity, surface, denseTable, denseList, searchControl, filterControl } from "../src/primitives";
import type { AttentionState, SourceFreshness } from "@symphony/operations";

it.each<AttentionState>(["normal", "waiting", "degraded", "needs_human", "failed"])("renders supplied attention %s with text", state => {
  expect(attentionBadge(state).textContent).toContain(state);
});
it.each([
  { status: "fresh", observedAt: 1, lastAttemptAt: 2 },
  { status: "stale", observedAt: 1, lastAttemptAt: 2 },
  { status: "unknown", lastAttemptAt: null, reason: "not observed" },
  { status: "unavailable", observedAt: null, lastAttemptAt: 2, reason: "offline" },
] satisfies SourceFreshness[])("keeps supplied freshness $status explicit", supplied => {
  const node = freshnessIndicator(supplied); expect(node.textContent).toContain(supplied.status);
  expect(node.className).toContain(supplied.status);
});
it.each(["empty", "unknown", "unavailable", "degraded"] as const)("keeps %s separate", state => {
  const node = presentationState(state, "supplied explanation");
  expect(node.className).toContain(`state-${state}`); expect(node.textContent).toContain("supplied explanation");
});
it("preserves full and independent exact target identities accessibly", () => {
  for (const label of ["PR HEAD", "Task target HEAD", "Result target HEAD"]) {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const node = shaIdentity(label, sha);
    expect(node.textContent).toBe(`${label}: ${sha.slice(0, 12)}`);
    expect(node.getAttribute("aria-label")).toBe(`${label}: ${sha}`); expect(node.title).toContain(sha);
  }
  expect(shaIdentity("HEAD", null).textContent).toContain("未知");
  const identity = workIdentity({ provider: "github", key: "owner/repo#170" }, "GH-170");
  expect(identity.textContent).toContain("github:owner/repo#170"); expect(identity.title).toBe(identity.textContent);
});
it("composes native structures and labeled keyboard controls without filtering facts", () => {
  const card = surface("Supplied facts");
  const article = surface("Diagnostic card", "article");
  expect(article.tagName).toBe("ARTICLE"); expect(article.querySelector("h3")?.textContent).toBe("Diagnostic card");
  card.append(denseTable("Current observations", ["Identity", "State"]), denseList([shaIdentity("HEAD", null)]), searchControl("Search work"), filterControl("Attention", ["All", "waiting"]));
  document.body.replaceChildren(card);
  const input = card.querySelector("input")!; input.focus(); expect(document.activeElement).toBe(input);
  expect(input.closest("label")?.textContent).toBe("Search work");
  const select = card.querySelector("select")!; select.focus(); expect(document.activeElement).toBe(select);
  expect(card.querySelector("th")?.scope).toBe("col");
  const css = readFileSync(`${import.meta.dirname}/../src/style.css`, "utf8");
  expect(css).toContain(":focus-visible"); expect(css).toContain('[aria-selected="true"]'); expect(css).toContain("tr:hover");
});
