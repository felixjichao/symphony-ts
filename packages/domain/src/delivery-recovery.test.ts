import { describe, expect, it } from "vitest";
import { isDeliveryMergeConflictRepair } from "./delivery-recovery";

const receipt = { cause: "merge_conflict", operationId: "operation-1", attempt: 1, prNumber: 187,
  expectedHeadSha: "a".repeat(40), baseSha: "b".repeat(40), phase: "reserved" };
describe("merge conflict recovery admission (§8/§14 extension)", () => {
  it("admits reserved operations and confirmed commit/push receipts", () => {
    expect(isDeliveryMergeConflictRepair(receipt)).toBe(true);
    expect(isDeliveryMergeConflictRepair({ ...receipt, phase: "pushed", commitSha: "c".repeat(40), outcome: "remote_confirmed" })).toBe(true);
  });
  it.each([
    { cause: "unmergeable" }, { attempt: 0 }, { attempt: 1.5 }, { prNumber: 0 }, { operationId: "" },
    { expectedHeadSha: "main" }, { baseSha: "origin/main" }, { phase: "pushed" },
    { phase: "pushing", commitSha: "HEAD" }, { phase: "unknown" },
  ])("rejects a checkpoint that cannot authorize recovery: %j", invalid => {
    expect(isDeliveryMergeConflictRepair({ ...receipt, ...invalid })).toBe(false);
  });
});
