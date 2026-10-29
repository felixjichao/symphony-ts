/** Observation facts and transport posture remain independent; SPEC §13 adjacent / #175. */
import type { OperationalSnapshot } from "@symphony/operations";
import type { Observation } from "./polling";
import { el } from "./dom";
import { token } from "./identity";
import { timestamp } from "./presentation";
import { denseList, freshnessIndicator, presentationState, surface, workIdentity } from "./primitives";
import { anomalyCards, anomalySummary } from "./anomaly";

export function system(snapshot: OperationalSnapshot, observation: Observation): HTMLElement {
  const page = el("section"); page.id = "system";
  const health = surface("Observation Plane 健康");
  health.append(el("p", `系统健康: ${snapshot.health}`), el("p", `快照生成: ${timestamp(snapshot.generatedAt)}`));
  const transport = el("p"); transport.id = "system-transport"; health.append(transport); updateTransport(transport, observation);
  const sources = surface("来源状态");
  if (snapshot.sources.length === 0) sources.append(presentationState("unknown", "快照未提供来源状态"));
  sources.append(denseList(snapshot.sources.map(source => {
    const item = el("article"); item.append(el("h3", `${source.source} / ${source.instance}`));
    if (source.workKey) { const work = el("p", "Work: "); work.append(workIdentity(source.workKey, source.workKey.key)); item.append(work); }
    item.append(freshnessIndicator(source.freshness)); return item;
  })));
  const anomalies = surface("异常范围"); anomalies.append(anomalyCards(snapshot.anomalies, null));
  const scoped = el("section"); scoped.append(el("h3", "Work 范围异常"));
  const keys = new Map(snapshot.anomalies.filter(a => a.workKey !== null).map(a => [token(a.workKey!), a.workKey!]));
  if (keys.size === 0) scoped.append(el("p", "当前快照未报告 Work 范围异常"));
  for (const key of keys.values()) { const group = el("section"); group.append(workIdentity(key, key.key), anomalySummary(snapshot.anomalies, key)); scoped.append(group); }
  anomalies.append(scoped); page.append(health, sources, anomalies); return page;
}
export function updateTransport(node: HTMLElement, observation: Observation): void {
  node.textContent = `传输 / 轮询: ${observation.error ? `刷新失败 · ${observation.error}` : "上次请求成功"} · 上次成功响应: ${timestamp(observation.receivedAt)}`;
}
