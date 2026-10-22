import { acquireFileAuthority } from "./file-authority";
/** Host-owned durable recovery invocations (§4/§8/§17). Never a workflow lifecycle. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkRecoveryRequest } from "@symphony/domain";
import { RECOVERY_ACTIONS, formatWorkKey } from "@symphony/domain";
import type { WorkRecoveryStorage } from "@symphony/orchestrator";

export function writeDurableJson(file: string, value: unknown): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const parent = fs.openSync(directory, "r");
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

interface Snapshot { schemaVersion: 1; requests: WorkRecoveryRequest[] }

function isTaskRef(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r["taskId"] === "string" && typeof r["revision"] === "number" && Number.isSafeInteger(r["revision"]) && r["revision"] >= 1;
}
function isHandoffRef(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r["handoffId"] === "string" && (r["headSha"] === null || typeof r["headSha"] === "string");
}

function validateRequest(value: unknown): value is WorkRecoveryRequest {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  const work = r["workKey"] as Record<string, unknown> | undefined;
  const authority = r["authority"] as Record<string, unknown> | undefined;
  return !!work && typeof work["provider"] === "string" && typeof work["key"] === "string"
    && typeof r["version"] === "string" && typeof r["stage"] === "string"
    && ["plan", "coding", "ci", "review", "repair", "delivery", "merge", "handoff"].includes(r["stage"])
    && typeof r["action"] === "string" && (RECOVERY_ACTIONS as readonly string[]).includes(r["action"])
    && !!authority && (authority["kind"] === "internal" && typeof authority["authority"] === "string"
      || authority["kind"] === "external" && typeof authority["system"] === "string" && typeof authority["condition"] === "string"
      || authority["kind"] === "human" && typeof authority["role"] === "string" && typeof authority["instruction"] === "string")
    && !!r["fence"] && typeof r["fence"] === "object" && !Array.isArray(r["fence"])
    && Object.entries(r["fence"]).every(([key, value]) =>
      ["retryToken", "leaseToken", "expectedHeadSha"].includes(key) ? typeof value === "string"
      : ["lifecycleGeneration", "reconciliationEpoch", "leaseGeneration", "bindingGeneration"].includes(key)
        && typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    && (r["taskRef"] === undefined || isTaskRef(r["taskRef"]))
    && (r["handoffRef"] === undefined || isHandoffRef(r["handoffRef"]))
    && (r["leaseExpiresAt"] === undefined || typeof r["leaseExpiresAt"] === "number" && Number.isFinite(r["leaseExpiresAt"]))
    && (r["invocationId"] === undefined || typeof r["invocationId"] === "string");
}

/** Cross-process read/modify/write exclusion. Proven dead clean owners may be
 * reclaimed; legacy/ambiguous metadata fails closed. Native authorities still
 * fence effects, and an unresolved WorkKey slot cannot be replaced. */
export class FileWorkRecoveryStorage implements WorkRecoveryStorage {
  constructor(private readonly file: string) {}
  private read(): Snapshot {
    if (!fs.existsSync(this.file)) return { schemaVersion: 1, requests: [] };
    const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (!raw || typeof raw !== "object") throw new Error("Invalid recovery snapshot");
    const snapshot = raw as Record<string, unknown>;
    if (snapshot["schemaVersion"] !== 1 || !Array.isArray(snapshot["requests"])
      || !snapshot["requests"].every(validateRequest)) throw new Error("Invalid recovery snapshot schema");
    const requests = snapshot["requests"] as WorkRecoveryRequest[];
    if (new Set(requests.map(r => formatWorkKey(r.workKey))).size !== requests.length) {
      throw new Error("Conflicting durable recovery requests");
    }
    return { schemaVersion: 1, requests };
  }
  load(): readonly WorkRecoveryRequest[] { return this.read().requests; }
  private mutate(action: (snapshot: Snapshot) => void): void {
    withStorageMutation(this.file, () => {
      const snapshot = this.read();
      action(snapshot);
      writeDurableJson(this.file, snapshot);
    });
  }
  put(request: WorkRecoveryRequest): void {
    this.mutate(snapshot => {
      if (snapshot.requests.some(r => formatWorkKey(r.workKey) === formatWorkKey(request.workKey))) {
        throw new Error("Recovery invocation already pending; re-observe authority before retry");
      }
      snapshot.requests.push(request);
    });
  }
  remove(request: WorkRecoveryRequest): void {
    this.mutate(snapshot => {
      snapshot.requests = snapshot.requests.filter(r => JSON.stringify(r) !== JSON.stringify(request));
    });
  }
}


