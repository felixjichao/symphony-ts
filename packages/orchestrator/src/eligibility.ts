/**
 * Dispatch eligibility 与并发 slot 的纯逻辑内核（SPEC §8.2 Candidate Selection
 * Rules、§8.3 Concurrency Control、§16.2 / §16.4）。
 *
 * 本模块只读 runtime state、不修改它，也不 fetch tracker / spawn worker / 解释
 * agent 协议。`issue_routable(issue)`（§8.2）刻意只表示 adapter `dispatchable`
 * 与 required-label 匹配——state 归属、claim 与并发由外围算法分别检查。
 */
import { normalizeIssueState, type Issue, type OrchestratorRuntimeState } from "@symphony/domain";

/**
 * dispatch 决策所需的 effective 调度策略（每 tick 由 composition 层从 effective
 * config 提供，§6.2 reload 后沿用新值）。
 *
 * 全局并发上限不在此处：它是 {@link OrchestratorRuntimeState.maxConcurrentAgents}
 * 上的"当前生效"标量。
 */
export interface DispatchPolicy {
  /** `tracker.active_states` 的 effective 值；比较时归一化（§8.2）。 */
  readonly activeStates: readonly string[];
  /** `tracker.terminal_states` 的 effective 值；比较时归一化（§8.2）。 */
  readonly terminalStates: readonly string[];
  /** `tracker.required_labels`，匹配忽略大小写与首尾空白（§5.3.1 / §8.2）。 */
  readonly requiredLabels: readonly string[];
  /** `agent.max_concurrent_agents_by_state`；key 已归一化（§5.3.5 / §8.3）。 */
  readonly maxConcurrentAgentsByState: Readonly<Record<string, number>>;
}

/** label 归一化：trim 首尾空白 + lowercase（SPEC §5.3.1 required-label 匹配口径）。 */
export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

/** issue 是否具备 §8.2 要求的必填调度字段（`id` / `identifier` / `title` / `state` 非空）。 */
export function hasRequiredDispatchFields(issue: Issue): boolean {
  return (
    issue.id.length > 0 &&
    issue.identifier.length > 0 &&
    issue.title.length > 0 &&
    issue.state.length > 0
  );
}

/** state 是否属于 active states（两侧均经 `normalizeIssueState`，§4.2 / §8.2）。 */
export function isActiveState(state: string, policy: DispatchPolicy): boolean {
  const normalized = normalizeIssueState(state);
  return policy.activeStates.some((candidate) => normalizeIssueState(candidate) === normalized);
}

/** state 是否属于 terminal states（两侧均经 `normalizeIssueState`，§4.2 / §8.2）。 */
export function isTerminalState(state: string, policy: DispatchPolicy): boolean {
  const normalized = normalizeIssueState(state);
  return policy.terminalStates.some((candidate) => normalizeIssueState(candidate) === normalized);
}

/**
 * issue 是否命中**每个** required label（SPEC §8.2 / §5.3.1）：忽略大小写与首尾
 * 空白；空白配置项不命中任何 issue。无 required labels 时恒为 `true`。
 */
export function matchesRequiredLabels(issue: Issue, policy: DispatchPolicy): boolean {
  if (policy.requiredLabels.length === 0) {
    return true;
  }
  const issueLabels = new Set(issue.labels.map(normalizeLabel));
  return policy.requiredLabels.every((required) => {
    const normalized = normalizeLabel(required);
    return normalized.length > 0 && issueLabels.has(normalized);
  });
}

/**
 * `issue_routable(issue)`（SPEC §8.2）：adapter `dispatchable === true` 且全部
 * required labels 匹配。state / claim / concurrency 由外围算法另行检查。
 */
export function issueRoutable(issue: Issue, policy: DispatchPolicy): boolean {
  return issue.dispatchable && matchesRequiredLabels(issue, policy);
}

/** 全局可用 slot：`max(max_concurrent_agents - running_count, 0)`（SPEC §8.3）。 */
export function globalAvailableSlots(state: OrchestratorRuntimeState): number {
  return Math.max(state.maxConcurrentAgents - state.running.size, 0);
}

/** 某 state 当前的 running 数（按 running entry 的当前 issue state，归一化比较）。 */
export function runningCountForState(state: OrchestratorRuntimeState, stateName: string): number {
  const normalized = normalizeIssueState(stateName);
  let count = 0;
  for (const entry of state.running.values()) {
    if (normalizeIssueState(entry.issue.state) === normalized) {
      count += 1;
    }
  }
  return count;
}

/**
 * 某 state 的可用 slot（SPEC §8.3）：存在 normalized state override 时用 override，
 * 否则 fallback 全局上限；结果不为负。
 *
 * override 查找只认 **own property**：`maxConcurrentAgentsByState` 是普通对象，
 * 若 state 归一化后恰为 `constructor` / `toString` 等 `Object.prototype` 键，直接
 * 索引会取到继承值（非 number），把 limit 变成 `undefined` 语义之外的值并使结果
 * 成为 `NaN`。缺失即 fallback 全局上限。
 */
export function perStateAvailableSlots(
  state: OrchestratorRuntimeState,
  stateName: string,
  policy: DispatchPolicy,
): number {
  const normalized = normalizeIssueState(stateName);
  const overrides = policy.maxConcurrentAgentsByState;
  const override = Object.hasOwn(overrides, normalized) ? overrides[normalized] : undefined;
  const limit = override ?? state.maxConcurrentAgents;
  return Math.max(limit - runningCountForState(state, stateName), 0);
}

/**
 * candidate issue 是否可 dispatch（SPEC §8.2）：必填字段在场、state ∈ active 且
 * ∉ terminal、`issue_routable`、不在 `running`、不在 `claimed`，且全局与 per-state
 * slot 均可用。
 *
 * `completed` 不参与 gating（§4.1.8 / §7.1）：成功退出只是记账，之后仍可重新派发。
 */
export function isDispatchEligible(
  issue: Issue,
  state: OrchestratorRuntimeState,
  policy: DispatchPolicy,
): boolean {
  return (
    hasRequiredDispatchFields(issue) &&
    isActiveState(issue.state, policy) &&
    !isTerminalState(issue.state, policy) &&
    issueRoutable(issue, policy) &&
    !state.running.has(issue.id) &&
    !state.claimed.has(issue.id) &&
    globalAvailableSlots(state) > 0 &&
    perStateAvailableSlots(state, issue.state, policy) > 0
  );
}

/**
 * retry refresh 后允许重新派发的判定（SPEC §16.6 `retry_dispatch_allowed(issue, state,
 * ignore_existing_claim=issue_id)`）：与 {@link isDispatchEligible} 相同，但**忽略该
 * issue 自己持有的 claim**——retry 恰需在 claim 保留的情况下消费它。
 *
 * 仍然要求：必填字段在场、state ∈ active ∧ ∉ terminal、`issue_routable`、不在
 * `running`；**不**检查 claim（由 `ownClaimIssueId` 豁免）与并发 slot（slot 由调用方
 * 单独检查，以便区分"不可派发"与 `no available orchestrator slots`）。
 */
export function isRetryDispatchAllowed(
  issue: Issue,
  state: OrchestratorRuntimeState,
  policy: DispatchPolicy,
  ownClaimIssueId: string,
): boolean {
  return (
    hasRequiredDispatchFields(issue) &&
    isActiveState(issue.state, policy) &&
    !isTerminalState(issue.state, policy) &&
    issueRoutable(issue, policy) &&
    !state.running.has(issue.id) &&
    (!state.claimed.has(issue.id) || issue.id === ownClaimIssueId)
  );
}
