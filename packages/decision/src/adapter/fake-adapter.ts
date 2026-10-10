/**
 * Provider-neutral fake executor adapter for tests and local demonstrations.
 * Demonstrates the full adapter lifecycle without requiring browser or external credentials.
 * Zero Node built-in dependencies (safe for browser environments).
 */
import {
  type DecisionSession,
  type DecisionTask,
  type DecisionResult,
  type ExecutorBinding,
  type DecisionContextStrategyKind,
  type DecisionExecutionRequest,
  type DecisionExecutorAdapter,
  type DecisionBindingInspectionResult,
  type DecisionSessionCreationResult,
  type DecisionSessionResumeResult,
  type DecisionExecutionOptions,
  type DecisionExecutionOutcome,
  type DecisionPlanResult,
  type DecisionReviewResult,
  DecisionAdapterError,
  validateDecisionContextForTask,
} from "@symphony/domain/decision";
import {
  extractDecisionResultFromOutput,
  normalizeDecisionResult,
  formatSymphonyResultPayload,
} from "./result-extractor";

export interface FakeAdapterHandle {
  readonly adapterName: string;
  readonly externalSessionRef: string;
  readonly resumeUri: string | null;
}

export interface FakeAdapterOptions {
  readonly name?: string | undefined;
  readonly supportedTaskKinds?: readonly ("plan" | "review")[] | undefined;
  readonly supportedContextStrategies?: readonly DecisionContextStrategyKind[] | undefined;
  /** Injected handler for custom executeTask logic */
  readonly executeHandler?: (
    request: DecisionExecutionRequest,
    options?: DecisionExecutionOptions
  ) => Promise<DecisionExecutionOutcome>;
  /** Injected raw markdown text to return and parse via extractDecisionResultFromOutput */
  readonly rawTextOutput?: string | undefined;
  /** Injected result object to return */
  readonly fixedResult?: DecisionResult | undefined;
  /** Injected error to throw in executeTask */
  readonly executeError?: Error | undefined;
  /** Injected binding inspection behavior */
  readonly inspectBindingStatus?: "usable" | "unusable" | "none" | undefined;
  readonly inspectBindingReason?: string | undefined;
  readonly inspectBindingNeedsRebind?: boolean | undefined;
  /** Injected error in binding inspection */
  readonly inspectError?: Error | undefined;
  /** Injected error in session creation */
  readonly createSessionError?: Error | undefined;
  /** Injected error in session resumption */
  readonly resumeSessionError?: Error | undefined;
  /** Injected error in session creation or resumption */
  readonly sessionError?: Error | undefined;
  /** Custom clock */
  readonly clock?: () => number;
}

export class FakeDecisionExecutorAdapter implements DecisionExecutorAdapter<FakeAdapterHandle> {
  readonly name: string;
  readonly supportedTaskKinds: readonly ("plan" | "review")[];
  readonly supportedContextStrategies: readonly DecisionContextStrategyKind[];

  private readonly options: FakeAdapterOptions;
  private readonly clock: () => number;

  readonly inspectCalls: DecisionSession[] = [];
  readonly createSessionCalls: DecisionSession[] = [];
  readonly resumeSessionCalls: { session: DecisionSession; binding: ExecutorBinding }[] = [];
  readonly executeTaskCalls: DecisionExecutionRequest[] = [];

  constructor(options: FakeAdapterOptions = {}) {
    this.options = options;
    this.name = options.name ?? "fake-executor";
    this.supportedTaskKinds = options.supportedTaskKinds ?? ["plan", "review"];
    this.supportedContextStrategies = options.supportedContextStrategies ?? ["connector", "materialized"];
    this.clock = options.clock ?? (() => Date.now());
  }

  async inspectBinding(
    session: DecisionSession,
    options?: { readonly signal?: AbortSignal | undefined }
  ): Promise<DecisionBindingInspectionResult<FakeAdapterHandle>> {
    options?.signal?.throwIfAborted();
    this.inspectCalls.push(session);

    if (this.options.inspectError) {
      throw this.options.inspectError;
    }

    if (this.options.sessionError) {
      throw this.options.sessionError;
    }

    if (this.options.inspectBindingStatus !== undefined) {
      if (this.options.inspectBindingStatus === "usable" && session.binding !== null) {
        return {
          status: "usable",
          binding: session.binding,
          handle: {
            adapterName: this.name,
            externalSessionRef: session.binding.externalSessionRef,
            resumeUri: session.binding.resumeUri,
          },
        };
      }
      if (this.options.inspectBindingStatus === "unusable") {
        return {
          status: "unusable",
          reason: this.options.inspectBindingReason ?? "Injected unusable binding state",
          needsRebind: this.options.inspectBindingNeedsRebind ?? true,
          observedGeneration: session.binding?.generation ?? session.bindingGeneration,
        };
      }
      return { status: "none" };
    }

    if (session.binding === null) {
      return { status: "none" };
    }

    if (session.binding.adapter !== this.name) {
      return {
        status: "unusable",
        reason: `Adapter mismatch: session bound to ${session.binding.adapter}, expected ${this.name}`,
        needsRebind: this.options.inspectBindingNeedsRebind ?? true,
        observedGeneration: session.binding.generation,
      };
    }

    return {
      status: "usable",
      binding: session.binding,
      handle: {
        adapterName: this.name,
        externalSessionRef: session.binding.externalSessionRef,
        resumeUri: session.binding.resumeUri,
      },
    };
  }

