/** DOM-native presentation only; SPEC §13 adjacent, #170. No projection derivation. */
import type { AttentionState, SourceFreshness, WorkKey } from "@symphony/operations";
import { el } from "./dom";
import { freshness } from "./presentation";
const attentionText = {
  normal: "○ normal · 正常", waiting: "◷ waiting · 等待", degraded: "△ degraded · 降级",
  needs_human: "! needs_human · 需要人工", failed: "× failed · 失败",
} satisfies Record<AttentionState, string>;
export function attentionBadge(state: AttentionState): HTMLElement {
  const node = el("span", attentionText[state]); node.className = `badge attention-${state}`; return node;
}
export function freshnessIndicator(supplied: SourceFreshness): HTMLElement {
  const node = el("span", freshness(supplied)); node.className = `badge freshness-${supplied.status}`; return node;
}
export function presentationState(state: "empty" | "unknown" | "unavailable" | "degraded", message: string): HTMLElement {
  const labels = { empty: "∅ 空", unknown: "? 未知", unavailable: "⊘ 不可用", degraded: "△ 降级" };
  const node = el("p", `${labels[state]} · ${message}`); node.className = `presentation-state state-${state}`; return node;
}
export function workIdentity(key: WorkKey, identifier: string): HTMLAnchorElement {
  const full = `${identifier} · ${key.provider}:${key.key}`;
  const node = el("a", full); node.title = full;
  node.href = `#${encodeURIComponent(JSON.stringify([key.provider, key.key]))}`; return node;
}
/** Caller supplies each target independently; this helper never compares targets. */
export function shaIdentity(label: string, sha: string | null): HTMLElement {
  const node = el("code", `${label}: ${sha === null ? "未知 / 未提供" : sha.slice(0, 12)}`);
  node.className = "identity"; node.title = `${label}: ${sha ?? "未知 / 未提供"}`;
  node.setAttribute("aria-label", node.title); return node;
}
export function surface(title: string, kind: "section" | "article" = "section"): HTMLElement {
  const node = el(kind); node.className = "surface"; node.append(el(kind === "section" ? "h2" : "h3", title)); return node;
}
export function denseTable(caption: string, columns: readonly string[]): HTMLTableElement {
  const node = el("table"); node.className = "dense-table"; node.append(el("caption", caption));
  const head = el("thead"), row = el("tr");
  for (const label of columns) { const cell = el("th", label); cell.scope = "col"; row.append(cell); }
  head.append(row); node.append(head); return node;
}
export function denseList(items: readonly HTMLElement[]): HTMLUListElement {
  const node = el("ul"); node.className = "dense-list";
  for (const content of items) { const item = el("li"); item.append(content); node.append(item); } return node;
}
/** Controls expose native events; filtering/search semantics belong to the caller. */
export function searchControl(label: string): HTMLLabelElement {
  const node = el("label", label); node.className = "control";
  const input = el("input"); input.type = "search"; node.append(input); return node;
}
export function filterControl(label: string, options: readonly string[]): HTMLLabelElement {
  const node = el("label", label); node.className = "control"; const select = el("select");
  for (const text of options) { const option = el("option", text); option.value = text; select.append(option); }
  node.append(select); return node;
}
