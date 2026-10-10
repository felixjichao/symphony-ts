/**
 * ChatGPT Web implementation of DecisionExecutorAdapter.
 * Drives ChatGPT Web UI within browser / Tampermonkey context.
 */
import {
  type DecisionExecutorAdapter,
  type DecisionSession,
  type ExecutorBinding,
  type DecisionBindingInspectionResult,
  type DecisionSessionCreationResult,
  type DecisionSessionResumeResult,
  type DecisionExecutionRequest,
  type DecisionExecutionOutcome,
  type DecisionTask,
  type DecisionReviewTask,
  type DecisionContextStrategyKind,
  DecisionAdapterError,
} from "@symphony/domain/decision";
import {
  findComposerElement,
  setComposerText,
  findSendButton,
  getAllAssistantTurns,
  waitForStreamingCompletion,
  extractConversationIdFromUrl,
  buildConversationUrl,
} from "./probes";
import {
  BOOTSTRAP_PROMPT,
  formatContinuationHeader,
  formatPlanPrompt,
  formatReviewPrompt,
  formatHandoffPrompt,
} from "./prompts";
import { extractResultFromAssistantTurn } from "./extractor";
import type { DriverStep } from "./checkpoint";

export interface ChatGptWebAdapterOptions {
  readonly origin?: string | undefined;
  readonly doc?: Document | undefined;
  readonly win?: Window | undefined;
  readonly timeoutMs?: number | undefined;
  readonly stabilizationMs?: number | undefined;
  readonly checkIntervalMs?: number | undefined;
}

export interface ChatGptWebHandle {
  readonly conversationId: string;
  readonly bootstrapped: boolean;
  readonly isRollover?: boolean | undefined;
  previousReviewedSha?: string | null | undefined;
}

export class ChatGptWebAdapter implements DecisionExecutorAdapter {
  readonly name = "chatgpt-web";
  readonly supportedTaskKinds: readonly ("plan" | "review")[] = ["plan", "review"] as const;
  readonly supportedContextStrategies: readonly DecisionContextStrategyKind[] = [
    "connector",
    "materialized",
  ] as const;
  readonly origin: string;
  private readonly docSupplier: () => Document;
  private readonly winSupplier: () => Window | null;
  private readonly timeoutMs: number;
  private readonly stabilizationMs: number;
  private readonly checkIntervalMs: number;
  private stepListener: ((step: DriverStep, meta?: Record<string, unknown>) => void) | null = null;

  constructor(options: ChatGptWebAdapterOptions = {}) {
    this.origin = options.origin ?? "https://chatgpt.com";
    this.docSupplier = () => options.doc ?? (typeof document !== "undefined" ? document : (null as unknown as Document));
    this.winSupplier = () => options.win ?? (typeof window !== "undefined" ? window : null);
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.stabilizationMs = options.stabilizationMs ?? 1000;
    this.checkIntervalMs = options.checkIntervalMs ?? 500;
  }

  setStepListener(listener: ((step: DriverStep, meta?: Record<string, unknown>) => void) | null): void {
    this.stepListener = listener;
  }

  async inspectBinding(
    session: DecisionSession,
    _options: { signal?: AbortSignal | undefined } = {}
  ): Promise<DecisionBindingInspectionResult> {
    if (session.status === "broken-binding") {
      return {
        status: "unusable",
        reason: "DecisionSession status is broken-binding",
        needsRebind: true,
        observedGeneration: session.bindingGeneration,
      };
    }

    if (session.binding === null) {
      return { status: "none" };
    }

    if (session.binding.adapter !== this.name) {
      return {
        status: "unusable",
        reason: `Binding adapter "${session.binding.adapter}" does not match "${this.name}"`,
        needsRebind: true,
        observedGeneration: session.bindingGeneration,
      };
    }

    return {
      status: "usable",
      binding: session.binding,
    };
  }

