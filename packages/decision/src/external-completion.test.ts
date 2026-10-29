import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { ExternalDeliverySettlementReceipt } from "@symphony/domain";
import { DecisionService, DurableDecisionStore, validateStoreRecord, readExternalCompletionFence, DecisionBridge, DecisionBridgeClient, DecisionPlanningGate } from "./index";
it("native external completion CAS cancels unfinished tasks, retains receipts and rejects a stale sequence", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-external-"));
  const store = new DurableDecisionStore({ storeDir: dir }); await store.open();
  try {
    const service = new DecisionService(store), session = await service.createSession({ provider: "github", key: "owner/repo#42" });
    const task = await service.createPlanTask(session.id);
    expect(readExternalCompletionFence(dir, session.id)).toBe(false);
    const sequence = store.getState().transactionSequence;
    const claim = await service.claimTask(task.id, { owner: "driver" });
    const receipt: ExternalDeliverySettlementReceipt = { schemaVersion: 1, kind: "external_completion", operationId: "external-42", requestHash: "a".repeat(64), sourceStateHash: "b".repeat(64),
      context: { repo: "owner/repo", issueNumber: 42, workspaceKey: "GH-42", headBranch: "work", baseBranch: "main" },
      target: { prNumber: 7, headSha: "b".repeat(40), mergeCommitSha: "c".repeat(40) }, operator: "operator", reason: "verified", settledAtMs: Date.now() };
    await expect(service.recordExternalCompletion(receipt, sequence)).rejects.toThrow("Stale");
    expect(service.getTask(task.id)?.lease).toEqual(claim.lease);
    const op = await service.recordExternalCompletion(receipt, store.getState().transactionSequence);
    expect(readExternalCompletionFence(dir, session.id)).toBe(true);
    expect(service.verifyPlanEligibility(session.id).reason).toBe("external_completion");
    expect(new DecisionPlanningGate(service).hasExternalCompletionSync(session.id)).toBe(true);
    const client = new DecisionBridgeClient("http://unused", { syncTransport: (method, route) => {
      expect(method).toBe("GET");
      expect(route).toBe(`/v1/sessions/${encodeURIComponent(session.id)}/external-completion`);
      return { settled: service.hasExternalCompletion(session.id) };
    } });
    expect(client.hasExternalCompletionSync(session.id)).toBe(true);
    const bridge = new DecisionBridge(service, { port: 0, authToken: "fixture" });
    const address = await bridge.start();
    try {
      const url = `http://127.0.0.1:${address.port}/v1/sessions/${encodeURIComponent(session.id)}/external-completion`;
      expect((await fetch(url)).status).toBe(401);
      const response = await fetch(url, { headers: { Authorization: "Bearer fixture" } });
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ settled: true });
    } finally { await bridge.stop(); }
    await store.open();
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

it("fails closed on unavailable or malformed Bridge terminal authority without caching", () => {
  let value: unknown = { settled: false };
  const client = new DecisionBridgeClient("http://unused", { syncTransport: () => value });
  expect(client.hasExternalCompletionSync("github:owner/repo#42")).toBe(false);
  value = { settled: true };
  expect(client.hasExternalCompletionSync("github:owner/repo#42")).toBe(true);
  for (const malformed of [null, {}, { settled: "false" }]) {
    value = malformed;
    expect(() => client.hasExternalCompletionSync("github:owner/repo#42")).toThrow();
  }
});
