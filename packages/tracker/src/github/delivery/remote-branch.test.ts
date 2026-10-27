import { describe, expect, it } from "vitest";
import { GitHubDeliveryService } from "./delivery-service";

const sha = "a".repeat(40);
describe("#188 authoritative repository branch fact", () => {
  it("reads the exact remote ref atomically, including slash branch names", async () => {
    const calls: string[][] = [];
    const service = new GitHubDeliveryService({ async exec(args) {
      calls.push([...args]);
      return { exitCode: 0, stderr: "", stdout: JSON.stringify({ ref: "refs/heads/release/v1", object: { type: "commit", sha } }) };
    } });
    expect(await service.readRemoteBranch("Owner/Repo", "release/v1"))
      .toEqual({ repository: "owner/repo", branch: "release/v1", sha });
    expect(calls).toEqual([["api", "repos/Owner/Repo/git/ref/heads/release%2Fv1"]]);
  });
  it.each([
    null, [], {}, { ref: "refs/heads/other", object: { type: "commit", sha } },
    { ref: "refs/heads/main", object: { type: "tag", sha } },
    { ref: "refs/heads/main", object: { type: "commit", sha: "invalid" } },
    { ref: "refs/heads/main", object: null },
  ])("rejects malformed or mismatching remote fact %j", async raw => {
    const service = new GitHubDeliveryService({ async exec() {
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(raw) };
    } });
    await expect(service.readRemoteBranch("owner/repo", "main")).rejects.toThrow("remote_branch_malformed");
  });
  it.each(["failure", "json"])("fails closed on %s", async kind => {
    const service = new GitHubDeliveryService({ async exec() {
      return { exitCode: kind === "failure" ? 1 : 0, stderr: "unavailable", stdout: "{bad" };
    } });
    await expect(service.readRemoteBranch("owner/repo", "main")).rejects.toThrow();
  });
  it.each(["", "../main", "-main", "main:other", "main\nother"])("rejects invalid branch %j without I/O", async branch => {
    const service = new GitHubDeliveryService({ async exec() { throw new Error("must not run"); } });
    await expect(service.readRemoteBranch("owner/repo", branch)).rejects.toThrow("identity_invalid");
  });
});
