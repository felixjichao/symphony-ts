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
  type DecisionReviewTask,
  type DecisionContextStrategyKind,
  DecisionAdapterError,
} from "@symphony/domain/decision";
import {
  findComposerElement,
  setComposerText,
  findSendButton,
  findLatestAssistantTurn,
  waitForStreamingCompletion,
  extractConversationIdFromUrl,
  buildConversationUrl,
} from "./probes";
import {
  BOOTSTRAP_PROMPT,
  formatContinuationHeader,
  formatPlanPrompt,
  formatReviewPrompt,
} from "./prompts";
import { extractResultFromAssistantTurn } from "./extractor";

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

  constructor(options: ChatGptWebAdapterOptions = {}) {
    this.origin = options.origin ?? "https://chatgpt.com";
    this.docSupplier = () => options.doc ?? (typeof document !== "undefined" ? document : (null as unknown as Document));
    this.winSupplier = () => options.win ?? (typeof window !== "undefined" ? window : null);
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.stabilizationMs = options.stabilizationMs ?? 1000;
    this.checkIntervalMs = options.checkIntervalMs ?? 500;
  }

  async inspectBinding(
    session: DecisionSession,
    _options: { signal?: AbortSignal | undefined } = {}
  ): Promise<DecisionBindingInspectionResult> {
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

    if (session.status === "broken-binding") {
      return {
        status: "unusable",
        reason: "DecisionSession status is broken-binding",
        needsRebind: true,
        observedGeneration: session.bindingGeneration,
      };
    }

    // Check if we are currently on the correct conversation URL if window is available
    const win = this.winSupplier();
    if (win && win.location) {
      const currentConvId = extractConversationIdFromUrl(win.location.href);
      if (currentConvId && currentConvId !== session.binding.externalSessionRef) {
        return {
          status: "unusable",
          reason: `Browser tab is on conversation "${currentConvId}", but binding expects "${session.binding.externalSessionRef}"`,
          needsRebind: true,
          observedGeneration: session.bindingGeneration,
        };
      }
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
    const doc = this.docSupplier();
    const win = this.winSupplier();

    const composer = findComposerElement(doc);
    if (!composer) {
      throw new DecisionAdapterError({
        code: "execution_failed",
        message: "ChatGPT prompt composer element not found in DOM",
        suggestedAction: "retry",
      });
    }

    setComposerText(composer, BOOTSTRAP_PROMPT);

    const sendBtn = findSendButton(doc);
    if (!sendBtn || sendBtn.disabled) {
      throw new DecisionAdapterError({
        code: "execution_failed",
        message: "Send button not ready or disabled",
        suggestedAction: "retry",
      });
    }

    sendBtn.click();

    // Wait for bootstrap response
    await waitForStreamingCompletion({
      doc,
      timeoutMs: this.timeoutMs,
      stabilizationMs: this.stabilizationMs,
      checkIntervalMs: this.checkIntervalMs,
      signal: options.signal,
    });

    let convId: string | null = null;
    if (win && win.location) {
      convId = extractConversationIdFromUrl(win.location.href);
    }
    if (!convId) {
      convId = `chatgpt-conv-${Date.now()}`;
    }

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
    };

    return {
      binding,
      handle,
    };
  }

  async resumeSession(
    session: DecisionSession,
    binding: ExecutorBinding,
    _options: { signal?: AbortSignal | undefined } = {}
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

      if (currentConvId !== targetConvId && win.location.href !== binding.resumeUri) {
        // In real browser, location.assign triggers a full page navigation
        win.location.assign(binding.resumeUri);
      }
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
    if (isContinuation) {
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

    sendBtn.click();

    // Wait for streaming response to finish
    await waitForStreamingCompletion({
      doc,
      timeoutMs: this.timeoutMs,
      stabilizationMs: this.stabilizationMs,
      checkIntervalMs: this.checkIntervalMs,
      signal: options.signal,
    });

    const assistantTurn = findLatestAssistantTurn(doc);
    if (!assistantTurn) {
      throw new DecisionAdapterError({
        code: "malformed_output",
        message: "No assistant response turn found in DOM",
        suggestedAction: "fail_closed",
      });
    }

    // Extract structured result
    let result;
    try {
      result = extractResultFromAssistantTurn(assistantTurn, task);
    } catch (err: unknown) {
      if (err instanceof DecisionAdapterError) {
        throw err;
      }
      throw new DecisionAdapterError({
        code: "malformed_output",
        message: `Failed to extract valid decision result: ${(err as Error).message}`,
        suggestedAction: "fail_closed",
      });
    }

    if (handle && task.kind === "review") {
      handle.previousReviewedSha = (task as DecisionReviewTask).target.headSha;
    }

    return {
      result,
      rawPayload: assistantTurn.textContent ?? undefined,
    };
  }
}
