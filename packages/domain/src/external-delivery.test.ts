import { expect, it } from "vitest";
import { externalDeliveryStateFingerprint, parseExternalDeliverySettlementRequest,
  validateExternalDeliveryState, type PersistedDeliveryState, type ExternalDeliverySettlementReceipt } from "./index";
const context = { repo: "owner/repo", issueNumber: 42, workspaceKey: "GH-42", headBranch: "work", baseBranch: "main" };
const state: PersistedDeliveryState = { ...context, spentRepairs: 2, spentWaitSeconds: 321, isPaused: true, lastUpdated: "before" };
const receipt: ExternalDeliverySettlementReceipt = { schemaVersion: 1, kind: "external_completion", operationId: "external-42",
  requestHash: "a".repeat(64), sourceStateHash: externalDeliveryStateFingerprint(state), context,
  target: { prNumber: 7, headSha: "b".repeat(40), mergeCommitSha: "c".repeat(40) }, operator: "operator", reason: "external merge verified", settledAtMs: 1000 };
it("pins original native facts and never treats changed budget/identity as externally settled", () => {
  expect(() => validateExternalDeliveryState({ ...state, externalSettlement: receipt })).not.toThrow();
  expect(() => validateExternalDeliveryState({ ...state, spentRepairs: 0, externalSettlement: receipt })).toThrow();
  expect(() => validateExternalDeliveryState({ ...state, externalSettlement: { ...receipt, context: { ...context, issueNumber: 43 } } })).toThrow();
  expect(() => validateExternalDeliveryState(JSON.parse(JSON.stringify({ ...state, externalSettlement: null })) as PersistedDeliveryState)).toThrow();
});
it("rejects unknown authorization fields and malformed remote targets", () => {
  const request = { schemaVersion: 1, operationId: "external-42", workspace: "/work/42", decisionStore: "/decision", context,
    target: receipt.target, expected: { deliveryHash: "a".repeat(64), decisionHash: "b".repeat(64), decisionSequence: 3, recoveryHash: "c".repeat(64), retryHash: "d".repeat(64) },
    authorization: { operator: "operator", reason: "verified", executorsStopped: false, allowUnmarkedPr: false } };
  expect(parseExternalDeliverySettlementRequest(request)).toEqual(request);
  expect(() => parseExternalDeliverySettlementRequest({ ...request, approve: true })).toThrow();
  expect(() => parseExternalDeliverySettlementRequest({ ...request, target: { ...receipt.target, headSha: "short" } })).toThrow();
  expect(() => parseExternalDeliverySettlementRequest({ ...request, context: { ...context, repo: "owner/../foreign" } })).toThrow();
});
