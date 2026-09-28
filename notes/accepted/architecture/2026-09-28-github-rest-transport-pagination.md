# Agent Note: GitHub REST transport 的分页、原子性与 fetch 注入边界（M2.3 / #20）
Status: accepted

## Problem

#19 把 GitHub adapter 的 provider 请求面收敛成单个注入端口 `GitHubIssueTransport`
（见
[2026-09-28-github-adapter-transport-boundary.md](2026-09-28-github-adapter-transport-boundary.md)），
并承诺 #20 只需提供该端口的真实实现。真做的时候有四件事那个 Note 没有替我们决定：

1. **transport 在哪一层构造**：profile 是模块级单例（`githubAdapterProfile`），而
   REST transport 需要 `repo` / `token` / `api_url` ——这些直到 `createAdapter(context)`
   才存在；
2. **分页完整性与"部分成功"的边界**：§11.1 要求 operation 对调度方是原子的，
   GitHub 的分页线索来自响应头 `Link`，而那是 provider 给的、我们不可信的输入；
3. **requested state 与 provider 返回之间的过滤责任**：`state=all` 会带回两种 state，
   单一 state 的查询也可能混进别的记录，而 malformed 判定明确属 adapter；
4. **怎么在测试里跑真实 HTTP**：`api_url` 的校验强制 HTTPS（M2.2 定的安全不变量：
   明文端点会把 token 放到线上），而本地 stub server 起的是明文 HTTP。

约束不变：本包不 import orchestrator / observability，不做 retry / backoff，
不引入新的运行时依赖（Node >= 20 的内置 `fetch` 够用）。

## Decision

`packages/tracker/src/github/transport.ts` 提供 `createGitHubIssueTransport(config, { fetchImpl })`，
四条裁定：

- **默认 transport 在 `createAdapter` 内按 context 构造**，不是 profile 级、也不是
  模块级。`profile.ts` 里 `options.transport ?? createGitHubIssueTransport(provider)`
  发生在配置校验之后、adapter 构造之前，因此 built-in 注册仍是一行
  `createGitHubAdapterProfile()`，组合根不需要知道 GitHub 的存在。M2.2 的
  `createUnconfiguredGitHubIssueTransport` 随之**删除**（不是保留为 deprecated 桩）：
  它的唯一职责是标记"transport 未就位"，那个里程碑已经过去了。
- **分页失败一律整 operation 失败，且 `Link` 里的 next URL 要过 origin 检查**：
  header 存在但解析不出任何 `<…>; rel="…"` 条目、next 不是合法 URL、或 next 的
  origin ≠ 配置 `api_url` 的 origin → `tracker_pagination`，且不向该 URL 发出请求。
  理由：`Link` 是 provider 响应面，照单全收等于允许一份响应把带 Bearer token 的
  请求引导到任意 host；而"读不懂的 next"如果降级成"到此为止"，调用方拿到的就是
  一个看起来成功、其实缺尾的候选列表——那正是 §11.1 原子性要防的事。
  解析按 `<…>; rel="…"` 配对匹配，不按逗号 split（分页 URL 的 query 可以含逗号）。
- **transport 不做 malformed 判定，state 过滤只用于收窄 state**：
  `state=open|closed` 时按 requested set 过滤，但 `state` 不是字符串的记录一律放行
  ——把"这条记录根本没有可用 state"翻译成 transport 的丢弃，会让 state-list 的
  "省略并 SHOULD log"与 ID-refresh 的"MUST fail"这两副面孔在 transport 层就丢失。
  同一条理由决定了 PR 记录原样返回（`dispatchable` 属 normalize），以及 ID-refresh
  的 404 是唯一走 omission 的 status（列表调用的 404 仍是 `tracker_status`）。
- **ID refresh 串行，且 dispatch ID 在进入请求循环之前整批校验**：坏 ID 让整个 call
  在零请求的状态下 `tracker_response` 失败。串行是因为 refresh 的量级是 active runs，
  并发只会把 rate-limit 风险前移，而重试节奏不归本包。

测试用**真实 HTTP**：本地 `http.createServer` stub + Node 内置 `fetch`
（`github-rest-fixture.ts`）。为此 transport 接受一个 `fetchImpl` 注入点，profile 也把
同一个点透出来（`createGitHubAdapterProfile({ fetchImpl })`）。**不**为了测试放宽
`api_url` 的 HTTPS-only 规则——profile 层的默认 transport 接线改用 fetch 记录器验证
（那条测的是"接线"，HTTP 行为由 `transport.test.ts` 覆盖）。

