/**
 * @symphony/domain — GitHub Delivery MVP.2: Codex Delivery + Land Workflow Skill Contracts (SPEC §11.5 / MVP.2).
 *
 * 领域纯类型与纯函数契约：
 * - DeliveryContext: 交付上下文（仓库、Issue 编号、WorkspaceKey、分支等）
 * - PrOwnershipMarker: PR 所属标记，防止接管外部或不明确的 PR
 * - CiCheckItem / CiCheckStatus / evaluateCiChecksPolicy: CI 检查状态模型与自动合并评估策略
 * - DeliveryHandoff / formatDeliveryHandoffMarkdown: 预算耗尽或 Blocker 时的可见交接报告（移除 symphony-ready 停止派发）
 * - DeliverySkillConfig / DeliverySkillResult: Skill 运行参数与结果定义
 */

export interface DeliveryContext {
  readonly repo: string;
  readonly issueNumber: number;
  readonly workspaceKey: string;
  readonly headBranch: string;
  readonly baseBranch: string;
}

export interface PrOwnershipMarker {
  readonly workspaceKey: string;
  readonly issueNumber: number;
  readonly repo: string;
  readonly headBranch: string;
  readonly baseBranch: string;
}

const MARKER_PREFIX = "<!-- symphony-delivery-marker:";
const MARKER_SUFFIX = "-->";

/**
 * 序列化 PR 所属标记为 HTML 注释字符串，供嵌入 PR 正文底部。
 */
export function serializePrOwnershipMarker(marker: PrOwnershipMarker): string {
  const json = JSON.stringify({
    workspaceKey: marker.workspaceKey,
    issueNumber: marker.issueNumber,
    repo: marker.repo,
    headBranch: marker.headBranch,
    baseBranch: marker.baseBranch,
  });
  return `${MARKER_PREFIX} ${json} ${MARKER_SUFFIX}`;
}

/**
 * 从 PR 正文中解析 PR 所属标记。若不存在或格式损坏，返回 null。
 */
