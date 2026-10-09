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
  DecisionAdapterError,
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

  // 1. Inspect and ensure session binding
  const inspection = await adapter.inspectBinding(currentSession, { signal });

  if (inspection.status === "none") {
    const created = await adapter.createSession(currentSession, { signal });
    handle = created.handle;
    if (controller.putBinding) {
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
      const created = await adapter.createSession(currentSession, { signal });
      handle = created.handle;
      if (controller.rebindSession) {
        const expectedGen = inspection.observedGeneration ?? currentSession.bindingGeneration;
        const opKey = options.operationKeyPrefix
          ? `${options.operationKeyPrefix}:rebind:${expectedGen + 1}`
          : undefined;
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
      throw new DecisionAdapterError({
        code: "binding_broken",
        message: inspection.reason,
        suggestedAction: "rebind",
        observedGeneration: inspection.observedGeneration,
      });
    }
  } else {
    // status === "usable"
    const resumed = await adapter.resumeSession(currentSession, inspection.binding, { signal });
    handle = resumed.handle;
  }

  // 2. Start the task under lease
  await controller.startTask(task.id, {
    owner: lease.owner,
    token: lease.token,
    generation: lease.generation,
  });

  // 3. Execute the task
  try {
    const executionOutcome = await adapter.executeTask(
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

    // 4. Submit result
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
  } catch (err) {
    let errorCode = "execution_failed";
    let retryable = false;
    let details: unknown = null;

    if (err instanceof DecisionAdapterError) {
      errorCode = err.code;
      retryable = err.retryable;
      details = err.details;
    } else if (err instanceof Error) {
      details = { message: err.message, name: err.name };
    }

    const submission = await controller.submitFailure(task.id, {
      owner: lease.owner,
      token: lease.token,
      generation: lease.generation,
      error: errorCode,
      details,
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
  }
}
