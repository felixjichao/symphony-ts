import type { OperationalSnapshot } from "@symphony/operations";
import type { Observation } from "./polling";
import { destination, destinations } from "./routing";
import { findWork } from "./identity";
import { timestamp } from "./presentation";
import { el } from "./dom";
import { createExplorer } from "./explorer";
import { workDetail } from "./detail";
import { executors as renderExecutors } from "./executors";
import { system as renderSystem, updateTransport } from "./system";
import { overview as renderOverview } from "./overview";
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
  const explorer = createExplorer();
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
      const transport = content.querySelector<HTMLElement>("#system-transport");
      if (transport) updateTransport(transport, state);
      if (!state.snapshot || state.snapshot === current) return;
      const focused = document.activeElement?.id;
      const open = new Set([...main.querySelectorAll("details[open]")].map(d => d.id));
      current = state.snapshot;
      const overview = renderOverview(current);
      const sources = renderSystem(current, state);
      const executors = renderExecutors(current);
      const table = explorer.update(current);
      overview.dataset["page"] = "Overview"; table.dataset["page"] = "Work";
      sources.dataset["page"] = "System"; executors.dataset["page"] = "Executors";
      content.replaceChildren(overview, table, sources, executors);
      for (const details of main.querySelectorAll("details")) if (open.has(details.id)) details.open = true;
      if (focused) document.getElementById(focused)?.focus();
      locate();
      if (focused && document.getElementById(focused) === null) (document.getElementById("detail-heading") ?? heading).focus();
    },
    destroy() { window.removeEventListener("hashchange", navigate); root.replaceChildren(); },
  };
}
