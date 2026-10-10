/**
 * Coordination helper tying DecisionExecutorAdapter to DecisionService or DecisionBridgeClient.
 * Handles binding inspection, CAS rebind, lease start, execution, and atomic result/failure submission.
 */
import {
  type DecisionTask,
  type DecisionSession,
  type DecisionLease,
  type DecisionResult,
  type DecisionContextBundle,
  type DecisionExecutorAdapter,
  type DecisionAdapterErrorCode,
  type DecisionAdapterSuggestedAction,
  type DecisionBindingInspectionResult,
  type DecisionSessionCreationResult,
  type DecisionSessionResumeResult,
  type DecisionExecutionOutcome,
  DecisionAdapterError,
  parseDecisionSessionRootFromId,
  validateDecisionContextForTask,
} from "@symphony/domain/decision";
import type {
  DecisionTaskFailure,
  SubmissionReceipt,
} from "../types";

export interface DecisionTaskController {
  startTask(
    taskId: string,
    params: { owner: string; token: string; generation: number }
  ): Promise<unknown>;

  submitResult(
    taskId: string,
    params: { owner: string; token: string; generation: number; result: DecisionResult }
  ): Promise<{ receipt: SubmissionReceipt; result: DecisionResult; superseded: boolean }>;

  submitFailure(
    taskId: string,
    params: {
      owner: string;
      token: string;
      generation: number;
      error: string;
      details?: unknown;
      retryable?: boolean;
    }
  ): Promise<{ receipt: SubmissionReceipt; failure: DecisionTaskFailure; superseded: boolean }>;

  putBinding?(
    sessionId: string,
    params: {
      adapter: string;
      externalSessionRef: string;
      resumeUri: string | null;
      owner?: string | undefined;
      token?: string | undefined;
      generation?: number | undefined;
    }
  ): Promise<DecisionSession | { session: DecisionSession }>;

  rebindSession?(
    sessionId: string,
    params: {
      adapter: string;
      externalSessionRef: string;
      resumeUri: string | null;
      expectedGeneration: number;
      operationKey?: string;
      owner?: string | undefined;
      token?: string | undefined;
      generation?: number | undefined;
    }
  ): Promise<DecisionSession | { session: DecisionSession }>;
}

export interface ExecuteTaskWithAdapterOptions {
  readonly controller: DecisionTaskController;
  readonly adapter: DecisionExecutorAdapter;
  readonly task: DecisionTask;
  readonly session: DecisionSession;
  readonly lease: DecisionLease;
  readonly context: DecisionContextBundle;
  readonly signal?: AbortSignal | undefined;
  readonly operationKeyPrefix?: string | undefined;
}

export interface TaskExecutionSuccessOutcome {
  readonly status: "completed";
  readonly result: DecisionResult;
  readonly receipt: SubmissionReceipt;
  readonly superseded: boolean;
  readonly session: DecisionSession;
}

export interface TaskExecutionFailureOutcome {
  readonly status: "failed";
  readonly failure: DecisionTaskFailure;
  readonly receipt: SubmissionReceipt;
  readonly superseded: boolean;
  readonly session: DecisionSession;
  readonly error: unknown;
}

export type TaskExecutionOutcome = TaskExecutionSuccessOutcome | TaskExecutionFailureOutcome;

export async function executeTaskWithAdapter(
  options: ExecuteTaskWithAdapterOptions
): Promise<TaskExecutionOutcome> {
  const { controller, adapter, task, lease, context, signal } = options;
  let currentSession = options.session;
  let handle: unknown;

  // Enforce work-item and task context consistency at the execution entry point (Blocker 2)
  validateDecisionContextForTask(context, task, currentSession);

const CANONICAL_SAFE_MESSAGES: Record<DecisionAdapterErrorCode, string> = {
  malformed_output: "Executor output failed schema validation or could not be parsed",
  task_mismatch: "Executor result does not match claimed task identity",
  revision_mismatch: "Executor result revision does not match claimed task revision",
  target_mismatch: "Executor review result target does not match claimed task target",
  binding_broken: "Executor binding is unusable or broken",
  execution_failed: "Executor task execution failed",
  human_required: "Executor requires human interaction or verification",
  unsupported_strategy: "Context strategy is not supported by executor adapter",
  unsupported_task_kind: "Task kind is not supported by executor adapter",
  cancelled: "Task execution was cancelled",
};

const VALID_ERROR_CODES = new Set<DecisionAdapterErrorCode>([
  "malformed_output",
  "task_mismatch",
  "revision_mismatch",
  "target_mismatch",
  "binding_broken",
  "execution_failed",
  "human_required",
  "unsupported_strategy",
  "unsupported_task_kind",
  "cancelled",
]);

const VALID_SUGGESTED_ACTIONS = new Set<DecisionAdapterSuggestedAction>([
  "retry",
  "rebind",
  "human_intervention",
  "fail_closed",
]);

const TRUSTED_ERROR_NAMES = new Set<string>([
  "Error",
  "SyntaxError",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "DecisionAdapterError",
  "AbortError",
  "TimeoutError",
]);

const TRUSTED_DIAGNOSTIC_REASONS = new Set<string>([
  "invalid_json",
  "schema_validation_failed",
  "unsupported_verdict",
  "missing_required_field",
  "adapter_mismatch",
  "session_not_found",
  "account_terminated",
  "binding_broken",
  "timeout",
  "network_error",
  "auth_required",
  "rate_limited",
]);

function sanitizeErrorName(name: unknown): string {
  if (typeof name === "string" && TRUSTED_ERROR_NAMES.has(name.trim())) {
    return name.trim();
  }
  return "Error";
}

function sanitizeSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // Session IDs must match work-item reference format: provider:key
  // e.g. github:owner/repo#123
  if (!/^[a-z][a-z0-9-]*:[a-zA-Z0-9_.-]+(\/[a-zA-Z0-9_.-]+)?#[1-9][0-9]*$/.test(trimmed)) {
    return undefined;
  }
  if (trimmed.length > 128) {
    return undefined;
  }
  try {
    parseDecisionSessionRootFromId(trimmed);
    return trimmed;
  } catch {
    return undefined;
  }
}

