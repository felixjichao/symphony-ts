/**
 * Provider-neutral Decision executor adapter interfaces and error contracts.
 * Independent of Symphony §7 orchestrator and concrete external providers.
 */
import type { DecisionSession, DecisionTask, DecisionResult, ExecutorBinding } from "./decision";
import type { DecisionContextStrategyKind, DecisionExecutionRequest } from "./decision-context";

export type DecisionAdapterErrorCode =
  | "malformed_output"
  | "task_mismatch"
  | "revision_mismatch"
  | "target_mismatch"
  | "binding_broken"
  | "execution_failed"
  | "human_required"
  | "unsupported_strategy"
  | "unsupported_task_kind"
  | "cancelled";

export type DecisionAdapterSuggestedAction =
  | "retry"
  | "rebind"
  | "human_intervention"
  | "fail_closed";

export interface DecisionAdapterFailureDiagnostic {
  readonly code: DecisionAdapterErrorCode;
  readonly message: string;
  readonly suggestedAction: DecisionAdapterSuggestedAction;
  readonly observedGeneration?: number | undefined;
  readonly rawDetails?: unknown | undefined;
}

export class DecisionAdapterError extends Error {
  readonly code: DecisionAdapterErrorCode;
  readonly retryable: boolean;
  readonly suggestedAction: DecisionAdapterSuggestedAction;
  readonly observedGeneration?: number | undefined;
  readonly details: Record<string, unknown>;

  constructor(options: {
    readonly code: DecisionAdapterErrorCode;
    readonly message: string;
    readonly retryable?: boolean | undefined;
    readonly suggestedAction?: DecisionAdapterSuggestedAction | undefined;
    readonly observedGeneration?: number | undefined;
    readonly rawDetails?: unknown | undefined;
    readonly cause?: unknown | undefined;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "DecisionAdapterError";
    this.code = options.code;
    this.observedGeneration = options.observedGeneration;

    if (options.suggestedAction !== undefined) {
      this.suggestedAction = options.suggestedAction;
    } else {
      switch (options.code) {
        case "execution_failed":
          this.suggestedAction = "retry";
          break;
        case "binding_broken":
          this.suggestedAction = "rebind";
          break;
        case "human_required":
          this.suggestedAction = "human_intervention";
          break;
        default:
          this.suggestedAction = "fail_closed";
          break;
      }
    }

    if (options.retryable !== undefined) {
      this.retryable = options.retryable;
    } else {
      this.retryable = this.suggestedAction === "retry";
    }

    this.details = {
      code: this.code,
      message: this.message,
      suggestedAction: this.suggestedAction,
      ...(this.observedGeneration !== undefined ? { observedGeneration: this.observedGeneration } : {}),
      ...(options.rawDetails !== undefined ? { rawDetails: options.rawDetails } : {}),
    };
  }
}

export type DecisionBindingInspectionResult<THandle = unknown> =
  | { readonly status: "usable"; readonly binding: ExecutorBinding; readonly handle?: THandle | undefined }
  | {
      readonly status: "unusable";
      readonly reason: string;
      readonly needsRebind: boolean;
      readonly observedGeneration?: number | undefined;
    }
  | { readonly status: "none" };

export interface DecisionSessionCreationResult<THandle = unknown> {
  readonly binding: ExecutorBinding;
  readonly handle?: THandle | undefined;
}

export interface DecisionSessionResumeResult<THandle = unknown> {
  readonly binding: ExecutorBinding;
  readonly handle?: THandle | undefined;
}

export interface DecisionExecutionOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  readonly handle?: unknown | undefined;
}

export interface DecisionExecutionOutcome {
  readonly result: DecisionResult;
  readonly rawPayload?: string | undefined;
}

export interface DecisionExecutorAdapter<THandle = unknown> {
  readonly name: string;
  readonly supportedTaskKinds: readonly ("plan" | "review")[];
  readonly supportedContextStrategies: readonly DecisionContextStrategyKind[];

  inspectBinding(
    session: DecisionSession,
    options?: { readonly signal?: AbortSignal | undefined }
  ): Promise<DecisionBindingInspectionResult<THandle>>;

  createSession(
    session: DecisionSession,
    options?: { readonly signal?: AbortSignal | undefined }
  ): Promise<DecisionSessionCreationResult<THandle>>;

  resumeSession(
    session: DecisionSession,
    binding: ExecutorBinding,
    options?: { readonly signal?: AbortSignal | undefined }
  ): Promise<DecisionSessionResumeResult<THandle>>;

  executeTask(
    request: DecisionExecutionRequest,
    options?: DecisionExecutionOptions
  ): Promise<DecisionExecutionOutcome>;

  normalizeResult?(
    rawResult: unknown,
    task: DecisionTask
  ): DecisionResult;
}
