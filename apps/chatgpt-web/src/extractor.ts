/**
 * Result extractor for ChatGPT Web turns.
 * Extracts structured symphony-result blocks from rendered DOM elements.
 */
import {
  extractDecisionResultFromOutput,
} from "@symphony/decision/adapter";
import type { DecisionResult, DecisionTask } from "@symphony/domain/decision";
import { extractCodeBlocksFromTurn } from "./probes";

export function extractResultFromAssistantTurn(
  turn: HTMLElement,
  task: DecisionTask
): DecisionResult {
  const codeBlocks = extractCodeBlocksFromTurn(turn);

  // 1. Try code blocks labeled language-symphony-result or json first
  for (let i = codeBlocks.length - 1; i >= 0; i--) {
    const block = codeBlocks[i]!;
    if (block.language === "symphony-result" || block.language === "json") {
      try {
        const parsed = extractDecisionResultFromOutput(
          `\`\`\`symphony-result\n${block.content}\n\`\`\``,
          task
        );
        return parsed;
      } catch {
        // try next or fallback
      }
    }
  }

  // 2. Try raw text content of the entire turn
  const fullText = turn.textContent || "";
  return extractDecisionResultFromOutput(fullText, task);
}

export function extractResultFromText(
  text: string,
  task: DecisionTask
): DecisionResult {
  return extractDecisionResultFromOutput(text, task);
}
