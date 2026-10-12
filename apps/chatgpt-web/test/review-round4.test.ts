import { describe, it, expect } from "vitest";
import { githubDecisionRoot } from "@symphony/domain/decision";
import { ChatGptWebAdapter } from "../src/adapter";
import { isInsideMessageContainer } from "../src/probes";
import { MockDocument, MockElement, MockWindow } from "./mock-dom";

describe("NEST-121: message exclusion during composer loading", () => {
  for (const text of ["Conversation not found", "Welcome back. Log in"]) {
    it(`ignores supported assistant markdown surface containing ${text}`, async () => {
      const doc = new MockDocument();
      const message = new MockElement("div", { "data-markdown-text-style": "assistant-message" });
      const heading = new MockElement("h2");
      heading.textContent = text;
      message.appendChild(heading);
      doc.body.appendChild(message);
      // MockDocument does not aggregate descendant text; supply the real DOM's body.textContent.
      doc.body.textContent = text;
      expect(isInsideMessageContainer(heading as unknown as Element)).toBe(true);
      const win = new MockWindow();
      win.location.href = "https://chatgpt.com/c/healthy";
      const binding = { schemaVersion: 1 as const, adapter: "chatgpt-web", externalSessionRef: "healthy", resumeUri: win.location.href, generation: 1 };
      const session = { schemaVersion: 1 as const, id: "github:owner/repo#1", root: githubDecisionRoot("owner", "repo", 1), status: "active" as const, binding, bindingGeneration: 1, createdAtMs: Date.now(), updatedAtMs: Date.now() };
      const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window, checkIntervalMs: 1, timeoutMs: 100 });
      const timer = setTimeout(() => doc.body.appendChild(new MockElement("textarea", { id: "prompt-textarea" })), 10);
      try {
        await expect(adapter.resumeSession(session, binding)).resolves.toMatchObject({ binding });
      } finally { clearTimeout(timer); }
    });
  }
});
