# @symphony/tracker

## Purpose

SPEC **§11 Issue Tracker Integration Contract** 的 owner 包，对应 §3 的 Issue Tracker Adapter：定义 provider 无关的工单读取接口（§11.1 read kernel）、adapter 的注册与选择机制（§11.2 profile / registry）、以及跨实现稳定的错误契约（§11.4）。**新增 tracker provider 的唯一落点在本包。**

M2.1 落地的是**内核与选择机制**，不含任何具体 provider：GitHub Issues adapter 归
#19，payload 归一化与 §11.1 的 malformed-record 策略随该任务落地。

公共出口是 `src/index.ts`（唯一 API 面，测试也经由它）。

## Public API（M2.1）

### Read kernel（§11.1）

```ts
import { TrackerAdapterRegistry, createTrackerReadKernel } from "@symphony/tracker";

const registry = createTrackerAdapterRegistry([/* TrackerAdapterProfile… */]);
const adapter = registry.create(serviceConfig.tracker, process.env);

const candidates = await adapter.fetchIssuesByStates(serviceConfig.tracker.activeStates ?? []);
const snapshots = await adapter.fetchIssuesByIds(["opaque-dispatch-id"]);
```

- `TrackerAdapterOperations` / `TrackerAdapter`：§11.1 REQUIRED 的两个 operation，
  均为 **async**（返回 `Promise<readonly Issue[]>`）——§11.1 的实现是网络 transport，
  同步接口会在 provider 落地时变成 breaking change。
- 返回类型只有 `@symphony/domain` 的归一化 `Issue`：provider payload 不越过 adapter
  边界（§11.2 / §11.3），`native_ref` 只放非敏感、可安全进 prompt/tool context 的值。
- `createTrackerReadKernel(adapter)`：统一保证 §11.1 的两处 MUST——
  **空输入 → 空结果且零 provider 请求**。该不变量属内核语义，因此由各 provider
  adapter 重复实现是错误归属；`registry.create()` 恒经此包装，adapter 只需假定拿到
  非空输入。除此之外内核不加任何策略（分页 / 重试 / cadence / required-label /
  并发上限归 provider adapter 与 coordination 层）。
- 失败以 `TrackerError` 抛出；`fetchIssuesByIds` 中"已不在配置 scope 内的 ID 被省略"
  是 provider adapter 的责任（orchestrator 视省略为"不再可见"，不伪造 state）。

### Adapter profile（§11.2）

`TrackerAdapterProfile` 声明一个 `tracker.kind` 拥有的全部配置语义：

| 能力 | 落点 |
|---|---|
| exact supported `tracker.kind` | `kind`（精确匹配，区分大小写、不 trim） |
| whole tracker config validation | `validateConfig?(tracker, env)` |
| provider-owned config validation / defaults | `resolveProviderConfig?(provider, env)` |
| adapter-owned secret / env fallback | 同上（入参 `env`），secret 名由 `secretProviderKeys` / `secretEnvVars` 声明 |
| active/terminal state validation / defaults | 校验在 `validateConfig`；默认值 `defaultActiveStates` / `defaultTerminalStates` |
| public error mapping / profile metadata | `documentation`（§11.2 compact profile 指针） |
| construction from effective config | `createAdapter(context)` |

- 可选方法缺席即"无该能力"：`resolveProviderConfig` 缺省 ⇒ `tracker.provider` 原样
  透传；`tracker.active_states === null` ⇒ 取 profile 默认（§5.3.1 / §6.4）。
- **约定**：`validateConfig` / `resolveProviderConfig` / `createAdapter` 以抛出
  `TrackerError` 表达失败（§11.4 允许 language-native exception form）。registry 的
  `validate()` 把失败转成结构化 `TrackerConfigExtensionFailure`：`category` 是唯一
  判别面，**三条路径都**经 `cause` 挂上原抛出物（配置 category 的 `TrackerError`
  也带上，否则 `retryable` / `providerStatus` / `providerDetail` 这类诊断面在 config
  侧就丢了）；抛出**非** `TrackerError` 的异常一律归一化为 `invalid_tracker_config`
  ——profile 不必各自兜底。

### Registry / factory（§11.2 / §6.3）

- `TrackerAdapterRegistry`：`kind` → profile 的唯一选择点。**无全局单例**——实例由
  组合根持有（M2.1 = 测试，M6 = `apps/cli`），profile 集合因此是显式依赖，不受 import
  顺序影响。
  - `register(profile)` / `lookup(kind)` / `supportedKinds`：注册期拒绝 `kind === ""`
    （那是 `tracker.kind` 的"未配置"哨兵）与重复 kind。
  - `create(tracker, env?)`：校验（`validateConfig` → `resolveProviderConfig`）→
    states 默认值回填 → `createAdapter` → 空输入守卫。校验失败**不产出半构造 adapter**。
  - `validate(tracker, env)`：与 `create` 同一套校验，但以返回值
    （`TrackerConfigExtensionFailure | undefined`）表达失败，不抛异常。
- `BUILT_IN_TRACKER_ADAPTER_PROFILES` + `createTrackerAdapterRegistry(extra)`：
  built-in adapter 的**稳定注册点**。#19 只需往里加 `github` profile，
  `@symphony/config` 一行都不用改（有测试证明）。

### config 集成（§6.3 / §17.1）

`registry.createConfigExtension()` 产出结构化扩展点，注入 config：

```ts
import { loadEffectiveWorkflow } from "@symphony/config";

const registry = createTrackerAdapterRegistry([githubProfile]);
const eff = loadEffectiveWorkflow({
  cwd,
  env: process.env,
  trackerExtension: registry.createConfigExtension(),
});
```

