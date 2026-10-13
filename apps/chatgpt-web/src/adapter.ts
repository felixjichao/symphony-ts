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
  findStopButton,
  getAllAssistantTurns,
  countAssistantTurns,
  extractCodeBlocksFromTurn,
  waitForStreamingCompletion,
  extractConversationIdFromUrl,
  extractFormalConversationIdFromUrl,
  buildConversationUrl,
  detectAuthRequired,
  detectConversationNotFound,
  isConversationAssociatedWithBootstrap,
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

// Tool-use commentary can temporarily be stable with no stop button after reload.
// Only result-bearing task turns may finish Plan/Review; extraction remains fail-closed.
function isResultTurn(turn: HTMLElement): boolean {
  return extractCodeBlocksFromTurn(turn).some((block) =>
    block.language.toLowerCase() === "symphony-result"
  ) || /```symphony-result\s/i.test(turn.textContent || "");
}

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

  private async waitForSendButton(signal?: AbortSignal): Promise<HTMLButtonElement> {
    const startedAt = Date.now();
    while (true) {
      if (signal?.aborted) throw new Error("Task execution aborted");
      const button = findSendButton(this.docSupplier());
      if (button && !button.disabled) return button;
      if (Date.now() - startedAt >= this.timeoutMs) {
        throw new DecisionAdapterError({
          code: "execution_failed",
          message: "Send button not ready or disabled",
          suggestedAction: "retry",
        });
      }
      await new Promise((resolve) => setTimeout(resolve, this.checkIntervalMs));
    }
  }

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

  getWindow(): Window | null {
    return this.winSupplier();
  }

  getDocument(): Document {
    return this.docSupplier();
  }

  getOrigin(): string {
    return this.origin;
  }

  getTimeoutMs(): number {
    return this.timeoutMs;
  }

  getStabilizationMs(): number {
    return this.stabilizationMs;
  }

  getCheckIntervalMs(): number {
    return this.checkIntervalMs;
  }

  async waitForBootstrapResponse(options: {
    baselineCount: number;
    baselineTurn?: HTMLElement | null | undefined;
    signal?: AbortSignal | undefined;
    onPoll?: (() => void) | undefined;
  }): Promise<string> {
    const doc = this.docSupplier();
    if (detectConversationNotFound(doc)) {
      throw new DecisionAdapterError({
        code: "binding_broken",
        message: "Conversation not found during bootstrap response wait",
        suggestedAction: "rebind",
      });
    }
    if (detectAuthRequired(doc)) {
      throw new DecisionAdapterError({
        code: "human_required",
        message: "Authentication required during bootstrap response wait",
        suggestedAction: "human_intervention",
      });
    }

    await waitForStreamingCompletion({
      doc,
      baselineCount: options.baselineCount,
      baselineTurn: options.baselineTurn ?? null,
      timeoutMs: this.timeoutMs,
      stabilizationMs: this.stabilizationMs,
      checkIntervalMs: this.checkIntervalMs,
      signal: options.signal,
      onPoll: options.onPoll,
    });

    if (detectConversationNotFound(doc)) {
      throw new DecisionAdapterError({
        code: "binding_broken",
        message: "Conversation not found after bootstrap response wait",
        suggestedAction: "rebind",
      });
    }
    if (detectAuthRequired(doc)) {
      throw new DecisionAdapterError({
        code: "human_required",
        message: "Authentication required after bootstrap response wait",
        suggestedAction: "human_intervention",
      });
    }

    const win = this.winSupplier();
    let convId: string | null = null;
    if (win && win.location) {
      convId = extractFormalConversationIdFromUrl(win.location.href);
    }

    if (!convId) {
      throw new DecisionAdapterError({
        code: "human_required",
        message: "Failed to obtain authoritative conversation reference from ChatGPT Web after session creation",
        suggestedAction: "human_intervention",
        retryable: false,
      });
    }

    return convId;
  }

  /**
   * True only when the tab currently shows the exact conversation recorded for this
   * bootstrap attempt. Page content — including the bootstrap prompt text — is shared by
   * every Symphony-created conversation, so it cannot substitute for the recorded
   * reference: recovery must fail closed instead of binding an ambiguous conversation.
   */
  isBootstrapConversationAssociated(recordedConvId: string | null): boolean {
    return isConversationAssociatedWithBootstrap(
      this.winSupplier()?.location?.href ?? null,
      recordedConvId
    );
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
    const origin = (win?.location as { origin?: string })?.origin || this.origin;
    const newChatUrl = new URL("/", origin).href;

    // 1. Ensure we are starting from a clean new conversation, not an existing thread.
    // Any previously recorded conversation reference is cleared: it belongs to an earlier
    // attempt and must never be matched against the conversation this attempt creates.
    if (win && win.location) {
      const currentConvId = extractConversationIdFromUrl(win.location.href);
      if (currentConvId) {
        // If the browser tab is on an existing conversation, navigate to root / new chat
        this.stepListener?.("navigating", { targetUri: newChatUrl, targetConvId: null });
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
      } else {
        this.stepListener?.("navigating", { targetUri: newChatUrl, targetConvId: null });
      }
    } else {
      this.stepListener?.("navigating", { targetUri: newChatUrl, targetConvId: null });
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
    const sendBtn = await this.waitForSendButton(options.signal);

    const initialTurns = getAllAssistantTurns(doc);
    const baselineCount = initialTurns.length;
    const baselineTurn = initialTurns[initialTurns.length - 1] ?? null;

    this.stepListener?.("bootstrap_submitting", { baselineCount });
    sendBtn.click();
    this.stepListener?.("bootstrap_waiting", { baselineCount, targetConvId: null });

    // Persist the conversation this send creates as soon as its route is observable. The
    // reference is immutable for the attempt: the first conversation route reached after the
    // send is what this attempt created, and any later route is a deviation (human
    // navigation, redirect, restart) that must never re-target the attempt.
    let recordedConvId: string | null = null;
    const recordCreatedConversationRef = () => {
      const currentWin = this.winSupplier();
      if (!currentWin || !currentWin.location) {
        return;
      }
      if (recordedConvId === null) {
        // A cancelled attempt never takes its creation reference from a route observed after
        // the interruption: that route may be an unrelated conversation (user navigation,
        // redirect). Without a recorded reference the recovery fails closed instead.
        if (options.signal?.aborted) {
          return;
        }
        const formalConvId = extractFormalConversationIdFromUrl(currentWin.location.href);
        if (formalConvId) {
          recordedConvId = formalConvId;
          this.stepListener?.("bootstrap_waiting", { targetConvId: formalConvId });
        }
        return;
      }
      // Once the formal reference has been latched, any deviation away from it
      // (whether departing to a temporary route, another conversation route, or
      // a route without conversation ID such as homepage /)
      // must trigger immutable association protection.
      const rawConvId = extractConversationIdFromUrl(currentWin.location.href);
      if (rawConvId !== recordedConvId) {
        throw new DecisionAdapterError({
          code: "human_required",
          message: `ChatGPT Web left the conversation this attempt created ("${recordedConvId}") for "${rawConvId ?? "root"}" while the bootstrap response was pending; refusing to re-target this attempt`,
          suggestedAction: "human_intervention",
          retryable: false,
        });
      }
    };

    const convId = await this.waitForBootstrapResponse({
      baselineCount,
      baselineTurn,
      signal: options.signal,
      onPoll: recordCreatedConversationRef,
    });

    // The reply must have been read from the conversation this attempt created.
    if (recordedConvId !== null && convId !== recordedConvId) {
      throw new DecisionAdapterError({
        code: "human_required",
        message: `ChatGPT Web conversation "${convId}" is not the conversation this attempt created ("${recordedConvId}"); refusing to bind the attempt to another conversation`,
        suggestedAction: "human_intervention",
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

    this.stepListener?.("rebind_submitting", {
      rebindState: {
        newExternalSessionRef: convId,
        newResumeUri: binding.resumeUri,
        expectedGeneration: session.bindingGeneration,
      },
    });

    const handle: ChatGptWebHandle = {
      conversationId: convId,
      bootstrapped: true,
      ...(isRollover ? { isRollover: true } : {}),
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
        this.stepListener?.("navigating", { targetUri: binding.resumeUri, targetConvId });
        win.location.assign(binding.resumeUri);
      }

      // Wait for route to actually match target conversation
      const startWaitRoute = Date.now();
      while (extractConversationIdFromUrl(win.location.href) !== targetConvId) {
        if (options.signal?.aborted) {
          throw new Error("Aborted while waiting for route navigation to conversation");
        }
        if (detectAuthRequired(this.docSupplier())) {
          throw new DecisionAdapterError({
            code: "human_required",
            message: "ChatGPT Web authentication / login required",
            suggestedAction: "human_intervention",
          });
        }
        if (detectConversationNotFound(this.docSupplier())) {
          throw new DecisionAdapterError({
            code: "binding_broken",
            message: `ChatGPT conversation "${targetConvId}" not found or deleted`,
            suggestedAction: "rebind",
            observedGeneration: binding.generation,
          });
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

    // Wait for composer ready on resumed page dynamically, verifying authentic error/auth UI before success
    const startWait = Date.now();
    while (true) {
      if (options.signal?.aborted) {
        throw new Error("Aborted while resuming ChatGPT conversation");
      }
      if (detectAuthRequired(this.docSupplier())) {
        throw new DecisionAdapterError({
          code: "human_required",
          message: "ChatGPT Web authentication / login required",
          suggestedAction: "human_intervention",
        });
      }
      if (detectConversationNotFound(this.docSupplier())) {
        throw new DecisionAdapterError({
          code: "binding_broken",
          message: `ChatGPT conversation "${binding.externalSessionRef}" not found or deleted`,
          suggestedAction: "rebind",
          observedGeneration: binding.generation,
        });
      }
      const composer = findComposerElement(this.docSupplier());
      if (composer) {
        break;
      }
      if (Date.now() - startWait > this.timeoutMs) {
        throw new DecisionAdapterError({
          code: "execution_failed",
          message: "Timeout waiting for ChatGPT prompt composer after session resume",
          suggestedAction: "retry",
        });
      }
      await new Promise((r) => setTimeout(r, this.checkIntervalMs));
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
    const turnCount = countAssistantTurns(doc);
    if (handle?.isRollover || (session.bindingGeneration > 1 && turnCount <= 1)) {
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

    const sendBtn = await this.waitForSendButton(options.signal);

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
      isCompletionCandidate: isResultTurn,
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
      isCompletionCandidate: isResultTurn,
    });

    const result = extractResultFromAssistantTurn(assistantTurn, task);
    return { result };
  }

  isPromptConfirmedSent(docSupplierOrDoc?: Document | (() => Document), baselineCount?: number): boolean {
    const doc =
      typeof docSupplierOrDoc === "function"
        ? docSupplierOrDoc()
        : (docSupplierOrDoc ?? this.docSupplier());
    const count = baselineCount ?? 0;
    if (findStopButton(doc) !== null) return true;
    if (getAllAssistantTurns(doc).length > count) return true;
    return false;
  }

  async confirmPromptSubmitted(options: {
    baselineCount: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const timeout = options.timeoutMs ?? 2000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (options.signal?.aborted) return false;
      if (this.isPromptConfirmedSent(undefined, options.baselineCount)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, Math.min(this.checkIntervalMs, 200)));
    }
    return this.isPromptConfirmedSent(undefined, options.baselineCount);
  }
}
