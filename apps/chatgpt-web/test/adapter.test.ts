import { describe, it, expect } from "vitest";
import { ChatGptWebAdapter } from "../src/adapter";
import type {
  DecisionSession,
  DecisionPlanTask,
  DecisionExecutionRequest,
} from "@symphony/domain/decision";
import { MockDocument, MockElement, MockWindow } from "./mock-dom";

describe("ChatGptWebAdapter", () => {
  const baseSession: DecisionSession = {
    schemaVersion: 1,
    id: "github:owner/repo#1",
    root: { provider: "github", key: "owner/repo#1" },
    status: "active",
    binding: null,
    bindingGeneration: 0,
    createdAtMs: 1000,
    updatedAtMs: 1000,
  };

  it("inspects bindings and reports none, unusable, or usable", async () => {
    const adapter = new ChatGptWebAdapter();

    // 1. none
    const inspectNone = await adapter.inspectBinding(baseSession);
    expect(inspectNone.status).toBe("none");

    // 2. unusable: wrong adapter
    const sessionWrongAdapter: DecisionSession = {
      ...baseSession,
      binding: {
        schemaVersion: 1,
        adapter: "claude-web",
        externalSessionRef: "conv-1",
        resumeUri: "https://claude.ai/chat/1",
        generation: 1,
      },
      bindingGeneration: 1,
    };
    const inspectWrong = await adapter.inspectBinding(sessionWrongAdapter);
    expect(inspectWrong.status).toBe("unusable");
    if (inspectWrong.status === "unusable") {
      expect(inspectWrong.needsRebind).toBe(true);
    }

    // 3. usable
    const sessionUsable: DecisionSession = {
      ...baseSession,
      binding: {
        schemaVersion: 1,
        adapter: "chatgpt-web",
        externalSessionRef: "67123456-abcd-ef01-2345-6789abcdef01",
        resumeUri: "https://chatgpt.com/c/67123456-abcd-ef01-2345-6789abcdef01",
        generation: 1,
      },
      bindingGeneration: 1,
    };
    const inspectUsable = await adapter.inspectBinding(sessionUsable);
    expect(inspectUsable.status).toBe("usable");
  });

  it("creates session, executes bootstrap, and returns new binding", async () => {
    const doc = new MockDocument();
    const win = new MockWindow();
    win.location.href = "https://chatgpt.com";

    const composer = new MockElement("textarea", { id: "prompt-textarea" });
    const sendBtn = new MockElement("button", { "data-testid": "send-button" });
    doc.body.appendChild(composer);
    doc.body.appendChild(sendBtn);

    sendBtn.addEventListener("click", () => {
      // Simulate response turn and URL update
      win.location.href = "https://chatgpt.com/c/new-conv-uuid-1234";
      const turn = new MockElement("article", { "data-testid": "conversation-turn-2" });
      const msg = new MockElement("div", { "data-message-author-role": "assistant" });
      msg.textContent = "I am ready to review plans and PRs.";
      turn.appendChild(msg);
      doc.body.appendChild(turn);
    });

    const adapter = new ChatGptWebAdapter({
      doc: doc as unknown as Document,
      win: win as unknown as Window,
      checkIntervalMs: 10,
      stabilizationMs: 20,
    });

    const created = await adapter.createSession(baseSession);
    expect(created.binding.adapter).toBe("chatgpt-web");
    expect(created.binding.externalSessionRef).toBe("new-conv-uuid-1234");
    expect(created.binding.generation).toBe(1);
    expect((created.handle as { conversationId?: string })?.conversationId).toBe("new-conv-uuid-1234");
  });

  it("waits for an asynchronously rendered send button after composer input", async () => {
    const doc = new MockDocument();
    const win = new MockWindow();
    win.location.href = "https://chatgpt.com";

    const composer = new MockElement("textarea", { id: "prompt-textarea" });
    const sendBtn = new MockElement("button", { "data-testid": "send-button" });
    doc.body.appendChild(composer);
    composer.addEventListener("input", () => {
      setTimeout(() => doc.body.appendChild(sendBtn), 20);
    });

    sendBtn.addEventListener("click", () => {
      // Simulate response turn and URL update
      win.location.href = "https://chatgpt.com/c/new-conv-uuid-1234";
      const turn = new MockElement("article", { "data-testid": "conversation-turn-2" });
      const msg = new MockElement("div", { "data-message-author-role": "assistant" });
      msg.textContent = "I am ready to review plans and PRs.";
      turn.appendChild(msg);
      doc.body.appendChild(turn);
    });

    const adapter = new ChatGptWebAdapter({
      doc: doc as unknown as Document,
      win: win as unknown as Window,
      checkIntervalMs: 10,
      stabilizationMs: 20,
      timeoutMs: 500,
    });

    const created = await adapter.createSession(baseSession);
    expect(created.binding.adapter).toBe("chatgpt-web");
    expect(created.binding.externalSessionRef).toBe("new-conv-uuid-1234");
    expect(created.binding.generation).toBe(1);
    expect((created.handle as { conversationId?: string })?.conversationId).toBe("new-conv-uuid-1234");
  });

  it("resumes session and updates window location if needed", async () => {
    const doc = new MockDocument();
    const win = new MockWindow();
    win.location.href = "https://chatgpt.com";

    const composer = new MockElement("textarea", { id: "prompt-textarea" });
    doc.body.appendChild(composer);

    const adapter = new ChatGptWebAdapter({
      doc: doc as unknown as Document,
      win: win as unknown as Window,
      checkIntervalMs: 10,
      timeoutMs: 500,
    });

    const binding = {
      schemaVersion: 1 as const,
      adapter: "chatgpt-web",
      externalSessionRef: "target-conv-id",
      resumeUri: "https://chatgpt.com/c/target-conv-id",
      generation: 1,
    };

    const resumed = await adapter.resumeSession(baseSession, binding);
    expect(resumed.binding).toEqual(binding);
    expect((resumed.handle as { conversationId?: string })?.conversationId).toBe("target-conv-id");
    expect(win.location.href).toBe("https://chatgpt.com/c/target-conv-id");
  });

  it("recovery ignores stable intermediate prose until the result turn arrives", async () => {
    const doc = new MockDocument();
    const intermediate = new MockElement("div", { "data-markdown-text-style": "assistant-message" });
    intermediate.textContent = "I will inspect the repository before planning.";
    doc.body.appendChild(intermediate);
    const task: DecisionPlanTask = {
      schemaVersion: 1, id: "github%3Aowner%2Frepo%231:plan:1", sessionId: baseSession.id, kind: "plan",
      revision: 1, status: "pending", lease: null, claimGeneration: 0,
      lastClaimToken: null, createdAtMs: 1000, updatedAtMs: 1000,
    };
    const finalTurn = new MockElement("div", { "data-markdown-text-style": "assistant-message" });
    const pre = new MockElement("pre");
    const code = new MockElement("code", { class: "language-symphony-result" });
    code.textContent = JSON.stringify({
      schemaVersion: 1, taskId: task.id, sessionId: task.sessionId, revision: 1,
      kind: "plan", verdict: "ready", createdAtMs: 1000,
      content: { plan: "Verified plan", acceptanceCriteria: ["Pass"], risks: [], clarifications: [] },
    });
    pre.appendChild(code);
    finalTurn.appendChild(pre);
    finalTurn.textContent = code.textContent;
    const timer = setTimeout(() => doc.body.appendChild(finalTurn), 70);
    const adapter = new ChatGptWebAdapter({
      doc: doc as unknown as Document, checkIntervalMs: 5, stabilizationMs: 10, timeoutMs: 500,
    });
    try {
      const outcome = await adapter.waitForExistingResponse(task, { baselineCount: 0 });
      expect(outcome.result.verdict).toBe("ready");
    } finally {
      clearTimeout(timer);
    }
  });

  it("executes plan task and extracts structured JSON result", async () => {
    const doc = new MockDocument();
    const win = new MockWindow();
    win.location.href = "https://chatgpt.com/c/target-conv-id";

    const composer = new MockElement("textarea", { id: "prompt-textarea" });
    const sendBtn = new MockElement("button", { "data-testid": "send-button" });
    doc.body.appendChild(composer);
    doc.body.appendChild(sendBtn);

    const planTask: DecisionPlanTask = {
      schemaVersion: 1,
      id: "github%3Aowner%2Frepo%231:plan:1",
      sessionId: "github:owner/repo#1",
      kind: "plan",
      revision: 1,
      status: "running",
      lease: {
        owner: "driver",
        token: "tok",
        generation: 1,
        expiresAtMs: 200_000,
      },
      claimGeneration: 1,
      lastClaimToken: "tok",
      createdAtMs: 1000,
      updatedAtMs: 1000,
    };

    const resultJson = {
      schemaVersion: 1,
      taskId: planTask.id,
      sessionId: planTask.sessionId,
      kind: "plan",
      revision: 1,
      verdict: "ready",
      content: {
        plan: "Step 1: Implement feature\nStep 2: Add tests",
        acceptanceCriteria: ["Tests pass"],
        risks: ["None"],
        clarifications: [],
      },
      createdAtMs: 2000,
    };

    sendBtn.addEventListener("click", () => {
      const turn = new MockElement("article", { "data-testid": "conversation-turn-2" });
      const msg = new MockElement("div", { "data-message-author-role": "assistant" });
      msg.textContent = `Here is the plan:\n\`\`\`symphony-result\n${JSON.stringify(resultJson, null, 2)}\n\`\`\``;
      turn.appendChild(msg);
      doc.body.appendChild(turn);
    });

    const adapter = new ChatGptWebAdapter({
      doc: doc as unknown as Document,
      win: win as unknown as Window,
      checkIntervalMs: 10,
      stabilizationMs: 20,
    });

    const request: DecisionExecutionRequest = {
      task: planTask,
      session: {
        ...baseSession,
        binding: {
          schemaVersion: 1,
          adapter: "chatgpt-web",
          externalSessionRef: "target-conv-id",
          resumeUri: "https://chatgpt.com/c/target-conv-id",
          generation: 1,
        },
        bindingGeneration: 1,
      },
      context: {
        strategy: "materialized",
        workItem: { provider: "github", key: "owner/repo#1" },
        repository: "owner/repo",
        issue: { repository: "owner/repo", number: 1, title: "Test", body: "Body" },
        plan: null,
        pullRequest: null,
        diff: null,
        ci: null,
        repositoryInstructions: null,
        previousReviews: [],
        unresolvedFindings: [],
      },
    };

    const outcome = await adapter.executeTask(request);
    expect(outcome.result.kind).toBe("plan");
    expect(outcome.result.verdict).toBe("ready");
    if (outcome.result.kind === "plan") {
      expect(outcome.result.content.plan).toContain("Step 1: Implement feature");
    }
  });
});
