import { describe, expect, it } from "vitest";
import type { DecisionExecutionRequest, DecisionReviewTask } from "@symphony/domain/decision";
import { ChatGptWebAdapter } from "../src/adapter";
import { MockDocument, MockElement, MockWindow } from "./mock-dom";

const target = { repository: "owner/repo", prNumber: 144, headSha: "a".repeat(40) };
const task: DecisionReviewTask = {
  schemaVersion: 1, id: `github%3Aowner%2Frepo%23137:review:2:owner%2Frepo:144:${target.headSha}`,
  sessionId: "github:owner/repo#137", kind: "review", revision: 2, target,
  status: "running", lease: { owner: "driver", token: "test-only", generation: 1, expiresAtMs: 10_000 },
  claimGeneration: 1, lastClaimToken: "test-only", createdAtMs: 1000, updatedAtMs: 1000,
};
const result = {
  schemaVersion: 1, taskId: task.id, sessionId: task.sessionId, revision: 2,
  createdAtMs: 2000, kind: "review", target, verdict: "changes_requested", findings: [],
};
function modernTurn(value: unknown): MockElement {
  const turn = new MockElement("div", { "data-markdown-text-style": "assistant-message" });
  const block = new MockElement("div", { "data-markdown-copy": "code-block" });
  const header = new MockElement("div", { "data-markdown-copy": "exclude" });
  const label = new MockElement("div");
  label.textContent = "symphony-result";
  header.appendChild(label);
  block.appendChild(header);
  const code = new MockElement("code", { class: "whitespace-pre! block text-size-code" });
  code.textContent = JSON.stringify(value);
  block.appendChild(code);
  turn.appendChild(block);
  // Mock DOM does not aggregate child textContent as browsers do.
  turn.textContent = `symphony-result\n${code.textContent}`;
  return turn;
}
function fixture(onResponseWaitState?: import("../src/adapter").ChatGptWebAdapterOptions["onResponseWaitState"]) {
  const doc = new MockDocument();
  const win = new MockWindow();
  win.location.href = "https://chatgpt.com/c/conv";
  const composer = new MockElement("textarea", { id: "prompt-textarea" });
  const send = new MockElement("button", { "data-testid": "send-button" });
  doc.body.appendChild(composer);
  doc.body.appendChild(send);
  const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window,
    responseTimeoutMs: 120, stabilizationMs: 10, checkIntervalMs: 5, onResponseWaitState });
  const request: DecisionExecutionRequest = { task, session: {
    schemaVersion: 1, id: task.sessionId, root: { provider: "github", key: "owner/repo#137" }, status: "active",
    binding: { schemaVersion: 1, adapter: "chatgpt-web", externalSessionRef: "conv", resumeUri: win.location.href, generation: 1 },
    bindingGeneration: 1, createdAtMs: 1000, updatedAtMs: 1000,
  }, context: { strategy: "materialized", workItem: { provider: "github", key: "owner/repo#137" }, repository: "owner/repo",
    issue: { repository: "owner/repo", number: 137, title: "HTTP transport", body: "Review" }, plan: null,
    pullRequest: null, diff: null, ci: null, repositoryInstructions: null, previousReviews: [], unresolvedFindings: [],
  } };
  return { doc, send, adapter, request };
}

