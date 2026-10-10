/**
 * @symphony/domain — GitHub delivery and auto-merge policy types and pure functions (SPEC §11.5 / MVP.3).
 */
import type { DecisionReviewTarget, DecisionTask, DecisionResult } from "./decision";
import type { DecisionContextBundle } from "./decision-context";

export interface DeliveryContext {
  readonly repo: string;
  readonly issueNumber: number;
  readonly workspaceKey: string;
  readonly headBranch: string;
  readonly baseBranch: string;
}

export interface PrOwnershipMarker {
  readonly schemaVersion: 1;
  readonly repo: string;
  readonly issueNumber: number;
  readonly workspaceKey: string;
  readonly headBranch: string;
  readonly baseBranch: string;
}

const MARKER_START = "<!-- symphony-delivery-marker:";
const MARKER_END = "-->";

export function serializePrOwnershipMarker(marker: PrOwnershipMarker): string {
  const json = JSON.stringify({
    schemaVersion: 1,
    repo: marker.repo,
    issueNumber: marker.issueNumber,
    workspaceKey: marker.workspaceKey,
    headBranch: marker.headBranch,
    baseBranch: marker.baseBranch,
  });
  return `${MARKER_START} ${json} ${MARKER_END}`;
}

export function parsePrOwnershipMarker(body: string): PrOwnershipMarker | null {
  const startIndex = body.indexOf(MARKER_START);
  if (startIndex === -1) {
    return null;
  }
  const endIndex = body.indexOf(MARKER_END, startIndex);
  if (endIndex === -1) {
    return null;
  }
  const jsonStr = body.substring(startIndex + MARKER_START.length, endIndex).trim();
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    if (parsed["schemaVersion"] !== 1) {
      return null;
    }
    if (
      typeof parsed["repo"] !== "string" ||
      typeof parsed["issueNumber"] !== "number" ||
      typeof parsed["workspaceKey"] !== "string" ||
      typeof parsed["headBranch"] !== "string" ||
      typeof parsed["baseBranch"] !== "string"
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      repo: parsed["repo"],
      issueNumber: parsed["issueNumber"],
      workspaceKey: parsed["workspaceKey"],
      headBranch: parsed["headBranch"],
      baseBranch: parsed["baseBranch"],
    };
  } catch {
    return null;
  }
}