  async createSession(
    session: DecisionSession,
    options?: { readonly signal?: AbortSignal | undefined }
  ): Promise<DecisionSessionCreationResult<FakeAdapterHandle>> {
    options?.signal?.throwIfAborted();
    this.createSessionCalls.push(session);

    if (this.options.createSessionError) {
      throw this.options.createSessionError;
    }

    if (this.options.sessionError) {
      throw this.options.sessionError;
    }

    const nextGen = session.bindingGeneration === 0 ? 1 : session.bindingGeneration + 1;
    const sessionSuffix = `${session.id.replace(/[^a-zA-Z0-9-]/g, "_")}-${nextGen}`;
    const binding: ExecutorBinding = {
      schemaVersion: 1,
      adapter: this.name,
      externalSessionRef: `ext-sess-${sessionSuffix}`,
      resumeUri: `https://fake.executor.local/chat/${sessionSuffix}`,
      generation: nextGen,
    };

    return {
      binding,
      handle: {
        adapterName: this.name,
        externalSessionRef: binding.externalSessionRef,
        resumeUri: binding.resumeUri,
      },
    };
  }

  async resumeSession(
    session: DecisionSession,
    binding: ExecutorBinding,
    options?: { readonly signal?: AbortSignal | undefined }
  ): Promise<DecisionSessionResumeResult<FakeAdapterHandle>> {
    options?.signal?.throwIfAborted();
    this.resumeSessionCalls.push({ session, binding });

    if (this.options.resumeSessionError) {
      throw this.options.resumeSessionError;
    }

    if (this.options.sessionError) {
      throw this.options.sessionError;
    }

    if (binding.adapter !== this.name) {
      throw new DecisionAdapterError({
        code: "binding_broken",
        message: `Cannot resume session with foreign adapter: ${binding.adapter}`,
        suggestedAction: "rebind",
        observedGeneration: binding.generation,
      });
    }

    return {
      binding,
      handle: {
        adapterName: this.name,
        externalSessionRef: binding.externalSessionRef,
        resumeUri: binding.resumeUri,
      },
    };
  }

  async executeTask(
    request: DecisionExecutionRequest,
    options?: DecisionExecutionOptions
  ): Promise<DecisionExecutionOutcome> {
    options?.signal?.throwIfAborted();
    this.executeTaskCalls.push(request);

    const { task, context } = request;

    // Check supported task kind
    if (!this.supportedTaskKinds.includes(task.kind)) {
      throw new DecisionAdapterError({
        code: "unsupported_task_kind",
        message: `Task kind "${task.kind}" is not supported by adapter "${this.name}"`,
      });
    }

    // Check supported context strategy
    if (!this.supportedContextStrategies.includes(context.strategy)) {
      throw new DecisionAdapterError({
        code: "unsupported_strategy",
        message: `Context strategy "${context.strategy}" is not supported by adapter "${this.name}"`,
      });
    }

    // Validate context against task
    try {
      validateDecisionContextForTask(context, task);
    } catch (err) {
      throw new DecisionAdapterError({
        code: "malformed_output",
        message: `Context validation error: ${(err as Error).message}`,
        cause: err,
      });
    }

    // Injected error
    if (this.options.executeError) {
      throw this.options.executeError;
    }

    // Injected custom handler
    if (this.options.executeHandler) {
      return await this.options.executeHandler(request, options);
    }

    // Injected raw text
    if (this.options.rawTextOutput !== undefined) {
      const result = extractDecisionResultFromOutput(this.options.rawTextOutput, task);
      return { result, rawPayload: this.options.rawTextOutput };
    }

    // Injected fixed result
    if (this.options.fixedResult !== undefined) {
      const result = normalizeDecisionResult(this.options.fixedResult, task);
      return { result };
    }

    // Default synthesis
    const now = Math.max(this.clock(), task.updatedAtMs);

    let defaultResult: DecisionResult;
    if (task.kind === "plan") {
      const planRes: DecisionPlanResult = {
        schemaVersion: 1,
        taskId: task.id,
        sessionId: task.sessionId,
        kind: "plan",
        revision: task.revision,
        verdict: "ready",
        content: {
          plan: "1. Define contracts\n2. Add test suite\n3. Pass all gates",
          acceptanceCriteria: ["Tests pass", "Fail-closed semantics proven"],
          risks: ["Concurrency edge cases"],
          clarifications: [],
        },
        createdAtMs: now,
      };
      defaultResult = planRes;
    } else {
      const reviewRes: DecisionReviewResult = {
        schemaVersion: 1,
        taskId: task.id,
        sessionId: task.sessionId,
        kind: "review",
        revision: task.revision,
        verdict: "approve",
        target: task.target,
        findings: [],
        createdAtMs: now,
      };
      defaultResult = reviewRes;
    }

    // Format as fenced block and round-trip through extractor to test end-to-end extraction
    const rawPayload = formatSymphonyResultPayload(defaultResult);
    const parsedResult = extractDecisionResultFromOutput(rawPayload, task);

    return {
      result: parsedResult,
      rawPayload,
    };
  }

  normalizeResult(rawResult: unknown, task: DecisionTask): DecisionResult {
    return normalizeDecisionResult(rawResult, task);
  }
}
