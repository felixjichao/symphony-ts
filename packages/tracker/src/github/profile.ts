/**
 * GitHub Issues 的 adapter profile（SPEC §11.2，NEST-55 / #19）：把
 * `config.ts` 的 provider 规则与 `adapter.ts` 的构造挂到
 * `TrackerAdapterProfile` 契约上，并注册进
 * `registry.BUILT_IN_TRACKER_ADAPTER_PROFILES`。
 *
 * compact profile（§11.2 要求的 8 项，"not only code"）落在
 * `packages/tracker/README.md` 的 GitHub Issues 一节：supported kind、provider 键
 * 与默认值、secret 键 / 环境变量名、`id` / `native_ref` 映射、state / label /
 * priority / timestamp / `dispatchable` / malformed-record / optional-field 归一化、
 * provider-native tools 现状、以及 public error form → category + message 的映射。
 *
 * scope selection / pagination / 请求上限由 `transport.ts` 的 REST transport 落实
 * （NEST-56 / #20）：未显式注入 transport 时，`createAdapter` 按已解析的 provider
 * 配置构造真实实现。
 */
import type { TrackerConfig } from "@symphony/domain";

import { GitHubTrackerAdapter } from "./adapter";
import type { GitHubIssueTransport, GitHubMalformedRecord } from "./adapter";
import {
  GITHUB_ACTIVE_STATE,
  GITHUB_SECRET_PROVIDER_KEYS,
  GITHUB_TERMINAL_STATE,
  GITHUB_TOKEN_ENV_VAR,
  GITHUB_TRACKER_KIND,
  resolveGitHubProviderConfig,
  toGitHubProviderConfig,
  validateGitHubStates,
} from "./config";
import { createGitHubIssueTransport } from "./transport";
import type { GitHubFetchImpl } from "./transport";
import type { TrackerAdapterContext, TrackerAdapterProfile, TrackerEnv } from "../profile";

/** {@link createGitHubAdapterProfile} 的入参。 */
export interface GitHubAdapterProfileOptions {
  /**
   * provider 请求实现。缺省为按 context 配置构造的 REST transport
   * （`createGitHubIssueTransport`）；测试可注入假 transport 以覆盖
   * 归一化 / malformed-record 面。
   */
  readonly transport?: GitHubIssueTransport;

  /**
   * REST transport 的 fetch 覆盖点（仅测试用：把默认 transport 指到本地 HTTP
   * server）。生产缺席，缺席即 `globalThis.fetch`。
   */
  readonly fetchImpl?: GitHubFetchImpl;

  /**
   * state-list 省略 malformed 记录的回调（§11.1 "SHOULD log that omission"）。
   * 缺省即静默省略——本包不 import `@symphony/observability`，日志面由组合根（M6）
   * 接到 logger 上。
   */
  readonly onMalformedRecord?: ((record: GitHubMalformedRecord) => void) | undefined;
}

/**
 * 构造 `tracker.kind: github` 的 profile。
 *
 * 做成工厂而非冻结常量，原因是 transport 注入点：transport 依赖已解析的 provider
 * 配置（`repo` / `token` / `api_url`），这些直到 `createAdapter(context)` 才确定，
 * 所以默认 transport 在 context 处按配置构造；测试仍可通过 `{ transport }` 注入
 * 假实现、通过 `{ fetchImpl }` 把默认实现指到本地 server。
 */
export function createGitHubAdapterProfile(
  options: GitHubAdapterProfileOptions = {},
): TrackerAdapterProfile {
  return {
    kind: GITHUB_TRACKER_KIND,
    documentation: "packages/tracker/README.md#github-issues",
    secretProviderKeys: GITHUB_SECRET_PROVIDER_KEYS,
    secretEnvVars: [GITHUB_TOKEN_ENV_VAR],
    defaultActiveStates: [GITHUB_ACTIVE_STATE],
    defaultTerminalStates: [GITHUB_TERMINAL_STATE],

    validateConfig(tracker: TrackerConfig): void {
      validateGitHubStates(tracker);
    },

    resolveProviderConfig(provider: Readonly<Record<string, unknown>>, env: TrackerEnv) {
      const config = resolveGitHubProviderConfig(provider, env);
      // resolved map 用**配置面的键名**，与 profile 对外披露的键集一致；
      // 不回写 resolved ServiceConfig（registry 的既有边界），只进
      // TrackerAdapterContext。
      return { repo: config.repo, token: config.token, api_url: config.apiUrl };
    },

    createAdapter(context: TrackerAdapterContext) {
      const provider = toGitHubProviderConfig(context.provider);
      const transport =
        options.transport ??
        createGitHubIssueTransport(
          provider,
          options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
        );
      return new GitHubTrackerAdapter({
        provider,
        transport,
        onMalformedRecord: options.onMalformedRecord,
      });
    },
  };
}

/** built-in 注册用的单例（默认走 `transport.ts` 的 REST transport）。 */
export const githubAdapterProfile: TrackerAdapterProfile = createGitHubAdapterProfile();
