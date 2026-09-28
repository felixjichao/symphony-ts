# Agent Note: GitHub adapter 的 transport 注入边界（M2.2 / #19 方案 B）
Status: accepted

## Problem

#19（M2.2）要交付 GitHub Issues 的 **adapter profile + payload 归一化**，而 REST
transport / pagination / scope selection 明确划给 #20。问题是这两半在 `§11.2` 的
契约里并不是干净的两天：`TrackerAdapterProfile.createAdapter(context)` 必须返回一个
实现 §11.1 两个 operation 的 `TrackerAdapter`，而这两个 operation 的**唯一合理实现
就是发 HTTP 请求**。于是 M2.2 面临三选一：

1. 只导出归一化纯函数，`createAdapter` 缺席或返回 `throws-not-implemented` 的桩；
2. adapter 实现 `TrackerAdapter`，但把 provider 请求面抽成注入端口，M2.2 用
   "未配置"的默认实现；
3. 把 #19 与 #20 合成一个 PR，一次做完。

约束还有三条：`kind: github` 应当在 M2.2 结束时就能通过 `@symphony/config` 的
preflight（否则"注册 built-in provider 不需要动 config"这条 §17.1 / §6.3 的证明要
推迟）；provider 知识不得泄漏进 core；归一化与 malformed-record 策略必须可测
（§11.1 的两副面孔在没有 HTTP 的情况下也要能验证）。

## Decision

采用 **2**：`GitHubTrackerAdapter` 实现 `TrackerAdapter`，provider 请求面收敛为单一
端口 `GitHubIssueTransport`（两个方法，返回 `readonly unknown[]`——即未归一化的
JSON），由 `createGitHubAdapterProfile({ transport })` 注入；built-in 注册的是
`createUnconfiguredGitHubIssueTransport()`，它的两个方法抛
`TrackerError("tracker_request")`。（**M2.3 / #20 更新**：端口与本 Note 的三条附属裁定
不变；built-in 的默认实现已换成按 context 构造的真实 REST transport，
`createUnconfiguredGitHubIssueTransport` 删除。分页与 fetch 注入面的新裁定见
[2026-09-28-github-rest-transport-pagination.md](2026-09-28-github-rest-transport-pagination.md)。）

于是 M2.2 的可交付面是完整的：`registry.create(tracker, env)` 端到端可用，配置校验
（provider 键、`token` 三态、`api_url`、states）真实发生，归一化与 malformed-record
策略有测试；而 `fetchIssuesByStates(["open"])` 明确地、以稳定 category 失败。

三条附属裁定：

- **`unknown` 而非声明 payload 类型**：transport 的产物是 `JSON.parse` 的结果，编译期
  没有形状保证。给它编一个 `GitHubIssuePayload` interface 会把"字段可能缺失 / 类型
  可能不对"这件 §11.1 malformed-record 的核心事实从类型系统里抹掉，让 normalizer 的
  运行时校验看起来像防御性冗余。
- **归一化失败用抛出（`tracker_response`）而非返回 union**：调用方（adapter）需要
  按 operation 决定丢留，而"malformed"与"transport 坏了"必须可判别。返回
  `Issue | Failure` 会让 `fetchIssuesByIds` 里"其他异常原样抛出"这条要求变得难以表达。
- **§11.1 的 "SHOULD log" 以 `onMalformedRecord` 注入点交付**，本包不 import
  `@symphony/observability`（§13 属 M6）。省略本身是 MUST，日志是 SHOULD：未接回调时
  静默省略，不阻塞 M2.2。

## Alternatives considered

- **方案 1（只导出纯函数，`createAdapter` 抛 not-implemented）**：被否。它让
  `createTrackerAdapterRegistry()` 里的 `github` 变成一个"配置校验能过、但拿不到
  adapter"的半成品，`registry.create()` 这条真实链路在 M2.2 无法验证；而 #20 落地时
  要同时新增 adapter 类、transport 与接线，改动面比"只替换一个注入实现"大。
  两者失败模式相似（都抛异常），但方案 1 抛在**构造期**，等于把 provider 的可用性
  问题伪装成配置问题——`registry.create()` 会在 preflight 通过后抛
  `invalid_tracker_config`，语义错位。
- **方案 3（#19 + #20 合一）**：被否。issue 已把 transport 划为非目标，合并会让一个
  PR 同时覆盖 §11.2 profile / §11.3 归一化 / §11.1 transport / §11.4 rate-limit 映射，
  评审面与回滚面都过大。
- **让 profile 的 `createAdapter` 自己 `fetch`（不分层）**：被否。那会让 GitHub 的
  pagination 细节与 `TrackerAdapter` 实现绑死，#20 必须重写 adapter 本体，
  并且 M2.2 的归一化测试只能靠真实网络或全局 fetch mock。
- **`GitHubIssueTransport` 返回 `readonly Issue[]`（在 transport 内归一化）**：被否。
  归一化与 malformed-record 判定是 adapter 的责任（§11.2），transport 只该管
  endpoint / auth / pagination；否则 `dispatchable` 与 malformed 策略会被推到
  transport 里，#20 与 #19 的关注点重新纠缠。

## Consequences

正面：

- `kind: github` 在 M2.2 就进了 `BUILT_IN_TRACKER_ADAPTER_PROFILES`，
  `config-integration.test.ts` 证明"不追加任何 profile 也能通过 config 校验"，
  §6.3 / §17.1 的这条证明不再欠账。
- #20 的改动面被压缩到一个文件：实现 `GitHubIssueTransport`（`fetch` + pagination +
  §11.4 的 status / rate-limit → category 映射），把它传给 profile。adapter /
  归一化 / 校验 / config 接线都不动。
- 归一化与 malformed-record 策略在无网络条件下被完整测试覆盖（假 transport）。

负面与后续承诺：

- **M2.2 之后的 `kind: github` 是"可配置但不可读"的状态**，这是有意为之，但容易被
  误读为已可用。承诺：`packages/tracker/README.md` 的 GitHub Issues 一节与
  `docs/conformance.md` 的 §11.1 行都必须显式写明 REST transport 属 #20；
  `docs/architecture.md` 的里程碑行同样标注。
- 未配置 transport 的失败 category 选了 `tracker_request`（"transport failure"），
  而不是更"新"的造词。含义是：从调用方视角，"没有 transport"与"transport 坏了"
  在 §11.4 的错误面里同属一类。若 #20 之后出现需要区分二者（例如 dashboard 要显示
  "provider 未就绪"），再在本 Note 之上补一条决策，不要就地扩散 category。
- `onMalformedRecord` 目前没有任何默认消费者；§11.1 的 SHOULD log 要到 M6 组合根
  接上 logger 才算真正履行。#20 若引入 retry / pagination 诊断，应复用同一注入点，
  不要在 adapter 内部另起日志通道或 import observability。
- 显式 `token: $VAR` 未设置时**不**回落到 `GITHUB_TOKEN`（只有键缺席 / 空值才回落）。
  这是"宁可失败也不要换凭据"的选择，与 core 的 `$VAR` 展开语义刻意不同；后来的
  provider 若需要 env fallback，应各自声明，不要合并成跨 provider 约定（§6.1）。
