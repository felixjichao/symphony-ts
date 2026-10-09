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
  type PutBindingRequest,
  type RebindSessionRequest,
  type CreateSessionRequest,
  type CreateTaskRequest,
  type BridgeErrorEnvelope,
} from "./types";

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
  DecisionPayloadTooLargeError,
} from "./errors";

export { canonicalJsonEqual, canonicalJsonStringify } from "./canonical-json";
export { StoreLock, type LockMetadata } from "./lock";
export {
  DurableDecisionStore,
  createEmptyStoreRecord,
  validateStoreRecord,
  validateDecisionTaskFailure,
  validateSubmissionReceipt,
} from "./store";
export { DecisionService } from "./service";
export { DecisionBridge } from "./bridge";
export { DecisionBridgeClient, type DecisionBridgeClientOptions } from "./client";
