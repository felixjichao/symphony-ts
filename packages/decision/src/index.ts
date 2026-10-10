/**
 * @symphony/decision — Durable local persistence and localhost-only Web Agent Bridge.
 */

export {
  DECISION_STORE_SCHEMA_VERSION,
  type DecisionStoreRecord,
  type DecisionStoreConfig,
  type DecisionBridgeConfig,
  type DecisionTaskFailure,
  type SubmissionReceipt,
  type OperationReceipt,
  type ClaimTaskRequest,
  type ClaimTaskResponse,
  type StartTaskRequest,
  type HeartbeatTaskRequest,
  type HeartbeatTaskResponse,
  type SubmitResultRequest,
  type SubmitResultResponse,
  type SubmitFailureRequest,
  type SubmitFailureResponse,
  type NextTaskResponse,
  type GetTaskResultResponse,
  type GetTaskReceiptResponse,
  type PutBindingRequest,
  type RebindSessionRequest,
  type CreateSessionRequest,
  type CreateTaskRequest,
  type BridgeErrorEnvelope,
} from "./types.js";

export {
  DecisionStoreError,
  DecisionStoreLockError,
  CorruptedStoreError,
  UnsupportedStoreVersionError,
  StorePoisonedError,
  DecisionConflictError,
  DecisionNotFoundError,
  DecisionValidationError,
  DecisionUnauthorizedError,
  DecisionForbiddenError,
  DecisionPayloadTooLargeError,
} from "./errors.js";

export { canonicalJsonEqual, canonicalJsonStringify } from "./canonical-json.js";
export { StoreLock, type LockMetadata } from "./lock.js";
export {
  DurableDecisionStore,
  createEmptyStoreRecord,
  validateStoreRecord,
  validateDecisionTaskFailure,
  validateSubmissionReceipt,
} from "./store.js";
export { DecisionService } from "./service.js";
export { DecisionBridge } from "./bridge.js";
export { DecisionBridgeClient, type DecisionBridgeClientOptions } from "./client.js";

// Executor adapter abstraction and context strategies (NEST-101 / #96)
export {
  extractSymphonyResultPayload,
  normalizeDecisionResult,
  extractDecisionResultFromOutput,
  formatSymphonyResultPayload,
  FakeDecisionExecutorAdapter,
  type FakeAdapterHandle,
  type FakeAdapterOptions,
  executeTaskWithAdapter,
  type DecisionTaskController,
  type ExecuteTaskWithAdapterOptions,
  type TaskExecutionSuccessOutcome,
  type TaskExecutionFailureOutcome,
  type TaskExecutionOutcome,
} from "./adapter/index.js";

