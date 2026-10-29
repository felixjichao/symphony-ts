/** Durable maintenance journal; survives issue workspace cleanup. */
import fs from "node:fs";
import path from "node:path";
import { externalSettlementFingerprint, externalDeliveryStateFingerprint, parseExternalDeliverySettlementRequest,
  parseExternalDeliverySettlementReceipt, decisionSessionId, type WorkKey, type WorkRecoveryRequest,
  type DurableRetryReservation, type PersistedDeliveryState, type ExternalDeliverySettlementRequest,
  type ExternalDeliverySettlementReceipt } from "@symphony/domain";

export interface ExternalSettlementJournal {
  readonly schemaVersion: 1;
  readonly phase: "prepared" | "complete";
  readonly request: ExternalDeliverySettlementRequest;
  readonly receipt: ExternalDeliverySettlementReceipt;
  readonly originalDelivery: PersistedDeliveryState;
  readonly recoveryRequests: readonly WorkRecoveryRequest[];
  readonly retries: readonly DurableRetryReservation[];
}
export function externalSettlementJournalPath(root: string, key: WorkKey): string {
  return path.join(root, ".symphony-host", "external-settlements", `${externalSettlementFingerprint(decisionSessionId(key))}.json`);
}
export function hasExternalSettlementFence(root: string, key: WorkKey): boolean {
  // External settlement is GitHub-only; custom tracker providers have no Decision root.
  if (key.provider !== "github") return false;
  return fs.existsSync(externalSettlementJournalPath(root, key));
}
export function readExternalSettlementJournal(root: string, key: WorkKey): ExternalSettlementJournal | null {
  const file = externalSettlementJournalPath(root, key);
  if (!fs.existsSync(file)) return null;
  const j = JSON.parse(fs.readFileSync(file, "utf8")) as ExternalSettlementJournal;
  parseExternalDeliverySettlementRequest(j.request);
  parseExternalDeliverySettlementReceipt(j.receipt);
  if (j.schemaVersion !== 1 || !["prepared", "complete"].includes(j.phase)
    || j.request.authorization.executorsStopped !== true || j.originalDelivery.externalSettlement !== undefined
    || !Array.isArray(j.recoveryRequests) || !Array.isArray(j.retries)
    || decisionSessionId(key) !== `github:${j.request.context.repo}#${j.request.context.issueNumber}`
    || j.receipt.requestHash !== externalSettlementFingerprint(j.request)
    || j.receipt.operationId !== j.request.operationId
    || j.receipt.sourceStateHash !== j.request.expected.deliveryHash
    || j.receipt.sourceStateHash !== externalDeliveryStateFingerprint(j.originalDelivery)
    || externalSettlementFingerprint(j.recoveryRequests) !== j.request.expected.recoveryHash
    || externalSettlementFingerprint(j.retries) !== j.request.expected.retryHash
    || JSON.stringify(j.receipt.context) !== JSON.stringify(j.request.context)
    || JSON.stringify(j.receipt.target) !== JSON.stringify(j.request.target)
    || j.receipt.operator !== j.request.authorization.operator || j.receipt.reason !== j.request.authorization.reason) {
    throw new Error("Invalid external settlement journal");
  }
  return j;
}
