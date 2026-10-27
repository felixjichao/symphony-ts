import type {
  DecisionExecution,
  DecisionSession,
  DecisionTask,
  DecisionResult,
  DecisionPlanResult,
  DecisionLease,
  DecisionReviewTarget,
  DecisionWorkItemRef,
  DecisionContextBundle,
  DeliveryReviewApprovalResult,
  PlanningEligibilityResult,
  UtcTimestampMs,
} from "@symphony/domain";

export const DECISION_STORE_SCHEMA_VERSION = 1 as const;

export interface DecisionPlanRecord {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly taskId: string;
  readonly revision: number;
  readonly triggerKind: "initial" | "requirements_changed" | "clarification" | "retry";
  readonly requirements: {
    readonly title: string;
    readonly body: string;
    readonly clarifications: readonly string[];
    readonly fingerprint: string;
  };
  readonly previousTaskId: string | null;
  readonly status: "pending" | "running" | "completed" | "failed" | "superseded";
  readonly result: DecisionPlanResult | null;
  readonly publishedCommentId: number | string | null;
  readonly publishedAtMs: number | null;
  readonly createdAtMs: UtcTimestampMs;
  readonly updatedAtMs: UtcTimestampMs;
}

export interface DecisionTaskFailure {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly error: string;
  readonly details: unknown | null;
  readonly retryable: boolean;
  readonly createdAtMs: UtcTimestampMs;
}

export interface SubmissionReceipt {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly type: "result" | "failure";
  readonly claimGeneration: number;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly acceptedAtMs: UtcTimestampMs;
  readonly payload: DecisionResult | DecisionTaskFailure;
  readonly supersededAtMs?: UtcTimestampMs | null | undefined;
}

export interface OperationReceipt {
  readonly schemaVersion: 1;
  readonly operationKey: string;
  readonly kind: "create-plan-task" | "create-review-task" | "rebind-session" | "publish-plan";
  readonly sessionId: string;
  readonly target?: DecisionReviewTarget | null | undefined;
  readonly triggerKind?: string | undefined;
  readonly fingerprint?: string | undefined;
  readonly previousTaskId?: string | null | undefined;
  readonly bindingGeneration?: number | undefined;
  readonly adapter?: string | undefined;
  readonly externalSessionRef?: string | undefined;
  readonly resumeUri?: string | null | undefined;
  readonly expectedGeneration?: number | undefined;
  readonly resultingSession?: DecisionSession | undefined;
  readonly entityId: string;
  readonly createdAtMs: UtcTimestampMs;
}

export interface DecisionStoreRecord {
  readonly schemaVersion: 1;
  readonly transactionSequence: number;
  readonly sessions: Record<string, DecisionSession>;
  readonly tasks: Record<string, DecisionTask>;
  readonly results: Record<string, DecisionResult>;
  readonly failures: Record<string, DecisionTaskFailure>;
  readonly receipts: Record<string, SubmissionReceipt>;
  readonly revisions: Record<string, number>;
  readonly operationReceipts: Record<string, OperationReceipt>;
  readonly contexts: Record<string, DecisionContextBundle>;
  readonly plans: Record<string, DecisionPlanRecord>;
  readonly claimBindingGenerations: Record<string, number>;
  readonly executions?: Record<string, DecisionExecution>;
}

export interface DecisionStoreConfig {
  readonly storeDir: string;
  readonly clock?: (() => UtcTimestampMs) | undefined;
  readonly defaultClaimTtlMs?: number | undefined;
  /** False means an observed stale target; throw a sanitized service error when observation is unavailable. */
  readonly authorizeExecution?: ((task: DecisionTask) => Promise<boolean>) | undefined;
}

export interface DecisionBridgeConfig {
  readonly storeDir: string;
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  readonly authToken?: string | undefined;
  readonly allowedOrigins?: readonly string[] | undefined;
  readonly clock?: (() => UtcTimestampMs) | undefined;
  readonly defaultClaimTtlMs?: number | undefined;
  /** False means an observed stale target; throw a sanitized service error when observation is unavailable. */
  readonly authorizeExecution?: ((task: DecisionTask) => Promise<boolean>) | undefined;
}

export interface ClaimTaskRequest {
  readonly owner: string;
  readonly ttlMs?: number | undefined;
}

export interface ClaimTaskResponse {
  readonly task: DecisionTask;
  readonly session: DecisionSession;
  readonly lease: DecisionLease;
}

export interface StartTaskRequest {
  readonly owner: string;
  readonly token: string;
  readonly generation: number;
}

