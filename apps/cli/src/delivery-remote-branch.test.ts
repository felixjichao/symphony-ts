import { describe, expect, it } from "vitest";
import { createRemoteBranchReader, parseDeliverySkillArgs } from "./delivery-skill-cli";
import type { DeliveryGitGhRunner } from "@symphony/agent";

describe("#188 host composition", () => {
  it("routes tracker branch reads through the same delivery runner and workspace", async () => {
    const calls: unknown[] = [];
    const runner: DeliveryGitGhRunner = {
      async git() { throw new Error("no local ref authority"); },
      async exec() { throw new Error("no executor"); },
      async gh(args, cwd) {
        calls.push({ args, cwd });
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ ref: "refs/heads/main", object: { type: "commit", sha: "b".repeat(40) } }) };
      },
    };
    expect(await createRemoteBranchReader(runner, "/workspace")("owner/repo", "main"))
      .toEqual({ repository: "owner/repo", branch: "main", sha: "b".repeat(40) });
    expect(calls).toEqual([{ args: ["api", "repos/owner/repo/git/ref/heads/main"], cwd: "/workspace" }]);
  });
  it("parses an explicit recovery fence without conflating ordinary resume", () => {
    expect(parseDeliverySkillArgs(["run", "--resume"]).conflictOperation).toBeUndefined();
    expect(parseDeliverySkillArgs(["run", "--resume", "--recover-conflict-operation", "op", "--recover-conflict-attempt", "1",
      "--expected-head", "a".repeat(40), "--confirm-executor-stopped"]))
      .toMatchObject({ resume: true, conflictOperation: "op", conflictAttempt: 1, expectedHead: "a".repeat(40), executorStopped: true });
  });
});
