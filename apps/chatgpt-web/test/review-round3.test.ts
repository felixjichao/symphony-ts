import { describe, it, expect } from "vitest";
import { githubDecisionRoot } from "@symphony/domain/decision";
import { ChatGptWebAdapter } from "../src/adapter";
import { MockDocument, MockElement, MockWindow } from "./mock-dom";

describe("NEST-121 third review: chat content is not error UI", () => {
  for (const kind of ["heading", "login link"] as const) {
    it(`resumes healthy conversation containing an assistant ${kind}`, async () => {
      const doc = new MockDocument();
      doc.body.appendChild(new MockElement("textarea", { id: "prompt-textarea" }));
      const article = new MockElement("article", { "data-testid": "conversation-turn-1" });
      const message = new MockElement("div", { "data-message-author-role": "assistant" });
      const content = kind === "heading"
        ? new MockElement("h2")
        : new MockElement("a", { href: "https://example.com/login" });
      content.textContent = kind === "heading" ? "Conversation not found" : "Login documentation";
      message.appendChild(content);
      article.appendChild(message);
      doc.body.appendChild(article);
      const win = new MockWindow();
      win.location.href = "https://chatgpt.com/c/healthy";
      const binding = { schemaVersion: 1 as const, adapter: "chatgpt-web", externalSessionRef: "healthy", resumeUri: win.location.href, generation: 1 };
      const session = { schemaVersion: 1 as const, id: "github:owner/repo#1", root: githubDecisionRoot("owner", "repo", 1), status: "active" as const, binding, bindingGeneration: 1, createdAtMs: Date.now(), updatedAtMs: Date.now() };
      const adapter = new ChatGptWebAdapter({ doc: doc as unknown as Document, win: win as unknown as Window });
      await expect(adapter.resumeSession(session, binding)).resolves.toMatchObject({ binding });
    });
  }
});
