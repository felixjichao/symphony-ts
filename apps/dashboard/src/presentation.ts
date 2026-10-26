import type { AttentionState, ReviewApprovalState, SourceFreshness, WorkProjection } from "@symphony/operations";
import { token } from "./identity";
export const attentionRank = { needs_human: 0, failed: 0, degraded: 1, waiting: 2, normal: 3 } satisfies Record<AttentionState, number>;
export const approvalLabels = {
  approved_current_head: "当前 HEAD 获批（观察投影，非合并授权）",
  approved_stale_head: "旧 HEAD / 陈旧批准，不表示当前 HEAD 获批",
  changes_requested: "要求修改", pending: "等待审查", not_approved: "未获批", unknown: "批准状态未知",
} satisfies Record<ReviewApprovalState, string>;
export const freshnessLabels = { fresh: "新鲜", stale: "陈旧", unknown: "未知 / 未观测", unavailable: "读取不可用" } satisfies Record<SourceFreshness["status"], string>;
export function ordered(work: readonly WorkProjection[]): WorkProjection[] {
  return [...work].sort((a, b) => attentionRank[a.attention] - attentionRank[b.attention] || token(a.key).localeCompare(token(b.key)));
}
export function timestamp(value: number | null | undefined): string {
  return value == null ? "未报告" : new Date(value).toISOString();
}
export function freshness(value: SourceFreshness): string {
  return `${value.status} · ${freshnessLabels[value.status]} · 观测 ${timestamp("observedAt" in value ? value.observedAt : null)} · 尝试 ${timestamp(value.lastAttemptAt)}${"reason" in value ? ` · ${value.reason ?? "未报告原因"}` : ""}`;
}
