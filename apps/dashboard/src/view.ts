import type { OperationalSnapshot, ReviewProjection, WorkProjection } from "@symphony/operations";
import type { Observation } from "./polling";
import { destination, destinations } from "./routing";
import { findWork, token } from "./identity";
import { approvalLabels, freshness, ordered, timestamp } from "./presentation";
import { el } from "./dom";
import { attentionBadge, denseTable, surface, workIdentity, shaIdentity, freshnessIndicator, presentationState } from "./primitives";
import { workDetail } from "./detail";
import { anomalyCards } from "./anomaly";
function reviewDetails(work: WorkProjection): HTMLElement {
  const details = el("details");
  details.id = `review-${token(work.key)}`;
  const summary = el("summary", "完整 HEAD / 审查标识");
  summary.id = `focus-${token(work.key)}`;
  details.append(summary);
  const review: ReviewProjection | null = work.review;
  const identifiers = {
    pullRequestHeadSha: work.pullRequest?.headSha ?? null,
    currentHeadSha: review?.currentHeadSha ?? null,
    taskTarget: review?.taskTarget ?? null,
    task: review?.task == null ? null : { taskId: review.task.taskId, revision: review.task.revision, target: review.task.kind === "review" ? review.task.target : null },
    result: review?.result == null ? null : { taskId: review.result.taskId, revision: review.result.revision, target: review.result.outcome.kind === "review" ? review.result.outcome.target : null },
  };
  details.append(shaIdentity("Review task target HEAD", review?.task?.kind === "review" ? review.task.target.headSha : null), shaIdentity("Review result / approval target HEAD", review?.result?.outcome.kind === "review" ? review.result.outcome.target.headSha : null), shaIdentity("PR HEAD", work.pullRequest?.headSha ?? null), shaIdentity("Review current HEAD", review?.currentHeadSha ?? null), el("pre", JSON.stringify(identifiers, null, 2)));
  return details;
}
function workTable(snapshot: OperationalSnapshot): HTMLElement {
  const section = surface("Work list · attention-first"); section.id = "work";
  if (snapshot.work.length === 0) section.append(presentationState("empty", "当前快照没有已知工作；请同时检查来源状态。"));
  const table = denseTable("当前工作投影（非历史记录）", ["工作 / Issue", "Phase", "等待原因", "CI", "Review", "Attention", "来源新鲜度"]);
  const body = el("tbody");
  for (const work of ordered(snapshot.work)) {
    const row = el("tr"); row.id = `work-${token(work.key)}`;
    const identity = el("td"); const link = workIdentity(work.key, work.workItem.identifier);
    link.href = `#${token(work.key)}`; link.id = `link-${token(work.key)}`;
    identity.append(link, el("p", work.workItem.title ?? "未报告标题"));
    const reviewCell = el("td", work.review === null ? "未提供审查信号" : approvalLabels[work.review.approval]);
    reviewCell.append(reviewDetails(work));
    row.append(identity, el("td", work.phase), el("td", work.waiting === null ? "未报告等待" : `${work.waiting.reason} · 自 ${timestamp(work.waiting.since)}`), el("td", work.ci?.status ?? "未提供 CI 信号"), reviewCell);
    const attentionCell = el("td"); attentionCell.append(attentionBadge(work.attention)); row.append(attentionCell);
    const sources = el("td");
    sources.append(el("p", "GitHub: "), freshnessIndicator(work.freshness.github), el("p", "Runtime: "), freshnessIndicator(work.freshness.runtime), el("p", "Decision: "), freshnessIndicator(work.freshness.decision));
    row.append(sources); body.append(row);
  }
  table.append(body); section.append(table); return section;
}
export function mount(root: HTMLElement, mode: string = "demo"): { update: (state: Observation) => void; destroy: () => void } {
  const header = el("header"); header.append(el("p", "SYMPHONY / OBSERVATION PLANE"), el("h1", "Operator Console"), el("strong", mode === "production" ? "当前生产只读观测 · 显式 WorkKey scope（非全局清单）" : "演示数据 · 只读 · 非生产状态面"));
  const nav = el("nav"); nav.setAttribute("aria-label", "主导航");
  const links = destinations.map(name => {
    const link = el("a", name); link.href = `#${name.toLowerCase()}`; link.id = `nav-${name.toLowerCase()}`;
    nav.append(link); return link;
  });
  header.append(nav);
  const skip = el("a", "跳至当前页面"); skip.href = "#page-heading"; skip.className = "skip-link";
  skip.addEventListener("click", event => { event.preventDefault(); (document.getElementById("detail-heading") ?? document.getElementById("page-heading"))?.focus(); });
  const notice = el("p", "加载快照…"); notice.setAttribute("role", "status");
  const route = el("p"); route.setAttribute("role", "status");
  const main = el("main");
  const heading = el("h2"); heading.id = "page-heading"; heading.tabIndex = -1;
  const content = el("div"); main.append(heading, content);
  const detail = el("section"); detail.id = "detail";
  main.append(detail);
  root.replaceChildren(skip, header, notice, route, main);
  let current: OperationalSnapshot | undefined;
  const locate = (focus = false) => {
    const opened = new Set([...detail.querySelectorAll("details[open]")].map(d => d.id));
    const focused = document.activeElement?.id;
    detail.replaceChildren();
    const hash = window.location.hash;
    const page = destination(hash);
    heading.textContent = page;
    for (const link of links) {
      if (link.textContent === page) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    for (const panel of content.querySelectorAll<HTMLElement>(":scope > *")) {
      panel.hidden = panel.dataset["page"] !== page || (page === "Work" && hash !== "#work");
    }
    if (focus) heading.focus();
    if (!hash || hash === "#overview" || hash === "#work" || hash === "#executors" || hash === "#system") {
      route.textContent = "";
      if (!focus && focused && document.getElementById(focused) === null) heading.focus();
      return;
    }
    const work = current && findWork(current.work, hash);
    route.textContent = work ? `已定位 ${work.key.provider}:${work.key.key}` : "工作标识无效或不在当前 scope";
    if (!focus && !work && focused && detail.id !== focused && document.getElementById(focused) === null) heading.focus();
    if (work && current) {
      detail.append(workDetail(work, current));
      for (const item of detail.querySelectorAll("details")) if (opened.has(item.id)) item.open = true;
      if (focus) document.getElementById("detail-heading")?.focus();
      else if (focused) document.getElementById(focused)?.focus();
    }
  };
  const navigate = () => locate(true);
  window.addEventListener("hashchange", navigate);
  locate();
  return {
    update(state) {
      notice.textContent = state.error ? `${state.snapshot ? "刷新失败，显示上次成功快照" : "尚未取得快照"} · ${state.error} · 上次成功响应 ${timestamp(state.receivedAt)}` : state.snapshot ? `已收到当前快照 · 响应时间 ${timestamp(state.receivedAt)}` : "加载快照…";
      if (!state.snapshot || state.snapshot === current) return;
      const focused = document.activeElement?.id;
      const open = new Set([...main.querySelectorAll("details[open]")].map(d => d.id));
      current = state.snapshot;
      const overview = el("section"); overview.id = "overview";
      overview.append(el("h2", "Overview"), el("p", `系统健康: ${current.health} · 快照生成 ${timestamp(current.generatedAt)}`));
      const counts = el("dl");
      for (const [label, value] of [["活动工作", current.summary.active], ["等待", current.summary.waiting], ["需要人工", current.summary.needsHuman], ["重试等待", current.summary.retrying], ["降级工作", current.summary.degradedWork], ["异常条目", current.summary.anomalyCount]] as const) counts.append(el("dt", label), el("dd", value === undefined ? "该版本未提供" : String(value)));
      overview.append(counts);
      const sources = el("section"); sources.append(el("h2", "来源新鲜度"), el("p", `系统健康: ${current.health} · 快照生成 ${timestamp(current.generatedAt)}`));
      for (const source of current.sources) sources.append(el("p", `${source.source} / ${source.instance} ${source.workKey ? `${source.workKey.provider}:${source.workKey.key}` : ""} · ${freshness(source.freshness)}`));
      const executors = el("section"); executors.append(el("h2", "Executor inventory"));
      // Empty inventory is only called observed-empty when an executor source says fresh.
      if (current.executors.length === 0) executors.append(el("p", "当前快照清单为空；是否已观测、未配置或不可用请见下方 executor 来源状态。"));
      for (const source of current.sources.filter(s => s.source === "executor")) executors.append(el("p", `Executor 来源: ${freshness(source.freshness)}`));
      for (const executor of current.executors) {
        const item = el("p", `${executor.id} · ${executor.role ?? "未报告角色"} · ${executor.adapter} · ${executor.status} · 心跳 ${timestamp(executor.lastHeartbeatAt)}`);
        if (executor.currentWork !== null) { const link = el("a", `${executor.currentWork.provider}:${executor.currentWork.key}`); link.href = `#${token(executor.currentWork)}`; item.append(" · ", link); }
        executors.append(item);
      }
      const table = workTable(current);
      const cards = anomalyCards(current.anomalies, null);
      overview.dataset["page"] = "Overview"; table.dataset["page"] = "Work";
      sources.dataset["page"] = "System"; executors.dataset["page"] = "Executors"; cards.dataset["page"] = "System";
      const overviewWork = el("a", "查看 Work"); overviewWork.href = "#work"; overview.append(overviewWork);
      content.replaceChildren(overview, table, sources, executors, cards);
      for (const details of main.querySelectorAll("details")) if (open.has(details.id)) details.open = true;
      if (focused) document.getElementById(focused)?.focus();
      locate();
      if (focused && document.getElementById(focused) === null) (document.getElementById("detail-heading") ?? heading).focus();
    },
    destroy() { window.removeEventListener("hashchange", navigate); root.replaceChildren(); },
  };
}
