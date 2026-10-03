# Agent Note: Read-only observability snapshot and retry URL
Status: accepted

## Problem

M6.1（NEST-81 / #63，SPEC §13.3 / §13.5 / §17.6）需要读取 M5 单一 authority 的 runtime，但不能暴露 scheduler handles、改变累计值或把 monotonic due 当成 Unix timestamp。retry 缺 URL，而 tracker 读取不属于 projection。

## Decision

domain 拥有只读 view、snapshot/row/result/clock 契约，observability 同步白名单投影并深复制 nested rate limits。输出不 freeze，复制隔离由双向 mutation 测试验证。普通对象/数组图使用 structuredClone；特殊 mutable 容器不属于 public snapshot，失败通过稳定 unavailable 原因码隔离。

host 注入 wallNow 与 authority 同源 monotonicNow，各采样一次。UTC 只用于展示 timestamp；elapsed/retryInMs 用单调差值。snapshot seconds 是 ended cumulative 加所有 active worker elapsed（包括准备期），读 snapshot 不入账。tokens 只复制 M5 的绝对值，不重建高水位逻辑。

Owner 已批准最小 nullable URL 透传：RetryEntry / RetryScheduleRequest 加兼容的可选 issueUrl；worker outcome 读取最新 running issue URL，refresh 失败保留旧 URL，有新 issue 的 slot/dispatch 失败重排使用最新 URL，显式 null 清空。无完整 Issue 副本或 metadata cache。

observability 的 runtime dependency 仅 domain；orchestrator 的 observability 引用仅为 devDependency 集成测试。测试走真实 authority → onEvent → public applyAgentEvent 实现；受控 runner 不读取生产 AgentAttemptOptions 的配置字段，因此 options fixture 在测试中通过 unknown 转型，生产没有放宽类型。

## Alternatives considered

- tracker 补 URL、整份 Issue 留 retry 或额外 metadata cache：增加 I/O/生命周期权威，超出批准范围。
- 从 rows 汇总 tokens、读取 snapshot 时更新 seconds：破坏 M5 高水位/ended 累计口径，导致双计。
- JSON stringify 深拷贝：丢失部分值及循环图，不作为通用复制。
- deep-freeze：不是复制隔离的证据，readonly + defensive copy 已满足要求。
- 在同步 projector 加 timer：不能中断同步工作，不是真正 timeout。timeout 留未来获取层。

## Consequences

snapshot 仅描述事实，不能输入 eligibility/retry/reconciliation/continuation。URL 不改变调度 policy 或 timer ownership。复制失败只影响本次观察，返回稳定原因码不泄露 Error。logging、HTTP 和整个 §17.6 不在本任务闭环范围；M6.2 公共出口/文档需累加合并，合并后重跑双方测试。
