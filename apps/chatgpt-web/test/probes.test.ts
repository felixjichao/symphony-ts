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
});
