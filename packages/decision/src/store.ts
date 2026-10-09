import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import {
  parseDecisionSession,
  parseDecisionTask,
  parseDecisionResult,
  parseDecisionReviewTarget,
  type DecisionSession,
  type DecisionTask,
  type DecisionResult,
} from "@symphony/domain";
import {
  CorruptedStoreError,
  StorePoisonedError,
  UnsupportedStoreVersionError,
  DecisionValidationError,
} from "./errors";
import { canonicalJsonEqual } from "./canonical-json";
import { StoreLock } from "./lock";
import {
  DECISION_STORE_SCHEMA_VERSION,
  type DecisionStoreConfig,
  type DecisionStoreRecord,
  type DecisionTaskFailure,
  type SubmissionReceipt,
  type OperationReceipt,
} from "./types";

export function validateDecisionTaskFailure(value: unknown): DecisionTaskFailure {
  if (typeof value !== "object" || value === null) {
    throw new DecisionValidationError("Expected task failure object");
  }
  const f = value as Record<string, unknown>;
  if (f["schemaVersion"] !== 1) {
    throw new DecisionValidationError("Invalid failure schemaVersion");
  }
  if (typeof f["taskId"] !== "string" || f["taskId"].trim() === "") {
    throw new DecisionValidationError("Invalid failure taskId");
  }
  if (typeof f["sessionId"] !== "string" || f["sessionId"].trim() === "") {
    throw new DecisionValidationError("Invalid failure sessionId");
  }
  if (typeof f["revision"] !== "number" || !Number.isSafeInteger(f["revision"]) || f["revision"] < 1) {
    throw new DecisionValidationError("Invalid failure revision");
  }
  if (typeof f["error"] !== "string" || f["error"].trim() === "") {
    throw new DecisionValidationError("Invalid failure error message");
  }
  if (typeof f["retryable"] !== "boolean") {
    throw new DecisionValidationError("Invalid failure retryable flag");
  }
  if (typeof f["createdAtMs"] !== "number" || !Number.isSafeInteger(f["createdAtMs"])) {
    throw new DecisionValidationError("Invalid failure createdAtMs");
  }
  return value as DecisionTaskFailure;
}

export function validateSubmissionReceipt(value: unknown): SubmissionReceipt {
  if (typeof value !== "object" || value === null) {
    throw new DecisionValidationError("Expected submission receipt object");
  }
  const r = value as Record<string, unknown>;
  if (r["schemaVersion"] !== 1) {
    throw new DecisionValidationError("Invalid receipt schemaVersion");
  }
  if (typeof r["taskId"] !== "string" || r["taskId"].trim() === "") {
    throw new DecisionValidationError("Invalid receipt taskId");
  }
  if (r["type"] !== "result" && r["type"] !== "failure") {
    throw new DecisionValidationError("Invalid receipt type");
  }
  if (typeof r["claimGeneration"] !== "number" || r["claimGeneration"] < 1) {
    throw new DecisionValidationError("Invalid receipt claimGeneration");
  }
  if (typeof r["claimOwner"] !== "string" || r["claimOwner"].trim() === "") {
    throw new DecisionValidationError("Invalid receipt claimOwner");
  }
  if (typeof r["claimToken"] !== "string" || r["claimToken"].trim() === "") {
    throw new DecisionValidationError("Invalid receipt claimToken");
  }
  if (typeof r["acceptedAtMs"] !== "number" || !Number.isSafeInteger(r["acceptedAtMs"])) {
    throw new DecisionValidationError("Invalid receipt acceptedAtMs");
  }
  if (r["type"] === "result") {
    parseDecisionResult(r["payload"]);
  } else {
    validateDecisionTaskFailure(r["payload"]);
  }
  return value as SubmissionReceipt;
}

