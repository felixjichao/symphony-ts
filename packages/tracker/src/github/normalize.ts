/**
 * GitHub REST issue payload → normalized `Issue`（SPEC §11.2 "mapping provider
 * payloads into the normalized Issue fields in Section 4.1.1" + §11.3
 * Normalization Rules，NEST-55 / #19）。
 *
 * 纯函数：不读环境变量、不发请求、无日志。形如
 * `POST /repos/{owner}/{repo}/issues` 返回的 issue 对象即本模块的输入面。
 *
 * **malformed 的判定只覆盖 §11.1 列出的 required 面**：`id` / `identifier` /
 * `title` / `state` / 显式 `dispatchable`，以及"应用完 §11.3 optional-field
 * fallback 后仍无法产出合法 `Issue`"。可空字段的坏值一律走 fallback（`null` /
 * 空数组 / 丢弃条目），不使整条记录 malformed（§11.1 "that fallback alone does
 * not make a record malformed"）。
 *
 * 失败以 {@link TrackerError}（`tracker_response`，§11.4 "malformed or
 * semantically invalid payload"）抛出：调用方（`GitHubTrackerAdapter`）按
 * §11.1 决定 state-list 省略并记日志、ID-refresh 直接失败，故此处必须抛出而非
 * 返回 union——返回 union 会把"这条记录 malformed 了但我不确定能不能丢"的信息
 * 在两层之间丢失。
 */
import type { Issue } from "@symphony/domain";

import { TrackerError } from "../errors";

/** §11.3 "created_at / updated_at MUST represent parsed RFC 3339 instants or null"。 */
const RFC_3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** `GH-` 前缀：`Issue.identifier` 的人读面（§4.2 "MUST be unique within the configured tracker scope"）。 */
const IDENTIFIER_PREFIX = "GH-";

/**
 * 把一条 GitHub REST issue payload 归一化为 §4.1.1 的 `Issue`。
 *
 * @param repo 已校验的 `owner/repo`，只用于 `native_ref.repo`（§11.2 "preserving
 *   any distinct underlying IDs in `native_ref`"）；GitHub 的 issue `number` 仅在
 *   单个 repository 内唯一，所以 `native_ref` 必须连 `repo` 一起给出。
 * @throws TrackerError（`tracker_response`）当 required 字段无法产出。
 */
export function normalizeGitHubIssue(payload: unknown, repo: string): Issue {
  const record = asRecord(payload);
  if (record === null) {
    throw malformed("payload is not an object");
  }

  const number = toIssueNumber(record["number"]);
  if (number === null) {
    throw malformed("`number` is missing or is not a non-negative integer");
  }

  const title = toNonEmptyString(record["title"]);
  if (title === null) {
    throw malformed("`title` is missing or is not a non-empty string");
  }

  // §11.3 "Preserve provider spelling in state" —— 不 trim、不 lowercase；
  // 调度比较前的归一化由 @symphony/domain 的 normalizeIssueState 负责。
  const state = toNonEmptyString(record["state"]);
  if (state === null) {
    throw malformed("`state` is missing or is not a non-empty string");
  }

  // dispatchable 是 §11.3 MUST-explicit 字段，且不接受 fallback：GitHub 的
  // issue 与 PR 共用同一编号序列，REST issue payload 带 `pull_request` 即表示
  // 它实为 PR，交给 orchestrator 当 issue 派发没有意义。
  const dispatchable = record["pull_request"] == null;

  return {
    id: String(number),
    nativeRef: nativeRef(record, number, repo),
    identifier: `${IDENTIFIER_PREFIX}${number}`,
    title,
    description: toNonEmptyString(record["body"]),
    // GitHub Issues core payload 没有规范化 priority（milestones / labels 不算），
    // §11.3 的"未知为 null"即此。
    priority: null,
    state,
    branchName: null,
    url: toNonEmptyString(record["html_url"]),
    // baseline reference 实现的 assignee 规则：primary assignee 的 login。
    assigneeId: loginUser(record["assignee"]),
    labels: normalizeLabels(record["labels"]),
    // 不从正文 / task list / 非规范关系推断 blocker（§11.3 "MUST NOT invent
    // blocker semantics they cannot represent reliably"）。
    blockedBy: [],
    dispatchable,
    createdAt: parseRfc3339(record["created_at"]),
    updatedAt: parseRfc3339(record["updated_at"]),
  };
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

function malformed(reason: string): TrackerError {
  return new TrackerError("tracker_response", `Malformed GitHub issue payload: ${reason}`, {
    retryable: false,
    providerDetail: { reason },
  });
}

/**
 * §11.3 要求 `native_ref` 为 `null` 或"只含 JSON-safe 非敏感值"的对象。GitHub 侧
 * 恒可安全表示——`number` + `repo` 就是 REST / GraphQL 都认的定位面，且都不敏感
 * （issue 编号与 owner/repo 本来就在 `url` 里），所以本实现从不返回 `null`，
 * 而是**只**保留这几项；author / milestone 等 provider 元数据不进 `native_ref`，
 * 免得把"会不会进 prompt"的判断散落到调用方。
 */
function nativeRef(payload: Record<string, unknown>, number: number, repo: string): Issue["nativeRef"] {
  const ref: Record<string, unknown> = { repo, number };
  const restId = toSafeInteger(payload["id"]);
  if (restId !== null) {
    ref["id"] = restId;
  }
  const nodeId = toNonEmptyString(payload["node_id"]);
  if (nodeId !== null) {
    ref["node_id"] = nodeId;
  }
  return ref;
}

/** REST 的 issue / PR `number`：非负整数（0 是合法编号，不是缺失哨兵）。 */
function toIssueNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function toSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * 非空字符串的**原样**取值（不做 trim）：§11.3 只对 labels 规定 trim +
 * lowercase，对 title / state 只规定"非空字符串"。
 */
function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function loginUser(value: unknown): string | null {
  return toNonEmptyString(asRecord(value)?.["login"]);
}

/**
 * §11.3：labels 必须 trimmed + lowercased、剔除空白、去重。坏条目（既不是字符串
 * 也不是 `{ name }`）按"unusable best-effort collection entries"丢弃。
 * 接受 string 条目是为了 baseline reference 实现里 GraphQL / REST 两种形状共用
 * 一条归一化路径。
 */
function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const entry of value) {
    const name = typeof entry === "string" ? entry : asRecord(entry)?.["name"];
    if (typeof name !== "string") {
      continue;
    }
    const label = name.trim().toLowerCase();
    if (label !== "") {
      seen.add(label);
    }
  }
  return [...seen];
}

/** 不可解析（缺字段 / 非字符串 / 非 RFC 3339 / 越界日期）→ `null`。 */
function parseRfc3339(value: unknown): number | null {
  const text = toNonEmptyString(value);
  if (text === null || !RFC_3339.test(text)) {
    return null;
  }
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
