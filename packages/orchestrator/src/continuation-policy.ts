/**
 * 注入给 agent runner 的同线程 continuation decider（SPEC §10.2 / §10.3、§8.2、
 * §16.5，M5.2 / #51）。
 *
 * orchestrator 在这里实现"每个正常 turn 结束后 refresh tracker，再决定是否在同一
 * live thread 上继续"的策略，而 `packages/agent` 只提供执行能力、不 import tracker
 * （AGENTS.md 硬约束：runner 不拥有 scheduler / retry policy）。
 *
 * 与 M5 的 post-worker continuation retry 严格分层：
 * - 本 decider 只决定 same-thread continue / stop，不读并发 slot、不读 claim
 *   eligibility、不做 retry / backoff —— 那些属 authority / M5.3；
 * - 返回 `continue` 时 runner 自己执行 `maxTurns` 上限。
 */
import type { ContinuationDecider, ContinuationDecision, TurnCompletedContext } from "@symphony/agent";
import type { Issue } from "@symphony/domain";

import { isActiveState, isTerminalState, issueRoutable, type DispatchPolicy } from "./eligibility";

/** decider 需要的只读 tracker refresh 能力（§11.1 `fetch_issues_by_ids`）。 */
export interface TrackerRefreshSource {
  fetchIssuesByIds(issueIds: readonly string[]): Promise<readonly Issue[]>;
  /**
   * OPTIONAL：startup terminal sweep（§8.6 / §11.1.1 `fetch_issues_by_states`）与
   * reconciliation 所需的按状态读取。未接线的组合根（或测试 fake）可以省略；省略时
   * {@link OrchestratorAuthority.runStartupTerminalCleanup} 报 `unavailable` 而不发请求。
   */
  fetchIssuesByStates?(stateNames: readonly string[]): Promise<readonly Issue[]>;
}

/** {@link createTrackerRefreshContinuationDecider} 的注入点。 */
export interface TrackerRefreshContinuationOptions {
  readonly tracker: TrackerRefreshSource;
  /**
   * 当前 effective 调度策略（active / terminal states、required labels、routable）。
   *
   * 接受静态对象（旧接线）或 **getter**（M5.5 live config re-apply）：每次 turn
   * 完成判定时读取，因此 workflow reload 后的新 policy 立即作用于之后的
   * continuation 判定，不缓存构造时快照。
   */
  readonly policy: DispatchPolicy | (() => DispatchPolicy);
  /**
   * 当前 attempt 是否仍是该 issue 的权威 running entry。attempt 已被替换 / 移除时，
   * 迟到 refresh 不得再写状态或触发下一 turn。
   */
  readonly isCurrent: () => boolean;
  /** 把 refresh 得到的有效快照回写当前 RunningEntry（仅在 `isCurrent` 时调用）。 */
  readonly onRefreshed: (issue: Issue) => void;
}

/**
 * 构造一个 decider：每个正常 turn 完成后用 `fetchIssuesByIds([issueId])` refresh，
 * 按最新快照 + effective policy 决定 continue / stop。
 *
 * - missing（refresh 结果无该 id）→ stop；
 * - terminal / inactive / unroutable → stop；
 * - active + routable → 回写快照并 continue；
 * - refresh 失败 → 抛出（`executeContinuationDecider` 收敛为 `continuation_failed`）；
 *   超时由 `executeContinuationDecider` 收敛为 `continuation_timeout`；
 * - attempt 过期 / `context.signal` 已 abort → 丢弃迟到结果并 stop，绝不写状态。
 */
export function createTrackerRefreshContinuationDecider(
  options: TrackerRefreshContinuationOptions,
): ContinuationDecider {
  const policyOption = options.policy;
  const currentPolicy: () => DispatchPolicy =
    typeof policyOption === "function" ? policyOption : () => policyOption;

  return async (context: TurnCompletedContext): Promise<ContinuationDecision> => {
    // 用函数读取，避免 TS 对 readonly optional 属性跨 await 的窄化误判。
    const cancelled = (): boolean => context.signal?.aborted ?? false;

    if (!options.isCurrent() || cancelled()) {
      return { kind: "stop" };
    }

    const issues = await options.tracker.fetchIssuesByIds([context.issue.id]);

    // fetch 期间可能已超时 / 被取消 / attempt 被替换：迟到结果一律丢弃。
    if (!options.isCurrent() || cancelled()) {
      return { kind: "stop" };
    }

    const refreshed = issues.find((candidate) => candidate.id === context.issue.id);
    if (refreshed === undefined) {
      return { kind: "stop" };
    }

    options.onRefreshed(refreshed);

    const policy = currentPolicy();
    if (isTerminalState(refreshed.state, policy)) {
      return { kind: "stop" };
    }
    if (!isActiveState(refreshed.state, policy)) {
      return { kind: "stop" };
    }
    if (!issueRoutable(refreshed, policy)) {
      return { kind: "stop" };
    }
    return { kind: "continue", issue: refreshed };
  };
}
