import { validatePrOwnership, parseExternalDeliverySettlementRequest, type ExternalDeliverySettlementRequest } from "@symphony/domain";
import type { GhRunner, GhExecResult } from "./gh-cli";

/** Explicit external target read; this never adopts a missing/foreign ownership marker. */
export async function verifyExternalDelivery(request: ExternalDeliverySettlementRequest, runner: GhRunner): Promise<void> {
  const approved = parseExternalDeliverySettlementRequest(request);
  const { context: c, target: t } = approved;
  const read = async (resource: string): Promise<Record<string, unknown>> => {
    let r: GhExecResult;
    try { r = await runner.exec(["api", "--hostname", "github.com", "--method", "GET", `repos/${c.repo}/${resource}`], { cwd: approved.workspace, timeoutMs: 10_000 }); }
    catch { throw new Error("External delivery observation unavailable"); }
    if (r.exitCode !== 0) throw new Error("External delivery observation unavailable");
    let data: unknown;
    try { data = JSON.parse(r.stdout); } catch { throw new Error("Invalid external delivery observation"); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid external delivery observation");
    return data as Record<string, unknown>;
  };
  const issue = await read(`issues/${c.issueNumber}`);
  const pr = await read(`pulls/${t.prNumber}`);
  const head = pr["head"] as { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } } | undefined;
  const base = pr["base"] as { ref?: unknown; repo?: { full_name?: unknown } } | undefined;
  if (issue["number"] !== c.issueNumber || issue["state"] !== "closed" || issue["pull_request"] !== undefined
    || pr["number"] !== t.prNumber || pr["state"] !== "closed" || pr["merged"] !== true
    || pr["merge_commit_sha"] !== t.mergeCommitSha || typeof pr["merged_at"] !== "string"
    || !Number.isFinite(Date.parse(pr["merged_at"])) || head?.sha !== t.headSha || head.ref !== c.headBranch
    || base?.ref !== c.baseBranch || typeof head.repo?.full_name !== "string" || head.repo.full_name.toLowerCase() !== c.repo.toLowerCase()
    || typeof base.repo?.full_name !== "string" || base.repo.full_name.toLowerCase() !== c.repo.toLowerCase()) {
    throw new Error("External delivery target is not the authorized closed/merged identity");
  }
  if (typeof pr["body"] !== "string" && pr["body"] !== null) throw new Error("Missing PR ownership evidence");
  const body = typeof pr["body"] === "string" ? pr["body"] : "";
  const owned = validatePrOwnership(body, c).valid;
  if (!owned && (body.includes("symphony-delivery-marker") || !approved.authorization.allowUnmarkedPr)) {
    throw new Error("Unmarked external PR requires explicit authorization; foreign markers cannot be overridden");
  }
}
