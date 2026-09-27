# @symphony/observability

## Purpose

SPEC **§13 Logging, Status, and Observability** 的 owner 包，对应 §3 的 Logging 与 Status Surface：结构化事件日志（路由到配置的 sink，保留 issue id / attempt 等关键标识符）、对 orchestrator runtime state 的**只读** snapshot 消费、面向操作者的人类可读状态出口（可选 dashboard / HTTP surface）。

## Configuration

日志 sink 与级别、状态出口开关由 `@symphony/config` 产出的 typed config 提供。

## Extension points

- 新 sink / 状态出口：实现本包的消费接口，读取 runtime snapshot contract；
- snapshot contract 的字段扩展属于跨包契约变更：附 Agent Note，并与 `@symphony/orchestrator` 的 state 定义同步。

## Known limitations

- M0.6 仅建立边界，`src/index.ts` 暂无公共 API；
- 结构化日志与状态出口随后续里程碑落地（SPEC §13、§17）；
- 边界约束：**只读**——永不回写 orchestrator 状态，也不得被 tracker / agent 用作调度旁路。