describe("task-bound response completion under DOM windowing", () => {
  it("extracts the expected review when older messages leave the DOM during execution", async () => {
    const { doc, send, adapter, request } = fixture();
    const previous = [modernTurn({ ...result, revision: 1 }), modernTurn({ ...result, revision: 1 })];
    previous.forEach(turn => doc.body.appendChild(turn));
    send.addEventListener("click", () => {
      previous.forEach(turn => doc.body.removeChild(turn));
      doc.body.appendChild(modernTurn(result));
    });
    await expect(adapter.executeTask(request)).resolves.toMatchObject({ result });
  });

  it("confirms Send from a strictly matching result after DOM windowing and Stop disappears", () => {
    const { doc, adapter } = fixture();
    doc.body.appendChild(modernTurn(result));
    expect(adapter.isPromptConfirmedSent(undefined, 20, task)).toBe(true);
  });

  it.each([
    { ...result, taskId: "another-task" },
    { ...result, revision: 1 },
    { ...result, target: { ...target, headSha: "b".repeat(40) } },
    { ...result, extra: "invalid schema" },
  ])("does not confirm Send from an unrelated or invalid result: %j", candidate => {
    const { doc, adapter } = fixture();
    doc.body.appendChild(modernTurn(candidate));
    expect(adapter.isPromptConfirmedSent(undefined, 20, task)).toBe(false);
  });

  it("recovers the exact task result when the persisted baseline exceeds current DOM count", async () => {
    const { doc, adapter } = fixture();
    doc.body.appendChild(modernTurn(result));
    await expect(adapter.waitForExistingResponse(task, { baselineCount: 4 })).resolves.toMatchObject({ result });
  });
  it("does not let a legacy message selector hide a new modern result", async () => {
    const { doc, send, adapter, request } = fixture();
    const old = new MockElement("div", { "data-message-author-role": "assistant" });
    old.textContent = "Previous response";
    doc.body.appendChild(old);
    send.addEventListener("click", () => doc.body.appendChild(modernTurn(result)));
    await expect(adapter.executeTask(request)).resolves.toMatchObject({ result });
  });

  it("recognizes an exact task result after the current message node is reused", async () => {
    const { doc, send, adapter, request } = fixture();
    const old = modernTurn({ ...result, revision: 1 });
    doc.body.appendChild(old);
    send.addEventListener("click", () => {
      const next = modernTurn(result);
      old.children = next.children;
      old.textContent = next.textContent;
    });
    await expect(adapter.executeTask(request)).resolves.toMatchObject({ result });
  });

  it.each([
    { ...result, revision: 1 },
    { ...result, taskId: "another-task" },
    { ...result, target: { ...target, headSha: "b".repeat(40) } },
    { ...result, extra: true },
  ])("never bypasses count fencing for an invalid or stale envelope %#", async value => {
    const { doc, adapter } = fixture();
    doc.body.appendChild(modernTurn(value));
    await expect(adapter.waitForExistingResponse(task, { baselineCount: 4 })).rejects.toThrow("Timeout waiting");
  });

  it("does not accept an unchanged exact-task result present before sending", async () => {
    const { doc, send, adapter, request } = fixture();
    const old = modernTurn(result);
    doc.body.appendChild(old);
    send.addEventListener("click", () => {
      doc.body.removeChild(old);
      doc.body.appendChild(modernTurn(result));
    });
    await expect(adapter.executeTask(request)).rejects.toThrow("Timeout waiting");
  });

  it("keeps waiting for generation to stop even with a valid task result", async () => {
    const { doc, adapter } = fixture();
    const stop = new MockElement("button", { "data-testid": "stop-button" });
    doc.body.appendChild(stop);
    doc.body.appendChild(modernTurn(result));
    await expect(adapter.waitForExistingResponse(task, { baselineCount: 4 })).rejects.toThrow("generating");
  });

  it("preserves the wait blocker and emits timeout diagnostics without response content", async () => {
    const states: Array<import("../src/probes").ResponseWaitState> = [];
    const { adapter } = fixture(state => states.push(state));
    await expect(adapter.waitForExistingResponse(task, { baselineCount: 4 })).rejects.toMatchObject({
      code: "execution_failed", retryable: false, details: { rawDetails: { reason: "timeout" } },
    });
    expect(states.map(state => state.phase)).toEqual(["waiting", "timeout"]);
    expect(states.at(-1)).toMatchObject({ reason: "no_new_turn", baselineCount: 4, currentCount: 0 });
  });

  it("rejects a reordered pre-send result when a rerender does not grow the count", async () => {
    const { doc, send, adapter, request } = fixture();
    const old = modernTurn(result);
    doc.body.appendChild(old);
    send.addEventListener("click", () => {
      doc.body.removeChild(old);
      doc.body.appendChild(modernTurn(Object.fromEntries(Object.entries(result).reverse())));
    });
    await expect(adapter.executeTask(request)).rejects.toThrow("no_new_turn");
  });

});