## Alternatives considered

- **profile 级 / 模块级构造默认 transport**（把 `githubAdapterProfile` 变成
  `createGitHubAdapterProfile({ transport: createGitHubIssueTransport(...) })`）：不可行。
  provider 配置在模块加载时不存在，硬要早构造就得把 token 提到 registry 之外，
  等于把 §11.2 的"adapter-owned secret 解析"从 profile 抢给组合根。
- **保留 `createUnconfiguredGitHubIssueTransport` 作为缺省**（真实 transport 只在显式
  注入时生效）：被否。`kind: github` 会停在"配置能过但读不到工单"的状态，而 M2.2
  Note 里那条负面承诺正是我们这次要清偿的债。留着桩还会让"忘了接线"与"provider
  未就绪"在错误面上同形。
- **分页读到不懂的 next 就当没有下一页**（降级为成功）：被否，见上——部分列表比
  失败更危险，orchestrator 无法区分"provider 真的只有这些"与"我们没读完"。
- **让 transport 自己判 malformed / 直接返回 `Issue[]`**：被否（沿用 #19 的裁定），
  这里只是把它贯彻到 state 过滤与 PR 记录两处。
- **ID refresh 并发化（`Promise.all` / 限流并发）**：被否。GitHub 的 secondary limit
  对突发并发很敏感，refresh 条数本来就小；而且并发让"哪一条失败"的诊断变复杂，
  换来的延迟收益不属于本包职责（§8 归 orchestrator）。
- **测试用 HTTPS stub server（自签证书）**：被否。要引入证书生成与 TLS 信任开关，
  比一个 `fetchImpl` 注入点重得多，而且真正的安全不变量（生产端点必须 HTTPS）
  不该由测试装配方式来反向决定。
- **在 transport 里做 retry / 尊重 `retry-after` 自动等待**：被否（§11.4 明确把
  orchestrator 的 retry policy 划在本包之外）。`retryAfterMs` / `retryable` 只作为
  错误面的信息带给上层。

## Consequences

正面：

- `tracker.kind: github` 从"可配置不可读"变成真的能读；`docs/conformance.md` 的
  §11.1 与新增 §17.3 行从 in-progress 落成 implemented。
- §11.2 要求披露的 scope selection / pagination / 请求上限有了唯一落点：
  `packages/tracker/README.md` 的 [GitHub Issues](../../../packages/tracker/README.md#github-issues)
  一节（endpoint 表、`per_page=100`、`sort=created&direction=asc`、404 的双面语义、
  分页 origin 拒绝）。
- 错误面被真实响应逐条测试覆盖，`retryable` 的判定有规则可循（5xx 可重试、
  4xx 鉴权 / 权限类不可重试、限流可重试）。

负面与后续承诺：

- **多了一个测试专用的公共面**：`GitHubFetchImpl` / `GitHubIssueTransportOptions` /
  profile 的 `fetchImpl` 都从 `index.ts` 导出。承诺：它只用于把 transport 指向指定
  endpoint，**不**是 retry / 缓存 / 代理的扩展点；要那些能力请另立端口，不要往
  `fetchImpl` 上叠语义。
- **没有请求超时**：慢 provider 会一直等下去。超时与 polling 节奏一起归 M5
  orchestrator（§8），本 Note 不假装已解决；README 的 Known limitations 已记。
- 分页的 `x-ratelimit-reset` → `retryAfterMs` 用本地时钟做差，时钟偏差会让等待估算
  偏低（clamp 到 ≥ 0，不做负数）。上层若需要严格退避，应以自己的策略为准。
- 删除 unconfigured 桩之后，"provider 配置正确但网络不可用"与"transport 未接线"在
  错误面上不再是两种形态——这是有意的：后者现在不存在了。若将来真要区分
  "provider 未就绪"，另加显式状态，不要再造一个会抛的默认 transport。
- `state` 非字符串的记录继续放行到 adapter，因此**任何** transport 实现都不能靠
  "过滤掉可疑记录"来履行 §11.1；malformed 判定永远只在 adapter 一层。
