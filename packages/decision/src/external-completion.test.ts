import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { ExternalDeliverySettlementReceipt } from "@symphony/domain";
import { DecisionService } from "./service";
import { DurableDecisionStore, validateStoreRecord } from "./store";
it("native external completion CAS cancels unfinished tasks, retains receipts and rejects a stale sequence", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-external-"));
  const store = new DurableDecisionStore({ storeDir: dir }); await store.open();
  try {
    const service = new DecisionService(store), session = await service.createSession({ provider: "github", key: "owner/repo#42" });
    const task = await service.createPlanTask(session.id);
    const sequence = store.getState().transactionSequence;
    const claim = await service.claimTask(task.id, { owner: "driver" });
    const receipt: ExternalDeliverySettlementReceipt = { schemaVersion: 1, kind: "external_completion", operationId: "external-42", requestHash: "a".repeat(64), sourceStateHash: "b".repeat(64),
      context: { repo: "owner/repo", issueNumber: 42, workspaceKey: "GH-42", headBranch: "work", baseBranch: "main" },
      target: { prNumber: 7, headSha: "b".repeat(40), mergeCommitSha: "c".repeat(40) }, operator: "operator", reason: "verified", settledAtMs: Date.now() };
    await expect(service.recordExternalCompletion(receipt, sequence)).rejects.toThrow("Stale");
    expect(service.getTask(task.id)?.lease).toEqual(claim.lease);
    const op = await service.recordExternalCompletion(receipt, store.getState().transactionSequence);
    const completedSequence = store.getState().transactionSequence;
    expect((await service.recordExternalCompletion(receipt, sequence))).toEqual(op);
    expect(store.getState().transactionSequence).toBe(completedSequence);
    expect(service.getTask(task.id)?.status).toBe("cancelled"); expect(store.getReceipt(task.id)).toBeNull();
    expect(service.getResult(task.id)).toBeNull(); validateStoreRecord(store.getState());
    const corrupt = store.getState();
    corrupt.operationReceipts[op.operationKey] = { ...op, externalCompletion: { ...receipt, operationId: "foreign" } };
    expect(() => validateStoreRecord(corrupt)).toThrow("Invalid external");
  } finally { await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
