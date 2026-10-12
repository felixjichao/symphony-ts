/**
 * Centralized DOM selectors and UI probes for ChatGPT Web.
 * Isolates DOM volatility so UI drift is localized.
 */

import { DecisionAdapterError } from "@symphony/domain/decision";

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

    if (detectConversationNotFound(doc)) {
      throw new DecisionAdapterError({
        code: "binding_broken",
        message: "Conversation not found while waiting for ChatGPT response",
        suggestedAction: "rebind",
      });
    }

    if (detectAuthRequired(doc)) {
      throw new DecisionAdapterError({
        code: "human_required",
        message: "Authentication required while waiting for ChatGPT response",
        suggestedAction: "human_intervention",
      });
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

/**
 * Checks whether an element is located inside a chat message container / turn content.
 */
export function isInsideMessageContainer(element: Element | null): boolean {
  if (!element) return false;
  // If browser DOM supports Element.closest:
  if (typeof (element as unknown as { closest?: (s: string) => Element | null }).closest === "function") {
    try {
      const match = (element as unknown as { closest: (s: string) => Element | null }).closest(
        "article, [data-message-author-role], [data-testid^='conversation-turn-'], [role='article'], .agent-turn, [data-markdown-text-style]"
      );
      if (match) return true;
    } catch {
      // Fallback to parentElement traversal
    }
  }

  // Traversal fallback for mock DOM or environments without closest
  let curr: Element | null = element;
  while (curr) {
    const tagName = curr.tagName ? curr.tagName.toLowerCase() : "";
    if (tagName === "article") {
      return true;
    }
    const testId = curr.getAttribute?.("data-testid");
    if (testId && testId.startsWith("conversation-turn-")) {
      return true;
    }
    if (curr.getAttribute?.("data-message-author-role") !== null && curr.getAttribute?.("data-message-author-role") !== undefined) {
      return true;
    }
    if (curr.getAttribute?.("role") === "article") {
      return true;
    }
    if (curr.getAttribute?.("data-markdown-text-style") !== null && curr.getAttribute?.("data-markdown-text-style") !== undefined) {
      return true;
    }
    if (curr.className && typeof curr.className === "string" && curr.className.includes("agent-turn")) {
      return true;
    }
    curr = curr.parentElement;
  }
  return false;
}

export const MESSAGE_CONTAINER_SELECTORS: readonly string[] = [
  "article",
  "[data-message-author-role]",
  "[data-testid^='conversation-turn-']",
  "[role='article']",
  ".agent-turn",
  "[data-markdown-text-style]",
];

/**
 * Checks whether any supported chat message containers / turn surfaces exist in the document.
 */
export function hasMessageContainers(doc: Document = document): boolean {
  if (!doc) return false;
  for (const selector of MESSAGE_CONTAINER_SELECTORS) {
    try {
      if (doc.querySelector && doc.querySelector(selector)) {
        return true;
      }
    } catch {
      // Continue checking next selector
    }
  }
  return false;
}

export function detectAuthRequired(doc: Document = document): boolean {
  if (!doc) return false;

  // 1. Authentic auth/login selectors outside chat messages always take precedence
  const authSelectors = [
    "[data-testid='login-button']",
    "[data-testid='auth-button']",
    "a[href*='/auth/login']",
    "a[href*='/login']",
    "[data-testid='login-container']",
  ];
  for (const selector of authSelectors) {
    const candidates = doc.querySelectorAll ? Array.from(doc.querySelectorAll(selector)) : [];
    for (const el of candidates) {
      if (!isInsideMessageContainer(el)) {
        return true;
      }
    }
  }

  // 2. If composer element is present without auth prompts outside messages, user is authenticated
  if (findComposerElement(doc)) {
    return false;
  }

  // 3. Exclude chat message content / containers from general text matching
  if (hasMessageContainers(doc)) {
    return false;
  }

  // 4. Fallback text scanning
  const text = doc.body?.textContent || "";
  if (
    (text.includes("Log in") || text.includes("Sign up")) &&
    (text.includes("Welcome back") || text.includes("Get started"))
  ) {
    return true;
  }
  return false;
}

export function detectConversationNotFound(doc: Document = document): boolean {
  if (!doc) return false;

  // 1. Explicit authentic error UI elements / testids outside chat messages always indicate conversation failure,
  // even if the page shell retains a disabled/dangling composer element!
  const notFoundSelectors = [
    "[data-testid='conversation-not-found']",
    "[data-testid='error-page']",
    "[data-testid='error-container']",
  ];
  for (const selector of notFoundSelectors) {
    const candidates = doc.querySelectorAll ? Array.from(doc.querySelectorAll(selector)) : [];
    for (const el of candidates) {
      if (!isInsideMessageContainer(el)) {
        return true;
      }
    }
  }

  // 2. Explicit error alerts / headings OUTSIDE message containers
  const alertSelectors = ["[role='alert']", "h1", "h2", "h3"];
  for (const selector of alertSelectors) {
    const candidates = doc.querySelectorAll ? Array.from(doc.querySelectorAll(selector)) : [];
    for (const el of candidates) {
      if (isInsideMessageContainer(el)) {
        continue;
      }
      const alertText = el.textContent || "";
      if (
        alertText.includes("Conversation not found") ||
        alertText.includes("Unable to load conversation") ||
        alertText.includes("This conversation may have been deleted") ||
        alertText.includes("404: Not Found") ||
        alertText.includes("404 - Not Found")
      ) {
        return true;
      }
    }
  }

  // 3. If composer element is present without authentic error UI outside messages, it is a healthy interactive conversation
  if (findComposerElement(doc)) {
    return false;
  }

  // 4. Exclude chat message content / containers from general text matching:
  // Text inside message articles or turn containers is user/assistant prose, not a page error!
  if (hasMessageContainers(doc)) {
    return false;
  }

  // 5. Fallback full-page text matching for minimal error pages
  const text = doc.body?.textContent || "";
  if (
    text.includes("Conversation not found") ||
    text.includes("Unable to load conversation") ||
    text.includes("This conversation may have been deleted") ||
    text.includes("404: Not Found")
  ) {
    return true;
  }
  return false;
}
