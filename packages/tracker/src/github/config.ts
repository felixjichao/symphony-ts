/**
 * GitHub Issues 的 provider 配置面（SPEC §11.2 "exact `tracker.provider` keys,
 * defaults, secret keys/environment names, and validation errors"，NEST-55 / #19）。
 *
 * 本模块是 `tracker.kind: github` 唯一解释 `tracker.provider` 的地方：
 * `@symphony/config` 按 §5.3.1 原样保留 unknown keys、不做 `$VAR` 展开、不认识任何
 * provider，所以这些规则全部落在这里，由 `profile.ts` 的 GitHub profile 挂上
 * `TrackerAdapterProfile` 契约。
 *
 * 与 core 的 `expandEnvReferences` 刻意分开：§6.1 写明 provider 的 secret / env
 * 约定是 "adapter-local, not a cross-provider convention"，所以 `GITHUB_TOKEN`
 * 只在 GitHub 这一侧成立。
 */
import type { TrackerConfig } from "@symphony/domain";

import { TrackerError } from "../errors";
import type { TrackerEnv } from "../profile";

/** 本 profile 支持的精确 `tracker.kind` 值。 */
export const GITHUB_TRACKER_KIND = "github";

/** `tracker.provider` 中唯一合法的键（未知键一律拒绝）。 */
export const GITHUB_PROVIDER_KEYS = ["repo", "token", "api_url"] as const;

const KNOWN_PROVIDER_KEYS: ReadonlySet<string> = new Set(GITHUB_PROVIDER_KEYS);

/** provider 键中属于 secret 的那些（值本身是凭据）。 */
export const GITHUB_SECRET_PROVIDER_KEYS: readonly string[] = ["token"];

/** adapter-local secret 环境变量名（§6.1）。 */
export const GITHUB_TOKEN_ENV_VAR = "GITHUB_TOKEN";

/** GitHub-native active / terminal state 拼写（其余值由 Linear / Jira 之类才有）。 */
export const GITHUB_ACTIVE_STATE = "open";
export const GITHUB_TERMINAL_STATE = "closed";

/** `tracker.provider.api_url` 的默认值（GHES 需显式改写）。 */
export const DEFAULT_GITHUB_API_URL = "https://api.github.com";

/** repo 命名的允许字符集；`/` 不在其中，故 `a/b/c` 天然被拒。 */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** POSIX 环境变量名的通行形状，用于识别 `$VAR` / `${VAR}` 形态的 token。 */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 解析完成、可直接构造 adapter 的 provider 配置。 */
export interface GitHubProviderConfig {
  /** 已校验的 `owner/repo`。 */
  readonly repo: string;
  /** 已展开 / 已 fallback 的**有效** token，恒为非空字符串。 */
  readonly token: string;
  /** 已归一化（HTTPS、去尾斜杠）的 API base URL。 */
  readonly apiUrl: string;
}

/**
 * 校验 + 默认值回填 + secret / env fallback，返回可直接交给
 * `GitHubTrackerAdapter` 的配置。
 *
 * 抛出的 category 只有两个：形状 / 取值非法 → `invalid_tracker_config`；
 * token 取不到 → `missing_tracker_secret`（§11.4 的配置阶段三个 category 中，
 * `unsupported_tracker_kind` 由 registry 负责）。
 *
 * **message 从不内插 token 值**——缺失时引用的是键名与变量名，不是内容。
 */
export function resolveGitHubProviderConfig(
  provider: Readonly<Record<string, unknown>>,
  env: TrackerEnv,
): GitHubProviderConfig {
  return toGitHubProviderConfig({
    ...provider,
    repo: provider["repo"],
    token: resolveToken(provider["token"], env),
    api_url: provider["api_url"] ?? DEFAULT_GITHUB_API_URL,
  });
}

/**
 * 把一份**已解析**的 provider map 收窄成 {@link GitHubProviderConfig}：
 * `resolveGitHubProviderConfig` 用它做最终校验，`profile.createAdapter` 用它从
 * `TrackerAdapterContext.provider`（`Record<string, unknown>`，编译期无形状）取回
 * 配置。同一份校验两处复用，避免"解析时严格、构造时宽松"的漂移。
 */
export function toGitHubProviderConfig(
  provider: Readonly<Record<string, unknown>>,
): GitHubProviderConfig {
  rejectUnknownKeys(provider);

  const repo = provider["repo"];
  if (typeof repo !== "string" || !REPO_PATTERN.test(repo)) {
    throw invalid(
      `tracker.provider.repo must be "owner/repo" (got ${describeValue(repo)}); it selects the GitHub repository the adapter reads`,
    );
  }

  const token = provider["token"];
  if (typeof token !== "string" || token === "") {
    throw invalid(
      "tracker.provider.token must resolve to a non-empty string; set the key, or leave it unset to fall back to GITHUB_TOKEN",
    );
  }

  const rawApiUrl = provider["api_url"];
  if (typeof rawApiUrl !== "string" || rawApiUrl === "") {
    throw invalid(
      `tracker.provider.api_url must be a non-empty https:// URL (got ${describeValue(rawApiUrl)})`,
    );
  }
  return { repo, token, apiUrl: normalizeApiUrl(rawApiUrl) };
}

