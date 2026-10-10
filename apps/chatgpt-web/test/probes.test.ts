import { describe, expect, it } from "vitest";
import { MockDocument, MockElement } from "./mock-dom";
import {
  findComposerElement,
  setComposerText,
  findSendButton,
  findStopButton,
  findLatestAssistantTurn,
  extractCodeBlocksFromTurn,
  extractConversationIdFromUrl,
  buildConversationUrl,
  waitForStreamingCompletion,
} from "../src/probes";

describe("DOM Probes and URL utilities", () => {
  it("locates prompt composer across selector fallbacks", () => {
    const doc = new MockDocument();
    expect(findComposerElement(doc as unknown as Document)).toBeNull();

    const textarea = new MockElement("textarea", { id: "prompt-textarea" });
    doc.body.appendChild(textarea);

    const found = findComposerElement(doc as unknown as Document);
    expect(found).not.toBeNull();
    expect(found?.getAttribute("id")).toBe("prompt-textarea");
  });

  it("sets composer text and fires events", () => {
    const textarea = new MockElement("textarea");
    let inputFired = false;
    let changeFired = false;
    textarea.addEventListener("input", () => {
      inputFired = true;
    });
    textarea.addEventListener("change", () => {
      changeFired = true;
    });

    setComposerText(textarea as unknown as HTMLTextAreaElement, "Hello Symphony");
    expect(textarea.value).toBe("Hello Symphony");
    expect(inputFired).toBe(true);
    expect(changeFired).toBe(true);
  });

  it("locates send and stop buttons", () => {
    const doc = new MockDocument();
    expect(findSendButton(doc as unknown as Document)).toBeNull();
    expect(findStopButton(doc as unknown as Document)).toBeNull();

    const sendBtn = new MockElement("button", { "data-testid": "send-button" });
    const stopBtn = new MockElement("button", { "data-testid": "stop-button" });
    doc.body.appendChild(sendBtn);
    doc.body.appendChild(stopBtn);

    expect(findSendButton(doc as unknown as Document)).not.toBeNull();
    expect(findStopButton(doc as unknown as Document)).not.toBeNull();
  });

  it("locates Chinese send buttons without test IDs", () => {
    for (const label of ["发送", "提交"]) {
      const doc = new MockDocument();
      const button = new MockElement("button", { "aria-label": label });
      doc.body.appendChild(button);
      expect(findSendButton(doc as unknown as Document)).toBe(button);
    }
  });

  it("locates latest assistant turn and extracts code blocks", () => {
    const doc = new MockDocument();
    const turn1 = new MockElement("article", { "data-testid": "conversation-turn-1" });
    const msg1 = new MockElement("div", { "data-message-author-role": "assistant" });
    msg1.textContent = "Turn 1 content";
    turn1.appendChild(msg1);
    doc.body.appendChild(turn1);

    const turn2 = new MockElement("article", { "data-testid": "conversation-turn-2" });
    const msg2 = new MockElement("div", { "data-message-author-role": "assistant" });
    msg2.textContent = "Turn 2 content";
    const pre = new MockElement("pre");
    const code = new MockElement("code", { class: "language-symphony-result" });
    code.textContent = '{"verdict":"approve"}';
    pre.appendChild(code);
    msg2.appendChild(pre);
    turn2.appendChild(msg2);
    doc.body.appendChild(turn2);

    const latest = findLatestAssistantTurn(doc as unknown as Document);
    expect(latest).not.toBeNull();
    expect(latest?.textContent).toContain("Turn 2 content");

    const blocks = extractCodeBlocksFromTurn(latest as unknown as HTMLElement);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.language).toBe("symphony-result");
    expect(blocks[0]?.content).toBe('{"verdict":"approve"}');
  });

  it("reads current ChatGPT assistant markdown and labeled code surfaces", () => {
    const doc = new MockDocument();
    const turn = new MockElement("div", { "data-markdown-text-style": "assistant-message" });
    const surface = new MockElement("div", { "data-markdown-copy": "code-block" });
    const header = new MockElement("div", { "data-markdown-copy": "exclude" });
    const label = new MockElement("div");
    label.textContent = "symphony-result";
    header.appendChild(label);
    surface.appendChild(header);
    const code = new MockElement("code");
    code.textContent = '{"schemaVersion":1}';
    surface.appendChild(code);
    turn.appendChild(surface);
    doc.body.appendChild(turn);
    const stop = new MockElement("button", { "aria-label": "停止" });
    doc.body.appendChild(stop);
    expect(findLatestAssistantTurn(doc as unknown as Document)).toBe(turn);
    expect(findStopButton(doc as unknown as Document)).toBe(stop);
    expect(extractCodeBlocksFromTurn(turn as unknown as HTMLElement)).toEqual([
      { language: "symphony-result", content: '{"schemaVersion":1}' },
    ]);
  });

  it("extracts mixed pre and data-markdown-copy surfaces strictly in document tree order", () => {
    // 1. surface first, pre second
    const turn1 = new MockElement("div");
    const surface1 = new MockElement("div", { "data-markdown-copy": "code-block" });
    const header1 = new MockElement("div", { "data-markdown-copy": "exclude" });
    const label1 = new MockElement("div");
    label1.textContent = "surface-first";
    header1.appendChild(label1);
    surface1.appendChild(header1);
    const code1 = new MockElement("code");
    code1.textContent = "content-1";
    surface1.appendChild(code1);
    turn1.appendChild(surface1);

    const pre1 = new MockElement("pre");
    const code2 = new MockElement("code", { class: "language-pre-second" });
    code2.textContent = "content-2";
    pre1.appendChild(code2);
    turn1.appendChild(pre1);

    expect(extractCodeBlocksFromTurn(turn1 as unknown as HTMLElement)).toEqual([
      { language: "surface-first", content: "content-1" },
      { language: "pre-second", content: "content-2" },
    ]);

    // 2. pre first, surface second
    const turn2 = new MockElement("div");
    const pre2 = new MockElement("pre");
    const code3 = new MockElement("code", { class: "language-pre-first" });
    code3.textContent = "content-3";
    pre2.appendChild(code3);
    turn2.appendChild(pre2);

    const surface2 = new MockElement("div", { "data-markdown-copy": "code-block" });
    const header2 = new MockElement("div", { "data-markdown-copy": "exclude" });
    const label2 = new MockElement("div");
    label2.textContent = "surface-second";
    header2.appendChild(label2);
    surface2.appendChild(header2);
    const code4 = new MockElement("code");
    code4.textContent = "content-4";
    surface2.appendChild(code4);
    turn2.appendChild(surface2);

    expect(extractCodeBlocksFromTurn(turn2 as unknown as HTMLElement)).toEqual([
      { language: "pre-first", content: "content-3" },
      { language: "surface-second", content: "content-4" },
    ]);
  });

  it("extracts conversation ID from URLs and constructs resume URLs", () => {
    expect(extractConversationIdFromUrl("https://chatgpt.com/c/67123456-abcd-ef01-2345-6789abcdef01")).toBe(
      "67123456-abcd-ef01-2345-6789abcdef01"
    );
    expect(extractConversationIdFromUrl("https://chat.openai.com/c/conv-test-123")).toBe("conv-test-123");
    expect(extractConversationIdFromUrl("https://chatgpt.com/")).toBeNull();
    expect(extractConversationIdFromUrl("invalid-url")).toBeNull();

    expect(buildConversationUrl("conv-123")).toBe("https://chatgpt.com/c/conv-123");
    expect(buildConversationUrl("conv-123", "https://chat.openai.com/")).toBe(
      "https://chat.openai.com/c/conv-123"
    );
  });

  it("waitForStreamingCompletion waits until stop button disappears and text stabilizes", async () => {
    const doc = new MockDocument();
    const stopBtn = new MockElement("button", { "data-testid": "stop-button" });
    const assistantTurn = new MockElement("div", { "data-message-author-role": "assistant" });
    assistantTurn.textContent = "Partial text";
    doc.body.appendChild(stopBtn);
    doc.body.appendChild(assistantTurn);

    setTimeout(() => {
      // Simulate finish
      doc.body.children = doc.body.children.filter((c) => c !== stopBtn);
      assistantTurn.textContent = "Completed text";
    }, 50);

    const result = await waitForStreamingCompletion({
      doc: doc as unknown as Document,
      checkIntervalMs: 20,
      stabilizationMs: 40,
      timeoutMs: 1000,
    });
    expect(result).toBe(assistantTurn);
  });

  it("waitForStreamingCompletion rejects on AbortSignal", async () => {
    const doc = new MockDocument();
    const stopBtn = new MockElement("button", { "data-testid": "stop-button" });
    doc.body.appendChild(stopBtn);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    await expect(
      waitForStreamingCompletion({
        doc: doc as unknown as Document,
        checkIntervalMs: 20,
        stabilizationMs: 40,
        timeoutMs: 1000,
        signal: controller.signal,
      })
    ).rejects.toThrow("Aborted while waiting for assistant completion");
  });

  it("waitForStreamingCompletion strictly requires a new assistant turn and does not accept old turn", async () => {
    const doc = new MockDocument();
    const oldTurn = new MockElement("div", { "data-message-author-role": "assistant" });
    oldTurn.textContent = "Old assistant message from previous turn";
    doc.body.appendChild(oldTurn);

    // 1. With baselineCount: 1 and no new turn, waiter must timeout, never returning old turn
    await expect(
      waitForStreamingCompletion({
        doc: doc as unknown as Document,
        baselineCount: 1,
        baselineTurn: oldTurn as unknown as HTMLElement,
        checkIntervalMs: 10,
        stabilizationMs: 20,
        timeoutMs: 100,
      })
    ).rejects.toThrow("Timeout waiting for ChatGPT response after 100ms");

    // 2. When a new turn appears, waiter returns the new turn
    const newTurn = new MockElement("div", { "data-message-author-role": "assistant" });
    newTurn.textContent = "New assistant response";
    setTimeout(() => {
      doc.body.appendChild(newTurn);
    }, 30);

    const result = await waitForStreamingCompletion({
      doc: doc as unknown as Document,
      baselineCount: 1,
      baselineTurn: oldTurn as unknown as HTMLElement,
      checkIntervalMs: 10,
      stabilizationMs: 20,
      timeoutMs: 500,
    });
    expect(result).toBe(newTurn);
  });
});
