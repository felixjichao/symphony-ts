/** Supplied executor inventory and source observations; SPEC §13 adjacent / #175. */
import type { OperationalSnapshot } from "@symphony/operations";
import { el } from "./dom";
import { timestamp } from "./presentation";
import { denseList, freshnessIndicator, presentationState, surface, workIdentity } from "./primitives";

export function executors(snapshot: OperationalSnapshot): HTMLElement {
  const page = el("section"); page.id = "executors";
  const inventory = surface("Executor inventory");
  if (snapshot.executors.length === 0) inventory.append(presentationState("empty", "当前快照清单为空；请结合以下各来源状态判断观测情况。"));
  inventory.append(denseList(snapshot.executors.map(executor => {
    const item = el("article");
    item.append(el("h3", executor.id), el("p", `角色: ${executor.role ?? "未报告角色"} · Adapter: ${executor.adapter} · 状态: ${executor.status}`), el("p", `Host: ${executor.host ?? "未报告"} · 心跳: ${timestamp(executor.lastHeartbeatAt)}`));
    const work = el("p", "当前 Work: ");
    if (executor.currentWork) work.append(workIdentity(executor.currentWork, executor.currentWork.key)); else work.append("未报告");
    item.append(work); return item;
  })));
  const sources = surface("Executor 来源状态");
  const supplied = snapshot.sources.filter(source => source.source === "executor");
  if (supplied.length === 0) sources.append(presentationState("unknown", "快照未提供 executor 来源状态"));
  for (const source of supplied) {
    const item = el("p", `${source.source} / ${source.instance} · `);
    if (source.workKey) item.append(workIdentity(source.workKey, source.workKey.key), " · ");
    item.append(freshnessIndicator(source.freshness));
    sources.append(item);
  }
  page.append(inventory, sources); return page;
}