export function validateStoreRecord(record: DecisionStoreRecord): void {
  if (typeof record !== "object" || record === null) {
    throw new CorruptedStoreError("Expected store record object");
  }
  if (record.schemaVersion !== DECISION_STORE_SCHEMA_VERSION) {
    throw new UnsupportedStoreVersionError(record.schemaVersion);
  }
  if (typeof record.transactionSequence !== "number" || record.transactionSequence < 0) {
    throw new CorruptedStoreError("Invalid transaction sequence");
  }
  if (typeof record.sessions !== "object" || record.sessions === null) {
    throw new CorruptedStoreError("sessions table must be an object");
  }
  if (typeof record.tasks !== "object" || record.tasks === null) {
    throw new CorruptedStoreError("tasks table must be an object");
  }
  if (typeof record.results !== "object" || record.results === null) {
    throw new CorruptedStoreError("results table must be an object");
  }
  if (typeof record.failures !== "object" || record.failures === null) {
    throw new CorruptedStoreError("failures table must be an object");
  }
  if (typeof record.receipts !== "object" || record.receipts === null) {
    throw new CorruptedStoreError("receipts table must be an object");
  }
  if (typeof record.revisions !== "object" || record.revisions === null) {
    throw new CorruptedStoreError("revisions table must be an object");
  }
  if (typeof record.operationReceipts !== "object" || record.operationReceipts === null) {
    throw new CorruptedStoreError("operationReceipts table must be an object");
  }

  // Validate sessions
  for (const [key, session] of Object.entries(record.sessions)) {
    if (key !== session.id) {
      throw new CorruptedStoreError(`Session key "${key}" does not match session id "${session.id}"`);
    }
    parseDecisionSession(session);
  }

  // Validate tasks
  for (const [key, task] of Object.entries(record.tasks)) {
    if (key !== task.id) {
      throw new CorruptedStoreError(`Task key "${key}" does not match task id "${task.id}"`);
    }
    parseDecisionTask(task);
    if (!record.sessions[task.sessionId]) {
      throw new CorruptedStoreError(`Task ${task.id} references non-existent session ${task.sessionId}`);
    }
  }

  // Validate revisions table
  for (const [revKey, revVal] of Object.entries(record.revisions)) {
    if (typeof revVal !== "number" || !Number.isSafeInteger(revVal) || revVal < 0) {
      throw new CorruptedStoreError(`Invalid revision value for key "${revKey}"`);
    }
  }

  // Check that every task's revision is <= the stored revision for its revision key
  for (const task of Object.values(record.tasks)) {
    const revKey =
      task.kind === "plan"
        ? `plan:${task.sessionId}`
        : `review:${task.sessionId}:${task.target.repository}:${task.target.prNumber}`;
    const storedRev = record.revisions[revKey];
    if (storedRev === undefined || storedRev < task.revision) {
      throw new CorruptedStoreError(
        `Task "${task.id}" has revision ${task.revision} but store revision index has ${storedRev ?? "undefined"}`
      );
    }
  }

  // Validate results
  for (const [key, result] of Object.entries(record.results)) {
    if (key !== result.taskId) {
      throw new CorruptedStoreError(`Result key "${key}" does not match result.taskId "${result.taskId}"`);
    }
    parseDecisionResult(result);
    const task = record.tasks[result.taskId];
    if (!task) {
      throw new CorruptedStoreError(`Result ${result.taskId} references non-existent task`);
    }
    if (task.sessionId !== result.sessionId) {
      throw new CorruptedStoreError(`Result ${result.taskId} sessionId does not match task sessionId`);
    }
    if (task.revision !== result.revision) {
      throw new CorruptedStoreError(`Result ${result.taskId} revision does not match task revision`);
    }
    if (task.kind !== result.kind) {
      throw new CorruptedStoreError(`Result ${result.taskId} kind does not match task kind`);
    }
    if (task.kind === "review" && result.kind === "review") {
      if (!canonicalJsonEqual(task.target, result.target)) {
        throw new CorruptedStoreError(`Result ${result.taskId} review target does not match task target`);
      }
    }
    if (task.status !== "completed" && task.status !== "superseded") {
      throw new CorruptedStoreError(`Result exists for task ${task.id} which is in status "${task.status}"`);
    }
  }

  // Validate failures
  for (const [key, failure] of Object.entries(record.failures)) {
    if (key !== failure.taskId) {
      throw new CorruptedStoreError(`Failure key "${key}" does not match failure.taskId "${failure.taskId}"`);
    }
    validateDecisionTaskFailure(failure);
    const task = record.tasks[failure.taskId];
    if (!task) {
      throw new CorruptedStoreError(`Failure ${failure.taskId} references non-existent task`);
    }
    if (task.sessionId !== failure.sessionId) {
      throw new CorruptedStoreError(`Failure ${failure.taskId} sessionId does not match task sessionId`);
    }
    if (task.revision !== failure.revision) {
      throw new CorruptedStoreError(`Failure ${failure.taskId} revision does not match task revision`);
    }
    if (task.status !== "failed" && task.status !== "superseded") {
      throw new CorruptedStoreError(`Failure exists for task ${task.id} which is in status "${task.status}"`);
    }
  }

  // Validate receipts
  for (const [key, receipt] of Object.entries(record.receipts)) {
    if (key !== receipt.taskId) {
      throw new CorruptedStoreError(`Receipt key "${key}" does not match receipt.taskId "${receipt.taskId}"`);
    }
    validateSubmissionReceipt(receipt);
    const task = record.tasks[receipt.taskId];
    if (!task) {
      throw new CorruptedStoreError(`Receipt ${receipt.taskId} references non-existent task`);
    }
    if (receipt.claimGeneration !== task.claimGeneration) {
      throw new CorruptedStoreError(
        `Receipt ${receipt.taskId} claimGeneration ${receipt.claimGeneration} does not match task claimGeneration ${task.claimGeneration}`
      );
    }
    if (receipt.claimToken !== task.lastClaimToken) {
      throw new CorruptedStoreError(
        `Receipt ${receipt.taskId} claimToken does not match task lastClaimToken`
      );
    }
    if (receipt.type === "result") {
      const res = record.results[key];
      if (!res || !canonicalJsonEqual(res, receipt.payload)) {
        throw new CorruptedStoreError(`Receipt ${key} payload does not match stored result`);
      }
    } else {
      const fail = record.failures[key];
      if (!fail || !canonicalJsonEqual(fail, receipt.payload)) {
        throw new CorruptedStoreError(`Receipt ${key} payload does not match stored failure`);
      }
    }
  }

  // Check terminal tasks have corresponding facts
  for (const task of Object.values(record.tasks)) {
    if (task.status === "completed") {
      if (!record.results[task.id] || !record.receipts[task.id]) {
        throw new CorruptedStoreError(`Completed task ${task.id} has no persisted result or receipt`);
      }
    } else if (task.status === "failed") {
      if (!record.failures[task.id] || !record.receipts[task.id]) {
        throw new CorruptedStoreError(`Failed task ${task.id} has no persisted failure or receipt`);
      }
    } else if (
      task.status === "pending" ||
      task.status === "claimed" ||
      task.status === "running" ||
      task.status === "cancelled"
    ) {
      if (record.results[task.id] || record.failures[task.id]) {
        throw new CorruptedStoreError(`Non-terminal task ${task.id} has unexpected result or failure`);
      }
    }
  }

  // Validate operationReceipts
  for (const [key, op] of Object.entries(record.operationReceipts)) {
    if (key !== op.operationKey) {
      throw new CorruptedStoreError(
        `Operation receipt key "${key}" does not match operationKey "${op.operationKey}"`
      );
    }
    if (op.schemaVersion !== 1) {
      throw new CorruptedStoreError("Invalid operation receipt schemaVersion");
    }
    if (!record.sessions[op.sessionId]) {
      throw new CorruptedStoreError(`Operation receipt references non-existent session ${op.sessionId}`);
    }
    if (op.kind === "create-plan-task") {
      const t = record.tasks[op.entityId];
      if (!t) {
        throw new CorruptedStoreError(`Operation receipt references non-existent task ${op.entityId}`);
      }
      if (t.sessionId !== op.sessionId) {
        throw new CorruptedStoreError(`Operation receipt task sessionId does not match receipt sessionId`);
      }
      if (t.kind !== "plan") {
        throw new CorruptedStoreError(
          `Operation receipt kind is create-plan-task but task ${t.id} kind is "${t.kind}"`
        );
      }
      if (op.target !== undefined && op.target !== null) {
        throw new CorruptedStoreError(`Operation receipt kind is create-plan-task but target is specified`);
      }
    } else if (op.kind === "create-review-task") {
      const t = record.tasks[op.entityId];
      if (!t) {
        throw new CorruptedStoreError(`Operation receipt references non-existent task ${op.entityId}`);
      }
      if (t.sessionId !== op.sessionId) {
        throw new CorruptedStoreError(`Operation receipt task sessionId does not match receipt sessionId`);
      }
      if (t.kind !== "review") {
        throw new CorruptedStoreError(
          `Operation receipt kind is create-review-task but task ${t.id} kind is "${t.kind}"`
        );
      }
      if (!op.target) {
        throw new CorruptedStoreError(`Operation receipt kind is create-review-task but has no target`);
      }
      parseDecisionReviewTarget(op.target);
      if (!canonicalJsonEqual(op.target, t.target)) {
        throw new CorruptedStoreError(
          `Operation receipt ${op.operationKey} target does not match task ${t.id} target`
        );
      }
    } else if (op.kind === "rebind-session") {
      if (op.entityId !== op.sessionId) {
        throw new CorruptedStoreError(`Operation receipt entityId does not match sessionId`);
      }
      const s = record.sessions[op.entityId];
      if (!s) {
        throw new CorruptedStoreError(`Operation receipt references non-existent session ${op.entityId}`);
      }
      if (op.resultingSession) {
        parseDecisionSession(op.resultingSession);
        if (op.resultingSession.id !== op.sessionId) {
          throw new CorruptedStoreError(`Operation receipt resultingSession id does not match sessionId`);
        }
        if (op.bindingGeneration !== undefined && op.resultingSession.bindingGeneration !== op.bindingGeneration) {
          throw new CorruptedStoreError(
            `Operation receipt resultingSession bindingGeneration does not match bindingGeneration`
          );
        }
      }
    } else {
      throw new CorruptedStoreError(
        `Unknown operation receipt kind: ${String((op as Record<string, unknown>)["kind"])}`
      );
    }
  }
}

