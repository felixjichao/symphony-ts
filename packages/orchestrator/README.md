# @symphony/orchestrator

## Purpose

SPEC **§7 Orchestration State Machine**、**§8 Polling, Scheduling, and Reconciliation**、**§14 Failure Model and Recovery Strategy** 的 owner 包，对应 §3 的 Orchestrator：轮询节奏、claim 集合、并发上限、dispatch 排序、retry / backoff、reconciliation，以及"单一权威 orchestrator runtime state"的维护。**修改 retry policy 的唯一落点在本包。**

M5.1 已落地**纯调度内核**（无副作用）：`createOrchestratorRuntimeState()` 初始化单一权威 runtime state；`DispatchPolicy` + eligibility 纯函数负责 active / terminal state、required-label matching、`issue_routable`、dispatch eligibility、claim / running gating、global / per-state 并发 slot；`sortForDispatch()` 实现 §8.2 stable sort；`backoff.ts` 提供 continuation / failure retry 的纯数学延迟。该内核不 fetch tracker、不 spawn worker、不调用 workspace cleanup、不解释 agent / Codex 协议。

## Configuration

轮询间隔、并发上限、backoff 参数等由 `@symphony/config` 产出的 typed config 提供（含 per-state 并发覆盖）；本包不自行解析 `WORKFLOW.md`。只有"当前生效"的 `pollIntervalMs` 与 `maxConcurrentAgents` 驻留在 runtime state 上；active / terminal states、required labels、per-state 并发上限、`max_retry_backoff_ms` 等由每 tick 的 effective config 以 `DispatchPolicy` / 纯函数参数传入，因此 reload 后自然采用新值。

## Extension points

- 调度 / claim / reconciliation 策略：在本包内实现，参考算法对齐 SPEC §16；
- 对 tracker / workspace / agent 的调用一律经各自公共 API；本包是唯一允许同时依赖它们的 coordination 层；
- 新增 `packages/orchestrator` 实现时同步更新 [docs/conformance.md](../../docs/conformance.md) 的 §7 / §8 / §14 行。

## Known limitations

- M5.1 只交付纯逻辑：dispatch 写路径、worker 生命周期、claim 转移、retry 队列 / timer、reconciliation、poll loop、config re-apply 与跨包端到端 conformance 随后续 M5 子任务落地（SPEC §7 / §8 / §14、§17.4）；
- runtime state 是 in-memory only（§14.3）：不提供 durable scheduler DB 或跨重启恢复。
