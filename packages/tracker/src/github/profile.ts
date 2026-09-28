/**
 * GitHub Issues 的 adapter profile（SPEC §11.2，NEST-55 / #19）：把
 * {@link ./config.ts} 的 provider 规则与 {@link ./adapter.ts} 的构造挂到
 * `TrackerAdapterProfile` 契约上，并注册进
 * `registry.BUILT_IN_TRACKER_ADAPTER_PROFILES`。
 *
 * compact profile（§11.2 要求的 8 项，"not only code"）落在
 * `packages/tracker/README.md` 的 GitHub Issues 一节：supported kind、provider 键
 * 与默认值、secret 键 / 环境变量名、`id` / `native_ref` 映射、state / label /
 * priority / timestamp / `dispatchable` / malformed-record / optional-field 归一化、
 * provider-native tools 现状、以及 public error form → category + message 的映射。
 *
 * scope selection / pagination / 请求上限**本批次只声明边界、不声明行为**：REST
 * transport 归 #20，见 {@link createUnconfiguredGitHubIssueTransport}。
 */
import type { TrackerConfig } from "@symphony/domain";

import { GitHubTrackerAdapter, createUnconfiguredGitHubIssueTransport } from "./adapter";
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
import type { TrackerAdapterContext, TrackerAdapterProfile, TrackerEnv } from "../profile";

/** {@link createGitHubAdapterProfile} 的入参。 */
export interface GitHubAdapterProfileOptions {
  /**
   * provider 请求实现。缺省为
   * {@link createUnconfiguredGitHubIssueTransport}：M2.2 只交付配置 + 归一化，
   * REST transport 归 #20。
   */
  readonly transport?: GitHubIssueTransport;

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
 * 做成工厂而非冻结常量，唯一原因是 transport 注入点：#20 落地 REST 实现后
 * `createGitHubAdapterProfile({ transport })` 即可接入，adapter / profile / 配置
 * 校验三层代码不用改。注册进 built-in 的是无参调用（见 `registry.ts`）。
 */
export function createGitHubAdapterProfile(
  options: GitHubAdapterProfileOptions = {},
): TrackerAdapterProfile {
  const transport = options.transport ?? createUnconfiguredGitHubIssueTransport();
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
      return new GitHubTrackerAdapter({
        provider: toGitHubProviderConfig(context.provider),
        transport,
        onMalformedRecord: options.onMalformedRecord,
      });
    },
  };
}

/** built-in 注册用的单例（无 transport，即 M2.2 的配置 + 归一化面）。 */
export const githubAdapterProfile: TrackerAdapterProfile = createGitHubAdapterProfile();