export function parsePrOwnershipMarker(body: string): PrOwnershipMarker | null {
  const start = body.indexOf(MARKER_PREFIX);
  if (start === -1) {
    return null;
  }
  const end = body.indexOf(MARKER_SUFFIX, start + MARKER_PREFIX.length);
  if (end === -1) {
    return null;
  }
  const rawJson = body.slice(start + MARKER_PREFIX.length, end).trim();
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    if (
      typeof parsed["workspaceKey"] === "string" &&
      typeof parsed["issueNumber"] === "number" &&
      typeof parsed["repo"] === "string" &&
      typeof parsed["headBranch"] === "string" &&
      typeof parsed["baseBranch"] === "string"
    ) {
      return {
        workspaceKey: parsed["workspaceKey"],
        issueNumber: parsed["issueNumber"],
        repo: parsed["repo"],
        headBranch: parsed["headBranch"],
        baseBranch: parsed["baseBranch"],
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 校验 PR 是否合法属于当前 Symphony 工单与工作区。
 */
export function validatePrOwnership(
  marker: PrOwnershipMarker | null,
  context: DeliveryContext,
): boolean {
  if (!marker) {
    return false;
  }
  return (
    marker.repo.toLowerCase() === context.repo.toLowerCase() &&
    marker.issueNumber === context.issueNumber &&
    marker.workspaceKey === context.workspaceKey &&
    marker.headBranch === context.headBranch &&
    marker.baseBranch === context.baseBranch
  );
}

export interface FormatPrBodyOptions {
  readonly description: string;
  readonly issueNumber: number;
  readonly repo: string;
  readonly workspaceKey: string;
  readonly headBranch: string;
  readonly baseBranch: string;
}

/**
 * 格式化 PR 正文：开头包含 Fixes #N 关联，结尾嵌入机器可读的所属标记。
 */
export function formatPrBody(options: FormatPrBodyOptions): string {
  const marker = serializePrOwnershipMarker({
    workspaceKey: options.workspaceKey,
    issueNumber: options.issueNumber,
    repo: options.repo,
    headBranch: options.headBranch,
    baseBranch: options.baseBranch,
  });

  const closingRef = `Fixes #${options.issueNumber}`;
  const descTrimmed = options.description.trim();

  let body = "";
  if (!descTrimmed.includes(closingRef)) {
    body = `${closingRef}\n\n${descTrimmed}`;
  } else {
    body = descTrimmed;
  }

  return `${body}\n\n${marker}\n`;
}

export type CiCheckStatus =
  | "success"
  | "failure"
  | "pending"
  | "cancelled"
  | "neutral"
  | "skipped"
  | "unknown";

export interface CiCheckItem {
  readonly name: string;
  readonly status: CiCheckStatus;
  readonly conclusion: string | null;
  readonly detailsUrl: string | null;
  readonly isRequired: boolean;
}

export interface CiPolicyEvaluation {
  readonly canLand: boolean;
  readonly reason: string;
  readonly failedChecks: readonly CiCheckItem[];
  readonly pendingChecks: readonly CiCheckItem[];
}

export interface EvaluateCiChecksOptions {
  readonly requiredChecks?: readonly string[] | undefined;
}

/**
 * 评估 CI checks 是否满足自动合入（squash merge）策略：
 * 1. 存在 required checks 时：所有 required checks 必须存在且成功，且所有当前观测到的 checks 也必须为 success。
 * 2. 不存在 required checks 时：至少存在 1 项 check，且所有 check 必须为 success。
 * 3. 0 个 checks、存在 pending checks、或存在任何 neutral/skipped/失败/取消/非成功 checks 均拒绝合入。
 */
export function evaluateCiChecksPolicy(
  checks: readonly CiCheckItem[],
  options?: EvaluateCiChecksOptions,
): CiPolicyEvaluation {
  if (checks.length === 0) {
    return {
      canLand: false,
      reason: "zero_checks_observed",
      failedChecks: [],
      pendingChecks: [],
    };
  }

  const failedChecks = checks.filter(
    (c) => c.status === "failure" || c.status === "cancelled" || c.status === "unknown",
  );
  const pendingChecks = checks.filter((c) => c.status === "pending");

  if (failedChecks.length > 0) {
    return {
      canLand: false,
      reason: `failing_checks_detected (${failedChecks.map((c) => c.name).join(", ")})`,
      failedChecks,
      pendingChecks,
    };
  }

  if (pendingChecks.length > 0) {
    return {
      canLand: false,
      reason: `pending_checks_detected (${pendingChecks.map((c) => c.name).join(", ")})`,
      failedChecks,
      pendingChecks,
    };
  }

  // 1. 显式配置的 requiredChecks 检查
  if (options?.requiredChecks && options.requiredChecks.length > 0) {
    const missingRequired = options.requiredChecks.filter(
      (reqName) => !checks.some((c) => c.name === reqName && c.status === "success"),
    );
    if (missingRequired.length > 0) {
      return {
        canLand: false,
        reason: `missing_required_checks (${missingRequired.join(", ")})`,
        failedChecks: [],
        pendingChecks: [],
      };
    }
  }

  // 2. check item 自身标记为 isRequired 的检查
  const requiredChecks = checks.filter((c) => c.isRequired);
  if (requiredChecks.length > 0) {
    const allRequiredSuccess = requiredChecks.every((c) => c.status === "success");
    if (!allRequiredSuccess) {
      return {
        canLand: false,
        reason: "required_checks_not_all_successful",
        failedChecks: [],
        pendingChecks: [],
      };
    }
  }

  // 3. 所有 observed checks 必须严格为 success（不允许 neutral 或 skipped 绕过）
  const allObservedSuccess = checks.every((c) => c.status === "success");
  if (!allObservedSuccess) {
    const nonSuccess = checks.filter((c) => c.status !== "success");
    return {
      canLand: false,
      reason: `non_successful_checks_present (${nonSuccess.map((c) => `${c.name}:${c.status}`).join(", ")})`,
      failedChecks: [],
      pendingChecks: [],
    };
  }

  const hasRequired = (options?.requiredChecks && options.requiredChecks.length > 0) || requiredChecks.length > 0;
  return {
    canLand: true,
    reason: hasRequired ? "all_required_and_observed_checks_succeeded" : "all_observed_checks_succeeded",
    failedChecks: [],
    pendingChecks: [],
  };
}

export type DeliveryHandoffReason =
  | "budget_exhausted"
  | "ci_failed_max_repairs"
  | "ci_wait_timeout"
  | "unmergeable"
  | "manual_intervention_required"
  | "foreign_pr_conflict"
  | "reconciliation_needed";

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
}

