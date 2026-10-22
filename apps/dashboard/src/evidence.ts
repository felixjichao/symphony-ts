import type { ProjectionEvidence, WorkKey } from "@symphony/operations";
import { el } from "./dom";
import { evidenceGroups, scopedEvidence, token } from "./identity";
import { timestamp } from "./presentation";
export function evidenceList(items: readonly ProjectionEvidence[], key: WorkKey | null): HTMLElement {
  const section = el("section");
  const selected = scopedEvidence(items, key);
  if (selected.length !== items.length) section.append(el("p", "证据归属不一致：已隐藏其他 WorkKey 的证据。"));
  if (selected.length === 0) section.append(el("p", "未提供证据"));
  let index = 0;
  for (const [label, entries] of evidenceGroups(selected)) {
    section.append(el("h4", label));
    for (const entry of entries) {
      const card = el("article");
      card.append(el("h5", entry.code), el("p", entry.detail ?? "detail 未提供"), el("p", `观测 ${timestamp(entry.observedAt)} · 实体时间 ${timestamp(entry.entityTimestampMs)}`));
      // Explicit structured provenance, with a raw copy for inspection. No rule evaluation.
      const fields = el("dl");
      for (const [label, value] of [["source", entry.source], ["role", entry.role], ["ruleId", entry.ruleId], ["freshness", entry.freshnessStatus], ["instance", entry.instance], ["field", entry.field], ["value", entry.value], ["headSha", entry.headSha], ["target", entry.target], ["sessionId", entry.sessionId], ["taskId", entry.taskId], ["revision", entry.revision], ["resultId", entry.resultId], ["WorkKey", entry.workKey]] as const) fields.append(el("dt", label), el("dd", value === undefined ? "未提供" : JSON.stringify(value)));
      const raw = el("details"); raw.id = `evidence-${key === null ? "global" : token(key)}-${index++}`;
      const summary = el("summary", "原始证据诊断"); summary.id = `${raw.id}-focus`;
      raw.append(summary, el("pre", JSON.stringify(entry, null, 2)));
      card.append(fields, raw); section.append(card);
    }
  }
  return section;
}
