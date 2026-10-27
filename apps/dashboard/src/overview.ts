/** Attention-first presentation of supplied projections; SPEC §13 adjacent / #171. */
import type { OperationalSnapshot } from "@symphony/operations";
import { el } from "./dom";
import { overviewGroups } from "./identity";
import { timestamp } from "./presentation";
import { attentionBadge, denseList, freshnessIndicator, presentationState, surface, workIdentity } from "./primitives";
import { anomalySummary } from "./anomaly";
export function overview(snapshot: OperationalSnapshot): HTMLElement {
  const page = el("section"); page.id = "overview";
  page.append(el("h2", "现在需要关注什么？"), el("p", "按已提供的 attention / waiting 与异常关联排列；当前 scope 的只读观测。"));
  for (const [label, entries] of overviewGroups(snapshot)) {
    const group = surface(label);
    if (entries.length === 0) group.append(el("p", "当前快照未报告此类工作"));
    const items = entries.map(work => {
      const item = el("article");
      item.append(workIdentity(work.key, work.workItem.identifier), el("p", work.workItem.title ?? "未报告标题"), attentionBadge(work.attention), el("p", `当前阶段: ${work.phase}`));
      if (work.waiting !== null) item.append(el("p", `等待: ${work.waiting.reason} · 自 ${timestamp(work.waiting.since)}`));
      item.append(anomalySummary(snapshot.anomalies, work.key));
      return item;
    });
    group.append(denseList(items)); page.append(group);
  }
  if (snapshot.work.length === 0) page.append(presentationState("empty", "当前快照没有已知工作；观测是否可信请见来源状态。"));
  const context = surface("当前运行与观测");
  context.append(el("p", `系统健康: ${snapshot.health} · 快照生成 ${timestamp(snapshot.generatedAt)}`));
  const counts = el("dl"); counts.className = "overview-counts";
  for (const [label, value] of [["活动工作", snapshot.summary.active], ["等待", snapshot.summary.waiting], ["需要人工", snapshot.summary.needsHuman], ["重试等待", snapshot.summary.retrying], ["降级工作", snapshot.summary.degradedWork], ["异常条目", snapshot.summary.anomalyCount]] as const) counts.append(el("dt", label), el("dd", value === undefined ? "该版本未提供" : String(value)));
  context.append(counts, el("h3", "来源新鲜度 / 观测健康"));
  if (snapshot.sources.length === 0) context.append(presentationState("unknown", "快照未提供来源状态"));
  for (const source of snapshot.sources) {
    const item = el("p", `${source.source} / ${source.instance} · `);
    if (source.workKey != null) item.append(workIdentity(source.workKey, source.workKey.key), " · ");
    item.append(freshnessIndicator(source.freshness)); context.append(item);
  }
  context.append(el("h3", "Executor 当前活动 / 归属"));
  if (snapshot.executors.length === 0) context.append(el("p", "当前快照清单为空；请结合 executor 来源状态判断观测情况。"));
  for (const executor of snapshot.executors) {
    const item = el("p", `${executor.id} · ${executor.role ?? "未报告角色"} · ${executor.adapter} · ${executor.status} · 心跳 ${timestamp(executor.lastHeartbeatAt)}`);
    if (executor.currentWork !== null) item.append(" · ", workIdentity(executor.currentWork, executor.currentWork.key));
    context.append(item);
  }
  page.append(context, anomalySummary(snapshot.anomalies, null));
  const link = el("a", "查看 Work"); link.href = "#work"; page.append(link);
  return page;
}
