import type {
  DecisionSession,
  DecisionTask,
  DecisionResult,
  DecisionLease,
  DecisionReviewTarget,
  DecisionWorkItemRef,
  UtcTimestampMs,
} from "@symphony/domain";

export const DECISION_STORE_SCHEMA_VERSION = 1 as const;

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
  readonly acceptedAtMs: UtcTimestampMs;
  readonly payload: DecisionResult | DecisionTaskFailure;
  readonly supersededAtMs?: UtcTimestampMs | null | undefined;
}

export interface OperationReceipt {
  readonly schemaVersion: 1;
  readonly operationKey: string;
  readonly kind: "create-plan-task" | "create-review-task" | "rebind-session";
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
}

export interface DecisionStoreConfig {
  readonly storeDir: string;
  readonly clock?: (() => UtcTimestampMs) | undefined;
  readonly defaultClaimTtlMs?: number | undefined;
}

export interface DecisionBridgeConfig {
  readonly storeDir: string;
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  readonly authToken?: string | undefined;
  readonly allowedOrigins?: readonly string[] | undefined;
  readonly clock?: (() => UtcTimestampMs) | undefined;
  readonly defaultClaimTtlMs?: number | undefined;
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

export interface HeartbeatTaskRequest {
  readonly owner: string;
  readonly token: string;
  readonly generation: number;
  readonly ttlMs?: number | undefined;
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

export interface PutBindingRequest {
  readonly adapter: string;
  readonly externalSessionRef: string;
  readonly resumeUri: string | null;
}

export interface RebindSessionRequest {
  readonly adapter: string;
  readonly externalSessionRef: string;
  readonly resumeUri: string | null;
  readonly expectedGeneration: number;
  readonly operationKey?: string | undefined;
}

export interface CreateSessionRequest {
  readonly root: DecisionWorkItemRef;
}

export interface CreateTaskRequest {
  readonly sessionId: string;
  readonly kind: "plan" | "review";
  readonly target?: DecisionReviewTarget | undefined;
  readonly operationKey: string;
}

export interface BridgeErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}
