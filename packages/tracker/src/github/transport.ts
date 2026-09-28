/**
 * GitHub Issues 的真实 REST transport（SPEC §11.1 scope selection / pagination、
 * §11.2 "endpoint, authentication, transport, timeouts, pagination, and
 * rate-limit handling"、§11.4 error mapping，NEST-56 / #20）。
 *
 * 这是 `GitHubIssueTransport` 注入端口的生产实现：只负责 endpoint / auth / 分页 /
 * 错误面，返回**未归一化的 JSON payload**——归一化与 malformed-record 判定是
 * adapter 的责任（见 `notes/accepted/architecture/2026-09-28-github-adapter-transport-boundary.md`）。
 *
 * 两条边界：
 *
 * - **不做 retry / backoff**：§11.4 把重试策略划给 orchestrator（§8 / §14），本
 *   模块只把 rate-limit 信息放进 `TrackerError` 的 `retryable` / `retryAfterMs`；
 * - **不判 malformed**：单记录去留（state-list 省略 vs ID-refresh 失败）由
 *   `GitHubTrackerAdapter` 按 operation 决定，transport 对两条调用面都原样吐 payload。
 */
import type { GitHubProviderConfig } from "./config";
import type { GitHubIssueTransport } from "./adapter";
import { TrackerError } from "../errors";

/** baseline reference 实现的请求上限（README 的 compact profile 披露此值）。 */
const PER_PAGE = 100;

/** GitHub REST 的版本头（§11.2 adapter-owned transport 细节）。 */
const API_VERSION = "2022-11-28";

/** 可注入的 fetch 面；生产用 `globalThis.fetch`，测试可指向同一签名的实现。 */
export type GitHubFetchImpl = (
  input: string,
  init: { method: "GET"; headers: Record<string, string> },
) => Promise<GitHubFetchResponse>;

/** transport 实际用到的响应面。 */
export interface GitHubFetchResponse {
  readonly status: number;
  ok: boolean;
  readonly headers: {
    get(name: string): string | null;
  };
  json(): Promise<unknown>;
}

/** {@link createGitHubIssueTransport} 的入参。 */
export interface GitHubIssueTransportOptions {
  /** 覆盖 fetch（仅测试用；生产恒为 `globalThis.fetch`）。 */
  readonly fetchImpl?: GitHubFetchImpl;
}

/**
 * 构造 `tracker.kind: github` 的 REST transport。
 *
 * endpoint = 归一化后的 `api_url`（GHES 的 `/api/v3` 前缀保留），鉴权 = host 侧
 * Bearer token，scope 固定为配置的 `owner/repo`。
 */
