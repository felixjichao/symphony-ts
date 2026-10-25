/** Validate durable native step records before they can authorize recovery (§4). */
import type { DeliveryContinuation, LandingIntent } from "./delivery";
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function isDeliveryContinuation(value: unknown): value is DeliveryContinuation {
  const r = object(value);
  return !!r && ["intentId", "headBranch", "baseBranch", "headSha", "readyLabel"].every(k => text(r[k]))
    && integer(r["prNumber"]) && r["prNumber"] > 0 && integer(r["maxRepairAttempts"])
    && integer(r["maxWaitSeconds"]) && typeof r["optInLand"] === "boolean"
    && ["ci", "review_intent", "review_wait", "result_observed", "repair_pending", "ready"].includes(String(r["phase"]))
    && ["repairCommand", "validationCommand", "reviewTaskId", "reviewOperationKey"].every(k => r[k] === undefined || text(r[k]))
    && (r["validationTimeoutMs"] === undefined || integer(r["validationTimeoutMs"]) && r["validationTimeoutMs"] > 0)
    && (r["reviewRevision"] === undefined || integer(r["reviewRevision"]))
    && (r["verdict"] === undefined || ["approve", "changes_requested", "needs_human"].includes(String(r["verdict"])))
    && (r["requiredChecks"] === undefined || Array.isArray(r["requiredChecks"]) && r["requiredChecks"].every(text));
}
export function isLandingIntent(value: unknown): value is LandingIntent {
  const r = object(value);
  const c = object(r?.["context"]);
  return !!r && !!c && ["repo", "workspaceKey", "headBranch", "baseBranch"].every(k => text(c[k]))
    && integer(c["issueNumber"]) && c["issueNumber"] > 0 && text(r["intentId"]) && text(r["headSha"])
    && integer(r["prNumber"]) && r["prNumber"] > 0 && r["optIn"] === true
    && ["intent", "observed"].includes(String(r["phase"]))
    && (r["phase"] !== "observed" || text(r["mergeCommitSha"]))
    && (r["mergedAt"] === undefined || text(r["mergedAt"]));
}
