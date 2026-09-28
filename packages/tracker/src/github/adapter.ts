/**
 * GitHub Issues adapter（SPEC §11.2 construction + §11.1 malformed-record 策略，
 * NEST-55 / #19）。
 *
 * adapter 只负责 §11.1–§11.3 规定的两件事；provider 请求面是注入端口
 * {@link GitHubIssueTransport}，其 REST 实现见 `transport.ts`（NEST-56 / #20）：
 *
 * 1. 把 transport 返回的 payload 数组归一化为 §4.1.1 的 `Issue`；
 * 2. 按调用面决定 malformed 记录的去留——state-list SHOULD 省略并记日志，
 *    ID-refresh MUST 失败（省略是有意义的，见 §11.1）。
 *
 * 空输入 → 空结果且零 provider 请求由 `createTrackerReadKernel`（`../adapter.ts`）
 * 统一保证，故此处可假定 `stateNames` / `issueIds` 非空。
 */
import type { Issue } from "@symphony/domain";

import type { TrackerAdapter } from "../adapter";
import { TrackerError } from "../errors";
import { normalizeGitHubIssue } from "./normalize";
import { GITHUB_TRACKER_KIND, type GitHubProviderConfig } from "./config";

/**
 * provider 请求端口：返回 GitHub REST 的原始 issue payload（未归一化的 JSON）。
 *
 * `unknown` 是刻意的——transport 拿到的是 `JSON.parse` 的结果，编译期没有任何
 * 形状保证，全部字段合法性由 {@link normalizeGitHubIssue} 在运行时判定。REST
 * 实现（`transport.ts`：fetch + pagination + §11.4 error mapping）与 adapter 之间
 * 只隔这一个端口，两侧可各自独立演化。
 */
export interface GitHubIssueTransport {
  /** 与 §11.1.1 同语义：处于这些 provider state 的 scope 内 issue payload。 */
  fetchPayloadsByStates(stateNames: readonly string[]): Promise<readonly unknown[]>;

  /**
   * 与 §11.1.2 同语义：入参是 normalized `Issue.id`（即 `String(issue number)`），
   * 已不在配置 scope 内的 ID 应省略。
   */
  fetchPayloadsByIds(issueIds: readonly string[]): Promise<readonly unknown[]>;
}

/** malformed 记录被省略时交给调用方的诊断面（§11.1 "SHOULD log that omission"）。 */
export interface GitHubMalformedRecord {
  /** 哪个 operation 省略了这条记录。 */
  readonly operation: "fetchIssuesByStates" | "fetchIssuesByIds";
  /** 归一化失败的具体原因（{@link TrackerError} 的 `providerDetail.reason` 同值）。 */
  readonly reason: string;
  /** 原始 {@link TrackerError}（`tracker_response`），供日志层自行取舍字段。 */
  readonly error: TrackerError;
}

/** {@link GitHubTrackerAdapter} 的构造入参。 */
export interface GitHubTrackerAdapterOptions {
  /** 已解析、已校验的 provider 配置（`repo` 用于 `native_ref`）。 */
  readonly provider: GitHubProviderConfig;
  /** provider 请求实现（REST 实现见 `transport.ts`；测试可注入假 transport）。 */
  readonly transport: GitHubIssueTransport;
  /**
   * state-list 省略 malformed 记录时的回调（缺省 = 静默省略）。
   *
   * 本包不 import `@symphony/observability`（§13 的日志面在 M6 装配），故 §11.1 的
   * "SHOULD log"以注入点交付：组合根把它接到 logger 即可，未接也不影响 §11.1 的
   * MUST（省略本身）。
   */
  readonly onMalformedRecord?: ((record: GitHubMalformedRecord) => void) | undefined;
}

/**
 * `tracker.kind: github` 的 adapter。
 *
 * `provider payload` 只存在于 `transport` 与本类的 try/catch 之间：一旦归一化完成
 * 就不再持有，跨包契约只有 normalized `Issue`（§11.2 / §11.3）。
 */
export class GitHubTrackerAdapter implements TrackerAdapter {
  readonly kind = GITHUB_TRACKER_KIND;

  private readonly provider: GitHubProviderConfig;
  private readonly transport: GitHubIssueTransport;
  private readonly onMalformedRecord: ((record: GitHubMalformedRecord) => void) | undefined;

  constructor(options: GitHubTrackerAdapterOptions) {
    this.provider = options.provider;
    this.transport = options.transport;
    this.onMalformedRecord = options.onMalformedRecord;
  }

  /**
   * §11.1.1：单条 malformed 记录可省略——它从来就不是可派发对象，且列表调用本来
   * 就不保证覆盖每一条。其余记录照常返回，不因一条坏 payload 让整个 tick 失败。
   */
  async fetchIssuesByStates(stateNames: readonly string[]): Promise<readonly Issue[]> {
    const payloads = await this.transport.fetchPayloadsByStates(stateNames);
    const issues: Issue[] = [];
    for (const payload of payloads) {
      try {
        issues.push(normalizeGitHubIssue(payload, this.provider.repo));
      } catch (error) {
        const malformed = asMalformedResponse(error);
        if (malformed === null) {
          throw error;
        }
        this.onMalformedRecord?.({
          operation: "fetchIssuesByStates",
          reason: malformedMessage(malformed),
          error: malformed,
        });
      }
    }
    return issues;
  }

  /**
   * §11.1.2：MUST 失败而非静默省略——调用方把"缺席"读成"不再可见"。
   *
   * 同时兑现 §11.1 对 refresh 结果的另两条不变量——"input IDs are treated as a
   * set" 与 "each dispatch ID appears at most once"：入参先去重再交给 transport
   * （transport 因此永远只看到集合，实现不必各自处理重复 ID），产出按 `id` 保留
   * 首次出现。这不是防御性冗余：重复 ID 若原样透传，orchestrator 会把它读成两条
   * 同一 issue 的快照，而 `Issue.id` 是内部 map key 与 workspace 身份的来源（§4.2）。
   */
  async fetchIssuesByIds(issueIds: readonly string[]): Promise<readonly Issue[]> {
    const requested = [...new Set(issueIds)];
    const payloads = await this.transport.fetchPayloadsByIds(requested);
    const seen = new Set<string>();
    const issues: Issue[] = [];
    for (const payload of payloads) {
      const issue = normalizeGitHubIssue(payload, this.provider.repo);
      if (!seen.has(issue.id)) {
        seen.add(issue.id);
        issues.push(issue);
      }
    }
    return issues;
  }
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/** 只拦截"记录自身 malformed"；其他异常（transport 故障、adapter 缺陷）原样抛出。 */
function asMalformedResponse(error: unknown): TrackerError | null {
  return error instanceof TrackerError && error.category === "tracker_response" ? error : null;
}

function malformedMessage(error: TrackerError): string {
  const detail = error.providerDetail;
  if (typeof detail === "object" && detail !== null && "reason" in detail) {
    const { reason } = detail as { reason: unknown };
    if (typeof reason === "string") {
      return reason;
    }
  }
  return error.message;
}
