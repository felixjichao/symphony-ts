import { expect, it, vi } from "vitest";
import { externalDeliveryStateFingerprint, type PersistedDeliveryState, type ExternalDeliverySettlementReceipt } from "@symphony/domain";
import { settleExternalDelivery } from "./settle-external";
import { runDeliverySkill } from "./delivery-skill-runner";
import { recoverDeliveryHandoff } from "./recover-handoff";
const context = { repo: "owner/repo", issueNumber: 42, workspaceKey: "GH-42", headBranch: "work", baseBranch: "main" };
const original: PersistedDeliveryState = { repo: context.repo, issueNumber: 42, workspaceKey: "GH-42", isPaused: true,
  spentRepairs: 2, spentWaitSeconds: 321, deadlineTimestampMs: 1234, lastUpdated: "before", pendingCompensation: true, commentPosted: false };
const receipt: ExternalDeliverySettlementReceipt = { schemaVersion: 1, kind: "external_completion", operationId: "settle-42",
  requestHash: "a".repeat(64), sourceStateHash: externalDeliveryStateFingerprint(original), context,
  target: { prNumber: 7, headSha: "b".repeat(40), mergeCommitSha: "c".repeat(40) }, operator: "operator", reason: "verified", settledAtMs: 1000 };
it("retains native history and recognizes a lost write acknowledgement without a second write", async () => {
  let state = original;
  const writeState = vi.fn(async (next: PersistedDeliveryState) => { state = next; throw new Error("lost write ACK"); });
  const storage = { readState: () => state, writeState };
  await expect(settleExternalDelivery(storage, receipt)).rejects.toThrow("lost write ACK");
  await settleExternalDelivery(storage, receipt);
  expect(writeState).toHaveBeenCalledTimes(1);
  expect(state).toEqual({ ...original, externalSettlement: receipt });
  await expect(settleExternalDelivery(storage, { ...receipt, operationId: "other" })).rejects.toThrow("Conflicting");
});
it("ordinary runner and compensation cannot replay any effect after explicit external completion", async () => {
  const state = { ...original, externalSettlement: receipt };
  const storage = { readState: () => state, writeState: vi.fn() };
  const forbidden = vi.fn(async () => { throw new Error("effect forbidden"); });
  const runner = { git: forbidden, gh: forbidden, exec: forbidden };
  const result = await runDeliverySkill({ ...context, cwd: "/unused", runner, stateStorage: storage });
  expect(result.status).toBe("blocked");
  expect((await recoverDeliveryHandoff({ ...context, cwd: "/unused", stateStorage: storage, runner })).success).toBe(false);
  expect(forbidden).not.toHaveBeenCalled(); expect(storage.writeState).not.toHaveBeenCalled();
});