function sanitizeNumberField(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
  if (value < min || value > max) return undefined;
  return value;
}

function sanitizeReviewTargetDiagnostic(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const res: Record<string, unknown> = {};

  if (typeof obj["repository"] === "string") {
    const repo = obj["repository"].trim();
    if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) && repo.length <= 128) {
      res["repository"] = repo;
    }
  }

  if (typeof obj["prNumber"] === "number" && Number.isSafeInteger(obj["prNumber"]) && obj["prNumber"] > 0) {
    res["prNumber"] = obj["prNumber"];
  }

  if (typeof obj["headSha"] === "string") {
    const sha = obj["headSha"].trim();
    if (/^[0-9a-fA-F]{40}$/.test(sha)) {
      res["headSha"] = sha;
    }
  }

  if (Object.keys(res).length > 0) {
    return res;
  }
  return undefined;
}

function buildSafeRawDetails(rawObj: unknown, task: DecisionTask): Record<string, unknown> | undefined {
  if (!rawObj || typeof rawObj !== "object" || Array.isArray(rawObj)) {
    return undefined;
  }
  const raw = rawObj as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};

  if ("errorName" in raw) {
    sanitized["errorName"] = sanitizeErrorName(raw["errorName"]);
  }

  if ("contentLength" in raw) {
    const len = sanitizeNumberField(raw["contentLength"], 0, 100_000_000);
    if (len !== undefined) {
      sanitized["contentLength"] = len;
    }
  }

  if ("reason" in raw) {
    if (typeof raw["reason"] === "string" && TRUSTED_DIAGNOSTIC_REASONS.has(raw["reason"].trim())) {
      sanitized["reason"] = raw["reason"].trim();
    }
  }

  if ("expectedKind" in raw) {
    sanitized["expectedKind"] = task.kind;
  }

  if ("actualKind" in raw && (raw["actualKind"] === "plan" || raw["actualKind"] === "review")) {
    sanitized["actualKind"] = raw["actualKind"];
  }

  if ("expectedSessionId" in raw) {
    sanitized["expectedSessionId"] = task.sessionId;
  }

  if ("actualSessionId" in raw) {
    const sid = sanitizeSessionId(raw["actualSessionId"]);
    if (sid !== undefined) {
      sanitized["actualSessionId"] = sid;
    }
  }

  if ("expectedRevision" in raw) {
    sanitized["expectedRevision"] = task.revision;
  }

  if ("actualRevision" in raw) {
    const rev = sanitizeNumberField(raw["actualRevision"], 1, 1_000_000);
    if (rev !== undefined) {
      sanitized["actualRevision"] = rev;
    }
  }

  if ("expectedTarget" in raw) {
    if (task.kind === "review" && task.target) {
      sanitized["expectedTarget"] = {
        repository: task.target.repository,
        prNumber: task.target.prNumber,
        headSha: task.target.headSha,
      };
    }
  }

  if ("actualTarget" in raw) {
    const target = sanitizeReviewTargetDiagnostic(raw["actualTarget"]);
    if (target !== undefined) {
      sanitized["actualTarget"] = target;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

  // Helper to record structured failure if adapter lifecycle or execution fails (Blocker 1 & 3)
  const recordFailure = async (err: unknown): Promise<TaskExecutionFailureOutcome> => {
    let errorCode: DecisionAdapterErrorCode = "execution_failed";
    let retryable = false;
    let suggestedAction: DecisionAdapterSuggestedAction = "fail_closed";
    let observedGeneration: number | undefined;
    let rawDetails: Record<string, unknown> | undefined;

    if (err instanceof DecisionAdapterError) {
      if (VALID_ERROR_CODES.has(err.code)) {
        errorCode = err.code;
      }
      retryable = Boolean(err.retryable);
      if (VALID_SUGGESTED_ACTIONS.has(err.suggestedAction)) {
        suggestedAction = err.suggestedAction;
      }
      if (
        typeof err.observedGeneration === "number" &&
        Number.isSafeInteger(err.observedGeneration) &&
        err.observedGeneration >= 0
      ) {
        observedGeneration = err.observedGeneration;
      }
      if (err.details && typeof err.details === "object") {
        rawDetails = buildSafeRawDetails(err.details["rawDetails"], task);
      }
    } else if (err instanceof Error) {
      rawDetails = {
        errorName: sanitizeErrorName(err.name),
      };
    }

    const safeMessage = CANONICAL_SAFE_MESSAGES[errorCode] ?? "Executor task execution failed";

    const safeDetails: Record<string, unknown> = {
      code: errorCode,
      message: safeMessage,
      suggestedAction,
      ...(observedGeneration !== undefined ? { observedGeneration } : {}),
      ...(rawDetails !== undefined ? { rawDetails } : {}),
    };

    const submission = await controller.submitFailure(task.id, {
      owner: lease.owner,
      token: lease.token,
      generation: lease.generation,
      error: errorCode,
      details: safeDetails,
      retryable,
    });

    return {
      status: "failed",
      failure: submission.failure,
      receipt: submission.receipt,
      superseded: submission.superseded,
      session: currentSession,
      error: err,
    };
  };

  // 1. Inspect and ensure session binding
  let inspection: DecisionBindingInspectionResult;
  try {
    inspection = await adapter.inspectBinding(currentSession, { signal });
  } catch (err) {
    return await recordFailure(err);
  }

  if (inspection.status === "none") {
    let created: DecisionSessionCreationResult;
    try {
      created = await adapter.createSession(currentSession, { signal });
    } catch (err) {
      return await recordFailure(err);
    }
    handle = created.handle;
    if (controller.putBinding) {
      // Controller authority call: errors rethrow
      const boundRes = await controller.putBinding(currentSession.id, {
        adapter: created.binding.adapter,
        externalSessionRef: created.binding.externalSessionRef,
        resumeUri: created.binding.resumeUri,
        owner: lease.owner,
        token: lease.token,
        generation: lease.generation,
      });
      currentSession =
        boundRes && typeof boundRes === "object" && "session" in boundRes
          ? (boundRes as { session: DecisionSession }).session
          : (boundRes as DecisionSession);
    }
  } else if (inspection.status === "unusable") {
    if (inspection.needsRebind) {
      let created: DecisionSessionCreationResult;
      try {
        created = await adapter.createSession(currentSession, { signal });
      } catch (err) {
        return await recordFailure(err);
      }
      handle = created.handle;
      if (controller.rebindSession) {
        const expectedGen = inspection.observedGeneration ?? currentSession.bindingGeneration;
        const opKey = options.operationKeyPrefix
          ? `${options.operationKeyPrefix}:rebind:${expectedGen + 1}`
          : undefined;
        // Controller authority call: CAS conflict or store error rethrows directly
        const reboundRes = await controller.rebindSession(currentSession.id, {
          adapter: created.binding.adapter,
          externalSessionRef: created.binding.externalSessionRef,
          resumeUri: created.binding.resumeUri,
          expectedGeneration: expectedGen,
          ...(opKey ? { operationKey: opKey } : {}),
          owner: lease.owner,
          token: lease.token,
          generation: lease.generation,
        });
        currentSession =
          reboundRes && typeof reboundRes === "object" && "session" in reboundRes
            ? (reboundRes as { session: DecisionSession }).session
            : (reboundRes as DecisionSession);
      }
    } else {
      const brokenErr = new DecisionAdapterError({
        code: "binding_broken",
        message: inspection.reason,
        suggestedAction: "rebind",
        observedGeneration: inspection.observedGeneration,
      });
      return await recordFailure(brokenErr);
    }
  } else {
    // status === "usable"
    let resumed: DecisionSessionResumeResult;
    try {
      resumed = await adapter.resumeSession(currentSession, inspection.binding, { signal });
    } catch (err) {
      return await recordFailure(err);
    }
    handle = resumed.handle;
  }

  // 2. Start the task under lease (controller authority call: errors rethrow)
  await controller.startTask(task.id, {
    owner: lease.owner,
    token: lease.token,
    generation: lease.generation,
  });

  // 3. Execute the task
  let executionOutcome: DecisionExecutionOutcome;
  try {
    executionOutcome = await adapter.executeTask(
      {
        task,
        session: currentSession,
        context,
      },
      {
        signal,
        handle,
      }
    );
  } catch (err) {
    return await recordFailure(err);
  }

  // 4. Submit result (controller authority call)
  const submission = await controller.submitResult(task.id, {
    owner: lease.owner,
    token: lease.token,
    generation: lease.generation,
    result: executionOutcome.result,
  });

  return {
    status: "completed",
    result: submission.result,
    receipt: submission.receipt,
    superseded: submission.superseded,
    session: currentSession,
  };
}
