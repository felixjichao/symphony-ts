# @symphony/operations

## Purpose

Operational Read Model / Observation Plane 的公共边界（NEST-113 / GitHub #109，NEST-114 reader、NEST-115 确定性 projector，以及 NEST-116 跨源异常检测与投影解释，对应父任务 #108 观察面）。本包提供只读事实与投影契约、四源 reader 与单次 collector、纯函数确定性 projector，以及跨源异常检测：把 GitHub、orchestrator runtime、Decision Plane、executor 观测归一化为 provider-neutral facts，并纯函数推导 phase / waiting / attention / snapshot 等展示语义与 8 类领域异常。

它**不是** Control Plane：纯只读推导、零 I/O、无全局时钟或变异 API、不提供查询服务（保留给 NEST-117）、不暴露 HTTP / Dashboard / SSE / WebSocket，也不提供任何写回 GitHub / Decision Store / orchestrator 的路径。领域契约的唯一权威是 `@symphony/domain`；本包提供面向 operational consumers 的重导出、只读采集、纯读投影与异常检测。

## Public API

契约全部定义在 `@symphony/domain` 的 `operations` 扩展（`packages/domain/src/operations*.ts`），本包重导出：

```ts
import {
  githubWorkKey, parseWorkKey, formatWorkKey, isExactHeadSha, parseReviewTarget,
  WORK_PHASES, WAITING_REASONS, ATTENTION_STATES, SYSTEM_HEALTH_STATES,
  OPERATIONAL_ANOMALY_CODES, OPERATIONAL_ANOMALY_CATALOG, PROJECTION_EVIDENCE_ROLES,
  OPERATIONAL_SNAPSHOT_SCHEMA_VERSION,
  type WorkKey, type GitHubWorkFacts, type RuntimeWorkFacts, type DecisionWorkFacts,
  type ExecutorFacts, type WorkProjection, type OperationalSnapshot,
  type SourceFreshness, type ReviewProjection, type OperationalAnomaly,
  type OperationalAnomalyCode, type ProjectionEvidence, type ProjectionEvidenceRole,
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

source reader 与 deterministic projector 均已在本包实现，允许**单向**读取 `@symphony/domain` 以及相应源包；源包（`orchestrator` / `decision` / `tracker` / `agent`）**不得**反向 import `@symphony/operations`。生产依赖保持 `operations → domain`；Decision、observability、tracker 是真实入口测试的 devDependencies。

## Readers

四类工厂 `createGitHubReader`、`createRuntimeReader`、`createDecisionReader`、`createExecutorReader` 接收 `ReaderOptions`（instance、clock、maxAgeMs）和只读来源 port；`collectOperationFacts` 等待所有源完成，返回独立 facts/freshness envelope。来源故障为 unavailable，未配置为 unknown，成功空集合与缺失对象分别为 [] / null。旧 snapshot/inventory 保留原 observedAt，阈值边界（age <= maxAgeMs）为 fresh。

```ts
const readers = {
  github: createGitHubReader(policy.github, () => delivery.observeWork(context)),
  runtime: createRuntimeReader(policy.runtime, () => host.snapshot()),
  decision: createDecisionReader(policy.decision, () => decision.observeWork(workKey)),
  executor: createExecutorReader(policy.executor, null),
};
const facts = await collectOperationFacts(readers);
```

GitHub `context` 必须是可信 DeliveryContext，已知 PR 可传 `{ prNumber }`；否则完整分页按机器 marker 查关联，不按标题猜测。CI 仅表示 observed rollup，不表示 merge authorization。Runtime 用已有 SnapshotResult，允许按 issueId 注入可信 scope mapping，无法关联的行保留 workKey=null。Decision 必须是宿主已打开的 service，不触发 lease 清理。Executor port 须报告独立 inventory 时间；没有显式 heartbeat/status 时为 null/unknown，不使用 lease 或 Codex 事件冒充。

## Projectors

纯函数推导层（NEST-115 / #111）：无副作用、无 I/O、无全局时钟调用，将归一化 facts 转化为面向消费者的展示投影：

```ts
import {
  deriveWorkPhase, deriveWaitingReason, deriveAttention, deriveReviewProjection,
  projectWork, projectExecutor, deriveSystemHealth, deriveSnapshotSummary,
  projectOperationalSnapshot,
} from "@symphony/operations";

