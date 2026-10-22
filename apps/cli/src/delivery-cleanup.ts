/** Delivery-owned deletion admission (§8/§9/§17). Keep the mutex outside the
 * workspace through hooks and recursive removal, including merge auto-close. */
import path from "node:path";
import { FileDeliveryStateStorage } from "./delivery-skill-cli";
import { deliveryAuthorityBlock, withDeliveryLifecycleAuthority } from "./file-authority";

export async function withDeliveryCleanupAuthority<T>(cwd: string, remove: () => Promise<T>): Promise<T> {
  return withDeliveryLifecycleAuthority(cwd, async () => {
    const block = deliveryAuthorityBlock(path.join(cwd, ".symphony", "delivery-authority.lock"));
    if (block) throw new Error(`Workspace cleanup blocked: ${block}`);
    // Schema errors deliberately propagate. Neither a terminal Issue nor a dead
    // owner establishes that an unacknowledged external effect is safe to erase.
    const state = new FileDeliveryStateStorage(path.join(cwd, ".symphony", "delivery-state.json")).readState();
    if (state?.pendingCompensation || state?.landing?.phase === "intent"
      || (state?.continuation && state.continuation.phase !== "ready")) {
      throw new Error("Workspace cleanup blocked: unfinished Delivery intent requires observation");
    }
    return remove();
  });
}
