/**
 * Adapter 错误契约（SPEC §11.4 Error Handling Contract）。
 *
 * §11.4 推荐 8 个 error category，本包**原样采用其名字**作为
 * {@link TrackerError.category} 的取值域——category 是稳定判别式，message 是
 * human-readable 诊断面（消费方只按 category 分支，不得解析 message 文本）。
 * SPEC 允许各实现用"language-native tagged error / exception"表达同一契约，只要
 * adapter profile 文档化 public error form → category + message 的映射；TypeScript
 * 侧的 public form 就是本类的**抛出**（throw），映射记录于各 adapter profile 的
 * `documentation`（§11.2 compact profile）。
 *
 * 除 category / message 外，adapter MAY 追加 `retryable` / `retryAfterMs` /
 * provider status / provider detail（§11.4 "Adapters MAY add"）；orchestrator 只
 * 依赖"成功 vs 失败"，因此这些字段全部可选，缺席即"未知"。
 *
 * 与 `@symphony/config` 的分工：`tracker_request` / `tracker_status` /
 * `tracker_response` / `tracker_pagination` / `tracker_rate_limited` 只在**读取
 * 期间**（§11.1 两个 operation）出现；配置阶段的三个 category
 * （{@link TrackerConfigErrorCategory}）同时是 config preflight 的错误面，由
 * {@link TrackerConfigRegistry.validate} 产出的 {@link TrackerConfigRejection}
 * 交 config 转换为 `SymphonyConfigError`（契约见
 * `notes/accepted/architecture/2026-09-28-tracker-adapter-config-extension.md`）。
 */

/**
 * SPEC §11.4 推荐的 8 个 adapter error category（一字不差，稳定契约）。
 *
 * - `unsupported_tracker_kind`：`tracker.kind` 不是本实现支持的 adapter（§6.3
 *   preflight / §17.1 "kind validation enforces an implementation-supported adapter"）。
 * - `invalid_tracker_config`：selected adapter 判定 tracker 配置非法——含
 *   `kind` 未配置、`provider` 键缺失 / 取值非法、active/terminal states 非法。
 *   注意与 `@symphony/config` 的 `invalid_config` 区分：后者是 core §5.3 / §6
 *   typed shape 校验，前者是 adapter-owned 语义校验。
 * - `missing_tracker_secret`：adapter-owned secret（provider 键或 adapter-local
 *   环境变量名，§6.1 "adapter-local, not a cross-provider convention"）未提供或为空。
 * - `tracker_request`：transport 失败（§11.4 "transport failure"）。
 * - `tracker_status`：非成功响应（§11.4 "non-success response"）。
 * - `tracker_response`：payload 畸形或语义非法（§11.4）。
 * - `tracker_pagination`：分页完整性失败（§11.4）。
 * - `tracker_rate_limited`：被限流（§11.4）。
 */
export type TrackerErrorCode =
  | "unsupported_tracker_kind"
  | "invalid_tracker_config"
  | "missing_tracker_secret"
  | "tracker_request"
  | "tracker_status"
  | "tracker_response"
  | "tracker_pagination"
  | "tracker_rate_limited";

/**
 * §11.4 中属于**配置阶段**的 category 子集：只有这三个能作为 config preflight
 * 的失败原因跨包出现（{@link TrackerConfigValidationFailure}），其余五个只在
 * §11.1 读取期间产生。
 */
export type TrackerConfigErrorCategory = Extract<
  TrackerErrorCode,
  "unsupported_tracker_kind" | "invalid_tracker_config" | "missing_tracker_secret"
>;

/** {@link TrackerError} 的可选附加信息（§11.4 "MAY add"）。 */
export interface TrackerErrorDetails {
  /** 失败是否值得重试；缺席 = adapter 未判定（不默认 true / false）。 */
  readonly retryable?: boolean;
  /** provider 建议的重试等待（ms）；缺席 = 未知。 */
  readonly retryAfterMs?: number;
  /** provider 原生状态码（HTTP status 等），原样保留供诊断。 */
  readonly providerStatus?: number;
  /** provider 原生诊断信息（**不得**含 secret；进日志归 observability，M6）。 */
  readonly providerDetail?: unknown;
  /** 底层原始异常（第三方 transport / parser），经 `Error.cause` 保留。 */
  readonly cause?: unknown;
}

/**
 * tracker 包对外唯一的 typed error。判别式是 {@link TrackerError.category}
 * （对齐 §11.4 的 portable `category` 字段名；config 侧同类契约用 `code`，两者
 * 分属各自包错误面，见包 README）。
 */
export class TrackerError extends Error {
  /** 稳定 category 判别式（SPEC §11.4）。 */
  readonly category: TrackerErrorCode;
  /**
   * 以下四项全部用 `declare` 声明：本包 target ES2022 开启 `useDefineForClassFields`，
   * 普通 class field 声明会在实例上**定义为 `undefined`**，让"adapter 未判定
   * retryable"与"判定为 false"在 `"retryable" in error` 上无法区分。`declare` 只贡献
   * 类型、不 emit 字段定义，缺席就真的缺席（下方构造器按需赋值）。
   */
  declare readonly retryable?: boolean;
  declare readonly retryAfterMs?: number;
  declare readonly providerStatus?: number;
  declare readonly providerDetail?: unknown;

  constructor(category: TrackerErrorCode, message: string, details: TrackerErrorDetails = {}) {
    super(message, "cause" in details ? { cause: details.cause } : undefined);
    this.name = "TrackerError";
    this.category = category;
    // exactOptionalPropertyTypes：缺席字段保持缺席，不写成 null/undefined 哨兵。
    if (details.retryable !== undefined) {
      this.retryable = details.retryable;
    }
    if (details.retryAfterMs !== undefined) {
      this.retryAfterMs = details.retryAfterMs;
    }
    if (details.providerStatus !== undefined) {
      this.providerStatus = details.providerStatus;
    }
    if (details.providerDetail !== undefined) {
      this.providerDetail = details.providerDetail;
    }
  }
}
