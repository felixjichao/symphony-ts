/**
 * Centralized DOM selectors and UI probes for ChatGPT Web.
 * Isolates DOM volatility so UI drift is localized.
 */

export const SELECTORS = {
  composer: [
    "#prompt-textarea",
    "textarea[data-id='root']",
    "div[contenteditable='true']#prompt-textarea",
    "div[contenteditable='true']",
    "textarea",
  ],
  sendButton: [
    "button[data-testid='send-button']",
    "button[aria-label='Send prompt']",
    "button[aria-label='Send message']",
    "form button[type='submit']",
  ],
  stopButton: [
    "button[data-testid='stop-button']",
    "button[aria-label='Stop generating']",
    "button[aria-label='Stop streaming']",
  ],
  assistantTurn: [
    "article[data-testid^='conversation-turn-'] [data-message-author-role='assistant']",
    "[data-message-author-role='assistant']",
    "article.agent-turn",
  ],
  codeBlock: [
    "pre code.language-symphony-result",
    "pre code.language-json",
    "pre code",
  ],
} as const;

export function findComposerElement(doc: Document = document): HTMLElement | null {
  for (const selector of SELECTORS.composer) {
    const el = doc.querySelector<HTMLElement>(selector);
    if (el) return el;
  }
  return null;
}

export function setComposerText(composer: HTMLElement, text: string): void {
  const isTextArea =
    (typeof HTMLTextAreaElement !== "undefined" && composer instanceof HTMLTextAreaElement) ||
    "value" in composer;

  const createEvent = (type: string, bubbles = true) => {
    if (typeof Event !== "undefined") return new Event(type, { bubbles });
    return { type, bubbles };
  };

  if (isTextArea) {
    (composer as HTMLTextAreaElement).value = text;
    composer.dispatchEvent(createEvent("input") as Event);
    composer.dispatchEvent(createEvent("change") as Event);
  } else {
    composer.textContent = text;
    if (typeof InputEvent !== "undefined") {
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    } else {
      composer.dispatchEvent(createEvent("input") as Event);
    }
    composer.dispatchEvent(createEvent("change") as Event);
  }
}

export function findSendButton(doc: Document = document): HTMLButtonElement | null {
  for (const selector of SELECTORS.sendButton) {
    const btn = doc.querySelector<HTMLButtonElement>(selector);
    if (btn) return btn;
  }
  return null;
}

export function findStopButton(doc: Document = document): HTMLButtonElement | null {
  for (const selector of SELECTORS.stopButton) {
    const btn = doc.querySelector<HTMLButtonElement>(selector);
    if (btn) return btn;
  }
  return null;
}

export function findLatestAssistantTurn(doc: Document = document): HTMLElement | null {
  for (const selector of SELECTORS.assistantTurn) {
    const turns = doc.querySelectorAll<HTMLElement>(selector);
    if (turns.length > 0) {
      return turns[turns.length - 1] ?? null;
    }
  }
  return null;
}

export interface ExtractedCodeBlock {
  readonly language: string;
  readonly content: string;
}

export function extractCodeBlocksFromTurn(turn: HTMLElement): ExtractedCodeBlock[] {
  const blocks: ExtractedCodeBlock[] = [];
  const codeElements = turn.querySelectorAll("pre code");
  for (const el of Array.from(codeElements)) {
    let language = "";
    const className = el.className || "";
    const match = /language-([a-zA-Z0-9_-]+)/.exec(className);
    if (match) {
      language = match[1] ?? "";
    }
    const content = el.textContent || "";
    blocks.push({ language, content });
  }
  return blocks;
}

export function extractConversationIdFromUrl(urlStr: string): string | null {
  try {
    const url = new URL(urlStr, "https://chatgpt.com");
    const match = /\/c\/([a-zA-Z0-9_-]+)/.exec(url.pathname);
    return match ? (match[1] ?? null) : null;
  } catch {
    return null;
  }
}

export function buildConversationUrl(conversationId: string, origin = "https://chatgpt.com"): string {
  const cleanOrigin = origin.replace(/\/+$/, "");
  return `${cleanOrigin}/c/${conversationId}`;
}

export function isChatGPTOrigin(originOrUrl: string): boolean {
  try {
    const url = new URL(originOrUrl, "https://chatgpt.com");
    return (
      url.hostname === "chatgpt.com" ||
      url.hostname === "chat.openai.com" ||
      url.hostname.endsWith(".chatgpt.com")
    );
  } catch {
    return false;
  }
}

export interface WaitForCompletionOptions {
  readonly doc?: Document | undefined;
  readonly checkIntervalMs?: number | undefined;
  readonly stabilizationMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export async function waitForStreamingCompletion(options: WaitForCompletionOptions = {}): Promise<void> {
  const doc = options.doc ?? document;
  const intervalMs = options.checkIntervalMs ?? 500;
  const stabilizationMs = options.stabilizationMs ?? 1500;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const signal = options.signal;

  const start = Date.now();
  let lastText = "";
  let lastChangeAt = Date.now();

  while (true) {
    if (signal?.aborted) {
      throw new Error("Aborted while waiting for assistant completion");
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for ChatGPT response after ${timeoutMs}ms`);
    }

    const stopButton = findStopButton(doc);

    const assistantTurn = findLatestAssistantTurn(doc);
    const currentText = assistantTurn ? assistantTurn.textContent || "" : "";

    if (currentText !== lastText) {
      lastText = currentText;
      lastChangeAt = Date.now();
    }

    // Condition: Stop button is gone AND text has stabilized AND we have some assistant text
    if (!stopButton && currentText.trim().length > 0) {
      const stableDuration = Date.now() - lastChangeAt;
      if (stableDuration >= stabilizationMs) {
        return;
      }
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
