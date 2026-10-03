# @symphony/observability

## Purpose

SPEC §13.3 / §13.5 的同步只读 runtime snapshot projection；领域契约来自 `@symphony/domain`。

## Configuration

```ts
import { projectObservabilitySnapshot, tryProjectObservabilitySnapshot } from "@symphony/observability";

const clock = { wallNow: hostWallNow, monotonicNow: authorityMonotonicNow };
const snapshot = projectObservabilitySnapshot(runtimeState, clock);
const result = tryProjectObservabilitySnapshot(runtimeState, clock);
```

host 注入双时钟，monotonic 必须与 authority 同源。每次各采样一次；`generatedAt` / running `startedAt` / last event timestamp 是 UTC epoch ms，elapsed 与 `retryInMs` 是单调时钟差值（负值归零）。不输出 raw retry due 或 wall-clock due。

## Extension points

公共 API 导出 domain 的 `ObservabilitySnapshot`、running/retry rows、`ObservabilityRuntimeView`、`SnapshotClock` 与 `SnapshotResult`。真实 runtime state 可直接满足只读 view，view 排除 worker/timer handles。row 按 issueId 字典序排列；首跑 attempt 为 null；session 未建立时 session 派生字段、turnCount、tokens 均为 null。aggregate tokens 直接复制累计值；secondsRunning 加入所有活跃 worker elapsed，不回写累计值。

输出通过 readonly 类型约束使用方，并完全复制数组、row、tokens、totals 和 nested rate-limit payload；不额外 freeze，运行时修改副本不会改变 state。rate-limit payload 使用 structuredClone，保留普通对象/数组图（含重复引用和循环）；拒绝函数与 Map/Set/Date 等特殊容器，不返回共享引用。try 入口将时钟/复制失败收敛为 `unavailable` + `projection_failed`；null runtime 为 `runtime_unavailable`，空 runtime 是成功。

运行 `npm test -w @symphony/observability`；真实 authority 集成入口为 `npm test -w @symphony/orchestrator -- src/observability-integration.test.ts`。

## Known limitations

同步入口没有获取层 timeout；timeout 留未来异步/远程获取层。HTTP/dashboard 属于可选扩展。projection 不做 tracker/fs/network I/O、不 await、不参与调度。跨包决定见 [snapshot note](../../notes/accepted/architecture/2026-10-03-observability-snapshot.md)。

## Structured logging (§13.1 / §13.2)

```ts
import { createStructuredLogger } from "@symphony/observability";
const logger = createStructuredLogger(); // default stderr, injectable sinks
logger.registerSecrets([trackerToken]); // before potentially failing operations
logger.emit({ scope: "issue", severity: "info", event: "dispatch_committed",
  outcome: "started", issue_id: issue.id, issue_identifier: issue.identifier });
logger.close();
```

`emit` never throws. Issue/session unions enforce required context; unknown manual retry identifier is null. Scalar whitelist fields render in fixed `key=value` order with JSON quoting and explicit nulls. No provider/protocol objects, Error/cause/stack, hook output or AgentEvent.summary enter default composition logs. Register raw/resolved tracker secret values and declared env values before candidate construction/validation, retaining previous secrets for running workers. Initial validation uses fixed reasons only.

Redaction precedes escaped UTF-8 truncation: reason 128 bytes, message 896, error 1024, stderr 2048; core/context strings at most 4096 escaped bytes and never silently truncated. Overbudget raw text is omitted; invalid/oversized context yields fixed `logging_format_failed` with null identity keys. A throwing sink cannot prevent delivery to other sinks; one `logging_sink_failed` warning reaches remaining sinks, with no recursion. Default stderr also isolates asynchronous stream errors and drops subsequent lines while backpressured, resuming on drain without a private queue. `renderStructuredLogEvent` is the lower-level throwing renderer without registered secrets; use logger.emit for runtime output.

§13.6 richer humanization is conditional/deferred. CLI helpers adapt runtime ports; production host/signal entrypoints now use the same observers and are covered by M6.3–M6.5. See [logging note](../../notes/accepted/architecture/2026-10-03-structured-logging.md).

## M6 Core host evidence

`npm test -w @symphony/cli -- src/bin.test.ts` verifies `rejects %s startup preflight with nonzero safe diagnostics`, issue/session identity in `waits for agent termination and after_run on %s, deduplicating mixed signals`, and operator-visible recoverable reload in `keeps live invalid reload recoverable, applies valid reload to a new real agent, and stops both roots`. Snapshot, token/rate-limit aggregation and sink-isolation files, exact case names and commands are indexed in [M6 Core conformance](../../docs/conformance.md#m65-core-证据索引). Runtime facts remain read-only observer inputs; snapshots/log lines are never scheduler authority or a fatal-error channel. Host supplies an independent failure promise to the shell.

M6 Core implementation evidence is ready; completion still requires all five submilestones merged and main CI success. HTTP §13.7 and richer §13.6 humanization remain optional/conditional; synchronous snapshot timeout is not applicable to this local projector. These fixtures do not establish §17.8 external Real Integration.
