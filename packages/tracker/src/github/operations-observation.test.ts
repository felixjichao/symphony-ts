import { expect, it } from "vitest";
import { formatPrBody, type DeliveryContext } from "@symphony/domain";
import { GitHubDeliveryService, type GhRunner } from "../index";

const context: DeliveryContext = { repo: "acme/repo", issueNumber: 1, workspaceKey: "GH-1", headBranch: "symphony/GH-1", baseBranch: "main" };
const body = formatPrBody({ context });
const sha = "a".repeat(40);
const raw = { number: 2, body, state: "OPEN", isDraft: false, headRefName: context.headBranch, headRefOid: sha,
  baseRefName: "main", url: "https://github.com/acme/repo/pull/2", isCrossRepository: false,
  headRepository: { name: "repo" }, headRepositoryOwner: { login: "acme" }, statusCheckRollup: [] };
function fixture(pr: object = raw, candidates = JSON.stringify([{ number: 2, body }])) {
  const seen: string[][] = [];
  const runner: GhRunner = { async exec(args) {
    seen.push([...args]);
    expect(args[0]).toMatch(/^(issue|api|pr)$/);
    if (args[0] === "pr") expect(args[1]).toBe("view");
    if (args[0] === "issue") expect(args[1]).toBe("view");
    return { stdout: args[0] === "issue" ? JSON.stringify({ state: "OPEN", url: "https://github.com/acme/repo/issues/1" })
      : args[0] === "api" ? candidates : JSON.stringify(pr), stderr: "", exitCode: 0 };
  } };
  return { service: new GitHubDeliveryService(runner), seen };
}
it.each(["OPEN", "CLOSED", "MERGED"])("observes %s PR, including terminal PR with deleted head repository", async (state) => {
  const { service, seen } = fixture({ ...raw, state, ...(state === "OPEN" ? {} : { headRepository: null, headRepositoryOwner: null }) });
  const facts = await service.observeWork(context);
  expect(facts.pullRequest).toMatchObject({ state: state.toLowerCase(), headSha: sha, number: 2 });
  expect(facts.ci).toBeNull();
  expect(seen[1]).toContain("--paginate");
});
it("finds marker in later API pages, excludes cross-repository same-number markers", async () => {
  const other = formatPrBody({ context: { ...context, repo: "other/repo" } });
  const { service } = fixture(raw, JSON.stringify([{ number: 9, body: other }]) + "\n" + JSON.stringify([{ number: 2, body }]));
  expect((await service.observeWork(context)).pullRequest?.number).toBe(2);
});
it("successful empty search is no PR; ambiguity, incomplete search and ownership failure are errors", async () => {
  expect(await fixture(raw, "[]").service.observeWork(context)).toMatchObject({ pullRequest: null, ci: null });
  await expect(fixture(raw, JSON.stringify([{ number: 2, body }, { number: 3, body }])).service.observeWork(context)).rejects.toMatchObject({ code: "ownership_refusal" });
  await expect(fixture(raw, '[{"number":2').service.observeWork(context)).rejects.toThrow();
  await expect(fixture({ ...raw, body: "unowned" }).service.observeWork(context, { prNumber: 2 })).rejects.toMatchObject({ code: "ownership_refusal" });
  await expect(fixture({ ...raw, isCrossRepository: true }).service.observeWork(context, { prNumber: 2 })).rejects.toMatchObject({ code: "ownership_refusal" });
});
it.each([
  ["COMPLETED", "SUCCESS", "success"], ["COMPLETED", "FAILURE", "failure"], ["IN_PROGRESS", "", "pending"],
])("normalizes observed CI %s/%s on the exact HEAD in one read", async (status, conclusion, expected) => {
  const { service, seen } = fixture({ ...raw, statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status, conclusion }] });
  const facts = await service.observeWork(context, { prNumber: 2 });
  expect(facts.ci).toEqual({ status: expected, headSha: facts.pullRequest?.headSha });
  expect(seen.filter((args) => args[0] === "pr")).toHaveLength(1);
});
it("unavailable/unknown CI and malformed SHA cannot become success or absent CI", async () => {
  await expect(fixture({ ...raw, statusCheckRollup: undefined }).service.observeWork(context)).rejects.toMatchObject({ code: "checks_unknown" });
  await expect(fixture({ ...raw, statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "NEW_UNKNOWN" }] }).service.observeWork(context)).rejects.toMatchObject({ code: "checks_unknown" });
  await expect(fixture({ ...raw, headRefOid: "abcd" }).service.observeWork(context)).rejects.toMatchObject({ code: "cli_malformed_response" });
});
