/**
 * Adapter registry / factory（SPEC §11.2 的 "each adapter owns construction from
 * the current effective tracker configuration" + §6.3 dispatch preflight 的
 * supported-adapter 校验）。
 *
 * registry 是 `tracker.kind` → {@link TrackerAdapterProfile} 的**唯一**选择点：
 * `@symphony/config` 因此不需要（也不允许）在 core 里判断 `kind === "github"` 之类
 * 的 provider 分支（§17.1 "kind validation enforces an implementation-supported
 * adapter" 与 "provider … validated through the selected adapter"）。
 *
 * 生命周期：**没有全局单例**。registry 实例由组合根创建并持有——M2.1 是测试，
 * M6 是 `apps/cli`（根 `AGENTS.md`：apps/cli 负责进程装配）。这样 profile 集合
 * 是显式依赖，不受 import 顺序影响，测试之间也不互相污染。
 *
 * `createConfigExtension()` 把 selected-adapter 校验作为**结构化**对象交给
 * `@symphony/config`：本包不 import config，config 也不 import tracker
 * （两包各自只依赖 domain）。契约与两侧独立声明这两个形状的原因见
 * `notes/accepted/architecture/2026-09-28-tracker-adapter-config-extension.md`。
 */
import type { TrackerConfig } from "@symphony/domain";

import { createTrackerReadKernel, type TrackerAdapter } from "./adapter";
import { TrackerError, type TrackerConfigErrorCategory } from "./errors";
import type { TrackerAdapterProfile, TrackerAdapterContext, TrackerEnv } from "./profile";

/**
 * config preflight 交给 extension 的输入：resolved `TrackerConfig` + adapter 可见
 * 的 env 视图。**形状必须与 `@symphony/config` 侧同名声明一致**（结构化契约，
 * 无共享 import；由 `config-integration.test.ts` 在编译期锁定）。
 */
export interface TrackerConfigValidationContext {
  readonly tracker: TrackerConfig;
  readonly env: TrackerEnv;
}

/**
 * 一次配置校验失败的稳定表示；`category` 只允许 §11.4 的 3 个**配置阶段**取值
 * （{@link TrackerConfigErrorCategory}），运行时 category（transport / 分页等）
 * 不在配置阶段出现。**形状必须与 `@symphony/config` 侧同名声明一致**。
 */
export interface TrackerConfigExtensionFailure {
  readonly category: TrackerConfigErrorCategory;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * `@symphony/config` 接受的扩展点形状（config 侧声明同名接口，
 * `ResolveServiceConfigOptions.trackerExtension` 消费）。
 */
export interface TrackerConfigExtension {
  readonly validateTrackerConfig: (
    context: TrackerConfigValidationContext,
  ) => TrackerConfigExtensionFailure | undefined;
}

/** profiles 的注册表；见文件头。 */
export class TrackerAdapterRegistry {
  private readonly profiles: Map<string, TrackerAdapterProfile> = new Map();

  constructor(profiles: readonly TrackerAdapterProfile[] = []) {
    for (const profile of profiles) {
      this.register(profile);
    }
  }

  /**
   * 注册一个 profile。`kind` 是 `@symphony/config` resolved 值的**精确**匹配键
   * （区分大小写、不 trim）——§11.2 要求 profile 声明 "exact supported
   * `tracker.kind` value"。
   *
   * 两个注册期不变量（都以 `TrackerError` 抛出，category 为
   * `invalid_tracker_config`）：
   *
   * - `kind === ""` 被拒：空串是 config M1.3 冻结的"未配置"哨兵，允许注册它会让
   *   缺失 kind 静默通过 preflight；
   * - 同一 kind 重复注册被拒：两个 profile 争一个 kind 意味着配置语义不确定。
   */
  register(profile: TrackerAdapterProfile): this {
    if (profile.kind === "") {
      throw new TrackerError(
        "invalid_tracker_config",
        "Cannot register a tracker adapter profile with an empty kind: \"\" is the reserved \"not configured\" sentinel of tracker.kind",
        { providerDetail: { kind: profile.kind } },
      );
    }
    if (this.profiles.has(profile.kind)) {
      throw new TrackerError(
        "invalid_tracker_config",
        `Duplicate tracker adapter registration for kind "${profile.kind}"`,
        { providerDetail: { kind: profile.kind } },
      );
    }
    this.profiles.set(profile.kind, profile);
    return this;
  }

