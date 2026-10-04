# @symphony/tracker

## Purpose

SPEC **§11 Issue Tracker Integration Contract** 的 owner 包，对应 §3 的 Issue Tracker Adapter：定义 provider 无关的工单读取接口（§11.1 read kernel）、adapter 的注册与选择机制（§11.2 profile / registry）、以及跨实现稳定的错误契约（§11.4）。**新增 tracker provider 的唯一落点在本包。**

M2.1 落地**内核与选择机制**；M2.2（#19）在其上注册首个 built-in provider：
`tracker.kind: github` 的 profile、provider payload → `Issue` 归一化，以及 §11.1 的
malformed-record 策略；M2.3（#20）补上该 provider 的**真实 REST transport**——
repository scope、分页、鉴权头与 §11.4 的 portable error mapping。行为细节见
[GitHub Issues](#github-issues) 一节。

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

### GitHub Delivery Primitives（§11.5 / MVP.3）

提供独立于 tracker read kernel 的 GitHub 交付原语与自动合并能力（`GitHubDeliveryService`）：

- `ensurePr(context, options)`：幂等创建或精确复用 PR。以机器可读 marker（`<!-- symphony-delivery-marker: ... -->`）与 `Fixes` 关联做所有权与仓库边界严格校验，拒绝外国 PR、歧义候选与 closed-unmerged。
- `readPr(context, options)`：读取 PR 详情并复验所有权与 head 仓库身份。
- `readChecks(context, options)`：拉取绑定当前 head SHA 的 required 与 current checks（包含 GraphQL 分支保护规则与 REST ruleset 分页拉取），执行严格 CI 策略判定；无法确认有效 required 规则时 fail-closed 返回 `checks_unknown`。
- `diagnoseFailedChecks(report)`：产出脱敏的失败/等待检查可行动诊断摘要。
- `landPr(context, options)`：显式 opt-in（`--opt-in`）下验证 PR open、non-draft、mergeable 与 checks 严格通过，通过 REST API 执行直接条件 squash merge（带 `sha: expectedHeadSha` 条件头，拒绝 merge queue 与 deferred auto-merge），并在合并后重读事实确认最终 `MERGED`、`mergeCommitSha` 与 `mergedAt` 终态。
- `verifyMerged(context, options)`：校验 PR 是否已合入，严格核验 merge commit SHA 与 mergedAt 终态（缺失时返回 `verification_unknown`）。
- 安全边界：通过 `DefaultGhRunner` 执行 `gh` 命令，采用白名单安全错误消息杜绝 Token/OAuth/URL 凭据泄露，有界超时并终止子进程树，保证 stdout 结构完整。

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
`adapter.ts`（实现 `TrackerAdapter` + `GitHubIssueTransport` 注入端口）、
`transport.ts`（该端口的真实 REST 实现）、`profile.ts`
（把四者挂到 `TrackerAdapterProfile`）。registry 与 config 都不认识 `"github"`
这个字符串，除注册点那一行。规则细节见 [GitHub Issues](#github-issues)。

未注入 `transport` 时，profile 在 `createAdapter` 内按已解析的 provider 配置构造真实
REST transport；测试可用 `createGitHubAdapterProfile({ transport })` 注入假 transport
（只验归一化 / malformed 策略），或用 `{ fetchImpl }` 把默认实现的 fetch 指向别处。

`{ fetchImpl }` 的第二个用途是把**默认** transport 指向本地 GitHub REST stub，同时让
`api_url` 保持配置的 https 端点：`src/github-rest-integration.test.ts` 因此能一条链路
验到底（`WORKFLOW.md` → config preflight → registry → adapter → REST → normalized
`Issue`），而 HTTPS-only 那条安全不变量不因测试装配而松动（只替换 URL 的 origin，
`Link` 分页的 origin 守卫照常生效）。

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

首个 built-in provider（SPEC §11.2 / §11.3，M2.2 / #19 + M2.3 / #20 的 REST transport）。
本节即 §11.2 要求的**compact profile**：`tracker.kind: github` 的全部配置、读取与归一化
语义以此处为准，代码只是它的实现。
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
| 单条 payload 的 required 字段无法产出 | `tracker_response` | `Malformed GitHub issue payload: <reason>`，`retryable: false` |
| 读取期间的 transport / status / rate-limit / payload / 分页失败 | `tracker_request` / `tracker_status` / `tracker_rate_limited` / `tracker_response` / `tracker_pagination` | 见下一节的 transport 侧映射表 |

### scope selection / pagination / 请求上限

M2.3（#20）已实现，落在 `github/transport.ts`；本节是 §11.2 要求的披露面。

**endpoint 与 scope**

| 调用 | endpoint |
|---|---|
| candidate read（`fetchIssuesByStates`） | `GET {api_url}/repos/{owner}/{repo}/issues` |
| ID refresh（`fetchIssuesByIds`） | `GET {api_url}/repos/{owner}/{repo}/issues/{number}` |

scope 恒为配置的 `owner/repo`（逐段 `encodeURIComponent`），`api_url` 的 path 前缀保留在
`/repos` 之前，因此 GHES 写 `https://ghes.example.com/api/v3` 即打到
`/api/v3/repos/…`。**不存在跨仓库读取**：`repo` 是单值必填，adapter 也不接受调用方传入
别的 owner/repo。鉴权与内容协商头每次请求都带上：
`Authorization: Bearer <token>`、`Accept: application/vnd.github+json`、
`X-GitHub-Api-Version: 2022-11-28`、`User-Agent: symphony-ts/tracker`。

**state mapping**：requested state 先按 §4.2 trim + lowercase，再映射到 GitHub 的
`open` / `closed`。两者同时被请求 → 用 `state=all` 一次读取；只要一种 → `state=open`
或 `state=closed`。无论请求怎么发，**结果都按 requested set 过滤**（GitHub 的 `state`
参数在列表 endpoint 上不是严格过滤；而"结果 ⊆ 请求集"这条不变量不该取决于一次请求
用了哪个 `state` 值）。映射不出任何 GitHub state（含空列表）→ 直接返回 `[]`，
**一个请求都不发**。

**排序与分页**：`sort=created&direction=asc`，`per_page=100`（本页大小时 GitHub 的
上限，也是本 adapter 的请求上限；无单次调用的页数上限——分页读完为止）。分页沿
Link header 的 `rel="next"` 走，**逐页拼接以保持 provider 返回顺序**；不按逗号 split
header（分页 URL 的 query 本身可能含逗号）。没有 next 即结束。

**原子性**：任一页的 transport / status / payload / 分页完整性失败，整个 operation 以
该 category 抛出，**不返回部分成功列表**。ID refresh 同理串行逐条读取（并发只会把
rate-limit 风险前移，重试策略归 orchestrator §8，不在本包）。

**pagination 的安全边界**：`rel="next"` 的 URL 若与配置 `api_url` 不同 origin →
`tracker_pagination`，且绝不向该 URL 发请求——provider 响应面不该把带 token 的请求
引导到配置 scope 之外。

**404 只有一种语义**：ID refresh 的 404 → omit（hidden / deleted / 已不在 scope，
调用方读成"不再可见"，不构造 synthetic state）；candidate read 的 404 与其他
unexpected status 一律 `tracker_status`，不吞掉。

**dispatch ID**：必须是正整数的字符串形式；列表里混进坏 ID → **整个 call 在任何请求
发出之前**以 `tracker_response` 失败（与 §11.1 "malformed requested record MUST fail"
同源）。入参去重与结果按 `id` 折叠由 `GitHubTrackerAdapter` 负责，transport 因此恒常
只看到集合。

**PR 记录**：GitHub 的 issue 与 PR 共用编号序列，`/issues` 两个 endpoint 都会返回 PR。
transport **原样保留**，由 normalize 标 `dispatchable=false`（§11.1：candidate polling
要连不可派发的一起返回，最终过滤属 scheduler）。

**不做的事**：不实现 retry / backoff / 限流调度（§8 / §14 归 orchestrator），只提供
`retryable` / `retryAfterMs` / `providerStatus` 供上层决策；没有请求超时（Node `fetch`
的默认行为）；不写 GitHub 写 API。

### public error form → category + message（transport 侧）

| 触发 | category | 附加字段 |
|---|---|---|
| fetch 抛异常（DNS / 连接 / TLS） | `tracker_request` | `retryable: true`、`cause` |
| 429；403 + `Retry-After`（GitHub secondary limit 的常见形状）；或 4xx + `x-ratelimit-remaining: 0` | `tracker_rate_limited` | `retryable: true`、`retryAfterMs`（`retry-after` 的秒数或 HTTP-date 优先，否则 `x-ratelimit-reset` 推算，clamp ≥ 0）、`providerStatus` |
| 其余非成功 status（401 / 403 无限流头 / 404 于 candidate read / 5xx） | `tracker_status` | `providerStatus`、`providerDetail.message`（GitHub 错误信封，截 200 字符）、`retryable = status >= 500` |
| 响应不是合法 JSON；列表顶层非数组；单条顶层非对象；坏 dispatch ID | `tracker_response` | `retryable: false`（JSON 失败另带 `cause`） |
| Link header 读不懂；next 跨出配置 origin；next 不是合法 URL | `tracker_pagination` | — |
| ID-refresh 的 404 | **omit**，不是错误 | — |

`message` 引用 URL、status 与 GitHub 自己的 `message`，**永不**引用请求头，因此 token
不会经错误面外泄（`src/github/transport.test.ts` 与 `src/github/profile.test.ts` 断言这一条）。

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

- **transport 没有请求超时**：`github/transport.ts` 用 Node 内置 `fetch` 的默认行为，
  不主动 abort 慢响应，也没有 per-operation 的时间预算。分页因此可能在一台无响应的
  provider 上停留较久；超时与重试节奏一起归 M5 orchestrator（§8）。
- **没有 provider 侧的 rate-limit 预算**：429、403 + `Retry-After`（secondary limit）与
  `x-ratelimit-remaining: 0` 都被如实映射成 `tracker_rate_limited` + `retryAfterMs`，但本包
  不排队、不降频、不缓存 ETag / `If-None-Match`（§11.2 的 rate-limit handling 只到"错误面
  诚实"为止）。
- **§11.1 malformed-record 日志接线已由 M6.2 helpers 验证**：
  `createGitHubAdapterProfile({ onMalformedRecord })` 接 CLI warning observer；callback
  throw 被 adapter 隔离，坏一条仍返回好 candidates，ID-refresh 保持 MUST fail。
  默认不装配 logger 的独立 adapter 仍静默省略；正式 CLI host 已通过同一 observer 完成生产日志装配（M6.3–M6.5）。
- **provider-native agent tools 未落地**（§11.5 / §17.3）：`TrackerAdapterContext.env`
  已为构造期需要预留，但 tools 的名字、schema、授权边界与结果/错误行为尚未定义。
- **没有真实 GitHub 的 smoke（§17.8 Real Integration Profile）**：本包的验收全部在
  Core Conformance 层，凭据无关、可在默认 CI 复跑；端到端那条用本地 REST stub 顶替
  provider（`src/github-rest-integration.test.ts`）。opt-in 的真实仓库只读 smoke 尚未
  实现，将来加入时缺席只能 skip、不得记为 Core Conformance passed，也不得对生产仓库
  做写操作。
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
