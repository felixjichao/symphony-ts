/**
 * Result extractor for ChatGPT Web turns.
 * Extracts structured symphony-result blocks from rendered DOM elements with strict fail-closed semantics.
 */
import {
  extractDecisionResultFromOutput,
} from "@symphony/decision/adapter";
import { DecisionAdapterError } from "@symphony/domain/decision";
import type { DecisionResult, DecisionTask } from "@symphony/domain/decision";
import { extractCodeBlocksFromTurn } from "./probes";

export function extractResponseFromAssistantTurn(
  turn: HTMLElement,
  task: DecisionTask
) {
  const codeBlocks = extractCodeBlocksFromTurn(turn);
  const symphonyBlocks = codeBlocks.filter(
    (b) => b.language.toLowerCase() === "symphony-result"
  );

  // If explicit symphony-result DOM code blocks exist, only inspect the LAST one.
  // Fail-closed: Never fall back to earlier blocks if the last block is malformed or invalid.
  // Never accept plain json blocks as a substitute for symphony-result.
  if (symphonyBlocks.length > 0) {
    const lastBlock = symphonyBlocks[symphonyBlocks.length - 1]!;
    return extractResponseFromText(
      `\`\`\`symphony-result\n${lastBlock.content}\n\`\`\``,
      task
    );
  }

  // If no syntax-highlighted DOM block with language-symphony-result was found,
  // parse the turn text directly using canonical last-block fail-closed extractor.
  // extractDecisionResultFromOutput strictly requires ```symphony-result and rejects plain ```json.
  const fullText = turn.textContent || "";
  return extractResponseFromText(fullText, task);
}

/** Web-local executor failure; never submitted as a domain DecisionResult. */
function extractResponseFromText(text: string, task: DecisionTask) {
  const blocks = [...text.matchAll(/```symphony-result\s*\n?([\s\S]*?)```/gi)];
  const raw = blocks.at(-1)?.[1];
  let value: unknown;
  try { value = raw ? JSON.parse(raw) : null; } catch { /* Canonical parser reports malformed output. */ }
  if (value && typeof value === "object" && "error" in value) {
    const v = value as Record<string, unknown>;
    const keys = ["schemaVersion", "taskId", "sessionId", "revision", "kind", "error", "message",
      ...(task.kind === "review" ? ["target"] : [])];
    const target = task.kind === "review" ? v["target"] as Record<string, unknown> | null : null;
    if (Object.keys(v).length !== keys.length || Object.keys(v).some(k => !keys.includes(k))
      || v["schemaVersion"] !== 1 || v["taskId"] !== task.id || v["sessionId"] !== task.sessionId
      || v["revision"] !== task.revision || v["kind"] !== task.kind || v["error"] !== "evidence_unavailable"
      || typeof v["message"] !== "string" || !v["message"].trim()
      || (task.kind === "review" && (!target || Object.keys(target).length !== 3
        || target["repository"] !== task.target.repository || target["prNumber"] !== task.target.prNumber
        || target["headSha"] !== task.target.headSha))) {
      throw new DecisionAdapterError({ code: "malformed_output", message: "Invalid or mismatched evidence failure envelope" });
    }
    return { error: "evidence_unavailable" as const, message: v["message"] };
  }
  return extractDecisionResultFromOutput(text, task);
}

export function extractResultFromAssistantTurn(turn: HTMLElement, task: DecisionTask): DecisionResult {
  const response = extractResponseFromAssistantTurn(turn, task);
  if ("error" in response) {
    throw new DecisionAdapterError({ code: "evidence_unavailable", message: response.message,
      retryable: true, suggestedAction: "retry", promptSubmitted: true });
  }
  return response;
}

export function extractResultFromText(text: string, task: DecisionTask): DecisionResult {
  return extractDecisionResultFromOutput(text, task);
}
