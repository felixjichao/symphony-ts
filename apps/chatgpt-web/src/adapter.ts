import { canonicalJsonStringify } from "./canonical-json";
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
  snapshotConversationNotFoundSignals,
  isConversationAssociatedWithBootstrap,
} from "./probes";
import {
  BOOTSTRAP_PROMPT,
  formatContinuationHeader,
  formatPlanPrompt,
  formatReviewPrompt,
  formatHandoffPrompt,
} from "./prompts";
import { extractResultFromAssistantTurn, extractResponseFromAssistantTurn } from "./extractor";
import type { DriverStep } from "./checkpoint";

// Tool-use commentary can temporarily be stable with no stop button after reload.
// Only result-bearing task turns may finish Plan/Review; extraction remains fail-closed.
function isResultTurn(turn: HTMLElement): boolean {
  return extractCodeBlocksFromTurn(turn).some((block) =>
    block.language.toLowerCase() === "symphony-result"
  ) || /```symphony-result\s/i.test(turn.textContent || "");
}

export const DEFAULT_RESPONSE_TIMEOUT_MS = 15 * 60_000;

export interface ChatGptWebAdapterOptions {
  readonly origin?: string | undefined;
  readonly doc?: Document | undefined;
  readonly win?: Window | undefined;
  readonly timeoutMs?: number | undefined;
  readonly responseTimeoutMs?: number | undefined;
  readonly onResponseWaitState?: ((state: import("./probes").ResponseWaitState & { taskId: string; kind: "plan" | "review"; revision: number }) => void) | undefined;
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
  private readonly responseTimeoutMs: number;
  private readonly onResponseWaitState: ChatGptWebAdapterOptions["onResponseWaitState"];
  private readonly stabilizationMs: number;
  private readonly checkIntervalMs: number;
  private stepListener: ((step: DriverStep, meta?: Record<string, unknown>) => void | Promise<void>) | null = null;
  private responseObservation: {
    task: DecisionTask;
    doc: Document;
    conversationId: string | null;
    baseline: Set<HTMLElement>;
    baselineTexts: Set<string>;
    baselineResults: Set<string>;
    candidate: HTMLElement | null;
    text: string;
    growing: boolean;
  } | null = null;

  private observeTaskResponse(taskId: string, baselineCount: number): HTMLElement | null {
    const observation = this.responseObservation;
    if (!observation || observation.task.id !== taskId || this.docSupplier() !== observation.doc ||
        extractConversationIdFromUrl(this.winSupplier()?.location.href ?? "") !== observation.conversationId) return null;
    const turns = getAllAssistantTurns(observation.doc);
    const candidate = turns.at(-1);
    if (!candidate) return null;
    if (turns.length > baselineCount && !observation.baseline.has(candidate)) return candidate;
    try {
      const result = canonicalJsonStringify(extractResponseFromAssistantTurn(candidate, observation.task));
      if (!observation.baselineResults.has(result)) return candidate;
      return null;
    } catch { /* A streaming response need not contain its final result yet. */ }
    const text = candidate.textContent ?? "";
    if (observation.baseline.has(candidate) || observation.baselineTexts.has(text)) return null;
    // Require observed append growth on the same eligible node while generating.
    // A restored sent checkpoint can observe its current streaming node, but a
    // count change or static re-render alone never proves response growth.
    if (candidate !== observation.candidate) {
      observation.candidate = candidate;
      observation.text = text;
      observation.growing = false;
    } else if (findStopButton(observation.doc) && text.length > observation.text.length && text.startsWith(observation.text)) {
      observation.text = text;
      observation.growing = true;
    }
    return observation.growing ? candidate : null;
  }

  /** Shared with the response waiter; response text remains in memory, never diagnostics/storage. */
  getResponseLength(taskId: string, baselineCount: number): number {
    return this.observeTaskResponse(taskId, baselineCount)?.textContent?.length ?? 0;
  }

  /**
   * Cancellation is cooperative: the step listener may await (driver checkpoint writes,
   * bridge calls), so every await preceding a page-mutating action must re-check the
   * signal. Otherwise Stop issued during the wait is acknowledged by the driver while the
   * already-scheduled Send/navigation still runs.
   */
  private throwIfAborted(signal: AbortSignal | undefined, message: string): void {
    if (signal?.aborted) throw new Error(message);
  }

  private async waitForSendButton(options: {
    signal?: AbortSignal | undefined;
    targetConvId?: string | null | undefined;
    observedGeneration?: number | undefined;
  } = {}): Promise<HTMLButtonElement> {
    const startedAt = Date.now();
    while (true) {
      if (options.signal?.aborted) throw new Error("Task execution aborted");

      const doc = this.docSupplier();
      if (detectAuthRequired(doc)) {
        throw new DecisionAdapterError({
          code: "human_required",
          message: "ChatGPT Web authentication / login required while waiting for send button",
          suggestedAction: "human_intervention",
        });
      }
      if (options.targetConvId) {
        if (detectConversationNotFound(doc)) {
          throw new DecisionAdapterError({
            code: "binding_broken",
            message: `ChatGPT conversation "${options.targetConvId}" not found or deleted while waiting for send button`,
            suggestedAction: "rebind",
            observedGeneration: options.observedGeneration,
            promptSubmitted: false,
          });
        }
        const win = this.winSupplier();
        if (win && win.location) {
          const currentConvId = extractConversationIdFromUrl(win.location.href);
          if (currentConvId !== options.targetConvId) {
            throw new DecisionAdapterError({
              code: "binding_broken",
              message: `ChatGPT navigated away from conversation "${options.targetConvId}" to "${win.location.href}" while waiting for send button`,
              suggestedAction: "rebind",
              observedGeneration: options.observedGeneration,
              promptSubmitted: false,
            });
          }
        }
      }

      const button = findSendButton(doc);
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
    this.onResponseWaitState = options.onResponseWaitState;
    this.responseTimeoutMs = options.responseTimeoutMs ?? options.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.responseTimeoutMs) || this.responseTimeoutMs <= 0 || this.responseTimeoutMs > 2_147_483_647) {
      throw new Error("responseTimeoutMs must be a positive integer <= 2147483647");
    }
    this.stabilizationMs = options.stabilizationMs ?? 1000;
    this.checkIntervalMs = options.checkIntervalMs ?? 500;
  }

  setStepListener(listener: ((step: DriverStep, meta?: Record<string, unknown>) => void | Promise<void>) | null): void {
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
    ignoredConversationNotFoundSignals?: ReadonlySet<string> | undefined;
  }): Promise<string> {
    const doc = this.docSupplier();
    if (detectConversationNotFound(doc, options.ignoredConversationNotFoundSignals)) {
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
      timeoutMs: this.responseTimeoutMs,
      stabilizationMs: this.stabilizationMs,
      checkIntervalMs: this.checkIntervalMs,
      signal: options.signal,
      onPoll: options.onPoll,
      ignoredConversationNotFoundSignals: options.ignoredConversationNotFoundSignals,
    });

    if (detectConversationNotFound(doc, options.ignoredConversationNotFoundSignals)) {
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
    // A page-level denial toast belongs to the previous conversation and may remain visible
    // while ChatGPT opens a fresh conversation. Ignore only matching signals present before
    // this creation attempt; new errors during bootstrap remain fatal.
    const ignoredConversationNotFoundSignals = snapshotConversationNotFoundSignals(this.docSupplier());
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
        await this.stepListener?.("navigating", { targetUri: newChatUrl, targetConvId: null });
        this.throwIfAborted(options.signal, "Aborted before navigating to new chat");
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
        await this.stepListener?.("navigating", { targetUri: newChatUrl, targetConvId: null });
      }
    } else {
      await this.stepListener?.("navigating", { targetUri: newChatUrl, targetConvId: null });
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
    const sendBtn = await this.waitForSendButton({ signal: options.signal });

    const initialTurns = getAllAssistantTurns(doc);
    const baselineCount = initialTurns.length;
    const baselineTurn = initialTurns[initialTurns.length - 1] ?? null;

    await this.stepListener?.("bootstrap_submitting", { baselineCount });
    // The listener await may have taken arbitrarily long (checkpoint/bridge I/O). Nothing has
    // been sent yet, so a Stop or a page that left the new-chat route must cancel the click
    // instead of sending a bootstrap prompt into an unexpected conversation.
    this.throwIfAborted(options.signal, "Aborted before sending the bootstrap prompt");
    const bootstrapRouteConvId = win?.location ? extractConversationIdFromUrl(win.location.href) : null;
    if (bootstrapRouteConvId !== null) {
      throw new DecisionAdapterError({
        code: "execution_failed",
        message: `ChatGPT Web left the new-chat route for conversation "${bootstrapRouteConvId}" while the bootstrap prompt was pending; refusing to send`,
        suggestedAction: "retry",
        promptSubmitted: false,
      });
    }
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
      ignoredConversationNotFoundSignals,
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

    const targetConvId = binding.externalSessionRef;
    const win = this.winSupplier();
    if (win && win.location && binding.resumeUri) {
      const currentUrl = win.location.href;
      const currentConvId = extractConversationIdFromUrl(currentUrl);

      if (currentConvId !== targetConvId && currentUrl !== binding.resumeUri) {
        await this.stepListener?.("navigating", { targetUri: binding.resumeUri, targetConvId });
        this.throwIfAborted(options.signal, "Aborted before navigating to the bound conversation");
        // Re-read the page after the listener await: a Stop or an already-satisfied route
        // must not be turned into a navigation away from the current page.
        if (extractConversationIdFromUrl(win.location.href) !== targetConvId && win.location.href !== binding.resumeUri) {
          win.location.assign(binding.resumeUri);
        }
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
            code: "binding_broken",
            message: `Timeout waiting for ChatGPT route navigation to conversation "${targetConvId}"`,
            suggestedAction: "rebind",
            observedGeneration: binding.generation,
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
      if (win && win.location && extractConversationIdFromUrl(win.location.href) !== targetConvId) {
        throw new DecisionAdapterError({
          code: "binding_broken",
          message: `ChatGPT navigated away from conversation "${targetConvId}" to "${win.location.href}"`,
          suggestedAction: "rebind",
          observedGeneration: binding.generation,
        });
      }
      const composer = findComposerElement(this.docSupplier());
      if (composer) {
        // Verify route and health stability before confirming resume:
        // Client-side router might render a lingering shell composer before redirecting to root
        // or popping up an asynchronous access-denied error dialog.
        const stabilizationTimeout = Math.min(this.stabilizationMs, 500);
        if (stabilizationTimeout > 0) {
          const stabStart = Date.now();
          while (Date.now() - stabStart < stabilizationTimeout) {
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
            if (win && win.location && extractConversationIdFromUrl(win.location.href) !== targetConvId) {
              throw new DecisionAdapterError({
                code: "binding_broken",
                message: `ChatGPT navigated away from conversation "${targetConvId}" to "${win.location.href}"`,
                suggestedAction: "rebind",
                observedGeneration: binding.generation,
              });
            }
            await new Promise((r) => setTimeout(r, Math.min(this.checkIntervalMs, 200)));
          }
        }
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

    const targetConvId = session.binding?.externalSessionRef ?? null;
    const win = this.winSupplier();
    if (detectAuthRequired(doc)) {
      throw new DecisionAdapterError({
        code: "human_required",
        message: "ChatGPT Web authentication / login required before execution",
        suggestedAction: "human_intervention",
      });
    }
    if (targetConvId && detectConversationNotFound(doc)) {
      throw new DecisionAdapterError({
        code: "binding_broken",
        message: `ChatGPT conversation "${targetConvId}" not found or inaccessible before execution`,
        suggestedAction: "rebind",
        observedGeneration: session.bindingGeneration,
        promptSubmitted: false,
      });
    }
    if (targetConvId && win && win.location) {
      const currentConvId = extractConversationIdFromUrl(win.location.href);
      if (currentConvId !== targetConvId) {
        throw new DecisionAdapterError({
          code: "binding_broken",
          message: `ChatGPT navigated away from bound conversation "${targetConvId}" to "${win.location.href}" before execution`,
          suggestedAction: "rebind",
          observedGeneration: session.bindingGeneration,
          promptSubmitted: false,
        });
      }
    }

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

    const sendBtn = await this.waitForSendButton({
      signal: options.signal,
      targetConvId,
      observedGeneration: session.bindingGeneration,
    });

    const initialTurns = getAllAssistantTurns(doc);
    const baselineCount = initialTurns.length;
    const baselineTurn = initialTurns[initialTurns.length - 1] ?? null;

    const baselineTexts = new Set(initialTurns.map(turn => turn.textContent ?? ""));
    const baselineResults = new Set(initialTurns.flatMap(turn => {
      try { return [canonicalJsonStringify(extractResponseFromAssistantTurn(turn, task))]; } catch { return []; }
    }));

    // Report prompt submitting step to listener (e.g. driver checkpoint)
    await this.stepListener?.("prompt_submitting", { baselineCount });

    // The listener await may have taken arbitrarily long (checkpoint/bridge I/O). The prompt is
    // typed but not sent, so Stop or a page that moved off the bound conversation must abort
    // here: promptSubmitted stays false and the task can be retried without a duplicate prompt.
    this.throwIfAborted(options.signal, "Aborted before sending the task prompt");
    if (targetConvId) {
      const currentWin = this.winSupplier();
      const currentConvId = currentWin?.location ? extractConversationIdFromUrl(currentWin.location.href) : null;
      if (currentConvId !== targetConvId) {
        throw new DecisionAdapterError({
          code: "binding_broken",
          message: `ChatGPT left bound conversation "${targetConvId}" for "${currentConvId ?? "root"}" while the task prompt was pending; refusing to send`,
          suggestedAction: "rebind",
          observedGeneration: session.bindingGeneration,
          promptSubmitted: false,
        });
      }
    }

    sendBtn.click();

    this.responseObservation = { task, doc, conversationId: targetConvId,
      baseline: new Set(initialTurns), baselineTexts,
      baselineResults, candidate: null, text: "", growing: false };

    // Report waiting response step
    this.stepListener?.("waiting_response", { baselineCount });

    // Wait for streaming response to finish and get the specific new turn
    const assistantTurn = await waitForStreamingCompletion({
      doc,
      baselineCount,
      baselineTurn,
      timeoutMs: this.responseTimeoutMs,
      stabilizationMs: this.stabilizationMs,
      checkIntervalMs: this.checkIntervalMs,
      signal: options.signal,
      isCompletionCandidate: isResultTurn,
      isNewResponse: () => this.observeTaskResponse(task.id, baselineCount) !== null,
      matchesExpectedResult: turn => {
        try { return !baselineResults.has(canonicalJsonStringify(extractResponseFromAssistantTurn(turn, task))); } catch { return false; }
      },
      onState: state => this.onResponseWaitState?.({ ...state, taskId: task.id, kind: task.kind, revision: task.revision }),
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
    const olderTurns = getAllAssistantTurns(doc).slice(0, -1);
    this.responseObservation = { task, doc, conversationId: extractConversationIdFromUrl(this.winSupplier()?.location.href ?? ""),
      baseline: new Set(olderTurns), baselineTexts: new Set(olderTurns.map(turn => turn.textContent ?? "")),
      baselineResults: new Set(), candidate: null, text: "", growing: false };
    const assistantTurn = await waitForStreamingCompletion({
      doc,
      baselineCount: options.baselineCount,
      baselineTurn: options.baselineTurn,
      timeoutMs: this.responseTimeoutMs,
      stabilizationMs: this.stabilizationMs,
      checkIntervalMs: this.checkIntervalMs,
      signal: options.signal,
      isCompletionCandidate: isResultTurn,
      isNewResponse: () => this.observeTaskResponse(task.id, options.baselineCount) !== null,
      matchesExpectedResult: turn => {
        try { extractResponseFromAssistantTurn(turn, task); return true; } catch { return false; }
      },
      onState: state => this.onResponseWaitState?.({ ...state, taskId: task.id, kind: task.kind, revision: task.revision }),
    });

    const result = extractResultFromAssistantTurn(assistantTurn, task);
    return { result };
  }

  isPromptConfirmedSent(docSupplierOrDoc?: Document | (() => Document), baselineCount?: number, task?: DecisionTask): boolean {
    const doc =
      typeof docSupplierOrDoc === "function"
        ? docSupplierOrDoc()
        : (docSupplierOrDoc ?? this.docSupplier());
    const count = baselineCount ?? 0;
    if (findStopButton(doc) !== null) return true;
    if (getAllAssistantTurns(doc).length > count) return true;
    const candidate = getAllAssistantTurns(doc).at(-1);
    if (task && candidate) {
      try { extractResponseFromAssistantTurn(candidate, task); return true; } catch { /* Exact-task results only. */ }
    }
    return false;
  }

  async confirmPromptSubmitted(options: {
    baselineCount: number;
    task?: DecisionTask;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const timeout = options.timeoutMs ?? 2000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (options.signal?.aborted) return false;
      if (this.isPromptConfirmedSent(undefined, options.baselineCount, options.task)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, Math.min(this.checkIntervalMs, 200)));
    }
    return this.isPromptConfirmedSent(undefined, options.baselineCount, options.task);
  }
}
