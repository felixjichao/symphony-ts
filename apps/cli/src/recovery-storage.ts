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

function validateRequest(value: unknown): value is WorkRecoveryRequest {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  const work = r["workKey"] as Record<string, unknown> | undefined;
  const authority = r["authority"] as Record<string, unknown> | undefined;
  return !!work && typeof work["provider"] === "string" && typeof work["key"] === "string"
    && typeof r["version"] === "string" && typeof r["stage"] === "string"
    && ["plan", "coding", "ci", "review", "repair", "delivery", "merge", "handoff"].includes(r["stage"])
    && typeof r["action"] === "string" && (RECOVERY_ACTIONS as readonly string[]).includes(r["action"])
    && !!authority && typeof authority["kind"] === "string"
    && !!r["fence"] && typeof r["fence"] === "object"
    && (r["invocationId"] === undefined || typeof r["invocationId"] === "string");
}

/** All read-modify-write operations serialize across processes. A crash in this tiny
 * synchronous section leaves a lock requiring operator verification; never steal by age.
 * Native authorities still fence effects. An existing unresolved slot cannot be replaced. */
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
function withStorageMutation(file: string, action: () => void): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const fd = fs.openSync(lock, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
    fs.fsyncSync(fd);
    action();
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