  /** 按精确 kind 查找 profile；未注册 → `undefined`。 */
  lookup(kind: string): TrackerAdapterProfile | undefined {
    return this.profiles.get(kind);
  }

  /** 已注册 kind 的升序快照（稳定错误 message 与诊断用）。 */
  get supportedKinds(): readonly string[] {
    return [...this.profiles.keys()].sort();
  }

  /**
   * selected-adapter 校验的**唯一**入口（§6.3 / §17.1）：kind 是否被支持、whole
   * tracker config、provider-owned 键与 secret。
   *
   * 不抛异常：失败以 {@link TrackerConfigExtensionFailure} 返回（config 侧转成
   * `SymphonyConfigError`），通过返回 `undefined`。这样 config 不需要
   * `instanceof` 一个来自 tracker 的类（那会要求 import tracker）。
   */
  validate(tracker: TrackerConfig, env: TrackerEnv): TrackerConfigExtensionFailure | undefined {
    try {
      this.resolve(tracker, env);
      return undefined;
    } catch (error) {
      return toExtensionFailure(error, tracker.kind);
    }
  }

  /**
   * 构造 §11.1 read kernel：先跑 {@link TrackerAdapterRegistry.validate} 的全部
   * 校验（fail-fast，不产出半构造 adapter），再交给 profile 的 `createAdapter`，
   * 最后统一加空输入守卫（§11.1 两处 MUST）。
   *
   * 失败抛 {@link TrackerError}，category 稳定（§11.4）。
   */
  create(tracker: TrackerConfig, env: TrackerEnv = process.env): TrackerAdapter {
    try {
      const { profile, context } = this.resolveEntry(tracker, env);
      return createTrackerReadKernel(profile.createAdapter(context));
    } catch (error) {
      if (error instanceof TrackerError) {
        throw error;
      }
      // profile.createAdapter 抛非 TrackerError：同样是 public form → category
      // 映射缺失，归一化以保住 §11.4 的稳定错误面。
      throw toTrackerError(error, tracker.kind, "constructing the tracker adapter");
    }
  }

  /**
   * 把本 registry 包装成 `@symphony/config` 的 tracker 配置扩展点
   * （`loadEffectiveWorkflow({ trackerExtension: registry.createConfigExtension() })`）。
   */
  createConfigExtension(): TrackerConfigExtension {
    return {
      validateTrackerConfig: ({ tracker, env }) => this.validate(tracker, env),
    };
  }

  /** 校验 + 解析（profile 缺陷归一化在此），返回构造上下文。 */
  private resolve(tracker: TrackerConfig, env: TrackerEnv): TrackerAdapterContext {
    return this.resolveEntry(tracker, env).context;
  }

  /**
   * kind 选择 → `validateConfig` → `resolveProviderConfig` → states 回填。
   * 顺序即 §6.3 preflight 的语义：先确认"有没有 selected adapter"，再谈该 adapter
   * 怎么看自己的配置。
   */
  private resolveEntry(
    tracker: TrackerConfig,
    env: TrackerEnv,
  ): { profile: TrackerAdapterProfile; context: TrackerAdapterContext } {
    const profile = this.selectProfile(tracker.kind);
    try {
      profile.validateConfig?.(tracker, env);
      const provider =
        profile.resolveProviderConfig?.(tracker.provider, env) ?? tracker.provider;
      return {
        profile,
        context: {
          kind: tracker.kind,
          provider,
          requiredLabels: tracker.requiredLabels,
          // null = "采用所选 adapter profile 文档化的默认"（§5.3.1 / §6.4）。
          // resolved ServiceConfig 形状不因 profile 改变（M1.1 冻结）：默认值只喂
          // adapter，不回写 config。见包 README 的边界一节。
          activeStates: tracker.activeStates ?? profile.defaultActiveStates,
          terminalStates: tracker.terminalStates ?? profile.defaultTerminalStates,
          env,
        },
      };
    } catch (error) {
      if (error instanceof TrackerError) {
        throw error;
      }
      throw toTrackerError(error, tracker.kind, "validating the tracker config");
    }
  }

