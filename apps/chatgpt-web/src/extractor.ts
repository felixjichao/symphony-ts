/**
 * Result extractor for ChatGPT Web turns.
 * Extracts structured symphony-result blocks from rendered DOM elements with strict fail-closed semantics.
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
  const symphonyBlocks = codeBlocks.filter(
    (b) => b.language.toLowerCase() === "symphony-result"
  );

  // If explicit symphony-result DOM code blocks exist, only inspect the LAST one.
  // Fail-closed: Never fall back to earlier blocks if the last block is malformed or invalid.
  // Never accept plain json blocks as a substitute for symphony-result.
  if (symphonyBlocks.length > 0) {
    const lastBlock = symphonyBlocks[symphonyBlocks.length - 1]!;
    return extractDecisionResultFromOutput(
      `\`\`\`symphony-result\n${lastBlock.content}\n\`\`\``,
      task
    );
  }

  // If no syntax-highlighted DOM block with language-symphony-result was found,
  // parse the turn text directly using canonical last-block fail-closed extractor.
  // extractDecisionResultFromOutput strictly requires ```symphony-result and rejects plain ```json.
  const fullText = turn.textContent || "";
  return extractDecisionResultFromOutput(fullText, task);
}

export function extractResultFromText(
  text: string,
  task: DecisionTask
): DecisionResult {
  return extractDecisionResultFromOutput(text, task);
}
