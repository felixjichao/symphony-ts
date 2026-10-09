import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import {
  parseDecisionSession,
  parseDecisionTask,
  parseDecisionResult,
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
  if (record.schemaVersion !== DECISION_STORE_SCHEMA_VERSION) {
    throw new UnsupportedStoreVersionError(record.schemaVersion);
  }
  if (typeof record.transactionSequence !== "number" || record.transactionSequence < 0) {
    throw new CorruptedStoreError("Invalid transaction sequence");
  }

  // Validate sessions
  for (const session of Object.values(record.sessions)) {
    parseDecisionSession(session);
  }

  // Validate tasks
  for (const task of Object.values(record.tasks)) {
    parseDecisionTask(task);
    if (!record.sessions[task.sessionId]) {
      throw new CorruptedStoreError(`Task ${task.id} references non-existent session ${task.sessionId}`);
    }
  }

  // Validate results
  for (const result of Object.values(record.results)) {
    parseDecisionResult(result);
    const task = record.tasks[result.taskId];
    if (!task) {
      throw new CorruptedStoreError(`Result ${result.taskId} references non-existent task`);
    }
  }

  // Validate failures
  for (const failure of Object.values(record.failures)) {
    validateDecisionTaskFailure(failure);
    const task = record.tasks[failure.taskId];
    if (!task) {
      throw new CorruptedStoreError(`Failure ${failure.taskId} references non-existent task`);
    }
  }

  // Validate receipts
  for (const receipt of Object.values(record.receipts)) {
    validateSubmissionReceipt(receipt);
    const task = record.tasks[receipt.taskId];
    if (!task) {
      throw new CorruptedStoreError(`Receipt ${receipt.taskId} references non-existent task`);
    }
  }

  // Check terminal tasks have corresponding facts
  for (const task of Object.values(record.tasks)) {
    if (task.status === "completed") {
      if (!record.results[task.id] && !record.receipts[task.id]) {
        throw new CorruptedStoreError(`Completed task ${task.id} has no persisted result or receipt`);
      }
    } else if (task.status === "failed") {
      if (!record.failures[task.id] && !record.receipts[task.id]) {
        throw new CorruptedStoreError(`Failed task ${task.id} has no persisted failure or receipt`);
      }
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
  readonly storeDir: string;
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

      // Sync directory if supported
      try {
        const dirHandle = await fs.open(this.storeDir, "r");
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      } catch {
        // Platform directory sync may not be supported on all filesystems
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
