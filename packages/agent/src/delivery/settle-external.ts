import { externalDeliveryStateFingerprint, validateExternalDeliveryState,
  type ExternalDeliverySettlementReceipt } from "@symphony/domain";
import type { DeliveryStateStorage } from "./delivery-skill-runner";

/** Delivery alone records its external outcome; never changes historical budgets/flags. */
export async function settleExternalDelivery(storage: DeliveryStateStorage, receipt: ExternalDeliverySettlementReceipt): Promise<void> {
  if (storage.withExclusive) return storage.withExclusive(locked => settleExternalDeliveryLocked(locked, receipt));
  return settleExternalDeliveryLocked(storage, receipt);
}
async function settleExternalDeliveryLocked(storage: DeliveryStateStorage, receipt: ExternalDeliverySettlementReceipt): Promise<void> {
  const state = await storage.readState();
  if (!state) throw new Error("Missing Delivery state");
  validateExternalDeliveryState(state);
  if (state.externalSettlement) {
    if (JSON.stringify(state.externalSettlement) !== JSON.stringify(receipt)) throw new Error("Conflicting external completion");
    return;
  }
  if (externalDeliveryStateFingerprint(state) !== receipt.sourceStateHash) throw new Error("Stale Delivery settlement authorization");
  const next = { ...state, externalSettlement: receipt };
  validateExternalDeliveryState(next);
  await storage.writeState(next);
}