/** Synchronous file commit mutex, never held across external effects or awaits. */
export function withStorageMutation(file: string, action: () => void): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = acquireFileAuthority(`${file}.lock`);
  try { action(); } finally { lock.release(); }
}

import type { DurableRetryReservation, RetryReservationStorage } from "@symphony/domain";
export class FileRetryReservationStorage implements RetryReservationStorage {
  constructor(private readonly file: string) {}
  load(): readonly DurableRetryReservation[] {
    if (!fs.existsSync(this.file)) return [];
    const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (!raw || typeof raw !== "object") throw new Error("Invalid retry snapshot");
    const s = raw as Record<string, unknown>;
    if (s["schemaVersion"] !== 1 || !Array.isArray(s["reservations"])) throw new Error("Invalid retry schema");
    const seen = new Set<string>();
    for (const value of s["reservations"]) {
      if (!value || typeof value !== "object") throw new Error("Invalid retry reservation");
      const r = value as Record<string, unknown>;
      if (typeof r["issueId"] !== "string" || !r["issueId"] || seen.has(r["issueId"])
        || !(r["identifier"] === null || typeof r["identifier"] === "string")
        || !(r["issueUrl"] === null || typeof r["issueUrl"] === "string")
        || !(r["error"] === null || typeof r["error"] === "string")
        || typeof r["attempt"] !== "number" || !Number.isSafeInteger(r["attempt"]) || r["attempt"] < 1
        || typeof r["dueAtUtcMs"] !== "number" || !Number.isSafeInteger(r["dueAtUtcMs"]) || r["dueAtUtcMs"] < 0
        || typeof r["token"] !== "string" || !r["token"]
        || !["failure", "continuation"].includes(String(r["kind"]))
        || !["scheduled", "launch_pending", "blocked"].includes(String(r["phase"]))) throw new Error("Invalid retry reservation");
      if (r["recoveryAccounting"] !== undefined) {
        const accounting = r["recoveryAccounting"] as Record<string, unknown> | null;
        if (!accounting || accounting["schemaVersion"] !== 1 || typeof accounting["legacyAttempts"] !== "number"
          || !Number.isSafeInteger(accounting["legacyAttempts"]) || accounting["legacyAttempts"] < 0) throw new Error("Invalid retry recovery accounting");
      }
      if (r["workKey"] !== undefined) {
        const key = r["workKey"] as Record<string, unknown> | null;
        if (!key || typeof key["provider"] !== "string" || typeof key["key"] !== "string") throw new Error("Invalid retry WorkKey");
      }
      seen.add(r["issueId"]);
    }
    return s["reservations"] as DurableRetryReservation[];
  }
  private mutate(action: (records: DurableRetryReservation[]) => void): void {
    withStorageMutation(this.file, () => {
      const records = [...this.load()];
      action(records);
      writeDurableJson(this.file, { schemaVersion: 1, reservations: records });
    });
  }
  put(record: DurableRetryReservation, expectedToken: string | null): void {
    this.mutate(records => {
      const index = records.findIndex(r => r.issueId === record.issueId);
      if ((records[index]?.token ?? null) !== expectedToken) throw new Error("Stale durable retry owner");
      if (index >= 0) records[index] = record;
      else records.push(record);
    });
  }
  remove(issueId: string, token: string): void {
    this.mutate(records => {
      const index = records.findIndex(r => r.issueId === issueId);
      if (index < 0 || records[index]?.token !== token) throw new Error("Stale durable retry owner");
      records.splice(index, 1);
    });
  }
}