export function createGitHubIssueTransport(
  config: GitHubProviderConfig,
  options: GitHubIssueTransportOptions = {},
): GitHubIssueTransport {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const [owner, repo] = config.repo.split("/", 2);
  if (owner === undefined || repo === undefined || repo === "") {
    // toGitHubProviderConfig 已校验 repo 形状；走到这里说明调用方绕过了校验。
    throw new TrackerError(
      "invalid_tracker_config",
      `tracker.provider.repo must be "owner/repo" (got "${config.repo}")`,
    );
  }
  const issueListUrl = `${config.apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
  const apiOrigin = new URL(config.apiUrl).origin;

  return {
    fetchPayloadsByStates: (stateNames) => fetchPayloadsByStates(stateNames),
    fetchPayloadsByIds: (issueIds) => fetchPayloadsByIds(issueIds),
  };

  // -------------------------------------------------------------------------
  // fetchPayloadsByStates（§11.1.1）
  // -------------------------------------------------------------------------

  async function fetchPayloadsByStates(stateNames: readonly string[]): Promise<readonly unknown[]> {
    const states = mapToGitHubStates(stateNames);
    if (states.length === 0) {
      // 无可映射的 GitHub state → 零 provider 请求（§11.1 empty-input MUST 的
      // transport 侧对应物）。
      return [];
    }

    // 同时请求 open+closed → state=all；单一状态 → state=open|closed。
    const singleState = states.length === 1 ? states[0] : undefined;
    const stateParam = singleState ?? "all";
    const query = new URLSearchParams({
      state: stateParam,
      sort: "created",
      direction: "asc",
      per_page: String(PER_PAGE),
    });
    const first = `${issueListUrl}?${query.toString()}`;

    const payloads: unknown[] = [];
    const requested = new Set(states);
    let next: string | null = first;
    while (next !== null) {
      const page = await fetchJsonArray(next);
      // 结果 ⊆ requested state set 是无条件不变量，两条分支都过一遍：GitHub 的
      // `state` 参数在列表 endpoint 上并非严格过滤（单一 state 的查询里 closed
      // 可能混进 PR 形态的记录），而 `state=all` 下"请求集 == 值域"只是当前恰好
      // 成立，不该让"要不要过滤"取决于那次请求怎么发。
      for (const payload of page.items) {
        if (matchesRequestedState(payload, requested)) {
          payloads.push(payload);
        }
      }
      // 任一中间页失败已在 fetchJsonArray 抛出 → 整个 operation 失败，
      // 不存在部分成功列表。
      next = nextPageUrl(page.linkHeader, apiOrigin);
    }
    return payloads;
  }

  // -------------------------------------------------------------------------
  // fetchPayloadsByIds（§11.1.2）
  // -------------------------------------------------------------------------

  async function fetchPayloadsByIds(issueIds: readonly string[]): Promise<readonly unknown[]> {
    // 先整批校验 dispatch ID：坏 ID 让**整个** refresh call 在任何请求发出之前
    // 失败（§11.1 malformed requested record MUST fail，省略是有意义的）。
    const numbers = issueIds.map(parseDispatchId);
    const payloads: unknown[] = [];
    // 串行刷新：refresh 的量级是 active runs，并发只会把 rate-limit 风险前移，
    // 且 §11.4 的原子性在串行下最直白。retry 策略不在此处（§8 归 orchestrator）。
    for (const number of numbers) {
      const url = `${issueListUrl}/${number}`;
      const page = await fetchJsonObject(url);
      if (page === null) {
        // 404 = hidden / deleted / out-of-scope → omit（§11.1 "omission is
        // meaningful"，不构造 synthetic state）。
        continue;
      }
      payloads.push(page.item);
    }
    return payloads;
  }

  // -------------------------------------------------------------------------
  // HTTP / error mapping（§11.4）
  // -------------------------------------------------------------------------

  /** 列表 endpoint：顶层 JSON 必须是数组，否则 `tracker_response`。 */
  async function fetchJsonArray(url: string): Promise<PageMeta> {
    const response = await exchange(url);
    await ensureSuccess(response, url);
    const payload = await parseJson(response, url);
    if (!Array.isArray(payload)) {
      throw new TrackerError(
        "tracker_response",
        `GitHub issues list returned a non-array payload from ${url}`,
        { retryable: false },
      );
    }
    return { items: payload, linkHeader: response.headers.get("link") };
  }

  /**
   * 单条 endpoint：顶层 JSON 必须是对象。
   *
   * 返回 `null` **只**表示 404 omission（§11.1.2："IDs no longer visible in the
   * configured scope are omitted"）。这条语义不对列表调用开放——那边的 404 是
   * unexpected status，走 `tracker_status`。
   */
  async function fetchJsonObject(url: string): Promise<SingleMeta | null> {
    const response = await exchange(url);
    if (response.status === 404) {
      return null;
    }
    await ensureSuccess(response, url);
    const payload = await parseJson(response, url);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new TrackerError(
        "tracker_response",
        `GitHub issue endpoint returned a non-object payload from ${url}`,
        { retryable: false },
      );
    }
    return { item: payload };
  }

  /**
   * 发送一次请求。只有 transport 本身失败会在这里抛出；status 判定交给
   * {@link ensureSuccess}，好让"404 是 omission 还是失败"由调用面决定。
   */
  async function exchange(url: string): Promise<GitHubFetchResponse> {
    try {
      return await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${config.token}`,
          "User-Agent": "symphony-ts/tracker",
          "X-GitHub-Api-Version": API_VERSION,
        },
      });
    } catch (cause) {
      throw new TrackerError("tracker_request", `GitHub request to ${url} failed`, {
        retryable: true,
        cause,
      });
    }
  }

  /** 非成功响应用 §11.4 的 category 抛出（限流 → rate limited，其余 → status）。 */
  async function ensureSuccess(response: GitHubFetchResponse, url: string): Promise<void> {
    if (response.ok) {
      return;
    }
    if (isRateLimitResponse(response)) {
      throw rateLimited(response, url);
    }
    throw await statusError(response, url);
  }

  async function parseJson(response: GitHubFetchResponse, url: string): Promise<unknown> {
    try {
      return await response.json();
    } catch (cause) {
      throw new TrackerError(
        "tracker_response",
        `GitHub response from ${url} is not valid JSON`,
        { retryable: false, cause },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 内部实现（模块级，与 config 无关）
// ---------------------------------------------------------------------------

/** 一次列表页读取的结果：payload 数组 + 原始 Link header。 */
interface PageMeta {
  readonly items: readonly unknown[];
  readonly linkHeader: string | null;
}

/** 一次单条读取的结果。 */
interface SingleMeta {
  readonly item: unknown;
}

function defaultFetch(
  input: string,
  init: { method: "GET"; headers: Record<string, string> },
): Promise<GitHubFetchResponse> {
  return globalThis.fetch(input, init);
}

/**
 * requested states → GitHub-native 集合（trim + lowercase，§4.2 的比较规则）。
 * 非 GitHub 的状态名映射不出任何东西——配置面已由 profile 拒绝，这里只是最后一道
 * "映射不出就不发请求"的守卫。
 */
function mapToGitHubStates(stateNames: readonly string[]): string[] {
  const mapped = new Set<string>();
  for (const name of stateNames) {
    const normalized = name.trim().toLowerCase();
    if (normalized === "open" || normalized === "closed") {
      mapped.add(normalized);
    }
  }
  // 顺序稳定：open 在前，`states[0]` 的单一状态分支因此可预期。
  return [
    ...(mapped.has("open") ? ["open"] : []),
    ...(mapped.has("closed") ? ["closed"] : []),
  ];
}

function matchesRequestedState(payload: unknown, requested: ReadonlySet<string>): boolean {
  if (typeof payload !== "object" || payload === null) {
    return true;
  }
  const state = (payload as Record<string, unknown>)["state"];
  if (typeof state !== "string") {
    // 缺 required 字段 → 交给 adapter 判 malformed，transport 不抢先丢弃。
    return true;
  }
  return requested.has(state.trim().toLowerCase());
}

/** 分页完整性（§11.4 `tracker_pagination`）失败时抛出。 */
function paginationFailure(message: string, cause?: unknown): TrackerError {
  return new TrackerError("tracker_pagination", message, cause === undefined ? {} : { cause });
}

/**
 * 解析 Link header 的 `rel="next"`（RFC 5988 格式，按 `<…>; rel="…"` 配对匹配，
 * 不按逗号 split——分页 URL 的 query 本身可能含逗号）。
 *
 * - header 存在但含读不懂的段落 → `tracker_pagination`（响应声称还有分页线索，
 *   返回部分列表会破坏 operation 原子性）；
 * - next URL 与配置 `api_url` 不同 origin → `tracker_pagination`（provider 响应
 *   面不得把请求引导到配置 scope 之外，token 也不会跨 origin 发送）。
 */
function nextPageUrl(linkHeader: string | null, configuredOrigin: string): string | null {
  if (linkHeader === null || linkHeader.trim() === "") {
    return null;
  }
  let sawRecognisedEntry = false;
  for (const match of linkHeader.matchAll(/<([^>]*)>\s*;\s*rel="([^"]*)"/g)) {
    sawRecognisedEntry = true;
    if (match[2] === "next") {
      return resolveNextUrl(match[1] ?? "", configuredOrigin);
    }
  }
  if (!sawRecognisedEntry) {
    throw paginationFailure(`Unparseable GitHub Link header: ${linkHeader}`);
  }
  return null;
}

function resolveNextUrl(raw: string, configuredOrigin: string): string {
  let next: URL;
  try {
    next = new URL(raw);
  } catch (cause) {
    throw paginationFailure(`Invalid GitHub pagination URL: ${raw}`, cause);
  }
  if (next.origin !== configuredOrigin) {
    throw paginationFailure(
      `GitHub pagination left the configured API origin (${configuredOrigin} → ${next.origin})`,
    );
  }
  return next.toString();
}

/**
 * §11.4 "429 / GitHub rate-limit response" 的判定面。GitHub 有两种限流形状：
 * primary limit 带 `x-ratelimit-remaining: 0`（status 403 或 429），secondary
 * limit 带 `Retry-After` 且**不保证**置 remaining 为 0（常常是 403）。两者都必须
 * 落进 `tracker_rate_limited`，否则调用方拿到 `retryable: false` 的
 * `tracker_status`，把"过一会儿再试"误读成"这条永久失败"。
 */
function isRateLimitResponse(response: GitHubFetchResponse): boolean {
  if (response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0") {
    return true;
  }
  return response.status === 403 && response.headers.get("retry-after") !== null;
}

function rateLimited(response: GitHubFetchResponse, url: string): TrackerError {
  const details: { retryable: boolean; retryAfterMs?: number; providerStatus: number } = {
    retryable: true,
    providerStatus: response.status,
  };
  const retryAfterMs = retryAfter(response);
  if (retryAfterMs !== null) {
    details.retryAfterMs = retryAfterMs;
  }
  return new TrackerError(
    "tracker_rate_limited",
    `GitHub rate limited the request to ${url} (status ${response.status})`,
    details,
  );
}

/** `retry-after`（秒或 HTTP-date）优先；缺席时用 `x-ratelimit-reset` 的绝对 epoch 秒推算。 */
function retryAfter(response: GitHubFetchResponse): number | null {
  const header = response.headers.get("retry-after");
  if (header !== null) {
    const value = header.trim();
    if (value !== "") {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) {
        // 负值按"现在就可以重试"处理，不落到推算分支。
        return Math.max(0, Math.round(seconds * 1000));
      }
      // RFC 9110 允许 `Retry-After` 写成 HTTP-date。GitHub 发的是秒数，但前置代理
      // / GHES 版本可能发日期，这里同样解成等待时长（绝对时刻做差）。
      const at = Date.parse(value);
      if (!Number.isNaN(at)) {
        return Math.max(0, Math.ceil(at - Date.now()));
      }
    }
  }
  const reset = response.headers.get("x-ratelimit-reset");
  if (reset !== null) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds)) {
      // clamp 到 >=0：reset 已过（时钟偏差 / 响应迟到）时不产出负数。
      return Math.max(0, Math.ceil(epochSeconds * 1000 - Date.now()));
    }
  }
  return null;
}

