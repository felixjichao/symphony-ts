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

同步入口没有获取层 timeout；timeout 留未来异步/远程获取层。structured logging 属于 M6.2，HTTP/dashboard 属于可选扩展。projection 不做 tracker/fs/network I/O、不 await、不参与调度。跨包决定见 [snapshot note](../../notes/accepted/architecture/2026-10-03-observability-snapshot.md)。