export function createEmptyStoreRecord(): DecisionStoreRecord {
  return {
    schemaVersion: DECISION_STORE_SCHEMA_VERSION,
    transactionSequence: 0,
    sessions: {},
    tasks: {},
    results: {},
    failures: {},
    receipts: {},
    revisions: {},
    operationReceipts: {},
  };
}

export class DurableDecisionStore {
  private readonly storeDir: string;
  private readonly storePath: string;
  private readonly lock: StoreLock;
  private state: DecisionStoreRecord = createEmptyStoreRecord();
  private poisoned = false;
  private poisonReason: string | null = null;
  private transactionQueue: Promise<unknown> = Promise.resolve();

  constructor(config: DecisionStoreConfig) {
    this.storeDir = path.resolve(config.storeDir);
    this.storePath = path.join(this.storeDir, "store.json");
    this.lock = new StoreLock(this.storeDir);
  }

  isPoisoned(): boolean {
    return this.poisoned;
  }

  async open(): Promise<void> {
    await this.lock.acquire();
    await fs.mkdir(this.storeDir, { recursive: true });

    let content: string | null = null;
    try {
      content = await fs.readFile(this.storePath, "utf8");
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        // Initialize brand new store file
        this.state = createEmptyStoreRecord();
        await this.persistDirect(this.state);
        return;
      }
      throw err;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new CorruptedStoreError(`Store file "${this.storePath}" contains invalid JSON`);
    }

