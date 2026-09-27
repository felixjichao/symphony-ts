# @symphony/orchestrator

## Purpose

SPEC **§7 Orchestration State Machine**、**§8 Polling, Scheduling, and Reconciliation**、**§14 Failure Model and Recovery Strategy** 的 owner 包，对应 §3 的 Orchestrator：轮询节奏、claim 集合、并发上限、dispatch 排序、retry / backoff、reconciliation，以及"单一权威 orchestrator runtime state"的维护。**修改 retry policy 的唯一落点在本包。**

## Configuration

轮询间隔、并发上限、backoff 参数等由 `@symphony/config` 产出的 typed config 提供（含 per-state 并发覆盖）；本包不自行解析 `WORKFLOW.md`。

## Extension points

- 调度 / claim / reconciliation 策略：在本包内实现，参考算法对齐 SPEC §16；
- 对 tracker / workspace / agent 的调用一律经各自公共 API；本包是唯一允许同时依赖它们的 coordination 层。

## Known limitations

- M0.6 仅建立边界，`src/index.ts` 暂无公共 API；
- 状态机、polling、retry 队列随后续里程碑落地（SPEC §7 / §8 / §14、§17）。
