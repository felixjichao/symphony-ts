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
  type DecisionBindingInspectionResult,
  type DecisionSessionCreationResult,
  type DecisionSessionResumeResult,
  type DecisionExecutionOutcome,
  DecisionAdapterError,
  validateDecisionContextForTask,
} from "@symphony/domain";
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
    params: { adapter: string; externalSessionRef: string; resumeUri: string | null }
  ): Promise<DecisionSession | { session: DecisionSession }>;

  rebindSession?(
    sessionId: string,
    params: {
      adapter: string;
      externalSessionRef: string;
      resumeUri: string | null;
      expectedGeneration: number;
      operationKey?: string;
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

  // Helper to record structured failure if adapter lifecycle or execution fails (Blocker 1 & 3)
  const recordFailure = async (err: unknown): Promise<TaskExecutionFailureOutcome> => {
    let errorCode: DecisionAdapterErrorCode = "execution_failed";
    let retryable = false;
    let safeDetails: Record<string, unknown> = {};

    if (err instanceof DecisionAdapterError) {
      errorCode = err.code;
      retryable = err.retryable;
      safeDetails = {
        code: err.code,
        message: err.message,
        suggestedAction: err.suggestedAction,
        ...(err.observedGeneration !== undefined ? { observedGeneration: err.observedGeneration } : {}),
      };
      if (err.details && typeof err.details === "object") {
        const raw = err.details["rawDetails"];
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          const rawObj = raw as Record<string, unknown>;
          const sanitizedRaw: Record<string, unknown> = {};
          for (const key of [
            "errorName",
            "contentLength",
            "reason",
            "expectedKind",
            "actualKind",
            "expectedSessionId",
            "actualSessionId",
            "expectedRevision",
            "actualRevision",
            "expectedTarget",
            "actualTarget",
          ]) {
            if (key in rawObj && rawObj[key] !== undefined) {
              sanitizedRaw[key] = rawObj[key];
            }
          }
          if (Object.keys(sanitizedRaw).length > 0) {
            safeDetails["rawDetails"] = sanitizedRaw;
          }
        }
      }
    } else if (err instanceof Error) {
      safeDetails = { message: err.message, name: err.name };
    }

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
