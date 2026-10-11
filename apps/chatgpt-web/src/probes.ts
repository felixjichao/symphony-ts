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
    "button[aria-label='发送']",
    "button[aria-label='提交']",
    "form button[type='submit']",
  ],
  stopButton: [
    "button[data-testid='stop-button']",
    "button[aria-label='Stop generating']",
    "button[aria-label='Stop streaming']",
    "button[aria-label='停止']",
  ],
  assistantTurn: [
    "article[data-testid^='conversation-turn-'] [data-message-author-role='assistant']",
    "[data-message-author-role='assistant']",
    "article.agent-turn",
    "[data-markdown-text-style='assistant-message']",
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

export function getAllAssistantTurns(doc: Document = document): HTMLElement[] {
  for (const selector of SELECTORS.assistantTurn) {
    const turns = doc.querySelectorAll<HTMLElement>(selector);
    if (turns.length > 0) {
      return Array.from(turns);
    }
  }
  return [];
}

export function countAssistantTurns(doc: Document = document): number {
  return getAllAssistantTurns(doc).length;
}

export function findLatestAssistantTurn(doc: Document = document): HTMLElement | null {
  const turns = getAllAssistantTurns(doc);
  return turns.length > 0 ? (turns[turns.length - 1] ?? null) : null;
}

export interface ExtractedCodeBlock {
  readonly language: string;
  readonly content: string;
}

export function extractCodeBlocksFromTurn(turn: HTMLElement): ExtractedCodeBlock[] {
  const blocks: ExtractedCodeBlock[] = [];
  // Query block containers together to preserve DOM order for last-block fencing.
  const containers = turn.querySelectorAll("pre, [data-markdown-copy='code-block']");
  for (const container of Array.from(containers)) {
    const el = container.querySelector("code");
    if (!el) continue;
    let language = "";
    const className = el.className || "";
    const match = /language-([a-zA-Z0-9_-]+)/.exec(className);
    if (match) {
      language = match[1] ?? "";
    }
    if (!language && container.getAttribute("data-markdown-copy") === "code-block") {
      const header = container.querySelector("[data-markdown-copy='exclude']");
      language = header?.querySelector("div")?.textContent?.trim() ?? "";
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
  readonly baselineCount?: number | undefined;
  readonly baselineTurn?: HTMLElement | null | undefined;
  readonly isCompletionCandidate?: ((turn: HTMLElement) => boolean) | undefined;
  readonly checkIntervalMs?: number | undefined;
  readonly stabilizationMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export async function waitForStreamingCompletion(
  options: WaitForCompletionOptions = {}
): Promise<HTMLElement> {
  const doc = options.doc ?? document;
  const intervalMs = options.checkIntervalMs ?? 500;
  const stabilizationMs = options.stabilizationMs ?? 1500;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const signal = options.signal;
  const baselineCount = options.baselineCount ?? 0;
  const baselineTurn = options.baselineTurn ?? null;

  const start = Date.now();
  let lastText = "";
  let lastChangeAt = Date.now();
  let turnObserved = false;

  while (true) {
    if (signal?.aborted) {
      throw new Error("Aborted while waiting for assistant completion");
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for ChatGPT response after ${timeoutMs}ms`);
    }

    const turns = getAllAssistantTurns(doc);
    const stopButton = findStopButton(doc);

    // Target turn MUST strictly be a newly appeared turn belonging to this send attempt:
    // 1. Total turn count must strictly exceed baselineCount
    // 2. The turn must not match baselineTurn if a baselineTurn was captured
    let targetTurn: HTMLElement | null = null;
    if (turns.length > baselineCount) {
      const candidate = turns[turns.length - 1] ?? null;
      if (candidate && (!baselineTurn || candidate !== baselineTurn)) {
        targetTurn = candidate;
      }
    }

    if (targetTurn) {
      const currentText = targetTurn.textContent || "";
      if (!turnObserved) {
        turnObserved = true;
        lastText = currentText;
        lastChangeAt = Date.now();
      } else if (currentText !== lastText) {
        lastText = currentText;
        lastChangeAt = Date.now();
      }

      // Completion conditions:
      // 1. Stop button is not active (model has finished generating/streaming)
      // 2. We have non-empty assistant text
      // 3. The text has remained stable for at least stabilizationMs
      if (!stopButton && currentText.trim().length > 0 &&
          (!options.isCompletionCandidate || options.isCompletionCandidate(targetTurn))) {
        const stableDuration = Date.now() - lastChangeAt;
        if (stableDuration >= stabilizationMs) {
          return targetTurn;
        }
      }
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