  async createSession(
    session: DecisionSession,
    options: { signal?: AbortSignal | undefined } = {}
  ): Promise<DecisionSessionCreationResult> {
    const win = this.winSupplier();

    // 1. Ensure we are starting from a clean new conversation, not an existing thread
    if (win && win.location) {
      const currentConvId = extractConversationIdFromUrl(win.location.href);
      if (currentConvId) {
        // If the browser tab is on an existing conversation, navigate to root / new chat
        const origin = (win.location as { origin?: string }).origin || this.origin;
        const newChatUrl = new URL("/", origin).href;
        win.location.assign(newChatUrl);

        // Wait for route to actually change to new chat
        const startWaitRoute = Date.now();
        while (extractConversationIdFromUrl(win.location.href) !== null) {
          if (options.signal?.aborted) {
            throw new Error("Aborted while waiting for route navigation to new chat");
          }
          if (Date.now() - startWaitRoute > this.timeoutMs) {
            throw new DecisionAdapterError({
              code: "execution_failed",
              message: "Timeout waiting for navigation to new chat",
              suggestedAction: "retry",
            });
          }
          await new Promise((r) => setTimeout(r, this.checkIntervalMs));
        }
      }
    }

    // Wait for composer element to be available and ready in dynamic docSupplier
    const startWait = Date.now();
    let composer = findComposerElement(this.docSupplier());
    while (!composer) {
      if (options.signal?.aborted) {
        throw new Error("Aborted while waiting for ChatGPT composer");
      }
      if (Date.now() - startWait > this.timeoutMs) {
        throw new DecisionAdapterError({
          code: "execution_failed",
          message: "ChatGPT prompt composer element not found in DOM",
          suggestedAction: "retry",
        });
      }
      await new Promise((r) => setTimeout(r, this.checkIntervalMs));
      composer = findComposerElement(this.docSupplier());
    }

    setComposerText(composer, BOOTSTRAP_PROMPT);

    const doc = this.docSupplier();
    const sendBtn = findSendButton(doc);
    if (!sendBtn || sendBtn.disabled) {
      throw new DecisionAdapterError({
        code: "execution_failed",
        message: "Send button not ready or disabled",
        suggestedAction: "retry",
      });
    }

    const initialTurns = getAllAssistantTurns(doc);
    const baselineCount = initialTurns.length;
    const baselineTurn = initialTurns[initialTurns.length - 1] ?? null;
    sendBtn.click();

    // Wait for bootstrap response
    await waitForStreamingCompletion({
      doc,
      baselineCount,
      baselineTurn,
      timeoutMs: this.timeoutMs,
      stabilizationMs: this.stabilizationMs,
      checkIntervalMs: this.checkIntervalMs,
      signal: options.signal,
    });

    let convId: string | null = null;
    if (win && win.location) {
      convId = extractConversationIdFromUrl(win.location.href);
    }

    // Must be a real conversation ID from URL. Do NOT synthesize dummy references!
    if (!convId) {
      throw new DecisionAdapterError({
        code: "execution_failed",
        message: "Failed to obtain authoritative conversation reference from ChatGPT Web after session creation",
        suggestedAction: "retry",
      });
    }

    const isRollover = session.bindingGeneration > 0 || session.status === "broken-binding";
    const nextGen = session.bindingGeneration === 0 ? 1 : session.bindingGeneration + 1;
    const binding: ExecutorBinding = {
      schemaVersion: 1,
      adapter: this.name,
      externalSessionRef: convId,
      resumeUri: buildConversationUrl(convId, this.origin),
      generation: nextGen,
    };

    const handle: ChatGptWebHandle = {
      conversationId: convId,
      bootstrapped: true,
      isRollover,
    };

    return {
      binding,
      handle,
    };
  }

  async resumeSession(
    session: DecisionSession,
    binding: ExecutorBinding,
    options: { signal?: AbortSignal | undefined } = {}
  ): Promise<DecisionSessionResumeResult> {
    if (binding.adapter !== this.name) {
      throw new DecisionAdapterError({
        code: "binding_broken",
        message: `Cannot resume binding with adapter "${binding.adapter}"`,
        suggestedAction: "rebind",
        observedGeneration: binding.generation,
      });
    }

    const win = this.winSupplier();
    if (win && win.location && binding.resumeUri) {
      const currentUrl = win.location.href;
      const targetConvId = binding.externalSessionRef;
      const currentConvId = extractConversationIdFromUrl(currentUrl);

      if (currentConvId !== targetConvId && currentUrl !== binding.resumeUri) {
        win.location.assign(binding.resumeUri);
      }

      // Wait for route to actually match target conversation
      const startWaitRoute = Date.now();
      while (extractConversationIdFromUrl(win.location.href) !== targetConvId) {
        if (options.signal?.aborted) {
          throw new Error("Aborted while waiting for route navigation to conversation");
        }
        if (Date.now() - startWaitRoute > this.timeoutMs) {
          throw new DecisionAdapterError({
            code: "execution_failed",
            message: `Timeout waiting for ChatGPT route navigation to conversation "${targetConvId}"`,
            suggestedAction: "retry",
          });
        }
        await new Promise((r) => setTimeout(r, this.checkIntervalMs));
      }
    }

    // Wait for composer ready on resumed page dynamically
    const startWait = Date.now();
    let composer = findComposerElement(this.docSupplier());
    while (!composer) {
      if (options.signal?.aborted) {
        throw new Error("Aborted while resuming ChatGPT conversation");
      }
      if (Date.now() - startWait > this.timeoutMs) {
        throw new DecisionAdapterError({
          code: "execution_failed",
          message: "Timeout waiting for ChatGPT prompt composer after session resume",
          suggestedAction: "retry",
        });
      }
      await new Promise((r) => setTimeout(r, this.checkIntervalMs));
      composer = findComposerElement(this.docSupplier());
    }

    const handle: ChatGptWebHandle = {
      conversationId: binding.externalSessionRef,
      bootstrapped: true,
    };

    return { binding, handle };
  }

