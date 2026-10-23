import type { OperationalSnapshot, WorkProjection } from "@symphony/operations";
import { el } from "./dom";
import { scopedSources, globalSources, scopedExecutors } from "./identity";
import { approvalLabels, freshness, timestamp } from "./presentation";
import { evidenceList } from "./evidence";
import { anomalyCards } from "./anomaly";
export function workDetail(work: WorkProjection, snapshot: OperationalSnapshot): HTMLElement {
  const section = el("section"); section.setAttribute("aria-labelledby", "detail-heading");
  const heading = el("h2", `Work Detail · ${work.key.provider}:${work.key.key}`); heading.id = "detail-heading"; heading.tabIndex = -1;
  section.append(heading, el("p", `${work.workItem.identifier} · ${work.workItem.title ?? "未报告标题"}`));
  section.append(el("h3", "当前结论 · Derived state"), el("p", `phase: ${work.phase} · attention: ${work.attention}`), el("p", work.waiting === null ? "未报告等待" : `waiting: ${work.waiting.reason} · 自 ${timestamp(work.waiting.since)}`), el("p", work.review === null ? "未提供审查信号" : approvalLabels[work.review.approval]));
  section.append(el("h3", "来源事实 / exact HEAD 标识"), el("p", "以下为当前快照所载事实；可信程度请结合来源新鲜度与 evidence role。结果事实 verdict 不代表当前 HEAD 获批。"));
  const fields = el("dl");
  for (const [label, value] of [["PR number / state", work.pullRequest === null ? null : { number: work.pullRequest.number, state: work.pullRequest.state }], ["当前 PR HEAD", work.pullRequest?.headSha], ["CI state", work.ci?.status], ["投影 currentHeadSha", work.review?.currentHeadSha], ["投影 taskTarget（可能来自 result fallback）", work.review?.taskTarget], ["真实 ReviewTask", work.review?.task], ["ReviewTask target HEAD", work.review?.task?.kind === "review" ? work.review.task.target.headSha : null], ["结果事实 verdict / target", work.review?.result], ["结果 / approval target HEAD", work.review?.result?.outcome.kind === "review" ? work.review.result.outcome.target.headSha : null], ["Planning projection", work.planning], ["Execution projection", work.execution]] as const) fields.append(el("dt", label), el("dd", value == null ? "未提供" : JSON.stringify(value, null, 2)));
  section.append(fields, el("h3", "来源新鲜度 · Work"));
  for (const [label, value] of Object.entries(work.freshness)) section.append(el("p", `${label}: ${freshness(value)}`));
  for (const source of scopedSources(snapshot.sources, work.key)) section.append(el("p", `${source.source} / ${source.instance}: ${freshness(source.freshness)}`));
  section.append(el("h3", "全局来源（非 Work 独有 freshness）"));
  for (const source of globalSources(snapshot.sources)) section.append(el("p", `${source.source} / ${source.instance}: ${freshness(source.freshness)}`));
  section.append(el("h3", "关联 Executor · 按完整 WorkKey"));
  for (const item of scopedExecutors(snapshot.executors, work.key)) section.append(el("p", `${item.id} · ${item.role ?? "未报告角色"} · ${item.adapter} · ${item.status} · 心跳 ${timestamp(item.lastHeartbeatAt)}`));
  section.append(el("h3", "Why · 投影证据（非完整规则执行轨迹）"), evidenceList(work.evidence, work.key, "projection"), anomalyCards(snapshot.anomalies, work.key));
  return section;
}
