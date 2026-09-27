import type { UtcTimestampMs } from "./time";

/**
 * `Issue.nativeRef` 的载荷类型（SPEC §4.1.1 `native_ref`、§4.2、§11.3）：
 * provider-native 工具所需的**非敏感** provider 标识符。
 *
 * 对 orchestrator 完全不透明：核心逻辑 MUST NOT 解释其中字段，也 MUST NOT 用它做
 * map key；仅在 prompt / tool 上下文中原样透传。provider 元数据无法安全表示时，
 * adapter 将其归一化为 `null`（§11.3）。
 */
export type IssueNativeRef = Readonly<Record<string, unknown>>;

/**
 * `Issue.blockedBy` 的条目（SPEC §4.1.1 `blocked_by`）：best-effort 的 blocker
 * 元数据。adapter MUST NOT 编造无法可靠表示的 blocker 语义（§11.3）；三个字段
 * 皆可为 `null`。
 */
export interface IssueBlockerRef {
  readonly id: string | null;
  readonly identifier: string | null;
  readonly state: string | null;
}

/**
 * 归一化后的可调度工作项（SPEC §4.1.1）。orchestration、prompt 渲染与
 * observability 输出的共享输入；名字中的 "Issue" 是泛指，adapter 可以把 ticket /
 * card / project item 等 provider 原生对象映射到本类型。
 *
 * 缺值语义（§11.3）：normalized 记录中**所有字段必须在场**——nullable 字段用
 * `null`，collection 字段用空数组。因此本类型不含任何 optional property；
 * 归一化**动作**（payload → Issue）归 `packages/tracker`（§11，M2）。
 *
 * `id` / `identifier` / `title` / `state` MUST 为非空字符串（§11.3）。
 */
export interface Issue {
  /**
   * SPEC `id`：configured tracker scope 内稳定的 dispatch identity，对
   * orchestrator 不透明（可以是 project-item / board-entry ID，§4.2）。
   * tracker 刷新调用与内部 map key 一律用它。
   */
  readonly id: string;
  /** SPEC `native_ref`：非敏感 provider 标识符；无则为 `null`（见 {@link IssueNativeRef}）。 */
  readonly nativeRef: IssueNativeRef | null;
  /**
   * SPEC `identifier`：人类可读工单号（如 `ABC-123`），tracker scope 内唯一
   * （跨命名空间的 adapter MUST 消歧）；用于日志与 workspace 命名（§4.2）。
   */
  readonly identifier: string;
  /** SPEC `title`。 */
  readonly title: string;
  /** SPEC `description`。 */
  readonly description: string | null;
  /**
   * SPEC `priority`：dispatch 排序中数值越小优先级越高；未知为 `null`
   * （§11.3：scheduler 把 1..4 排在 null/未知之前，其余整数与 null 同序）。
   */
  readonly priority: number | null;
  /**
   * SPEC `state`：provider 原生状态名，**保留 provider 拼写**（§11.3）；
   * 调度比较前经 {@link normalizeIssueState} 归一化。
   */
  readonly state: string;
  /** SPEC `branch_name`：tracker 提供的分支元数据（如有）。 */
  readonly branchName: string | null;
  /** SPEC `url`。 */
  readonly url: string | null;
  /** SPEC `assignee_id`。 */
  readonly assigneeId: string | null;
  /**
   * SPEC `labels`：已归一化为 trimmed + lowercase，空 label 已剔除、重复
   * SHOULD 去重（§11.3，动作归 adapter）。
   */
  readonly labels: readonly string[];
  /** SPEC `blocked_by`：best-effort provider 元数据；无则为空数组。 */
  readonly blockedBy: readonly IssueBlockerRef[];
  /**
   * SPEC `dispatchable`：adapter 判定的 provider-specific 可派发资格
   * （assignment / board membership / blocker 语义等 generic scheduler 无法安全
   * 推断的规则），MUST 显式给出（§4.1.1 / §11.3）；orchestrator 仍会叠加
   * state / label / claim / retry / 并发等配置规则。
   */
  readonly dispatchable: boolean;
  /** SPEC `created_at`：由 RFC 3339 解析而来（§11.3）；不可得为 `null`。 */
  readonly createdAt: UtcTimestampMs | null;
  /** SPEC `updated_at`：同 `createdAt`。 */
  readonly updatedAt: UtcTimestampMs | null;
}

/**
 * 归一化 issue state 供调度比较（SPEC §4.2 "Normalized Issue State"）：
 * trim 首尾空白 + lowercase。
 *
 * 仅用于比较，不回写 {@link Issue.state}——§11.3 要求 normalized 记录保留
 * provider 拼写。
 */
export function normalizeIssueState(state: string): string {
  return state.trim().toLowerCase();
}
