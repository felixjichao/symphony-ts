/**
 * Stable dispatch sort（SPEC §8.2 Candidate Selection Rules、§16.2
 * `sort_for_dispatch`）。
 *
 * 纯比较器 + 非破坏性排序；不读 runtime state、不访问 tracker。
 */
import type { Issue } from "@symphony/domain";

/** `priority` 的优先 bucket 上界：1..4 为高优先级，其余整数与 `null` 同属低 bucket。 */
const PRIORITY_BUCKET_MAX = 4;

/** 优先级 bucket 秩：1..4 返回自身，其余（含 `null`）返回 `Infinity`（并列）。 */
function priorityRank(priority: number | null): number {
  if (
    priority !== null &&
    Number.isInteger(priority) &&
    priority >= 1 &&
    priority <= PRIORITY_BUCKET_MAX
  ) {
    return priority;
  }
  return Number.POSITIVE_INFINITY;
}

/** createdAt oldest first；`null` 最后（SPEC §8.2）。 */
function compareCreatedAt(a: Issue, b: Issue): number {
  if (a.createdAt === b.createdAt) {
    return 0;
  }
  if (a.createdAt === null) {
    return 1;
  }
  if (b.createdAt === null) {
    return -1;
  }
  return a.createdAt < b.createdAt ? -1 : 1;
}

/** identifier 字典序 tie-breaker（SPEC §8.2）。 */
function compareIdentifier(a: Issue, b: Issue): number {
  if (a.identifier === b.identifier) {
    return 0;
  }
  return a.identifier < b.identifier ? -1 : 1;
}

/**
 * dispatch 排序比较器（SPEC §8.2）：
 *
 * 1. priority 1..4 升序；其他整数与 `null` 同属低优先级 bucket；
 * 2. createdAt oldest first，`null` 最后；
 * 3. identifier 字典序。
 */
export function compareForDispatch(a: Issue, b: Issue): number {
  const rankA = priorityRank(a.priority);
  const rankB = priorityRank(b.priority);
  if (rankA !== rankB) {
    return rankA < rankB ? -1 : 1;
  }
  return compareCreatedAt(a, b) || compareIdentifier(a, b);
}

/**
 * 按 §8.2 排序候选 issues，返回新数组（不修改入参）。
 *
 * `Array.prototype.sort` 在受支持的 Node（>= 20）上稳定，因此同 key 项保持输入序。
 */
export function sortForDispatch(issues: readonly Issue[]): Issue[] {
  return [...issues].sort(compareForDispatch);
}