    if (typeof raw !== "object" || raw === null) {
      throw new CorruptedStoreError(`Store file "${this.storePath}" does not contain a JSON object`);
    }

    const candidate = raw as DecisionStoreRecord;
    try {
      validateStoreRecord(candidate);
    } catch (valErr: unknown) {
      if (valErr instanceof UnsupportedStoreVersionError) {
        throw valErr;
      }
      throw new CorruptedStoreError(`Store file validation failed: ${(valErr as Error).message}`);
    }

    this.state = candidate;
  }

  async close(): Promise<void> {
    // Wait for in-flight transaction
    await this.transactionQueue.catch(() => {});
    await this.lock.release();
  }

  getState(): DecisionStoreRecord {
    return structuredClone(this.state);
  }

  getSession(id: string): DecisionSession | null {
    const s = this.state.sessions[id];
    return s ? structuredClone(s) : null;
  }

  getAllSessions(): DecisionSession[] {
    return Object.values(this.state.sessions).map((s) => structuredClone(s));
  }

  getTask(id: string): DecisionTask | null {
    const t = this.state.tasks[id];
    return t ? structuredClone(t) : null;
  }

  getAllTasks(): DecisionTask[] {
    return Object.values(this.state.tasks).map((t) => structuredClone(t));
  }

  getTasksForSession(sessionId: string): DecisionTask[] {
    return Object.values(this.state.tasks)
      .filter((t) => t.sessionId === sessionId)
      .map((t) => structuredClone(t));
  }

  getResult(taskId: string): DecisionResult | null {
    const r = this.state.results[taskId];
    return r ? structuredClone(r) : null;
  }

  getFailure(taskId: string): DecisionTaskFailure | null {
    const f = this.state.failures[taskId];
    return f ? structuredClone(f) : null;
  }

  getReceipt(taskId: string): SubmissionReceipt | null {
    const r = this.state.receipts[taskId];
    return r ? structuredClone(r) : null;
  }

  getOperationReceipt(key: string): OperationReceipt | null {
    const r = this.state.operationReceipts[key];
    return r ? structuredClone(r) : null;
  }

  getRevision(key: string): number {
    return this.state.revisions[key] ?? 0;
  }

  async transaction<T>(mutator: (draft: DecisionStoreRecord) => T | Promise<T>): Promise<T> {
    if (this.poisoned) {
      throw new StorePoisonedError(this.poisonReason ?? "Store previously experienced an unrecoverable write error");
    }

    const run = async (): Promise<T> => {
      if (this.poisoned) {
        throw new StorePoisonedError(this.poisonReason ?? "Store is poisoned");
      }

      const draft: DecisionStoreRecord = structuredClone(this.state);
      const result = await mutator(draft);

      (draft as { transactionSequence: number }).transactionSequence = this.state.transactionSequence + 1;

      // Validate new snapshot
      validateStoreRecord(draft);

      // Persist to disk atomically
      await this.persistDirect(draft);

      // Advance memory state
      this.state = draft;
      return result;
    };

    const promise = this.transactionQueue.then(run, run);
    this.transactionQueue = promise.catch(() => {});
    return promise;
  }

  private async persistDirect(record: DecisionStoreRecord): Promise<void> {
    const tempPath = path.join(this.storeDir, `store.json.tmp.${crypto.randomUUID()}`);
    const json = JSON.stringify(record, null, 2);

    try {
      const handle = await fs.open(tempPath, "w");
      try {
        await handle.writeFile(json, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      await fs.rename(tempPath, this.storePath);

      // Sync directory
      try {
        const dirHandle = await fs.open(this.storeDir, "r");
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      } catch (dirErr: unknown) {
        const code = (dirErr as NodeJS.ErrnoException).code;
        if (
          code === "EISDIR" ||
          code === "ENOTSUP" ||
          code === "EOPNOTSUPP" ||
          code === "EINVAL" ||
          (code === "EPERM" && process.platform === "win32")
        ) {
          // Documented unsupported directory fsync on specific platform/filesystem
        } else {
          // Real I/O error (e.g. EIO) must propagate and poison store
          throw dirErr;
        }
      }
    } catch (err: unknown) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // Temp file cleanup failure
      }
      this.poisoned = true;
      this.poisonReason = (err as Error).message;
      throw err;
    }
  }
}