- 注入后，`tracker.kind` 的 supported-adapter 校验与 `tracker.provider` 的
  adapter-owned 校验发生在 core resolution **之后**（preflight），失败抛
  `SymphonyConfigError`，`code` ∈ `unsupported_tracker_kind` /
  `invalid_tracker_config` / `missing_tracker_secret`。
- **不注入 = M1 行为不变**：core 不认识任何 provider，任意未知 kind 与 provider 键
  原样通过。
- `watchWorkflow` 经 `WatchWorkflowOptions` 继承同一选项，因此无效 tracker 配置的
  reload 自动走 §6.2 语义（保留 last-known-good + `onEvent({kind:"error"})`）。
- 依赖方向：本包**不 import `@symphony/config`**。两侧各自声明同形
  （`TrackerConfigExtension` 等三个类型）的结构化契约；漂移由
  `src/config-integration.test.ts` 的双向赋值断言在编译期发现。完整理由与备选见
  [Agent Note](../../notes/accepted/architecture/2026-09-28-tracker-adapter-config-extension.md)。

### 错误契约（§11.4）

`TrackerError` + `TrackerErrorCode`：8 个推荐 category **一字不差**采用——
`unsupported_tracker_kind` / `invalid_tracker_config` / `missing_tracker_secret` /
`tracker_request` / `tracker_status` / `tracker_response` / `tracker_pagination` /
`tracker_rate_limited`。

- 判别式是 `category`（对齐 §11.4 的 portable `category` 字段名；config 侧同类契约用
  `code`，两者分属各自包的错误面）。`message` 恒为 human-readable 诊断面，
  **不是**判别面，文案可演进。
- §11.4 "MAY add" 的 `retryable` / `retryAfterMs` / `providerStatus` /
  `providerDetail` 全部可选，且**缺席即缺席**（不写成 `undefined` 哨兵），使消费方能
  区分"adapter 未判定"与"判定为 false"。第三方 transport 异常经 `Error.cause` 保留，
  不作为对外契约。
- 前三个 category 属于**配置阶段**（`TrackerConfigErrorCategory`），后五个只在
  §11.1 读取期间出现。
- orchestrator 侧的行为（candidate fetch 失败 → 本 tick 跳过；refresh 失败 → 保留
  active worker；startup cleanup 失败 → 记 warning 继续）归 M5，本包只保证错误面稳定。

## Configuration

provider 的连接参数由 `@symphony/config` 产出的 typed `TrackerConfig` 提供
（`kind` / `provider` / `required_labels` / `active_states` / `terminal_states`）。
本包**不自行读取配置文件**；环境变量只在调用方显式传入 `env` 时可见
（`create(tracker, env)` 缺省用 `process.env`，供组合根省略）。

`tracker.provider` 的键、默认值与 secret / env fallback 是 **adapter-owned**：core 原样
保留 unknown keys、不预校验、不做 `$VAR` 展开（§6.1 "adapter-local, not a
cross-provider convention"）。

## Extension points

- **新增 provider**：实现 `TrackerAdapterProfile`（含 `createAdapter`），把 normalized
  结果类型固定为 `@symphony/domain` 的 `Issue`，不在 adapter 内另造 Issue 模型；built-in
  的注册位置是 `BUILT_IN_TRACKER_ADAPTER_PROFILES`。provider payload 的字段映射差异在
  adapter 层吸收；profile 的 compact profile 文档（§11.2 要求的 8 项）写进本 README。
- **profile 必须披露的内容**（§11.2，不得只在代码里）：supported kind、exact provider
  keys 与默认值、secret 键 / 环境变量名、scope selection 与分页与请求上限、`id` 与
  `native_ref` 映射、state / label / priority / timestamp / `dispatchable` /
  malformed-record / optional-field 归一化、provider-native tools（如有）、public error
  form → category + message 的映射。
- **消费方**（M5 orchestrator）只经 `registry.create()` 拿 kernel，不得解释 provider
  payload，不得假设 `issue.id` 是底层 ticket ID，不得按 provider-specific blocker /
  board / transition 语义分支（§11.2）。

## Known limitations

- **无 built-in adapter**：`BUILT_IN_TRACKER_ADAPTER_PROFILES` 当前为空数组，只是稳定
  注册点；`github` 的具体规则（provider 键、`GITHUB_TOKEN`、分页、scope 选择、
  `dispatchable` 推导）归 #19。
- **payload 归一化与 malformed-record 策略未落地**（§11.3 / §11.1：state-list 可省略单条
  畸形记录并记日志，ID-refresh MUST fail 而非静默省略）：需要真实 provider payload，
  与 #19 / #20 一同实现，conformance 的 §11 行保持 `in-progress`。
- **provider-native agent tools 未落地**（§11.5 / §17.3）：`TrackerAdapterContext.env`
  已为构造期需要预留，但 tools 的名字、schema、授权边界与结果/错误行为尚未定义。
- 本包不拥有 polling cadence / claim / retry / required-label 过滤 / 并发上限（§8、§14
  归 orchestrator），**永不 import `@symphony/orchestrator`**（根 `AGENTS.md` 硬约束）。
- 不做 generic 写操作 CRUD（comment / state / attachment）：那会丢失 provider 原生语义，
  且 orchestrator 不需要（§11 / §11.5）。
- 空输入的"零 provider 请求"由 `createTrackerReadKernel` 保证，但该守卫只在经由
  registry 或显式 `createTrackerReadKernel` 的路径上生效；直接持有裸 `TrackerAdapter`
  的调用方需自行包装。
- 进度见 [docs/conformance.md](../../docs/conformance.md)。
