import { expect, it, vi } from "vitest";
import { formatPrBody, type ExternalDeliverySettlementRequest } from "@symphony/domain";
import { verifyExternalDelivery } from "./external-observation";
const request: ExternalDeliverySettlementRequest = { schemaVersion: 1, operationId: "external-42", workspace: "/work/42", decisionStore: "/decision",
  context: { repo: "owner/repo", issueNumber: 42, workspaceKey: "GH-42", headBranch: "work", baseBranch: "main" },
  target: { prNumber: 7, headSha: "b".repeat(40), mergeCommitSha: "c".repeat(40) },
  expected: { deliveryHash: "a".repeat(64), decisionHash: "b".repeat(64), decisionSequence: 1, recoveryHash: "c".repeat(64), retryHash: "d".repeat(64) },
  authorization: { operator: "operator", reason: "verified", executorsStopped: true, allowUnmarkedPr: false } };
function runner(body = formatPrBody({ context: request.context })) {
  const exec = vi.fn(async (args: readonly string[]) => ({ stdout: JSON.stringify(args[5]?.includes("/issues/") ? { number: 42, state: "closed" } : {
    number: 7, state: "closed", merged: true, merged_at: "2026-10-29T12:00:00Z", merge_commit_sha: request.target.mergeCommitSha,
    body, head: { ref: "work", sha: request.target.headSha, repo: { full_name: "owner/repo" } }, base: { ref: "main", repo: { full_name: "owner/repo" } },
  }), stderr: "", exitCode: 0 }));
  return { exec };
}
it("pins reads to public GitHub GET and verifies the full external target", async () => {
  const r = runner(); await verifyExternalDelivery(request, r);
  expect(r.exec).toHaveBeenCalledTimes(2);
  for (const call of r.exec.mock.calls) expect(call[0].slice(0, 5)).toEqual(["api", "--hostname", "github.com", "--method", "GET"]);
});
it("unmarked authorization never overrides a foreign marker", async () => {
  await expect(verifyExternalDelivery(request, runner("manual"))).rejects.toThrow("explicit authorization");
  const approved = { ...request, authorization: { ...request.authorization, allowUnmarkedPr: true } };
  await verifyExternalDelivery(approved, runner("manual"));
  await expect(verifyExternalDelivery(approved, runner(formatPrBody({ context: { ...request.context, issueNumber: 99 } })))).rejects.toThrow("foreign markers");
});
it("invalid authority is refused before I/O and malformed/provider errors never expose payloads", async () => {
  const r = runner();
  await expect(verifyExternalDelivery({ ...request, context: { ...request.context, repo: "../foreign/escape" } }, r)).rejects.toThrow();
  expect(r.exec).not.toHaveBeenCalled();
  await expect(verifyExternalDelivery(request, { exec: async () => ({ stdout: "private credential", stderr: "", exitCode: 0 }) })).rejects.toThrow("Invalid external delivery observation");
  await expect(verifyExternalDelivery(request, { exec: async () => { throw new Error("private credential"); } })).rejects.toThrow("External delivery observation unavailable");
});
