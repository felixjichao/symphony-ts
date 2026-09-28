/**
 * Provider 无关的 tracker read kernel（SPEC §11.1 REQUIRED Adapter Operations）。
 *
 * §11 把 tracker 边界刻意压到最小：**调度所需的读取** + OPTIONAL provider-native
 * agent tools。本文件只有 §11.1 REQUIRED 的两个 operation，且 MUST NOT 因
 * "让各 provider 长得一样"而加 comment / state / attachment 之类的写操作 CRUD
 * （§11 开篇、§11.5：ticket 变更由 coding agent 经 adapter 的 provider-native
 * tools 完成，orchestrator 不拥有写 API）。
 *
 * 返回类型固定为 `@symphony/domain` 的 {@link Issue}：normalized 记录是唯一跨包
 * 契约，provider payload 不得越过 adapter 边界（§11.2 / §11.3）。归一化**动作**
 * （payload → Issue、`dispatchable` 推导、`native_ref` 保留）由各 provider 的
 * adapter 实现（§11.3，GitHub 归 #19）。
 *
 * 两个 operation 一律 **async**：§11.1 的实现是网络 transport（REST / GraphQL），
 * 同步接口会在 provider 落地时变成 breaking change。
 *
 * 失败以 `TrackerError`（§11.4）抛出——SPEC 允许 language-native exception form，
 * public form → category + message 的映射由 adapter profile 文档化。
 */
import type { Issue } from "@symphony/domain";

/**
 * §11.1 的两个 REQUIRED operation；{@link TrackerAdapter}（provider 实现的端口）
 * 与 {@link createTrackerReadKernel} 产出的 read kernel（消费方看到的门面）共用
 * 这一 operation 形状。
 */
export interface TrackerAdapterOperations {
  /**
   * `fetch_issues_by_states(state_names)`（§11.1.1）：返回配置 scope 内处于这些
   * state 的 normalized issues。
   *
   * - adapter MUST 自行应用 provider-side scope selection 与 pagination；
   * - 用于 candidate polling 时**须包含** `dispatchable === false` 的 active
   *   issues——最后的过滤（`required_labels` / dispatchable / claim / retry /
   *   并发）归 orchestrator（§11.1）；
   * - `state_names` 为空 → 空结果且**不发 provider 请求**（§11.1 MUST，
   *   由 {@link createTrackerReadKernel} 统一保证）。
   */
  fetchIssuesByStates(stateNames: readonly string[]): Promise<readonly Issue[]>;

  /**
   * `fetch_issues_by_ids(issue_ids)`（§11.1.2）：返回这些 opaque dispatch ID 的
   * **当前完整 normalized snapshot**（不只是 state 字符串——label / assignment /
   * routing / provider-specific dispatchability 都会在运行期变化）。
   *
   * - 用于 active-run reconciliation 与 stale-dispatch revalidation；
   * - 已不在配置 scope 内的 ID **被省略**，orchestrator 视省略为"不再可见"，
   *   adapter MUST NOT 伪造 synthetic state；
   * - `issue_ids` 为空 → 空结果且**不发 provider 请求**（§11.1 MUST，由
   *   {@link createTrackerReadKernel} 统一保证）。
   */
  fetchIssuesByIds(issueIds: readonly string[]): Promise<readonly Issue[]>;
}

/**
 * provider adapter 实现的端口（§11.2）：一个 provider 一个实现（GitHub 归 #19）。
 *
 * `kind` 是该 adapter 处理的**确切** `tracker.kind` 值（§11.2 compact profile 的
 * "exact supported tracker.kind value"），供诊断与 observability 输出使用。
 */
export interface TrackerAdapter extends TrackerAdapterOperations {
  readonly kind: string;
}

/** 空结果共享实例：避免每次空输入调用都新建数组。 */
const NO_ISSUES: readonly Issue[] = Object.freeze([]);

/**
 * 把 provider adapter 包装成 §11.1 read kernel：透传两个 operation，并统一保证
 * "空输入 → 空结果且零 provider 请求"（§11.1 两处 MUST、§17.1 两条验收）。
 *
 * 该不变量属 provider 无关的内核语义，因此由各 adapter **重复实现一遍**是错误
 * 归属——{@link TrackerAdapterRegistry.create}（`registry.ts`）恒经本函数包装，
 * adapter 只需假定拿到的是非空输入。
 *
 * 除此以外不加策略：分页、重试、cadence、required-label 过滤、并发上限都归
 * provider adapter 与 coordination 层（§11.2 / §8，根 AGENTS.md 依赖方向）。
 */
export function createTrackerReadKernel(adapter: TrackerAdapter): TrackerAdapter {
  return {
    kind: adapter.kind,
    fetchIssuesByStates: (stateNames) =>
      stateNames.length === 0 ? Promise.resolve(NO_ISSUES) : adapter.fetchIssuesByStates(stateNames),
    fetchIssuesByIds: (issueIds) =>
      issueIds.length === 0 ? Promise.resolve(NO_ISSUES) : adapter.fetchIssuesByIds(issueIds),
  };
}
