// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { mount } from "../src/view";
import { token } from "../src/identity";
import { snapshot, work } from "./fixtures";
let destroy = () => {};
afterEach(() => { destroy(); document.body.replaceChildren(); window.history.replaceState(null, "", "/"); });
function setup(mode = "demo") {
  const root = document.createElement("div"); document.body.append(root);
  const view = mount(root, mode); destroy = view.destroy;
  return { root, view };
}
function navigate(hash: string) {
  window.history.replaceState(null, "", hash);
  window.dispatchEvent(new Event("hashchange"));
}
it.each(["Overview", "Work", "Executors", "System"])("routes %s with persistent chrome, one active destination and heading focus", name => {
  const { root, view } = setup();
  const nav = root.querySelector("nav");
  view.update({ snapshot: snapshot() });
  navigate(`#${name.toLowerCase()}`);
  expect(root.querySelector("nav")).toBe(nav);
  expect(root.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  expect(root.querySelector('[aria-current="page"]')?.textContent).toBe(name);
  expect(document.activeElement?.id).toBe("page-heading");
  const visible = [...root.querySelectorAll<HTMLElement>("[data-page]")].filter(node => !node.hidden);
  expect(visible.length).toBeGreaterThan(0);
  expect(visible.every(node => node.dataset["page"] === name)).toBe(true);
  root.querySelector<HTMLAnchorElement>('[aria-current="page"]')!.focus();
  view.update({ snapshot: snapshot() });
  expect(document.activeElement?.textContent).toBe(name);
});
it("loads a legacy deep link and keeps Work ownership for invalid and out-of-scope keys", () => {
  window.history.replaceState(null, "", `#${token(work().key)}`);
  const { root, view } = setup("production");
  view.update({ snapshot: snapshot() });
  expect(root.querySelector("#detail-heading")?.textContent).toContain(work().key.key);
  expect(root.querySelector('[aria-current="page"]')?.textContent).toBe("Work");
  expect(root.textContent).toContain("当前生产只读观测");
  expect(root.textContent).not.toContain("演示数据");
  for (const hash of ["#%bad", `#${token({ provider: "github", key: "outside/repo#1" })}`]) {
    navigate(hash);
    expect(root.querySelector("#detail")?.textContent).toBe("");
    expect(root.textContent).toContain("工作标识无效或不在当前 scope");
    expect(document.activeElement?.id).toBe("page-heading");
  }
});
it("supports skip navigation and preserves visible Work diagnostics on polling", () => {
  const { root, view } = setup(); view.update({ snapshot: snapshot() });
  expect(root.textContent).toContain("演示数据 · 只读 · 非生产状态面");
  navigate("#work");
  const raw = root.querySelector<HTMLDetailsElement>("#work details")!;
  raw.open = true; raw.querySelector("summary")!.focus();
  const id = document.activeElement?.id;
  view.update({ snapshot: snapshot() });
  expect(document.activeElement?.id).toBe(id);
  expect(root.querySelector<HTMLDetailsElement>("#work details")?.open).toBe(true);
  root.querySelector<HTMLAnchorElement>(".skip-link")!.click();
  expect(document.activeElement?.id).toBe("page-heading");
  expect(root.querySelectorAll("button,form,input,textarea")).toHaveLength(0);
});


it("uses native hash history for back/forward between destinations and detail", async () => {
  const { root, view } = setup(); view.update({ snapshot: snapshot() });
  window.location.hash = "work";
  await vi.waitFor(() => expect(root.querySelector('[aria-current="page"]')?.textContent).toBe("Work"));
  window.location.hash = token(work().key);
  await vi.waitFor(() => expect(document.activeElement?.id).toBe("detail-heading"));
  window.location.hash = "system";
  await vi.waitFor(() => expect(root.querySelector('[aria-current="page"]')?.textContent).toBe("System"));
  window.history.back();
  await vi.waitFor(() => expect(document.activeElement?.id).toBe("detail-heading"));
  expect(root.querySelector('[aria-current="page"]')?.textContent).toBe("Work");
  window.history.forward();
  await vi.waitFor(() => expect(root.querySelector('[aria-current="page"]')?.textContent).toBe("System"));
  expect(document.activeElement?.id).toBe("page-heading");
});
