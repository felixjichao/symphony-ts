# @symphony/tracker

## Purpose

SPEC **§11 Issue Tracker Integration Contract** 的 owner 包，对应 §3 的 Issue Tracker Adapter：定义 provider 无关的工单读取接口（§11.1 read kernel）、adapter 的注册与选择机制（§11.2 profile / registry）、以及跨实现稳定的错误契约（§11.4）。**新增 tracker provider 的唯一落点在本包。**

M2.1 落地**内核与选择机制**；M2.2（#19）在其上注册首个 built-in provider：
`tracker.kind: github` 的 profile、provider payload → `Issue` 归一化，以及 §11.1 的
malformed-record 策略。GitHub REST transport / pagination / scope selection 仍归 #20，
见 [GitHub Issues](#github-issues) 一节的最后一小节。

公共出口是 `src/index.ts`（唯一 API 面，测试也经由它）。

## Public API

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
  built-in adapter 的**稳定注册点**，M2.2 起含 [GitHub Issues](#github-issues) 的 profile。
  再加 provider 依旧只需往里加一项，`@symphony/config` 一行都不用改（有测试证明）；
  追加与 built-in 同名的 kind 会被拒绝，不覆盖。

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

### GitHub Issues adapter（§11.2 / §11.3）

```ts
import { createTrackerAdapterRegistry, githubAdapterProfile } from "@symphony/tracker";

const registry = createTrackerAdapterRegistry(); // built-in 已含 github
const kernel = registry.create(serviceConfig.tracker, process.env);
```

`github/` 子目录承载这个 provider 的全部知识：`config.ts`（provider 键、secret /
`GITHUB_TOKEN`、`api_url`、states 校验）、`normalize.ts`（payload → `Issue` 纯函数）、
`adapter.ts`（实现 `TrackerAdapter` + `GitHubIssueTransport` 注入端口）、`profile.ts`
（把三者挂到 `TrackerAdapterProfile`）。registry 与 config 都不认识 `"github"`
这个字符串，除注册点那一行。规则细节见 [GitHub Issues](#github-issues)。

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

## GitHub Issues

首个 built-in provider（SPEC §11.2 / §11.3，M2.2 / #19）。本节即 §11.2 要求的
**compact profile**：`tracker.kind: github` 的全部配置与归一化语义以此处为准，代码只是它的实现。
注册点是 `BUILT_IN_TRACKER_ADAPTER_PROFILES`，所以 `createTrackerAdapterRegistry()` 不追加任何
profile 就认识 `github`；`@symphony/config` 一侧零改动。

### Supported kind 与 provider 键

精确匹配 `github`（区分大小写、不 trim）。`tracker.provider` 只接受三个键，**未知键直接失败**
（拼错的 `tokne` 不该被静默忽略成"没给 token"）：

| 键 | 必填 | 默认 | 语义 |
|---|---|---|---|
| `repo` | 是 | — | `owner/repo`，字符集 `[A-Za-z0-9._-]`，恰好一个 `/`。决定读取哪个仓库，也进 `native_ref` |
| `token` | 否 | 缺失时取 `GITHUB_TOKEN` | 见下方 secret 一节 |
| `api_url` | 否 | `https://api.github.com` | **仅 HTTPS**；解析为 URL 后去掉全部尾斜杠，path 保留（GHES 写 `https://ghes.example.com/api/v3`）。**拒绝** URL 里携带 userinfo（`https://user:pass@…`）——鉴权只有 `token` 一条路；任何回显该值的诊断文案先把 userinfo 换成 `<redacted>` |

### Secret：`token` / `GITHUB_TOKEN`

三态，effective token 必须是非空字符串：

1. **显式字面值** → 直接用；
2. **`$VAR` / `${VAR}`** → 只解释这一个变量名；变量未设置或为空 →
   `missing_tracker_secret`，**不会**再悄悄改用 `GITHUB_TOKEN`（显式指定了凭据来源，
   换成另一个变量等于换一份凭据发请求）；
3. **键缺席 / `null` / 空串**（空值按缺失，与 config 的 env 语义一致）→ adapter-local
   fallback `GITHUB_TOKEN`；仍为空 → `missing_tracker_secret`。

`secretProviderKeys = ["token"]` / `secretEnvVars = ["GITHUB_TOKEN"]` 已按 §11.2 声明出来，
供 M6 的日志脱敏消费。token 值本身：不写回 resolved `ServiceConfig`（core 保留的是用户写的
字面量，`$GITHUB_TOKEN` 不会被 core 展开），不进 `native_ref`，不进任何错误 message。

### active / terminal states

只接受 GitHub-native 值：`active_states` → `open`，`terminal_states` → `closed`。比较按 §4.2
忽略首尾空白与大小写（`"Open "` 合法），但**不回写**配置值。其他状态名（`In Progress` /
`Done` …）→ `invalid_tracker_config`。两键为 `null`（未配置）时 profile 默认为
`["open"]` / `["closed"]`；空数组是"显式什么都不要"，不报错。

### `id` / `native_ref` 映射

- `id = String(payload.number)`：GitHub 的 issue 编号在**单个 repository 内**稳定且唯一，
  与配置的 `repo` 一起构成 dispatch identity。跨仓库场景不存在（`repo` 是单值必填）。
- `identifier = "GH-<number>"`。
- `native_ref = { repo, number }`，再按可用性附上 REST `id`（整数）与 `node_id`（GraphQL ID）。
  只有这四类值进 `native_ref`：JSON-safe、非敏感、可安全进 prompt / tool context（§11.3）。
  `user` / `milestone` / `comments_url` 等 provider 元数据**不保留**——需要时由
  provider-native tool 自己按 `number` 取，而不是让 payload 面扩张到 orchestrator。
  本实现从不返回 `null`：`repo` + `number` 恒可安全表示。

### 归一化（§11.3 逐条）

| 字段 | 规则 |
|---|---|
| `title` / `state` | required 非空字符串；`state` 保留 GitHub 拼写，不 trim 不 lowercase |
| `description` | ← `body`；缺失 / 非字符串 / 空串 → `null` |
| `url` | ← `html_url`，否则 `null` |
| `assignee_id` | ← `assignee.login`（primary assignee），否则 `null` |
| `priority` | 恒 `null`：GitHub Issues core payload 没有规范化 priority |
| `branch_name` | 恒 `null` |
| `labels` | `["x"]` 与 `[{ name: "x" }]` 两种形状都吃；trim + lowercase、剔除空白、去重；非数组条目丢弃 → 最坏 `[]` |
| `created_at` / `updated_at` | 严格 RFC 3339（含 `Z` / `±HH:MM` / 小数秒）→ epoch ms；不可解析 → `null` |
| `blocked_by` | 恒 `[]`：**不**从正文、task list 或非规范关系推断 blocker（§11.3 禁止编造） |
| `dispatchable` | 普通 issue `true`；payload 含 `pull_request`（非 `null`）→ `false`——PR 仍会被读取 / 刷新，但 generic scheduler 不该把它当工单派发 |

**malformed 的判定面只有 §11.1 列出的 required 字段**（`id` / `identifier` / `title` /
`state` / 显式 `dispatchable`），实现方式是抛 `TrackerError("tracker_response")`，
`providerDetail.reason` 给出可判别的原因。可空字段的坏值一律走上面的 fallback，
**不**因此判 malformed。两副面孔由 `GitHubTrackerAdapter` 落实：
`fetchIssuesByStates` 省略单条畸形记录（SHOULD log：`onMalformedRecord` 回调，缺省静默），
`fetchIssuesByIds` 直接失败（省略对刷新调用是有意义的）。

`fetchIssuesByIds` 同时兑现 §11.1 对 refresh 结果的另外两条不变量：入参**按集合处理**
（去重之后才交给 transport），产出**每个 dispatch ID 至多一次**（按 `id` 保留首次出现）。
放在 adapter 而不是等 transport：`Issue.id` 是 orchestrator 的 map key 与 workspace 身份
来源（§4.2），这条不变量不该依赖某个 transport 实现的自觉。

### provider-native tools

M2.2 **不提供**（§11.5 / §17.3，归后续里程碑）。`TrackerAdapterContext.env` 已为该构造期需要预留。

### public error form → category + message

TypeScript 侧的 public form 是**抛出** `TrackerError`（§11.4 允许 language-native
exception）；`category` 是唯一判别面，`message` 是 human-readable 诊断面、文案可演进：

| 抛出点 | category | message 形态 |
|---|---|---|
| `kind` 未注册 / 为空 | `unsupported_tracker_kind` / `invalid_tracker_config` | 由 registry 产出，列出 supported kinds |
| `repo` / `api_url` 形状或取值非法（含 `api_url` 携带 userinfo）、`active_states` / `terminal_states` 非 GitHub-native、未知 provider 键 | `invalid_tracker_config` | `tracker.provider.<key> …` / `tracker.<key> entry …`（引用键名与非法值，绝不引用 token 内容；回显 `api_url` 前把 userinfo 换成 `<redacted>`） |
| token 三处皆不可得、显式 `$VAR` 未设置 | `missing_tracker_secret` | 引用键名 / 变量名 |
| 任何一次工单读取（M2.2 现状） | `tracker_request` | `GitHub tracker transport is not implemented yet …` |
| 单条 payload 的 required 字段无法产出 | `tracker_response` | `Malformed GitHub issue payload: <reason>`，`retryable: false` |

### scope selection / pagination / 请求上限

**M2.2 未实现**（issue 的"非目标"：REST transport 归 #20）。provider 请求面收敛为单个注入
端口 `GitHubIssueTransport`，默认实现 `createUnconfiguredGitHubIssueTransport()` 抛
`tracker_request`。#20 只需替换该 transport：profile、归一化、adapter 与 config 接线都不改动。
因此本节的"M2.2 能做什么"= 配置校验端到端可用 + 给定 payload 得到合法 `Issue`；
`adapter.fetchIssuesByStates(...)` 在 #20 之前必然失败，这是设计好的边界，不是缺陷。

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

- **GitHub REST transport 未实现**（#20）：`github` 的 profile / 归一化 / adapter 已就位，
  但 M2.2 的默认 transport 在被真正读取工单时抛 `tracker_request`。也就是说
  `kind: github` 的配置能通过 preflight 与 `registry.create()`，而
  `fetchIssuesByStates` / `fetchIssuesByIds` 要到 #20 才有网络实现。provider 请求面是
  `GitHubIssueTransport` 这一个注入端口，#20 不改 profile / 归一化 / 接线。
- **§11.1 malformed-record 的"SHOULD log"尚未接线**：省略逻辑已实现，回调注入点
  （`createGitHubAdapterProfile({ onMalformedRecord })`）已留出，但本包不 import
  `@symphony/observability`，默认静默省略；日志落点随 M6 的组合根装配。
- **provider-native agent tools 未落地**（§11.5 / §17.3）：`TrackerAdapterContext.env`
  已为构造期需要预留，但 tools 的名字、schema、授权边界与结果/错误行为尚未定义。
- **只有 GitHub 一个 provider**：§11.3 的通用归一化规则目前只有单一实现作为对照，
  "跨 provider 抽象是否漏了什么"要等第二个 adapter（Linear / Jira）才能证伪。
- 本包不拥有 polling cadence / claim / retry / required-label 过滤 / 并发上限（§8、§14
  归 orchestrator），**永不 import `@symphony/orchestrator`**（根 `AGENTS.md` 硬约束）。
- 不做 generic 写操作 CRUD（comment / state / attachment）：那会丢失 provider 原生语义，
  且 orchestrator 不需要（§11 / §11.5）。
- 空输入的"零 provider 请求"由 `createTrackerReadKernel` 保证，但该守卫只在经由
  registry 或显式 `createTrackerReadKernel` 的路径上生效；直接持有裸 `TrackerAdapter`
  的调用方需自行包装。
- 进度见 [docs/conformance.md](../../docs/conformance.md)。
