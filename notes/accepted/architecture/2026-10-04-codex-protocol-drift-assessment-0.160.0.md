# Agent Note: Codex Protocol Drift Assessment against rust-v0.160.0
Status: accepted

## Problem

本仓库在 M4.1（#37）确立了与外部协议交互的架构规范，将 Codex app-server 协议基线固定在 `openai/codex@rust-v0.159.2`（commit `ff6aec96948b70d94983af2641a6b67c94faeff5`）。根据 [docs/upstream.md](../../../docs/upstream.md) 与 [codex-protocol-baseline-and-agent-contracts note](2026-09-30-codex-protocol-baseline-and-agent-contracts.md) 确立的纪律：
1. 仓库实现代码只依赖 pinned baseline，不得随本机 `codex` 二进制或 Codex `main` 静默漂移；
2. 升级协议必须基于 upstream release 进行逐层 schema diff，区分形状类别漂移与内部实现变化；
3. 本任务（NEST-88 / symphony-ts#75）作为 post-M6 维护性 protocol drift assessment，需对 upstream 正式 release `rust-v0.160.0` 进行逐层协议审查，评估是否发生 breaking / behaviorally relevant 漂移，并给出明确结论（A. No migration required 或 B. Migration required）。

## Decision

评估结论：**A. No migration required**。保持当前 pinned 基线 `rust-v0.159.2`（`ff6aec96948b70d94983af2641a6b67c94faeff5`），不修改生产运行时代码。

### 1. 协议树哈希与逐层 Schema Diff 证据

对比基线 `rust-v0.159.2`（tag `8b9fa496bbf2c47aebd62e85a080b9a522a455b5`，commit `ff6aec96948b70d94983af2641a6b67c94faeff5`）与目标 `rust-v0.160.0`（tag `79b1b666f2e8551f8abbbca34957227f67f3f553`，commit `a956835d020762cb2b570053af06f643a11c0ecc`）：

- **协议总目录树哈希**：`codex-rs/app-server-protocol` 在两个版本中的 Git Tree SHA 均为 `01988e423904843f6b005fa640750aa3cd7b97b6`。在 Git Merkle tree 保证下，该目录下所有 TypeScript schema、JSON schema 及 Rust protocol 源码**完全一致，零字节差异**。
- **必查 Schema Surface 逐项比对**（路径相对 `codex-rs/app-server-protocol/schema/typescript/`）：
  - **握手层（Handshake）**：
    - `InitializeParams.ts`：blob `e48c5ee7b5`（无变化）
    - `InitializeCapabilities.ts`：blob `ac82d743e3`（无变化）
    - `InitializeResponse.ts`：blob `f1f79d173c`（无变化）
    - `ClientInfo.ts`：blob `33339b6b20`（无变化）
  - **Method / notification envelopes**：
    - `ClientRequest.ts`：blob `5e3fb8c915`（无变化）
    - `ClientNotification.ts`：blob `8ce2839108`（无变化）
    - `ServerRequest.ts`：blob `89a5440056`（无变化）
    - `ServerNotification.ts`：blob `360f971862`（无变化）
    - `RequestId.ts`：blob `8a771bd021`（无变化）
  - **Thread 生命周期**：
    - `v2/ThreadStartParams.ts`：blob `69280c0b38`（无变化）
    - `v2/ThreadStartResponse.ts`：blob `c4ff08409c`（无变化）
    - `v2/Thread.ts`：blob `9a0f865d7b`（无变化）
  - **Turn 生命周期**：
    - `v2/TurnStartParams.ts`：blob `b5f5321916`（无变化）
    - `v2/TurnStartResponse.ts`：blob `cc2ee3772a`（无变化）
    - `v2/Turn.ts`：blob `e804fa974c`（无变化）
    - `v2/TurnStatus.ts`：blob `476922edc2`（无变化）
    - `v2/TurnStartedNotification.ts`：blob `34f71b2465`（无变化）
    - `v2/TurnCompletedNotification.ts`：blob `e1b151bfa7`（无变化）
  - **Pass-through policy shapes**：
    - `v2/AskForApproval.ts`：blob `1d605501b2`（无变化）
    - `v2/SandboxMode.ts`：blob `b8cf4326b9`（无变化）
    - `v2/SandboxPolicy.ts`：blob `5575701ff2`（无变化）
    - `v2/NetworkAccess.ts`：blob `7b697b2314`（无变化）
  - **Usage / rate limits**：
    - `v2/ThreadTokenUsageUpdatedNotification.ts`：blob `1be282500c`（无变化）
    - `v2/RateLimitSnapshot.ts`：blob `4740f38da0`（无变化）

