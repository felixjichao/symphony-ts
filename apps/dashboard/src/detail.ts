import type { OperationalSnapshot, WorkProjection } from "@symphony/operations";
import { el } from "./dom";
import { scopedSources, globalSources, scopedExecutors } from "./identity";
import { approvalLabels, freshness, timestamp } from "./presentation";
import { evidenceList } from "./evidence";
import { anomalyCards } from "./anomaly";

type Value = string | number | boolean | null | undefined;
function rows(values: readonly (readonly [string, Value])[]): HTMLElement {
  const list = el("dl");
  for (const [label, value] of values) list.append(el("dt", label), el("dd", value == null ? "未提供" : String(value)));
  return list;
}
function card(title: string, values: readonly (readonly [string, Value])[]): HTMLElement {
  const node = el("div"); node.className = "detail-card"; node.append(el("h4", title), rows(values)); return node;
}
function sourceLink(url: string | null, label: string): HTMLElement {
  try {
    const parsed = new URL(url ?? "");
    if (parsed.protocol === "https:" || parsed.protocol === "http:") { const link = el("a", label); link.href = parsed.href; return link; }
  } catch { /* Missing or invalid source URL. */ }
  return el("span", `${label}：未提供`);
}
export function workDetail(work: WorkProjection, snapshot: OperationalSnapshot): HTMLElement {
  const section = el("section"); section.setAttribute("aria-labelledby", "detail-heading");
  const heading = el("h2", `Work Detail · ${work.key.provider}:${work.key.key}`); heading.id = "detail-heading"; heading.tabIndex = -1;
  section.append(heading, el("p", `${work.workItem.identifier} · ${work.workItem.title ?? "未报告标题"}`), sourceLink(work.workItem.url, "Issue 来源"));
  const conclusion = el("div"); conclusion.className = "detail-conclusion";
  conclusion.append(el("h3", "当前结论 · Derived state"), el("p", `phase: ${work.phase} · attention: ${work.attention}`), el("p", work.waiting === null ? "未报告等待" : `waiting: ${work.waiting.reason} · 自 ${timestamp(work.waiting.since)}`), el("p", work.review === null ? "未提供审查信号" : approvalLabels[work.review.approval]), rows([["Planning session", work.planning?.sessionStatus], ["Planning task", work.planning?.taskStatus], ["Plan verdict", work.planning?.planVerdict]]));
  section.append(conclusion, el("h3", "当前执行 / PR / Review 标识"), el("p", "以下为当前快照所载事实；可信程度请结合来源新鲜度与 evidence role。结果事实 verdict 不代表当前 HEAD 获批。"));
  const execution = work.execution, pr = work.pullRequest, review = work.review;
  const task = review?.task, result = review?.result;
  const taskTarget = task?.kind === "review" ? task.target : null;
  const resultTarget = result?.outcome.kind === "review" ? result.outcome.target : null;
  const grid = el("div"); grid.className = "detail-grid";
  grid.append(card("Execution", [["Issue ID", execution?.issueId], ["Attempt", execution?.attempt], ["Status", execution?.status], ["Workspace", execution?.workspacePath], ["Started", timestamp(execution?.startedAtMs)], ["Retry in (ms)", execution?.retryInMs]]));
  const prCard = card("Pull request / CI", [["PR number", pr?.number], ["PR state", pr?.state], ["Draft", pr?.isDraft], ["Mergeability", pr?.mergeable], ["当前 PR HEAD", pr?.headSha], ["CI state", work.ci?.status]]);
  prCard.append(sourceLink(pr?.url ?? null, "PR 来源")); grid.append(prCard);
  grid.append(card("Review identities", [["Approval state", review?.approval], ["投影 currentHeadSha", review?.currentHeadSha], ["投影 taskTarget（可能来自 result fallback）", review?.taskTarget != null ? `${review.taskTarget.repository} #${review.taskTarget.prNumber} · ${review.taskTarget.headSha}` : null], ["ReviewTask identity / revision", task != null ? `${task.taskId} / ${task.revision}` : null], ["ReviewTask status / kind", task != null ? `${task.status} / ${task.kind}` : null], ["ReviewTask target HEAD", taskTarget?.headSha], ["ReviewTask target repository / PR", taskTarget != null ? `${taskTarget.repository} #${taskTarget.prNumber}` : null], ["Result task identity / revision", result != null ? `${result.taskId} / ${result.revision}` : null], ["结果事实 verdict", result?.outcome.verdict], ["结果 / approval target HEAD", resultTarget?.headSha], ["Result target repository / PR", resultTarget != null ? `${resultTarget.repository} #${resultTarget.prNumber}` : null]]));
  section.append(grid, el("h3", "来源新鲜度 · Work"));
  for (const [label, value] of Object.entries(work.freshness)) section.append(el("p", `${label}: ${freshness(value)}`));
  const sources = scopedSources(snapshot.sources, work.key);
  if (!sources.length) section.append(el("p", "未提供 Work 专属来源状态"));
  for (const source of sources) section.append(el("p", `${source.source} / ${source.instance}: ${freshness(source.freshness)}`));
  section.append(el("h4", "全局来源（非 Work 独有 freshness）"));
  const global = globalSources(snapshot.sources);
  if (!global.length) section.append(el("p", "未提供全局来源状态"));
  for (const source of global) section.append(el("p", `${source.source} / ${source.instance}: ${freshness(source.freshness)}`));
  section.append(el("h3", "关联 Executor · 按完整 WorkKey"));
  const executors = scopedExecutors(snapshot.executors, work.key);
  if (!executors.length) section.append(el("p", "未报告关联 Executor"));
  for (const item of executors) section.append(card(item.id, [["Role", item.role], ["Adapter", item.adapter], ["Status", item.status], ["Host", item.host], ["Heartbeat", timestamp(item.lastHeartbeatAt)]]));
  section.append(el("h3", "Why · 投影证据（非完整规则执行轨迹）"), evidenceList(work.evidence, work.key, "projection"), anomalyCards(snapshot.anomalies, work.key));
  return section;
}
