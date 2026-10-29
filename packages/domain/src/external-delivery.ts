/** Explicit external completion, SPEC §4/§11.5 adjacent. Never an approval receipt. */
import { createHash } from "node:crypto";
import type { DeliveryContext, PersistedDeliveryState } from "./delivery";
import { record, requireValue, string } from "./decision";

export interface ExternalDeliveryTarget {
  readonly prNumber: number;
  readonly headSha: string;
  readonly mergeCommitSha: string;
}
export interface ExternalDeliverySettlementRequest {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly workspace: string;
  readonly decisionStore: string;
  readonly context: DeliveryContext;
  readonly target: ExternalDeliveryTarget;
  readonly expected: {
    readonly deliveryHash: string;
    readonly decisionHash: string;
    readonly decisionSequence: number;
    readonly recoveryHash: string;
    readonly retryHash: string;
  };
  readonly authorization: {
    readonly operator: string;
    readonly reason: string;
    readonly executorsStopped: boolean;
    readonly allowUnmarkedPr: boolean;
  };
}
export interface ExternalDeliverySettlementReceipt {
  readonly schemaVersion: 1;
  readonly kind: "external_completion";
  readonly operationId: string;
  readonly requestHash: string;
  readonly sourceStateHash: string;
  readonly context: DeliveryContext;
  readonly target: ExternalDeliveryTarget;
  readonly operator: string;
  readonly reason: string;
  readonly settledAtMs: number;
}
/** Fingerprints deliberately pin JSON structure/order, not credentials or mutable clocks. */
export function externalSettlementFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function externalDeliveryStateFingerprint(state: PersistedDeliveryState): string {
  const { externalSettlement: _receipt, ...original } = state;
  return externalSettlementFingerprint(original);
}
function integer(value: unknown, minimum = 0): asserts value is number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum, "invalid integer");
}
function sha(value: unknown, length: number): void {
  requireValue(typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value), "invalid digest");
}
function context(value: unknown): DeliveryContext {
  const c = record(value, ["repo", "issueNumber", "workspaceKey", "headBranch", "baseBranch"]);
  for (const key of ["repo", "workspaceKey", "headBranch", "baseBranch"]) string(c[key]);
  requireValue(typeof c["repo"] === "string" && /^[\w.-]+\/[\w.-]+$/.test(c["repo"])
    && c["repo"].split("/").every(part => part !== "." && part !== ".."), "invalid public GitHub repository");
  integer(c["issueNumber"], 1);
  return c as unknown as DeliveryContext;
}
function target(value: unknown): ExternalDeliveryTarget {
  const t = record(value, ["prNumber", "headSha", "mergeCommitSha"]);
  integer(t["prNumber"], 1); sha(t["headSha"], 40); sha(t["mergeCommitSha"], 40);
  return t as unknown as ExternalDeliveryTarget;
}
export function parseExternalDeliverySettlementRequest(value: unknown): ExternalDeliverySettlementRequest {
  const r = record(value, ["schemaVersion", "operationId", "workspace", "decisionStore", "context", "target", "expected", "authorization"]);
  requireValue(r["schemaVersion"] === 1, "unsupported external settlement version");
  for (const key of ["operationId", "workspace", "decisionStore"]) string(r[key]);
  context(r["context"]); target(r["target"]);
  const e = record(r["expected"], ["deliveryHash", "decisionHash", "decisionSequence", "recoveryHash", "retryHash"]);
  for (const key of ["deliveryHash", "decisionHash", "recoveryHash", "retryHash"]) sha(e[key], 64);
  integer(e["decisionSequence"]);
  const a = record(r["authorization"], ["operator", "reason", "executorsStopped", "allowUnmarkedPr"]);
  string(a["operator"]); string(a["reason"]);
  requireValue(typeof a["executorsStopped"] === "boolean" && typeof a["allowUnmarkedPr"] === "boolean", "invalid external authorization");
  return r as unknown as ExternalDeliverySettlementRequest;
}
export function parseExternalDeliverySettlementReceipt(value: unknown): ExternalDeliverySettlementReceipt {
  const r = record(value, ["schemaVersion", "kind", "operationId", "requestHash", "sourceStateHash", "context", "target", "operator", "reason", "settledAtMs"]);
  requireValue(r["schemaVersion"] === 1 && r["kind"] === "external_completion", "invalid external completion receipt");
  for (const key of ["operationId", "operator", "reason"]) string(r[key]);
  sha(r["requestHash"], 64); sha(r["sourceStateHash"], 64); integer(r["settledAtMs"]);
  context(r["context"]); target(r["target"]);
  return r as unknown as ExternalDeliverySettlementReceipt;
}
export function validateExternalDeliveryState(state: PersistedDeliveryState): void {
  if (state.externalSettlement === undefined) return;
  const receipt = parseExternalDeliverySettlementReceipt(state.externalSettlement);
  requireValue(receipt.context.repo === state.repo && receipt.context.issueNumber === state.issueNumber
    && receipt.context.workspaceKey === state.workspaceKey
    && receipt.sourceStateHash === externalDeliveryStateFingerprint(state), "external completion source changed");
}
