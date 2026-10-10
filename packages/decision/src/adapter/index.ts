/**
 * @symphony/decision/adapter — Browser-safe executor adapter primitives and contracts.
 * Zero Node built-in dependencies.
 */

export {
  extractSymphonyResultPayload,
  normalizeDecisionResult,
  extractDecisionResultFromOutput,
  formatSymphonyResultPayload,
} from "./result-extractor";

export {
  FakeDecisionExecutorAdapter,
  type FakeAdapterHandle,
  type FakeAdapterOptions,
} from "./fake-adapter";

export {
  executeTaskWithAdapter,
  type DecisionTaskController,
  type ExecuteTaskWithAdapterOptions,
  type TaskExecutionSuccessOutcome,
  type TaskExecutionFailureOutcome,
  type TaskExecutionOutcome,
} from "./coordinator";

export type {
  SubmissionReceipt,
  DecisionTaskFailure,
} from "../types";
