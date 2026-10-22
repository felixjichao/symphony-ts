import type { OperationalAnomaly, WorkKey } from "@symphony/operations";
import { el } from "./dom";
import { scopedAnomalies } from "./identity";
import { evidenceList } from "./evidence";
import { timestamp } from "./presentation";
export function anomalyCards(items: readonly OperationalAnomaly[], key: WorkKey | null): HTMLElement {
  const section = el("section");
  section.append(el("h3", key === null ? "全局异常（未关联 WorkKey）" : "Work 异常"));
  const selected = scopedAnomalies(items, key);
  if (selected.length === 0) section.append(el("p", "当前快照未报告异常"));
  for (const entry of selected) {
    const card = el("article");
    card.append(el("h4", entry.code), el("p", `severity: ${entry.severity}`), el("p", entry.message), el("p", `WorkKey: ${JSON.stringify(entry.workKey)} · 检测 ${timestamp(entry.detectedAt)}`), evidenceList(entry.evidence ?? [], key));
    section.append(card);
  }
  return section;
}
