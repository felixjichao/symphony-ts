import { describe, it, expect } from "vitest";
import { extractResultFromAssistantTurn } from "../src/extractor";
import { MockElement } from "./mock-dom";
import type { DecisionPlanTask, DecisionReviewTask } from "@symphony/domain/decision";
import { DecisionAdapterError } from "@symphony/domain/decision";

describe("extractResultFromAssistantTurn strict fail-closed contract", () => {
  const planTask: DecisionPlanTask = {
    schemaVersion: 1,
    id: "github%3Aowner%2Frepo%231:plan:1",
    sessionId: "github:owner/repo#1",
    kind: "plan",
    revision: 1,
    status: "pending",
    lease: null,
    claimGeneration: 0,
    lastClaimToken: null,
    createdAtMs: 1000,
    updatedAtMs: 1000,
  };

  const validResultJson = JSON.stringify({
    schemaVersion: 1,
    taskId: planTask.id,
    sessionId: planTask.sessionId,
    revision: planTask.revision,
    createdAtMs: 1000,
    kind: "plan",
    verdict: "ready",
    content: {
      plan: "Valid plan",
      acceptanceCriteria: ["A"],
      risks: [],
      clarifications: [],
    },
  });

  function createMockTurnWithBlocks(blocks: { language: string; content: string }[]): MockElement {
    const turn = new MockElement("div");
    for (const b of blocks) {
      const pre = new MockElement("pre");
      const code = new MockElement("code");
      code.className = b.language ? `language-${b.language}` : "";
      code.textContent = b.content;
      pre.appendChild(code);
      turn.appendChild(pre);
    }
    return turn;
  }

  it("routes a task-bound evidence failure to a retryable executor error, never a result", () => {
    const envelope = { schemaVersion: 1, taskId: planTask.id, sessionId: planTask.sessionId,
      revision: planTask.revision, kind: "plan", error: "evidence_unavailable", message: "Connector denied access" };
    const turn = createMockTurnWithBlocks([{ language: "symphony-result", content: JSON.stringify(envelope) }]);
    expect(() => extractResultFromAssistantTurn(turn as unknown as HTMLElement, planTask)).toThrow(
      expect.objectContaining({ code: "evidence_unavailable", retryable: true, suggestedAction: "retry" }));
    for (const change of [{ taskId: "other" }, { sessionId: "other" }, { revision: 2 },
      { kind: "review" }, { verdict: "approve" }, { message: "" }, { error: "other" }]) {
      const invalid = createMockTurnWithBlocks([{ language: "symphony-result", content: JSON.stringify({ ...envelope, ...change }) }]);
      expect(() => extractResultFromAssistantTurn(invalid as unknown as HTMLElement, planTask)).toThrow(
        expect.objectContaining({ code: "malformed_output" }));
    }
    const malformedLast = createMockTurnWithBlocks([
      { language: "symphony-result", content: JSON.stringify(envelope) },
      { language: "symphony-result", content: "{ broken" },
    ]);
    expect(() => extractResultFromAssistantTurn(malformedLast as unknown as HTMLElement, planTask)).toThrow(
      expect.objectContaining({ code: "malformed_output" }));
  });

  it("rejects evidence failures for a different review target HEAD or unknown target fields", () => {
    const task: DecisionReviewTask = { ...planTask, kind: "review", target: {
      repository: "owner/repo", prNumber: 42, headSha: "a".repeat(40) } };
    for (const target of [{ ...task.target, headSha: "b".repeat(40) }, { ...task.target, extra: true }]) {
      const turn = createMockTurnWithBlocks([{ language: "symphony-result", content: JSON.stringify({
        schemaVersion: 1, taskId: task.id, sessionId: task.sessionId, revision: task.revision,
        kind: "review", target, error: "evidence_unavailable", message: "Missing diff" }) }]);
      expect(() => extractResultFromAssistantTurn(turn as unknown as HTMLElement, task)).toThrow(
        expect.objectContaining({ code: "malformed_output" }));
    }
  });

  it("extracts result from valid symphony-result code block", () => {
    const turn = createMockTurnWithBlocks([
      { language: "symphony-result", content: validResultJson },
    ]);
    const res = extractResultFromAssistantTurn(turn as unknown as HTMLElement, planTask);
    expect(res.kind).toBe("plan");
    expect(res.verdict).toBe("ready");
  });

  it("fails closed when earlier block is valid but last block is malformed (no fallback)", () => {
    const turn = createMockTurnWithBlocks([
      { language: "symphony-result", content: validResultJson },
      { language: "symphony-result", content: "{ malformed json ... not valid }" },
    ]);
    expect(() =>
      extractResultFromAssistantTurn(turn as unknown as HTMLElement, planTask)
    ).toThrow(DecisionAdapterError);
  });

  it("fails closed when code block is labeled json instead of symphony-result", () => {
    const turn = createMockTurnWithBlocks([
      { language: "json", content: validResultJson },
    ]);
    expect(() =>
      extractResultFromAssistantTurn(turn as unknown as HTMLElement, planTask)
    ).toThrow(DecisionAdapterError);
  });

  it("extracts labeled code surfaces and rejects a malformed last surface", () => {
    const turn = new MockElement("div");
    const appendSurface = (content: string) => {
      const surface = new MockElement("div", { "data-markdown-copy": "code-block" });
      const header = new MockElement("div", { "data-markdown-copy": "exclude" });
      const label = new MockElement("div");
      label.textContent = "symphony-result";
      header.appendChild(label);
      const code = new MockElement("code");
      code.textContent = content;
      surface.appendChild(header);
      surface.appendChild(code);
      turn.appendChild(surface);
    };
    appendSurface(validResultJson);
    expect(extractResultFromAssistantTurn(turn as unknown as HTMLElement, planTask).verdict)
      .toBe("ready");
    appendSurface("{malformed}");
    expect(() => extractResultFromAssistantTurn(turn as unknown as HTMLElement, planTask))
      .toThrow(DecisionAdapterError);
  });

  it("preserves document order and fails closed when the last block in mixed pre and code surface is malformed", () => {
    const appendPre = (target: MockElement, content: string) => {
      const pre = new MockElement("pre");
      const code = new MockElement("code", { class: "language-symphony-result" });
      code.textContent = content;
      pre.appendChild(code);
      target.appendChild(pre);
    };
    const appendSurface = (target: MockElement, content: string) => {
      const surface = new MockElement("div", { "data-markdown-copy": "code-block" });
      const header = new MockElement("div", { "data-markdown-copy": "exclude" });
      const label = new MockElement("div");
      label.textContent = "symphony-result";
      header.appendChild(label);
      const code = new MockElement("code");
      code.textContent = content;
      surface.appendChild(header);
      surface.appendChild(code);
      target.appendChild(surface);
    };

    // Case 1: surface first (valid), pre last (malformed) -> must fail closed on malformed pre
    const turn1 = new MockElement("div");
    appendSurface(turn1, validResultJson);
    appendPre(turn1, "{malformed}");
    expect(() => extractResultFromAssistantTurn(turn1 as unknown as HTMLElement, planTask))
      .toThrow(DecisionAdapterError);

    // Case 2: pre first (valid), surface last (malformed) -> must fail closed on malformed surface
    const turn2 = new MockElement("div");
    appendPre(turn2, validResultJson);
    appendSurface(turn2, "{malformed}");
    expect(() => extractResultFromAssistantTurn(turn2 as unknown as HTMLElement, planTask))
      .toThrow(DecisionAdapterError);
  });

  it("preserves document order and accepts the last valid block in mixed pre and code surface", () => {
    const appendPre = (target: MockElement, content: string) => {
      const pre = new MockElement("pre");
      const code = new MockElement("code", { class: "language-symphony-result" });
      code.textContent = content;
      pre.appendChild(code);
      target.appendChild(pre);
    };
    const appendSurface = (target: MockElement, content: string) => {
      const surface = new MockElement("div", { "data-markdown-copy": "code-block" });
      const header = new MockElement("div", { "data-markdown-copy": "exclude" });
      const label = new MockElement("div");
      label.textContent = "symphony-result";
      header.appendChild(label);
      const code = new MockElement("code");
      code.textContent = content;
      surface.appendChild(header);
      surface.appendChild(code);
      target.appendChild(surface);
    };

    // Case 1: surface first (malformed), pre last (valid) -> accepts valid pre
    const turn1 = new MockElement("div");
    appendSurface(turn1, "{malformed}");
    appendPre(turn1, validResultJson);
    expect(extractResultFromAssistantTurn(turn1 as unknown as HTMLElement, planTask).verdict)
      .toBe("ready");

    // Case 2: pre first (malformed), surface last (valid) -> accepts valid surface
    const turn2 = new MockElement("div");
    appendPre(turn2, "{malformed}");
    appendSurface(turn2, validResultJson);
    expect(extractResultFromAssistantTurn(turn2 as unknown as HTMLElement, planTask).verdict)
      .toBe("ready");
  });

  it("fails closed when turn has no symphony-result blocks", () => {
    const turn = new MockElement("div");
    turn.textContent = "Here is some prose without any code blocks.";
    expect(() =>
      extractResultFromAssistantTurn(turn as unknown as HTMLElement, planTask)
    ).toThrow(DecisionAdapterError);
  });
});