/**
 * `tracker.active_states` / `terminal_states` 的 provider 语义校验（§11.2
 * "active/terminal state validation"）。
 *
 * GitHub Issues 只有两个 state：`open` / `closed`。比较按 §4.2
 * "Normalized Issue State" 忽略首尾空白与大小写，但**不回写**配置值——normalized
 * `Issue.state` 要保留 provider 拼写，且原始值还要给 #20 做查询参数。
 *
 * `null`（未配置）不校验：registry 会回填 profile 默认。
 */
export function validateGitHubStates(tracker: TrackerConfig): void {
  checkStates(tracker.activeStates, "active_states", GITHUB_ACTIVE_STATE);
  checkStates(tracker.terminalStates, "terminal_states", GITHUB_TERMINAL_STATE);
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

function checkStates(
  states: readonly string[] | null,
  key: "active_states" | "terminal_states",
  supported: string,
): void {
  if (states === null) {
    return;
  }
  for (const state of states) {
    if (state.trim().toLowerCase() !== supported) {
      throw invalid(
        `tracker.${key} entry ${describeValue(state)} is not a GitHub Issues state; the only supported value is "${supported}"`,
      );
    }
  }
}

function rejectUnknownKeys(provider: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(provider)) {
    if (!KNOWN_PROVIDER_KEYS.has(key)) {
      throw invalid(
        `tracker.provider.${key} is not a GitHub provider key; known keys: ${GITHUB_PROVIDER_KEYS.join(", ")}`,
      );
    }
  }
}

/**
 * `token` 的三态（§5.3.1 / §6.1）：
 *
 * - **显式字面值** → 直接用；
 * - **`$VAR` / `${VAR}`** → 只解释这一个变量名，取不到就直接失败。不做
 *   `GITHUB_TOKEN` 二次 fallback：显式写了 `token: $MY_PAT` 却静默改用别的变量，
 *   等于用另一份凭据去发请求；
 * - **缺失 / `null` / 空串** → 空值按缺失（与 config 的 env 语义一致），fallback 到
 *   adapter-local `GITHUB_TOKEN`。
 */
function resolveToken(raw: unknown, env: TrackerEnv): string {
  if (raw === undefined || raw === null) {
    return fallbackToken();
  }
  if (typeof raw !== "string") {
    throw invalid(
      `tracker.provider.token must be a string or an environment reference like "$${GITHUB_TOKEN_ENV_VAR}" (got ${describeValue(raw)})`,
    );
  }
  if (raw === "") {
    return fallbackToken();
  }
  const envName = environmentReference(raw);
  if (envName === null) {
    return raw;
  }
  const value = env[envName] ?? "";
  if (value === "") {
    throw missingSecret(`tracker.provider.token refers to $${envName}, which is unset or empty`);
  }
  return value;

  function fallbackToken(): string {
    const value = env[GITHUB_TOKEN_ENV_VAR] ?? "";
    if (value === "") {
      throw missingSecret(
        `No GitHub token available: set tracker.provider.token, or export ${GITHUB_TOKEN_ENV_VAR}`,
      );
    }
    return value;
  }
}

/** `$VAR` / `${VAR}` → `VAR`；其他形态返回 `null`（按字面值处理）。 */
function environmentReference(raw: string): string | null {
  const braced = /^\$\{(.*)\}$/.exec(raw);
  const name = braced?.[1] ?? (raw.startsWith("$") ? raw.slice(1) : null);
  return name !== null && ENV_NAME_PATTERN.test(name) ? name : null;
}

function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(`tracker.provider.api_url is not a valid URL (got ${describeApiUrl(value)})`);
  }
  if (url.protocol !== "https:") {
    throw invalid(
      `tracker.provider.api_url must use https://; a plaintext API endpoint would send the token over the wire (got ${describeApiUrl(value)})`,
    );
  }
  // userinfo 一律拒绝而不是脱敏保留：GitHub 的凭据属于 `token` → `Authorization`
  // 头，base URL 里带 `user:pass@` 从来不是合法形态，而 resolved provider map 会进
  // TrackerAdapterContext——留着它等于把一份凭据放到"日志脱敏要看的地方"（§11.2
  // secret 面）。message 里只回显脱敏后的形态。
  if (url.username !== "" || url.password !== "") {
    throw invalid(
      `tracker.provider.api_url must not embed credentials (got ${describeApiUrl(value)}); authenticate with tracker.provider.token`,
    );
  }
  return url.href.replace(/\/+$/, "");
}

function invalid(message: string): TrackerError {
  return new TrackerError("invalid_tracker_config", message);
}

function missingSecret(message: string): TrackerError {
  return new TrackerError("missing_tracker_secret", message);
}

/**
 * `api_url` 的诊断回显：先剥掉 userinfo 段再交给 {@link describeValue}。
 * 非法 URL 走不到 `new URL()`，所以脱敏必须在解析之前也成立。
 */
function describeApiUrl(value: string): string {
  return describeValue(value.replace(/\/\/[^/@]*@/, "//<redacted>@"));
}

/** 诊断用的值回显：声明的 secret 永远不会走到这里（调用方只在非 secret 键上使用）。 */
function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return `"${value}"`;
  }
  return value === undefined ? "undefined" : String(value);
}
