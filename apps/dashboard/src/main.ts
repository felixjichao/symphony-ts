import { mount } from "./view";
import { poll } from "./polling";
import { readSnapshot } from "./transport";
import "./style.css";
const root = document.getElementById("app");
if (root) {
  const view = mount(root);
  const stop = poll(readSnapshot, view.update);
  window.addEventListener("pagehide", () => { stop(); view.destroy(); }, { once: true });
}
