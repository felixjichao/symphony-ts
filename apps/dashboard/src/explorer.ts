/** Work Explorer: presentation-only selection over supplied projections. SPEC §13 adjacent, #172. */
import type { OperationalSnapshot, ReviewProjection, WorkProjection } from "@symphony/operations";
import { token } from "./identity";
import { approvalLabels, ordered, timestamp } from "./presentation";
import { el } from "./dom";
import { attentionBadge, denseTable, surface, workIdentity, shaIdentity, freshnessIndicator, presentationState } from "./primitives";

function reviewDetails(work: WorkProjection): HTMLElement {
  const details = el("details"); details.id = `review-${token(work.key)}`;
  const summary = el("summary", "完整 HEAD / 审查标识"); summary.id = `focus-${token(work.key)}`; details.append(summary);
  const review: ReviewProjection | null = work.review;
  const identifiers = { pullRequestHeadSha: work.pullRequest?.headSha ?? null, currentHeadSha: review?.currentHeadSha ?? null, taskTarget: review?.taskTarget ?? null, task: review?.task ?? null, result: review?.result ?? null };
  details.append(shaIdentity("Review task target HEAD", review?.taskTarget?.headSha ?? null), shaIdentity("Review result / approval target HEAD", review?.result?.outcome.kind === "review" ? review.result.outcome.target.headSha : null), shaIdentity("PR HEAD", work.pullRequest?.headSha ?? null), shaIdentity("Review current HEAD", review?.currentHeadSha ?? null), el("pre", JSON.stringify(identifiers, null, 2)));
  return details;
}
function scope(work: WorkProjection): string {
  const repository = work.key.key.match(/^([^/]+\/[^#]+)#\d+$/)?.[1];
  return repository ? `${work.key.provider}:${repository}` : work.key.provider;
}
export function createExplorer(): { update: (snapshot: OperationalSnapshot) => HTMLElement } {
  const section = surface("Work Explorer · attention-first"); section.id = "work"; section.dataset["page"] = "Work";
  const controls = el("div"); controls.className = "explorer-controls";
  const searchLabel = el("label", "搜索身份 / 标题"); searchLabel.className = "control";
  const search = el("input"); search.type = "search"; search.id = "explorer-search"; searchLabel.append(search); controls.append(searchLabel);
  function select(label: string, id: string): HTMLSelectElement {
    const wrapper = el("label", label); wrapper.className = "control"; const input = el("select"); input.id = id; wrapper.append(input); controls.append(wrapper); return input;
  }
  const scopeFilter = select("Provider / repository", "explorer-scope");
  const phase = select("Phase", "explorer-phase"); const attention = select("Attention", "explorer-attention");
  const github = select("GitHub freshness", "explorer-github"); const runtime = select("Runtime freshness", "explorer-runtime"); const decision = select("Decision freshness", "explorer-decision");
  const filters = [scopeFilter, phase, attention, github, runtime, decision];
  const reset = el("button", "重置筛选"); reset.type = "button"; reset.id = "explorer-reset"; controls.append(reset);
  const status = el("p"); status.setAttribute("role", "status");
  const results = el("div"); results.className = "explorer-results"; results.tabIndex = 0; results.setAttribute("aria-label", "工作表格，可横向滚动");
  section.append(controls, status, results);
  let current: OperationalSnapshot | undefined;
  function options(input: HTMLSelectElement, values: readonly string[]): void {
    const selected = input.value; input.replaceChildren();
    for (const choice of ["", ...new Set([...values, ...(selected ? [selected] : [])])].sort((a, b) => a.localeCompare(b))) {
      const option = el("option", choice || "全部"); option.value = choice; input.append(option);
    }
    input.value = selected;
  }
  function render(): void {
    if (!current) return;
    const all = current.work;
    options(scopeFilter, all.flatMap(w => [w.key.provider, scope(w)])); options(phase, all.map((w): string => w.phase)); options(attention, all.map((w): string => w.attention));
    for (const input of [github, runtime, decision]) options(input, ["fresh", "stale", "unknown", "unavailable"]);
    const query = search.value.trim().toLocaleLowerCase();
    const selected = ordered(all).filter(w => (!query || [w.key.provider, w.key.key, w.workItem.identifier, w.workItem.title ?? ""].some(v => v.toLocaleLowerCase().includes(query))) && (!scopeFilter.value || (w.key.provider === scopeFilter.value || scope(w) === scopeFilter.value)) && (!phase.value || w.phase === phase.value) && (!attention.value || w.attention === attention.value) && (!github.value || w.freshness.github.status === github.value) && (!runtime.value || w.freshness.runtime.status === runtime.value) && (!decision.value || w.freshness.decision.status === decision.value));
    status.textContent = `显示 ${selected.length} / ${all.length} 项 · attention-first`;
    results.replaceChildren();
    if (all.length === 0) { results.append(presentationState("empty", "当前快照没有已知工作；请同时检查来源状态。")); return; }
    if (selected.length === 0) { results.append(presentationState("empty", "没有工作匹配当前筛选；可重置筛选。")); return; }
    const table = denseTable("当前工作投影（非历史记录）", ["工作 / Issue", "Phase", "等待原因", "CI", "Review", "Attention", "来源新鲜度"]); const body = el("tbody");
    for (const work of selected) {
      const row = el("tr"); row.id = `work-${token(work.key)}`;
      const identity = el("td"); const link = workIdentity(work.key, work.workItem.identifier); link.id = `link-${token(work.key)}`;
      identity.append(link, el("p", work.workItem.title ?? "未报告标题"));
      if (work.execution !== null) identity.append(el("p", `Execution: ${work.execution.issueId} · attempt ${work.execution.attempt ?? "未知"} · ${work.execution.status ?? "未知"}`));
      if (work.pullRequest !== null) identity.append(el("p", `PR #${work.pullRequest.number} · ${work.pullRequest.state}`), shaIdentity("PR HEAD", work.pullRequest.headSha));
      const reviewCell = el("td", work.review === null ? "未提供审查信号" : approvalLabels[work.review.approval]); reviewCell.append(reviewDetails(work));
      row.append(identity, el("td", work.phase), el("td", work.waiting === null ? "未报告等待" : `${work.waiting.reason} · 自 ${timestamp(work.waiting.since)}`), el("td", work.ci?.status ?? "未提供 CI 信号"), reviewCell);
      const attentionCell = el("td"); attentionCell.append(attentionBadge(work.attention)); row.append(attentionCell);
      const sources = el("td"); sources.append(el("p", "GitHub: "), freshnessIndicator(work.freshness.github), el("p", "Runtime: "), freshnessIndicator(work.freshness.runtime), el("p", "Decision: "), freshnessIndicator(work.freshness.decision)); row.append(sources); body.append(row);
    }
    table.append(body); results.append(table);
  }
  search.addEventListener("input", render); for (const input of filters) input.addEventListener("change", render);
  reset.addEventListener("click", () => { search.value = ""; for (const input of filters) input.value = ""; render(); });
  return { update(snapshot) { current = snapshot; render(); return section; } };
}
