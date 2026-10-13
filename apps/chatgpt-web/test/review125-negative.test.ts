import { it, expect } from "vitest";
import { ChatGptWebAdapter } from "../src/adapter";
import { type DecisionSession } from "@symphony/domain/decision";
import { MockDocument, MockElement, MockWindow } from "./mock-dom";

const session: DecisionSession = { schemaVersion: 1, id: "github:owner/repo#1", root: { provider: "github", key: "owner/repo#1" }, status: "active", binding: null, bindingGeneration: 0, createdAtMs: 1, updatedAtMs: 1 };
function fixture() {
  const doc = new MockDocument();
  const win = new MockWindow();
  win.location.href = "https://chatgpt.com/";
  const composer = new MockElement("textarea", { id: "prompt-textarea" });
  const send = new MockElement("button", { "data-testid": "send-button" });
  doc.body.appendChild(composer); doc.body.appendChild(send);
  const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window, checkIntervalMs: 5, stabilizationMs: 10, timeoutMs: 500 });
  const reply = () => { const msg = new MockElement("div", { "data-message-author-role": "assistant" }); msg.textContent = "Ready for Symphony tasks"; doc.body.appendChild(msg); };
  return { win, send, adapter, reply };
}
it("fails closed if a latched formal conversation departs to a temporary route", async () => {
  const { win, send, adapter, reply } = fixture();
  send.addEventListener("click", () => {
    win.location.href = "https://chatgpt.com/c/6acd96b1-aab4-83e9-8792-5e6937a72afb";
    setTimeout(() => { win.location.href = "https://chatgpt.com/c/local-other"; }, 30);
    setTimeout(() => { win.location.href = "https://chatgpt.com/c/6acd96b1-aab4-83e9-8792-5e6937a72afb"; reply(); }, 80);
  });
  await expect(adapter.createSession(session)).rejects.toMatchObject({ code: "human_required", retryable: false });
});
it("does not authorize a retry after bootstrap completes without a formal reference", async () => {
  const { win, send, adapter, reply } = fixture();
  send.addEventListener("click", () => { win.location.href = "https://chatgpt.com/c/local-chatgpt"; reply(); });
  await expect(adapter.createSession(session)).rejects.toMatchObject({ code: "human_required", retryable: false });
});
