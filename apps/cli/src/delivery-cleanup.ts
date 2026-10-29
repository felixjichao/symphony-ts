/** Delivery-owned deletion admission (§8/§9/§17). Keep the mutex outside the
 * workspace through hooks and recursive removal, including merge auto-close. */
import path from "node:path";
import { FileDeliveryStateStorage } from "./delivery-skill-cli";
import { deliveryAuthorityBlock, withDeliveryLifecycleAuthority } from "./file-authority";
import { readExternalSettlementJournal } from "./external-settlement-journal";

export async function withDeliveryCleanupAuthority<T>(cwd: string, remove: () => Promise<T>): Promise<T> {
  return withDeliveryLifecycleAuthority(cwd, async () => {
    const block = deliveryAuthorityBlock(path.join(cwd, ".symphony", "delivery-authority.lock"));
    if (block) throw new Error(`Workspace cleanup blocked: ${block}`);
    // Schema errors deliberately propagate. Neither a terminal Issue nor a dead
    // owner establishes that an unacknowledged external effect is safe to erase.
    const state = new FileDeliveryStateStorage(path.join(cwd, ".symphony", "delivery-state.json")).readState();
    const journal = state ? readExternalSettlementJournal(path.dirname(cwd), { provider: "github", key: `${state.repo}#${state.issueNumber}` }) : null;
    if (journal || state?.externalSettlement) {
      if (!journal || journal.phase !== "complete" || !state?.externalSettlement
        || JSON.stringify(journal.receipt) !== JSON.stringify(state.externalSettlement)) {
        throw new Error("Workspace cleanup blocked: external settlement is incomplete");
      }
      return remove();
    }
    const continuation = state?.continuation;
    const landing = state?.landing;
    // Auto-land completes from result_observed, rather than the no-land ready
    // phase. Only its exact target's verified merge settles that continuation.
    const mergedContinuation = continuation?.phase === "result_observed"
      && continuation.verdict === "approve" && landing?.phase === "observed"
      && !!landing.mergeCommitSha && landing.prNumber === continuation.prNumber
      && landing.headSha === continuation.headSha
      && landing.context.headBranch === continuation.headBranch
      && landing.context.baseBranch === continuation.baseBranch;
    if (state?.pendingCompensation || state?.landing?.phase === "intent"
      || (continuation && continuation.phase !== "ready" && !mergedContinuation)) {
      throw new Error("Workspace cleanup blocked: unfinished Delivery intent requires observation");
    }
    return remove();
  });
}