  async executeTask(
    request: DecisionExecutionRequest,
    options: { signal?: AbortSignal | undefined; handle?: unknown } = {}
  ): Promise<DecisionExecutionOutcome> {
    const { task, session, context } = request;
    const doc = this.docSupplier();

    const composer = findComposerElement(doc);
    if (!composer) {
      throw new DecisionAdapterError({
        code: "execution_failed",
        message: "Prompt composer element not found in DOM",
        suggestedAction: "retry",
      });
    }

    const handle = options.handle as ChatGptWebHandle | undefined;
    const isContinuation = Boolean(session.binding);
    let prevSha = handle?.previousReviewedSha ?? null;
    if (!prevSha && context.strategy === "materialized" && context.previousReviews.length > 0) {
      const latestPrev = context.previousReviews[context.previousReviews.length - 1];
      if (latestPrev && latestPrev.kind === "review") {
        prevSha = latestPrev.target.headSha;
      }
    }

    let promptText = "";
    if (handle?.isRollover) {
      promptText += formatHandoffPrompt(task, context, session.bindingGeneration);
    } else if (isContinuation) {
      promptText += formatContinuationHeader(task, prevSha);
    }

    if (task.kind === "plan") {
      promptText += formatPlanPrompt(task, context);
    } else if (task.kind === "review") {
      promptText += formatReviewPrompt(task as DecisionReviewTask, context, {
        previousReviewedSha: prevSha,
      });
    } else {
      const unsupportedKind = (task as { kind: string }).kind;
      throw new DecisionAdapterError({
        code: "unsupported_task_kind",
        message: `Task kind "${unsupportedKind}" is not supported`,
        suggestedAction: "fail_closed",
      });
    }

    setComposerText(composer, promptText);

    const sendBtn = findSendButton(doc);
    if (!sendBtn || sendBtn.disabled) {
      throw new DecisionAdapterError({
        code: "execution_failed",
        message: "Send button not ready or disabled",
        suggestedAction: "retry",
      });
    }

    const initialTurns = getAllAssistantTurns(doc);
    const baselineCount = initialTurns.length;
    const baselineTurn = initialTurns[initialTurns.length - 1] ?? null;

    // Report prompt submitting step to listener (e.g. driver checkpoint)
    this.stepListener?.("prompt_submitting", { baselineCount });

    sendBtn.click();

    // Report waiting response step
    this.stepListener?.("waiting_response", { baselineCount });

    // Wait for streaming response to finish and get the specific new turn
    const assistantTurn = await waitForStreamingCompletion({
      doc,
      baselineCount,
      baselineTurn,
      timeoutMs: this.timeoutMs,
      stabilizationMs: this.stabilizationMs,
      checkIntervalMs: this.checkIntervalMs,
      signal: options.signal,
    });

    // Extract structured result
    const result = extractResultFromAssistantTurn(assistantTurn, task);

    // If review task, record evaluated headSha for subsequent continuity
    if (handle && task.kind === "review" && task.target) {
      handle.previousReviewedSha = task.target.headSha;
    }

    return {
      result,
    };
  }

  async waitForExistingResponse(
    task: DecisionTask,
    options: {
      baselineCount: number;
      baselineTurn?: HTMLElement | null | undefined;
      signal?: AbortSignal | undefined;
    }
  ): Promise<DecisionExecutionOutcome> {
    const doc = this.docSupplier();
    const assistantTurn = await waitForStreamingCompletion({
      doc,
      baselineCount: options.baselineCount,
      baselineTurn: options.baselineTurn,
      timeoutMs: this.timeoutMs,
      stabilizationMs: this.stabilizationMs,
      checkIntervalMs: this.checkIntervalMs,
      signal: options.signal,
    });

    const result = extractResultFromAssistantTurn(assistantTurn, task);
    return { result };
  }
}