export function validatePrOwnership(
  body: string,
  expected: DeliveryContext,
): { readonly valid: true; readonly marker: PrOwnershipMarker } | { readonly valid: false; readonly reason: string } {
  // Check for multiple/conflicting markers
  const markerMatches = body.match(/<!--\s*symphony-delivery-marker:/g);
  if (!markerMatches || markerMatches.length === 0) {
    return { valid: false, reason: "missing_or_malformed_symphony_marker" };
  }
  if (markerMatches.length > 1) {
    return { valid: false, reason: "conflicting_multiple_markers_found" };
  }

  const marker = parsePrOwnershipMarker(body);
  if (!marker) {
    return { valid: false, reason: "missing_or_malformed_symphony_marker" };
  }
  if (marker.repo.toLowerCase() !== expected.repo.toLowerCase()) {
    return { valid: false, reason: `repo_mismatch: expected ${expected.repo}, got ${marker.repo}` };
  }
  if (marker.issueNumber !== expected.issueNumber) {
    return { valid: false, reason: `issue_mismatch: expected ${expected.issueNumber}, got ${marker.issueNumber}` };
  }
  if (marker.workspaceKey !== expected.workspaceKey) {
    return { valid: false, reason: `workspace_key_mismatch: expected ${expected.workspaceKey}, got ${marker.workspaceKey}` };
  }
  if (marker.headBranch !== expected.headBranch) {
    return { valid: false, reason: `head_branch_mismatch: expected ${expected.headBranch}, got ${marker.headBranch}` };
  }
  if (marker.baseBranch !== expected.baseBranch) {
    return { valid: false, reason: `base_branch_mismatch: expected ${expected.baseBranch}, got ${marker.baseBranch}` };
  }

  // Check closing issue association strictly: keyword (Fixes|Closes|Resolves) + exact issue reference
  const closingRegex = /\b(?:fixes|closes|resolves)\s+(?:https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/|([^\s#]+)#|#)(\d+)\b/gi;
  let hasValidClosingRef = false;
  let match: RegExpExecArray | null;
  while ((match = closingRegex.exec(body)) !== null) {
    const matchedRepo = match[1] ?? match[2];
    const matchedNumber = parseInt(match[3]!, 10);
    if (matchedNumber === expected.issueNumber) {
      if (!matchedRepo || matchedRepo.toLowerCase() === expected.repo.toLowerCase()) {
        hasValidClosingRef = true;
        break;
      }
    }
  }
  if (!hasValidClosingRef) {
    return { valid: false, reason: `missing_issue_association_in_body: #${expected.issueNumber}` };
  }

  return { valid: true, marker };
}

export function formatPrBody(options: {
  readonly body?: string | undefined;
  readonly context: DeliveryContext;
}): string {
  const marker = serializePrOwnershipMarker({
    schemaVersion: 1,
    repo: options.context.repo,
    issueNumber: options.context.issueNumber,
    workspaceKey: options.context.workspaceKey,
    headBranch: options.context.headBranch,
    baseBranch: options.context.baseBranch,
  });

  const baseText = options.body ? options.body.trim() : `Automated changes for issue #${options.context.issueNumber}`;
  const closingRef = `Fixes ${options.context.repo}#${options.context.issueNumber}`;

  return `${baseText}\n\n${closingRef}\n\n${marker}\n`;
}

export type PrState = "OPEN" | "CLOSED" | "MERGED";
export type PrMergeability = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export interface PrRecord {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly state: PrState;
  readonly isDraft: boolean;
  readonly mergeable: PrMergeability;
  readonly headBranch: string;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly mergedAt: string | null;
  readonly mergeCommitSha: string | null;
  readonly marker: PrOwnershipMarker | null;
}

export type CheckConclusion =
  | "SUCCESS"
  | "FAILURE"
  | "NEUTRAL"
  | "CANCELLED"
  | "TIMED_OUT"
  | "ACTION_REQUIRED"
  | "SKIPPED"
  | "UNKNOWN";

export type CheckState = "PENDING" | "COMPLETED";

export interface PrCheck {
  readonly name: string;
  readonly workflowName?: string | null | undefined;
  readonly state: CheckState;
  readonly conclusion: CheckConclusion | null;
  readonly isRequired: boolean;
  readonly detailsUrl?: string | null | undefined;
  readonly startedAt?: string | null | undefined;
  readonly completedAt?: string | null | undefined;
  readonly appId?: number | string | null | undefined;
}

export type ChecksSummaryStatus = "passed" | "failing" | "pending" | "none" | "unknown";

export interface ChecksEvaluationResult {
  readonly canAutoMerge: boolean;
  readonly status: ChecksSummaryStatus;
  readonly reason: string;
  readonly failedOrPendingChecks: readonly PrCheck[];
}

/**
 * Auto-merge CI policy (confirmed by user):
 * - If required checks are configured:
 *     All required checks MUST be strictly SUCCESS.
 *     All current checks MUST also be strictly SUCCESS.
 * - If NO required checks are configured:
 *     At least one current check MUST exist, and ALL current checks MUST be strictly SUCCESS.
 * - Any pending, failing, skipped, neutral, cancelled, timed_out, unknown checks -> refuse auto-merge.
 */
export function evaluateChecksAutoMergePolicy(
  requiredChecks: readonly PrCheck[],
  currentChecks: readonly PrCheck[],
): ChecksEvaluationResult {
  const allChecks = [...currentChecks];
  // Ensure required checks are included in allChecks if not already present
  for (const req of requiredChecks) {
    if (!allChecks.some(c => c.name === req.name && (req.appId == null || c.appId === req.appId))) {
      allChecks.push(req);
    }
  }

  const isSuccess = (check: PrCheck): boolean => {
    return check.state === "COMPLETED" && check.conclusion === "SUCCESS";
  };

  const isPending = (check: PrCheck): boolean => {
    return check.state === "PENDING" || check.conclusion === null;
  };

  if (requiredChecks.length > 0) {
    // 1. Required checks exist
    const pendingRequired = requiredChecks.filter(isPending);
    if (pendingRequired.length > 0) {
      const names = pendingRequired.map(c => c.name).join(", ");
      return {
        canAutoMerge: false,
        status: "pending",
        reason: `Required check(s) pending: ${names}`,
        failedOrPendingChecks: pendingRequired,
      };
    }

    const failedRequired = requiredChecks.filter(c => !isSuccess(c));
    if (failedRequired.length > 0) {
      const names = failedRequired.map(c => `${c.name} (${c.conclusion ?? "incomplete"})`).join(", ");
      return {
        canAutoMerge: false,
        status: "failing",
        reason: `Required check(s) did not succeed: ${names}`,
        failedOrPendingChecks: failedRequired,
      };
    }

    // Also check current checks
    const pendingCurrent = currentChecks.filter(isPending);
    if (pendingCurrent.length > 0) {
      const names = pendingCurrent.map(c => c.name).join(", ");
      return {
        canAutoMerge: false,
        status: "pending",
        reason: `Current check(s) pending: ${names}`,
        failedOrPendingChecks: pendingCurrent,
      };
    }

    const failedCurrent = currentChecks.filter(c => !isSuccess(c));
    if (failedCurrent.length > 0) {
      const names = failedCurrent.map(c => `${c.name} (${c.conclusion ?? "incomplete"})`).join(", ");
      return {
        canAutoMerge: false,
        status: "failing",
        reason: `Current check(s) did not succeed: ${names}`,
        failedOrPendingChecks: failedCurrent,
      };
    }

    return {
      canAutoMerge: true,
      status: "passed",
      reason: `All ${requiredChecks.length} required checks and ${currentChecks.length} current checks succeeded`,
      failedOrPendingChecks: [],
    };
  }

  // 2. No required checks configured
  if (currentChecks.length === 0) {
    return {
      canAutoMerge: false,
      status: "none",
      reason: "No checks found for commit; auto-merge requires at least one successful check",
      failedOrPendingChecks: [],
    };
  }

  const pendingChecks = currentChecks.filter(isPending);
  if (pendingChecks.length > 0) {
    const names = pendingChecks.map(c => c.name).join(", ");
    return {
      canAutoMerge: false,
      status: "pending",
      reason: `Check(s) pending: ${names}`,
      failedOrPendingChecks: pendingChecks,
    };
  }

  const nonSuccessChecks = currentChecks.filter(c => !isSuccess(c));
  if (nonSuccessChecks.length > 0) {
    const names = nonSuccessChecks.map(c => `${c.name} (${c.conclusion ?? "incomplete"})`).join(", ");
    return {
      canAutoMerge: false,
      status: "failing",
      reason: `Check(s) did not strictly succeed: ${names}`,
      failedOrPendingChecks: nonSuccessChecks,
    };
  }

  return {
    canAutoMerge: true,
    status: "passed",
    reason: `All ${currentChecks.length} current checks strictly succeeded (no required checks configured)`,
    failedOrPendingChecks: [],
  };
}

export type DeliveryErrorCode =
  | "invalid_context"
  | "ownership_refusal"
  | "checks_waiting"
  | "checks_failing"
  | "checks_unknown"
  | "head_changed"
  | "auth_failure"
  | "rate_limited"
  | "network_failure"
  | "cli_missing"
  | "cli_malformed_response"
  | "timeout"
  | "merge_rejected"
  | "verification_unknown"
  | "opt_in_required"
  | "pr_closed_unmerged"
  | "review_gate_required"
  | "review_not_approved"
  | "session_mismatch";

export interface DeliveryErrorOptions extends ErrorOptions {
  readonly code: DeliveryErrorCode;
  readonly details?: Record<string, unknown> | undefined;
}

export class DeliveryError extends Error {
  readonly code: DeliveryErrorCode;
  readonly details?: Record<string, unknown> | undefined;

  constructor(message: string, options: DeliveryErrorOptions) {
    super(message, options);
    this.name = "DeliveryError";
    this.code = options.code;
    this.details = options.details;
  }
}

export interface DeliveryReviewApprovalResult {
  readonly approved: boolean;
  readonly reason: string;
  readonly taskId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly headSha?: string | undefined;
  readonly verdict?: "approve" | "changes_requested" | "needs_human" | "pending" | "none" | undefined;
}

export interface DeliveryReviewStatusResult {
  readonly taskId: string;
  readonly status: "pending" | "claimed" | "running" | "completed" | "failed" | "cancelled" | "superseded";
  readonly result?: DecisionResult | null | undefined;
  readonly error?: string | undefined;
}

export interface DeliveryReviewGate {
  /**
   * Ensure or create an active ReviewTask for the given delivery session and PR target,
   * attaching the specified context atomically.
   */
  ensureReviewTask(
    sessionId: string,
    target: DecisionReviewTarget,
    context?: DecisionContextBundle,
    options?: { operationKey?: string },
  ): Promise<DecisionTask>;

  /**
   * Poll or query the status/result of the review for the given task.
   */
  getReviewStatus(
    taskId: string,
  ): Promise<DeliveryReviewStatusResult>;

  /**
   * Pre-merge approval check (fail closed).
   * Validates that task is completed, verdict is approve, and target PR & HEAD SHA match.
   */
  verifyReviewApproval(
    target: DecisionReviewTarget & { readonly sessionId?: string },
  ): Promise<DeliveryReviewApprovalResult>;

  /**
   * Supersede prior reviews when a new HEAD is pushed or when replacing PR.
   */
  supersedeReviewTask?(taskId: string): Promise<void>;
}

/**
 * @symphony/domain — GitHub Delivery MVP.2: Codex Delivery + Land Workflow Skill Contracts (SPEC §11.5 / MVP.2).
 *
 * NEST-91 独有的 skill 运行参数、可见交接报告与预算状态类型。共享的 PR 所属标记、
 * PR/checks 记录与 CI 门禁策略以本文件上方的 canonical 定义（MVP.3 / NEST-92）为唯一权威。
 */

export type DeliveryHandoffReason =
  | "budget_exhausted"
  | "ci_failed_max_repairs"
  | "ci_wait_timeout"
  | "unmergeable"
  | "manual_intervention_required"
  | "foreign_pr_conflict"
  | "reconciliation_needed"
  | "review_changes_requested_max_repairs"
  | "review_needs_human";

export interface DeliveryHandoff {
  readonly reason: DeliveryHandoffReason;
  readonly details: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly headBranch: string;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly headSha: string | null;
  readonly spentRepairs: number;
  readonly maxRepairs: number;
  readonly spentWaitSeconds: number;
  readonly maxWaitSeconds: number;
  readonly readyLabel: string;
  readonly readyLabelRemoved?: boolean | undefined;
  readonly commentPosted?: boolean | undefined;
}

export interface PersistedDeliveryState {
  readonly repo: string;
  readonly issueNumber: number;
  readonly workspaceKey: string;
  readonly spentRepairs: number;
  readonly spentWaitSeconds: number;
  readonly deadlineTimestampMs?: number | undefined;
  readonly isPaused: boolean;
  readonly pauseReason?: string | undefined;
  readonly lastUpdated: string;
}

/**
 * 格式化 Blocker / 预算耗尽时的可见交接报告（Operator-Visible Handoff Report）。
 *
 * 核心设计决策（用户确认）：
 * - GitHub issue 保持 open，不误关任务；
 * - 尝试移除 symphony-ready 标签，停止 continuation 与后续派发；若移除失败，诚实记录告警；
 * - 明确列出已消耗预算与恢复指南，由 Operator 处理后重新加回标签。
 */
export function formatDeliveryHandoffMarkdown(handoff: DeliveryHandoff): string {
  const prDisplay = handoff.prUrl
    ? `[#${handoff.prNumber}](${handoff.prUrl})`
    : handoff.prNumber
      ? `#${handoff.prNumber}`
      : "无 (尚未创建)";
  const headDisplay = handoff.headSha ? `\`${handoff.headSha.slice(0, 10)}\`` : "未知";

  const labelStatusText =
    handoff.readyLabelRemoved === false
      ? `⚠️ **从 Issue #${handoff.issueNumber} 移除 \`${handoff.readyLabel}\` 标签失败**（可能缺乏写权限或 GitHub API 异常），**自动停止派发未成功**，请 Operator 立即人工介入移除标签！`
      : `已从 Issue #${handoff.issueNumber} 移除 \`${handoff.readyLabel}\` 标签，**已自动停止当前任务派发与 Continuation 循环**。`;

  const commentStatusText =
    handoff.commentPosted === false
      ? `\n- **评论状态**: ⚠️ 交接评论发表失败，请通过命令行日志核对原因。`
      : "";

  return `## 🚨 Symphony Delivery Handoff Report

**触发原因**：\`${handoff.reason}\`
**详细信息**：${handoff.details}

---

### 1. 任务与交付状态
- **Repository**: \`${handoff.repo}\`
- **Issue**: #${handoff.issueNumber}
- **Branch**: \`${handoff.headBranch}\`
- **PR**: ${prDisplay}
- **Head SHA**: ${headDisplay}

### 2. 预算消耗情况
- **修复重试消耗**: ${handoff.spentRepairs} / ${handoff.maxRepairs} 次上限
- **CI 等待时间消耗**: ${handoff.spentWaitSeconds}s / ${handoff.maxWaitSeconds}s 上限

### 3. 调度控制与交接说明
- **Issue 状态保持**: Open（未完成，绝不误关闭）
- **标签操作**: ${labelStatusText}${commentStatusText}
- **恢复操作指引**:
  1. 人工排查上述详情或 CI 日志中的 blocker / 失败项；
  2. 修复问题后，在 GitHub Issue #${handoff.issueNumber} 上重新添加 \`${handoff.readyLabel}\` 标签以恢复 Symphony 自动调度。
`;
}

export interface DeliverySkillConfig {
  readonly repo: string;
  readonly issueNumber: number;
  readonly workspaceKey: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly validationCommand?: string | undefined;
  readonly repairCommand?: string | undefined;
  readonly maxRepairAttempts?: number | undefined;
  readonly maxWaitSeconds?: number | undefined;
  readonly pollIntervalSeconds?: number | undefined;
  readonly readyLabel?: string | undefined;
  readonly commitType?: string | undefined;
  readonly commitMessage?: string | undefined;
  readonly prTitle?: string | undefined;
  readonly optInLand?: boolean | undefined;
  readonly resume?: boolean | undefined;
  readonly requiredChecks?: readonly string[] | undefined;
  readonly reviewGate?: DeliveryReviewGate | undefined;
  readonly sessionId?: string | undefined;
  readonly reviewPollIntervalSeconds?: number | undefined;
}

export type DeliverySkillStatus = "completed" | "blocked" | "ready_to_land";

export interface DeliverySkillResult {
  readonly status: DeliverySkillStatus;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly headSha: string | null;
  readonly mergeSha?: string | null | undefined;
  readonly spentRepairs: number;
  readonly spentWaitSeconds: number;
  readonly reason: string;
  readonly handoffMarkdown?: string | undefined;
  readonly reviewTaskId?: string | null | undefined;
}
