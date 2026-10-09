/**
 * Provider-neutral Decision result extraction and strict validation primitives.
 * Consumes machine-readable fenced code blocks (```symphony-result) with fail-closed semantics.
 * Zero Node built-in dependencies (safe for browser environments).
 */
import {
  type DecisionTask,
  type DecisionResult,
  parseDecisionResult,
  validateDecisionResultForTask,
  DecisionAdapterError,
} from "@symphony/domain";

/**
 * Extracts the raw JSON payload from the LAST ```symphony-result code block in `rawText`.
 * Fails closed if the block is missing, unclosed, or contains malformed JSON.
 * Does NOT fall back to earlier blocks if the last block is invalid or unclosed.
 */
export function extractSymphonyResultPayload(rawText: string): unknown {
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    throw new DecisionAdapterError({
      code: "malformed_output",
      message: "Empty or non-string executor output; expected symphony-result payload",
    });
  }

  // Find all opening fences for symphony-result
  // Matches ```symphony-result or ~~~symphony-result (case-insensitive)
  const openingRegex = /(?:^|\r?\n)[ \t]*(`{3,}|~{3,})[ \t]*symphony-result[ \t]*(?:\r?\n|$)/gi;

  interface OpeningMatch {
    readonly fenceChar: string;
    readonly fenceLength: number;
    readonly contentStart: number;
  }

  const openings: OpeningMatch[] = [];
  let match: RegExpExecArray | null;

  while ((match = openingRegex.exec(rawText)) !== null) {
    const fence = match[1];
    if (!fence) continue;
    openings.push({
      fenceChar: fence[0]!,
      fenceLength: fence.length,
      contentStart: match.index + match[0].length,
    });
  }

  if (openings.length === 0) {
    throw new DecisionAdapterError({
      code: "malformed_output",
      message: "No symphony-result code block found in executor output",
    });
  }

  // The rule strictly mandates taking the LAST block.
  const lastOpening = openings[openings.length - 1]!;

  // Look for closing fence matching the fence character and length after contentStart
  // A closing fence is a line starting with at least `fenceLength` of `fenceChar`
  const closingRegex = new RegExp(
    `(?:^|\\r?\\n)[ \\t]*${lastOpening.fenceChar}{${lastOpening.fenceLength},}[ \\t]*(?:\\r?\\n|$)`,
    "g"
  );
  closingRegex.lastIndex = lastOpening.contentStart;

  const closingMatch = closingRegex.exec(rawText);
  if (!closingMatch) {
    throw new DecisionAdapterError({
      code: "malformed_output",
      message: "Unclosed symphony-result code block in executor output",
    });
  }

  // Extract content between opening and closing fences
  const contentEnd = closingMatch.index;
  const content = rawText.slice(lastOpening.contentStart, contentEnd).trim();

  if (content.length === 0) {
    throw new DecisionAdapterError({
      code: "malformed_output",
      message: "Empty content in symphony-result code block",
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new DecisionAdapterError({
      code: "malformed_output",
      message: "Malformed JSON in symphony-result code block",
      rawDetails: {
        errorName: (err as Error).name,
        reason: "invalid_json",
        contentLength: content.length,
      },
      cause: err,
    });
  }

  return parsed;
}

/**
 * Normalizes and strictly validates a raw DecisionResult payload against v1 schema
 * and optionally against the expected DecisionTask identity and target.
 */
export function normalizeDecisionResult(payload: unknown, task?: DecisionTask): DecisionResult {
  let result: DecisionResult;
  try {
    result = parseDecisionResult(payload);
  } catch (err) {
    throw new DecisionAdapterError({
      code: "malformed_output",
      message: "Invalid DecisionResult envelope",
      rawDetails: {
        errorName: "TypeError",
        reason: "schema_validation_failed",
      },
      cause: err,
    });
  }

  if (task !== undefined) {
    if (result.kind !== task.kind) {
      throw new DecisionAdapterError({
        code: "task_mismatch",
        message: `DecisionResult kind mismatch: expected "${task.kind}", got "${result.kind}"`,
        rawDetails: { expectedKind: task.kind, actualKind: result.kind },
      });
    }

    if (result.sessionId !== task.sessionId) {
      throw new DecisionAdapterError({
        code: "task_mismatch",
        message: `DecisionResult sessionId mismatch: expected "${task.sessionId}", got "${result.sessionId}"`,
        rawDetails: { expectedSessionId: task.sessionId, actualSessionId: result.sessionId },
      });
    }

    if (result.revision !== task.revision) {
      throw new DecisionAdapterError({
        code: "revision_mismatch",
        message: `DecisionResult revision mismatch: expected revision ${task.revision}, got ${result.revision}`,
        rawDetails: { expectedRevision: task.revision, actualRevision: result.revision },
      });
    }

    if (task.kind === "review" && result.kind === "review") {
      if (
        result.target.repository !== task.target.repository ||
        result.target.prNumber !== task.target.prNumber ||
        result.target.headSha !== task.target.headSha
      ) {
        throw new DecisionAdapterError({
          code: "target_mismatch",
          message: `DecisionReviewResult target mismatch: expected repo=${task.target.repository} pr=${task.target.prNumber} sha=${task.target.headSha}, got repo=${result.target.repository} pr=${result.target.prNumber} sha=${result.target.headSha}`,
          rawDetails: { expectedTarget: task.target, actualTarget: result.target },
        });
      }
    }

    if (result.taskId !== task.id) {
      throw new DecisionAdapterError({
        code: "task_mismatch",
        message: `DecisionResult taskId mismatch: expected "${task.id}", got "${result.taskId}"`,
        rawDetails: { expectedTaskId: task.id, actualTaskId: result.taskId },
      });
    }

    if (result.createdAtMs < task.createdAtMs) {
      throw new DecisionAdapterError({
        code: "malformed_output",
        message: `DecisionResult createdAtMs (${result.createdAtMs}) predates task createdAtMs (${task.createdAtMs})`,
        rawDetails: { taskCreatedAtMs: task.createdAtMs, resultCreatedAtMs: result.createdAtMs },
      });
    }

    try {
      validateDecisionResultForTask(task, result);
    } catch (err) {
      throw new DecisionAdapterError({
        code: "malformed_output",
        message: "DecisionResult validation failed for task",
        rawDetails: {
          errorName: "TypeError",
          reason: "schema_validation_failed",
        },
        cause: err,
      });
    }
  }

  return result;
}

/**
 * Extracts and strictly validates a DecisionResult from raw executor prose output.
 */
export function extractDecisionResultFromOutput(rawText: string, task?: DecisionTask): DecisionResult {
  const payload = extractSymphonyResultPayload(rawText);
  return normalizeDecisionResult(payload, task);
}

/**
 * Formats a valid DecisionResult into a canonical markdown ```symphony-result code block.
 */
export function formatSymphonyResultPayload(result: DecisionResult): string {
  parseDecisionResult(result);
  return "```symphony-result\n" + JSON.stringify(result, null, 2) + "\n```";
}