### 2. 漂移分类判定

| 漂移类别 | 判定结论 | 详细说明 |
|---|---|---|
| enum member drift | **无** | `AskForApproval`、`SandboxMode`、`SandboxPolicy`、`TurnStatus` 等全部枚举/联合类型成员无增减 |
| shape/category drift | **无** | pass-through policy 形状类别（string vs tagged object）保持不变，无需调整 `@symphony/domain` 类型 |
| method rename/add/remove | **无** | `ClientRequest`、`ClientNotification`、`ServerRequest`、`ServerNotification` 方法集合与 JSON-RPC 签名完全一致 |
| lifecycle semantics drift | **无** | `initialize` → `initialized` → `thread/start` → `turn/start` → `turn/completed` 的状态机流转与通知时序无变化 |
| usage/rate-limit drift | **无** | `thread/tokenUsage/updated` payload 与 `RateLimitSnapshot` 结构保持不变 |

### 3. Upstream app-server 内部实现差异审查

`codex-rs/app-server` 仅有两处内部优化与修复，均不触及协议或 wire 行为：
1. `codex-rs/app-server/src/thread_status.rs`：`running_turn_count` 在 `ThreadWatchState` 发生变化时进行增量维护，替代了原先每次持锁遍历全部 runtimes 的计算，减少锁持有时间。
2. `codex-rs/app-server/src/lib.rs` 及 `stderr_logging_tests.rs`：tracing stderr 日志的 span events 从 `FmtSpan::FULL` 调整为 `FmtSpan::NEW | FmtSpan::CLOSE`，避免 SQLx 在未 drain stderr 时因持锁而出现 worker stall。

### 4. 影响与兼容性结论

- 当前 `packages/agent` 的 protocol adapter、JSON-RPC transport 及 runner 逻辑完全兼容；
- `@symphony/domain` 的 `CodexPassThroughValue` 与 `@symphony/config` 的 JSON-safety 校验完全适用，无需变更；
- 协议层无漂移，无需升级 baseline；在 [docs/upstream.md](../../../docs/upstream.md) 记录审查结论。

## Alternatives considered

1. **直接升级 pinned baseline 到 `rust-v0.160.0`**：否掉。`docs/upstream.md` 明确规定升级 baseline 必须单独提 PR 且应有实际收益。鉴于 `codex-rs/app-server-protocol` 在两个版本中完全相同（Tree SHA 完全一致），升级 commit SHA 不会带来任何契约变化，反而会产生无意义的版本颠簸。
2. **提前扩充 `CodexPassThroughValue` 或 pass-through 规则**：否掉。根据 SPEC §5.3.6 与既有决策，只有当 upstream 协议的形状类别发生实质改变时才调整领域类型，不做投机性投宽。
3. **将本地环境安装的 `codex` 版本作为事实来源**：否掉。仓库严格遵守“本机装了哪个 Codex 与本仓库无关”的不变量，协议权威唯独来自 git commit 中 ts-rs 生成的 schema 路径。

## Consequences

- 保持当前基线 `rust-v0.159.2`（`ff6aec96948b70d94983af2641a6b67c94faeff5`）；
- 不修改任何生产代码与运行时类型；
- 在 [docs/upstream.md](../../../docs/upstream.md) 记录对 `rust-v0.160.0` 的审查通过条目与归档依据；
- 本次 assessment 不对后续 M7 或其他业务里程碑产生破坏性影响。
