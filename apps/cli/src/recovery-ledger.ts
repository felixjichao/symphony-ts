/** Host-owned recovery evidence, not a copy of task/PR lifecycle (§17/§18). */
import fs from "node:fs";
import { isRecoveryOwnershipConflict, type RecoveryBudget, type RecoveryIncident, type RecoveryLedger } from "@symphony/domain";
import { withStorageMutation, writeDurableJson } from "./recovery-storage";

interface Snapshot { schemaVersion: 1; budgets: RecoveryBudget[]; incidents: RecoveryIncident[] }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function validBudget(value: unknown): value is RecoveryBudget {
  if (!value || typeof value !== "object") return false;
  const b = value as Record<string, unknown>;
  return b["schemaVersion"] === 1 && typeof b["scope"] === "string" && typeof b["target"] === "string"
    && count(b["epoch"]) && count(b["attempts"]) && count(b["repeated"]) && count(b["strategyAttempts"])
    && typeof b["fingerprint"] === "string" && (b["strategy"] === null || strategy(b["strategy"]))
    && Array.isArray(b["actions"]) && b["actions"].every(strategy)
    && Array.isArray(b["invocations"]) && b["invocations"].every(v => typeof v === "string")
    && (b["incident"] === null || validIncident(b["incident"]));
}
function strategy(value: unknown): boolean { return typeof value === "string" && ["retry", "resume", "reconstruct", "rebind", "reclaim", "compensate"].includes(value); }
function validIncident(value: unknown): value is RecoveryIncident {
  if (!value || typeof value !== "object") return false;
  const i = value as Record<string, unknown>;
  const w = i["workKey"] as Record<string, unknown> | null;
  const f = i["failure"] as Record<string, unknown> | null;
  const condition = i["unblockCondition"] as Record<string, unknown> | undefined;
  const fence = i["fence"] as Record<string, unknown> | null;
  return typeof i["id"] === "string" && typeof i["fingerprint"] === "string" && count(i["epoch"])
    && count(i["attempts"]) && count(i["createdAt"]) && typeof i["target"] === "string"
    && typeof i["expectedAction"] === "string" && typeof i["blockedReason"] === "string" && typeof i["unblock"] === "string"
    && (condition === undefined || !!condition && condition["kind"] === "ownership_conflict_absent" && isRecoveryOwnershipConflict(condition["reason"]))
    && (i["owner"] === null || typeof i["owner"] === "string")
    && (i["lastProgressAt"] === "unknown" || count(i["lastProgressAt"]))
    && !!w && typeof w["provider"] === "string" && typeof w["key"] === "string"
    && !!f && typeof f["reason"] === "string" && typeof f["classification"] === "string" && ["transient", "recoverable", "auth_required", "human_required", "invariant_violation", "irrecoverable_binding", "outcome_unknown"].includes(f["classification"])
    && !!fence && !Array.isArray(fence) && typeof fence["hasLeaseToken"] === "boolean"
    && Object.entries(fence).every(([key, value]) => key === "hasLeaseToken" ? typeof value === "boolean"
      : ["retryToken", "expectedHeadSha"].includes(key) ? typeof value === "string"
      : ["lifecycleGeneration", "reconciliationEpoch", "leaseGeneration", "bindingGeneration"].includes(key) && count(value))
    && Array.isArray(i["actions"]) && i["actions"].every(strategy);
}
export class FileRecoveryLedger implements RecoveryLedger {
  constructor(readonly file: string) {}
  private read(): Snapshot {
    if (!fs.existsSync(this.file)) return { schemaVersion: 1, budgets: [], incidents: [] };
    const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (!raw || typeof raw !== "object") throw new Error("Invalid recovery ledger");
    const s = raw as Record<string, unknown>;
    if (s["schemaVersion"] !== 1 || !Array.isArray(s["budgets"]) || !s["budgets"].every(validBudget)
      || !Array.isArray(s["incidents"]) || !s["incidents"].every(validIncident)) throw new Error("Invalid recovery ledger schema");
    const budgets = s["budgets"] as RecoveryBudget[];
    const incidents = s["incidents"] as RecoveryIncident[];
    if (new Set(budgets.map(b => b.scope)).size !== budgets.length || new Set(incidents.map(i => i.id)).size !== incidents.length) throw new Error("Duplicate recovery evidence");
    return { schemaVersion: 1, budgets, incidents };
  }
  list(): readonly RecoveryBudget[] { return this.read().budgets; }
  incidents(): readonly RecoveryIncident[] { return this.read().incidents; }
  transact(scope: string, update: (current: RecoveryBudget | null) => RecoveryBudget): RecoveryBudget {
    let result: RecoveryBudget | null = null;
    withStorageMutation(this.file, () => {
      const snapshot = this.read();
      const index = snapshot.budgets.findIndex(b => b.scope === scope);
      result = update(snapshot.budgets[index] ?? null);
      if (!validBudget(result) || result.scope !== scope) throw new Error("Invalid recovery budget update");
      if (index < 0) snapshot.budgets.push(result); else snapshot.budgets[index] = result;
      if (result.incident && !snapshot.incidents.some(i => i.id === result!.incident?.id)) snapshot.incidents.push(result.incident);
      writeDurableJson(this.file, snapshot);
    });
    return result!;
  }
}
