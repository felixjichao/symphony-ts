# @symphony/operations

## Purpose

Operational Read Model / Observation Plane 的公共边界（NEST-113 / GitHub #109，父任务 #108 的首个实现分片）。本包**只提供只读事实与投影契约**：把 GitHub、orchestrator runtime、Decision Plane、executor 观测归一化为 provider-neutral facts，再由未来 projector 推导 phase / waiting / attention 等展示语义。

它**不是** Control Plane：不读取实时状态、不推导、不做异常检测、不提供查询服务、不暴露 HTTP / Dashboard / SSE / WebSocket，也不提供任何写回 GitHub / Decision Store / orchestrator 的路径。领域契约的唯一权威是 `@symphony/domain`；本包只做面向 operational consumers 的重导出与后续实现的落点。

## Public API

契约全部定义在 `@symphony/domain` 的 `operations` 扩展（`packages/domain/src/operations*.ts`），本包重导出：

```ts
import {
  githubWorkKey, parseWorkKey, formatWorkKey, isExactHeadSha, parseReviewTarget,
  WORK_PHASES, WAITING_REASONS, ATTENTION_STATES, SYSTEM_HEALTH_STATES,
  OPERATIONAL_SNAPSHOT_SCHEMA_VERSION,
  type WorkKey, type GitHubWorkFacts, type RuntimeWorkFacts, type DecisionWorkFacts,
  type ExecutorFacts, type WorkProjection, type OperationalSnapshot,
  type SourceFreshness, type ReviewProjection,
} from "@symphony/operations";
```

关键语义：

- **WorkKey**：以 GitHub Issue 为 semantic root 的稳定身份（`{ provider: "github", key: "owner/repo#N" }`），复用 Decision root 的 canonical 校验；PR、executor session、host、workspace 都不是身份。
- **Facts**：GitHub / runtime / Decision / executor 四类独立 readonly DTO，显式挑选字段，不透传 provider API 对象、store record、lease token、DOM 或 executor handle。
- **Provenance**：每份 facts 携带 `FactProvenance`（source kind、instance、observedAt），支持后续 freshness 与 explainability。
- **Freshness**：`fresh / stale / unavailable / unknown` 为判别联合，语义互不混同；成功读到“无 PR / 无 session”用 `null` 表达，与读取失败（`unavailable`）区分。
- **WorkProjection / OperationalSnapshot**：面向消费者的只读投影与系统级快照；携带 per-source freshness，支持 partial source failure。
- **Review 语义**：`ReviewProjection` 分别保留 `currentHeadSha`、`taskTarget`、`result` 的精确 target；旧 SHA 的 approve 只能作为历史事实（`approved_stale_head`），绝不表示当前 HEAD 已获批。
- **Derived-only**：`WorkPhase` / `WaitingReason` / `AttentionState` / `SystemHealth` 明确是派生展示概念，没有 setter / transition / 调度接口；`phase` 与 `attention` 正交。

## Extension points

后续 source reader 与 projector 在本包实现，允许**单向**读取 `@symphony/domain` 以及相应源包；源包（`orchestrator` / `decision` / `tracker` / `agent`）**不得**反向 import `@symphony/operations`。Dependency 方向固定为 `operations → domain`。

## Known limitations

本分片仅定义契约：没有 live 读取、没有推导函数、没有异常检测、没有 query service、没有 transport。freshness 阈值、phase 优先级、health / summary 计算、anomaly 判定与 CLI / Dashboard 接线均属于后续分片。跨包边界决定见 [operations contracts note](../../notes/accepted/architecture/2026-10-11-operational-read-model-contracts.md)。

运行 `npm test -w @symphony/operations`（边界守卫）；契约形状测试见 `npm test -w @symphony/domain`。