/** SPEC §4 adjacent / §10 / §12: progress carried by both native and HTTP clients. */
export interface HeartbeatTaskRequest {
  readonly owner: string;
  readonly token: string;
  readonly generation: number;
  readonly ttlMs?: number | undefined;
  readonly progress?: Pick<DecisionExecution, "phase" | "responseLength"> | undefined;
}

export interface HeartbeatTaskResponse {
  readonly expiresAtMs: UtcTimestampMs;
  readonly ttlMs: number;
}

export interface SubmitResultRequest {
  readonly owner: string;
  readonly token: string;
  readonly generation: number;
  readonly result: DecisionResult;
}

export interface SubmitResultResponse {
  readonly receipt: SubmissionReceipt;
  readonly result: DecisionResult;
  readonly superseded: boolean;
}

export interface SubmitFailureRequest {
  readonly owner: string;
  readonly token: string;
  readonly generation: number;
  readonly error: string;
  readonly details?: unknown;
  readonly retryable?: boolean | undefined;
}

export interface SubmitFailureResponse {
  readonly receipt: SubmissionReceipt;
  readonly failure: DecisionTaskFailure;
  readonly superseded: boolean;
}

export interface NextTaskResponse {
  readonly task: DecisionTask;
  readonly session: DecisionSession;
}

export interface GetTaskResultResponse {
  readonly result: DecisionResult;
}

export interface GetTaskReceiptResponse {
  readonly receipt: SubmissionReceipt;
}

export interface PutTaskContextRequest {
  readonly context: DecisionContextBundle;
}

export interface PutTaskContextResponse {
  readonly context: DecisionContextBundle;
}

export interface GetTaskContextResponse {
  readonly context: DecisionContextBundle;
}

export interface PutBindingRequest {
  readonly adapter: string;
  readonly externalSessionRef: string;
  readonly resumeUri: string | null;
  readonly owner?: string | undefined;
  readonly token?: string | undefined;
  readonly generation?: number | undefined;
}

export interface RebindSessionRequest {
  readonly adapter: string;
  readonly externalSessionRef: string;
  readonly resumeUri: string | null;
  readonly expectedGeneration: number;
  readonly operationKey?: string | undefined;
  readonly owner?: string | undefined;
  readonly token?: string | undefined;
  readonly generation?: number | undefined;
}

export interface BreakBindingRequest {
  readonly owner?: string | undefined;
  readonly token?: string | undefined;
  readonly generation?: number | undefined;
  readonly expectedGeneration?: number | undefined;
}

export interface CreateSessionRequest {
  readonly root: DecisionWorkItemRef;
}

export interface CreateTaskRequest {
  readonly sessionId: string;
  readonly kind: "plan" | "review";
  readonly target?: DecisionReviewTarget | undefined;
  readonly operationKey?: string | undefined;
  readonly context?: DecisionContextBundle | undefined;
  readonly supersedeSessionReviews?: boolean | undefined;
  readonly forceNewRevision?: boolean | undefined;
      reuseCompleted?: boolean | undefined;
  readonly triggerKind?: "initial" | "requirements_changed" | "clarification" | "retry" | undefined;
  readonly requirements?: {
    readonly title: string;
    readonly body: string;
    readonly clarifications?: readonly string[] | undefined;
  } | undefined;
  readonly previousTaskId?: string | null | undefined;
}

export interface VerifyReviewApprovalRequest {
  readonly sessionId: string;
  readonly target: DecisionReviewTarget;
  readonly requirements?: {
    readonly title: string;
    readonly body: string;
    readonly clarifications?: readonly string[] | undefined;
  } | undefined;
}

export interface VerifyReviewApprovalResponse {
  readonly approval: DeliveryReviewApprovalResult;
}

export interface VerifyPlanEligibilityRequest {
  readonly sessionId: string;
  readonly requirements?: {
    readonly title: string;
    readonly body: string;
    readonly clarifications?: readonly string[] | undefined;
  } | undefined;
}

export interface VerifyPlanEligibilityResponse {
  readonly eligibility: PlanningEligibilityResult;
}

export interface MarkPlanPublishedRequest {
  readonly commentId?: string | number | undefined;
  readonly publishedAtMs?: number | undefined;
}

export interface MarkPlanPublishedResponse {
  readonly plan: DecisionPlanRecord;
}

export interface GetLatestPlanResponse {
  readonly plan: DecisionPlanRecord | null;
}

export interface GetSessionTasksResponse {
  readonly tasks: readonly DecisionTask[];
}

export interface BridgeErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}