const work = projectWork({ collection, workKey });
const snapshot = projectOperationalSnapshot({ generatedAt, work: [work], sources, executors: [] });
```

- **Phase 推导**：以 fresh GitHub 终态优先得到 `completed`；活动执行按前置 CI failure / `changes_requested` 识别为 `repair` 或 `coding`；`landing` 严格要求 open PR + exact HEAD CI success + `approved_current_head`；GitHub 故障或 stale 时安全降级为 `unknown`。
- **Review 安全**：精确比较 HEAD SHA（40 字符小写十六进制）；对历史 SHA 的 approve 保留为 `approved_stale_head`，不推出当前 HEAD 获批。
- **正交性**：`WorkPhase` 与 `AttentionState` 正交。`completed` 清除 waiting，但来源健康问题独立通过 `degraded` attention 呈现。
- **System Health & Summary**：Summary 计数器（active, waiting, retrying, needsHuman）为正交交叉统计；系统健康度区分 `healthy`、`degraded`、`unavailable`、`unknown`，无可用来源且有明确失败报告 `unavailable`。
- **确定性与无写回**：输入数组无论换序与否产生逐字节一致的输出，禁止任何 `setWorkPhase` / `setWaitingReason` 等写回突变。

## Anomalies and Explanations

跨源异常检测与投影解释（NEST-116 / #112）：基于规范化 facts 进行纯函数异常扫描，输出机器可读的结构化证据（`ProjectionEvidence` breadcrumbs）：

```ts
import {
  detectWorkAnomalies, detectCollectionAnomalies, hasWorkAnomalies,
  projectWorkWithAnomalies,
} from "@symphony/operations";

const workAnomalies = detectWorkAnomalies({ collection, workKey, detectedAt });
const allAnomalies = detectCollectionAnomalies({ collection, detectedAt });
const work = projectWorkWithAnomalies({ collection, workKey, detectedAt });
```

- **8 类领域异常**：
  1. `review_target_head_mismatch` (`warning`)：Review 任务 target SHA 与 GitHub PR 当前 HEAD 不一致。
  2. `review_approval_head_mismatch` (`error`)：Decision 批准的 commit 与当前 PR HEAD 不一致。
  3. `review_result_target_mismatch` (`error`)：Decision 结果 commit 与任务声明的 target 不一致。
  4. `execution_on_terminal_work` (`warning`)：Issue 已 closed 或 PR 已 merged，但 runtime 仍处于 running / claimed。
  5. `decision_active_task_without_session` (`error`)：活动任务关联的 session 不存在。
  6. `decision_active_task_on_completed_session` (`error`)：活动任务所属 session 已处于 completed 终态。
  7. `decision_result_without_task` (`error`)：Decision 结果对应的 task 不存在。
  8. `conflicting_active_review_tasks` (`error`)：同一 workKey 下存在多个并发处于 active 状态的 review tasks。
- **证据与解释性面包屑**：每个异常携带结构化 `evidence` 数组（`source`, `role`, `workKey`, `taskId`, `revision`, `target`, `headSha`, `field`, `value`），供下游解释工具准确定位根因。
- **安全守卫**：缺失、stale 或 unavailable 的源安全略过，绝不产生误报领域异常。
- **联动降级**：存在异常时，`deriveAttention` 降级为 `degraded`（保留 `needs_human` / `failed` 优先级）；`deriveSystemHealth` 不得为 `healthy`。

## Known limitations

没有持久缓存、后台轮询、source timeout wrapper、query service（NEST-117）或 transport。底层 port 负责预算、取消与收尾；默认 gh runner 有有界 subprocess timeout。四源不是原子快照。当前没有统一 executor inventory，宿主未接入时应使用 null port。架构决定见 [source readers note](../../notes/accepted/architecture/2026-10-13-operational-source-readers.md)、[deterministic projectors note](../../notes/accepted/architecture/2026-10-14-deterministic-work-and-system-projectors.md) 与 [anomaly detection note](../../notes/accepted/architecture/2026-10-15-cross-source-anomaly-detection-and-projection-explanations.md)。

运行 `npm test -w @symphony/operations`（真实 Decision / snapshot 采集、推导器、异常检测与边界），`npm test -w @symphony/tracker -- src/github/operations-observation.test.ts`（只读 GitHub 归一化）；共享契约测试见 `npm test -w @symphony/domain`。