  /** kind 未配置 / 未注册 → 稳定 {@link TrackerError}。 */
  private selectProfile(kind: string): TrackerAdapterProfile {
    if (kind === "") {
      throw new TrackerError(
        "invalid_tracker_config",
        "tracker.kind is not configured: set it to one of the supported adapters",
        { providerDetail: { supportedKinds: this.supportedKinds } },
      );
    }
    const profile = this.profiles.get(kind);
    if (profile === undefined) {
      throw new TrackerError(
        "unsupported_tracker_kind",
        `Unsupported tracker.kind "${kind}"; supported kinds: ${formatKinds(this.supportedKinds)}`,
        { providerDetail: { kind, supportedKinds: this.supportedKinds } },
      );
    }
    return profile;
  }
}

/** 首个 built-in adapter 的**稳定注册点**（GitHub Issues 的具体 profile 归 #19）。 */
export const BUILT_IN_TRACKER_ADAPTER_PROFILES: readonly TrackerAdapterProfile[] = [];

/**
 * 组合根入口：built-in profiles + 调用方追加的 profiles 建成一个 registry。
 * `apps/cli`（M6）与测试都从这里开始，#19 只需往
 * {@link BUILT_IN_TRACKER_ADAPTER_PROFILES} 里加 profile，不需要改 `@symphony/config`。
 */
export function createTrackerAdapterRegistry(
  profiles: readonly TrackerAdapterProfile[] = [],
): TrackerAdapterRegistry {
  return new TrackerAdapterRegistry([...BUILT_IN_TRACKER_ADAPTER_PROFILES, ...profiles]);
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/**
 * §11.4 的稳定映射：配置阶段只允许 3 个 category。profile 若抛出运行时 category
 * （说明该检查放错了位置）或非 `TrackerError`（adapter 缺陷），一律收敛为
 * `invalid_tracker_config` 并经 `cause` 保留原异常——config 的错误面因此始终可判别。
 */
function toExtensionFailure(error: unknown, kind: string): TrackerConfigExtensionFailure {
  if (error instanceof TrackerError && isConfigCategory(error.category)) {
    return { category: error.category, message: error.message };
  }
  // 其余情况一律 invalid_tracker_config（见 toTrackerError 的两个分支）。
  const wrapped = toTrackerError(error, kind, "validating the tracker config");
  return { category: "invalid_tracker_config", message: wrapped.message, cause: error };
}

function isConfigCategory(category: string): category is TrackerConfigErrorCategory {
  return (
    category === "unsupported_tracker_kind" ||
    category === "invalid_tracker_config" ||
    category === "missing_tracker_secret"
  );
}

/** 非 TrackerError / 非配置 category → 收敛为 invalid_tracker_config。 */
function toTrackerError(error: unknown, kind: string, activity: string): TrackerError {
  if (error instanceof TrackerError) {
    if (isConfigCategory(error.category)) {
      return error;
    }
    return new TrackerError(
      "invalid_tracker_config",
      `Tracker adapter "${kind}" reported ${error.category} while ${activity}, which is a configuration-time failure: ${error.message}`,
      { cause: error },
    );
  }
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new TrackerError(
    "invalid_tracker_config",
    `Tracker adapter "${kind}" threw an unclassified error while ${activity}: ${detail}`,
    { cause: error },
  );
}

function formatKinds(kinds: readonly string[]): string {
  return kinds.length === 0 ? "(none registered)" : kinds.map((kind) => `"${kind}"`).join(", ");
}
