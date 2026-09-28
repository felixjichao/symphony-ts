/**
 * Tracker 配置校验扩展点（SPEC §6.3 Dispatch Preflight Validation + §17.1 两条
 * tracker config 验收项）。
 *
 * M1.3 把 `tracker.kind` 的 supported-adapter 校验显式推迟到需要注册表的 M2
 * （`tracker.kind` 缺失 → `""` 哨兵，resolution 不报错，见
 * `notes/accepted/architecture/2026-09-27-config-resolution-contract.md`
 * Decision 2）。本文件就是那个推迟落地的**扩展点**：
 *
 * - `@symphony/config` 只定义契约，**不 import `@symphony/tracker`**——否则
 *   core 会反向依赖 adapter 层，并把 provider knowledge 拖进配置层（根
 *   `AGENTS.md` 依赖方向 + §11.2）。契约是结构化（duck）类型：tracker 侧的
 *   `TrackerAdapterRegistry.createConfigExtension()` 产出同形对象即可注入，
 *   两侧各自独立声明这三个形状，理由与兼容锁定见
 *   `notes/accepted/architecture/2026-09-28-tracker-adapter-config-extension.md`。
 * - **缺省不注入 = M1 行为逐字不变**：裸 `WORKFLOW.md` 仍得到 §6.4 全量默认值的
 *   `ServiceConfig`，core resolution 不依赖任何注册表。
 * - 注入后是 **post-resolution 的 preflight 校验**，不是 core 校验的一部分：它只
 *   读已经 resolved 的 `tracker` 与本次 resolution 的 `env`，不改写
 *   `ServiceConfig` 形状（adapter-owned 的 provider / states 默认值留在 tracker
 *   侧喂 adapter，M1.1 冻结的形状不动）。
 * - 失败面：{@link TrackerExtensionErrorCode} 三个 category 名与 SPEC §11.4 一字
 *   不差，复用单一 {@link SymphonyConfigError}（`code` 即判别式，`path` 为 workflow
 *   文件绝对路径），因此 `watchWorkflow` 自动获得 §6.2 语义——无效 tracker 配置的
 *   reload 保留 last-known-good 并发 `onEvent({ kind: "error" })`。
 */
import type { TrackerConfig } from "@symphony/domain";

/**
 * 属于配置阶段的 §11.4 category（与 tracker 侧
 * `TrackerConfigErrorCategory` 同域；名字固定为 SPEC 原文）。
 */
export type TrackerExtensionErrorCode =
  | "unsupported_tracker_kind"
  | "invalid_tracker_config"
  | "missing_tracker_secret";

/**
 * 扩展点收到的输入。
 *
 * - `tracker`：**已 resolved** 的 tracker 配置（§6.1 管道之后）。`kind` 可能是
 *   `""`（未配置哨兵）；`provider` 是 core 原样保留的 adapter-owned map（core 不
 *   校验其键，也不做 `$VAR` 展开）；`activeStates` / `terminalStates` 为 `null`
 *   表示"采用所选 adapter profile 的默认"。
 * - `env`：本次 resolution 使用的环境变量视图（与 `workspace.root` 的 `$VAR`
 *   展开同源）。adapter-owned 的 secret / env fallback 由扩展自行解释
 *   （§6.1 "adapter-local, not a cross-provider convention"）。
 */
export interface TrackerConfigValidationContext {
  readonly tracker: TrackerConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * 一次失败的稳定表示。`message` 是 human-readable 诊断面，直接成为
 * `SymphonyConfigError.message`；`cause` 可选保留 adapter 侧原始异常。
 */
export interface TrackerConfigExtensionFailure {
  readonly category: TrackerExtensionErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * 注入 `ResolveServiceConfigOptions.trackerExtension` /
 * `LoadEffectiveWorkflowOptions.trackerExtension` 的扩展点。
 *
 * 契约：`validateTrackerConfig` **不得抛异常**来表达配置非法——失败只能经返回值
 * 传递（抛出的异常会被视为内部缺陷并向上传播，破坏 §6.2 的 crash-resistance）。
 * 通过则返回 `undefined`。
 */
export interface TrackerConfigExtension {
  readonly validateTrackerConfig: (
    context: TrackerConfigValidationContext,
  ) => TrackerConfigExtensionFailure | undefined;
}
