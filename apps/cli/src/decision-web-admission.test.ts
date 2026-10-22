import { expect, it } from "vitest";
import type { DecisionReviewTask } from "@symphony/domain";
import { authorizeDecisionWebExecution } from "./decision-web-admission";

it("authorizes only a fresh exact open PR HEAD and fails closed when GitHub is unreadable", async () => {
  const task: DecisionReviewTask = { schemaVersion: 1, id: "review", sessionId: "session", kind: "review", revision: 1,
    status: "running", lease: null, claimGeneration: 1, lastClaimToken: null, createdAtMs: 0, updatedAtMs: 0,
    target: { repository: "owner/repo", prNumber: 42, headSha: "a".repeat(40) } };
  for (const [number, state, sha, allowed] of [[42, "open", "a".repeat(40), true], [42, "closed", "a".repeat(40), false],
    [42, "open", "b".repeat(40), false], [43, "open", "a".repeat(40), false]] as const) {
    const runner = { gh: async (args: readonly string[]) => {
      expect(args).toEqual(["api", "repos/owner/repo/pulls/42"]);
      return { exitCode: 0, stdout: JSON.stringify({ number, state, head: { sha } }), stderr: "" };
    } };
    expect(await authorizeDecisionWebExecution(task, runner)).toBe(allowed);
  }
  expect(await authorizeDecisionWebExecution(task, { gh: async () => { throw new Error("offline"); } })).toBe(false);
  expect(await authorizeDecisionWebExecution(task, { gh: async () => ({ exitCode: 0, stdout: "invalid", stderr: "" }) })).toBe(false);
});