async function statusError(response: GitHubFetchResponse, url: string): Promise<TrackerError> {
  const details: { providerStatus: number; providerDetail?: unknown; retryable?: boolean } = {
    providerStatus: response.status,
  };
  const message = await bodyMessage(response);
  if (message !== null) {
    details.providerDetail = { message };
  }
  // 5xx 值得重试，4xx（鉴权 / 权限 / 形状）重试无益。
  details.retryable = response.status >= 500;
  return new TrackerError(
    "tracker_status",
    `GitHub returned status ${response.status} for ${url}${message === null ? "" : `: ${message}`}`,
    details,
  );
}

/** 只取 GitHub 错误信封的 `message` 字段并截断，绝不回显请求头（token 所在处）。 */
async function bodyMessage(response: GitHubFetchResponse): Promise<string | null> {
  try {
    const payload = await response.json();
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
      const message = (payload as Record<string, unknown>)["message"];
      if (typeof message === "string" && message !== "") {
        return message.slice(0, 200);
      }
    }
  } catch {
    // 错误响应体不是 JSON：诊断面退化为纯 status。
  }
  return null;
}

/** dispatch ID 必须是正整数的字符串形式（normalize 的 `String(number)` 产出面）。 */
function parseDispatchId(issueId: string): number {
  if (!/^[1-9][0-9]*$/.test(issueId)) {
    throw new TrackerError(
      "tracker_response",
      `Malformed GitHub dispatch ID "${issueId}": expected a positive issue number`,
      { retryable: false, providerDetail: { reason: "dispatch ID is not a positive integer" } },
    );
  }
  const number = Number(issueId);
  if (!Number.isSafeInteger(number)) {
    throw new TrackerError(
      "tracker_response",
      `Malformed GitHub dispatch ID "${issueId}": issue number exceeds the safe integer range`,
      { retryable: false, providerDetail: { reason: "dispatch ID is not a safe integer" } },
    );
  }
  return number;
}
