# 上游基线（两条独立版本轴）

本仓库是 OpenAI Symphony 的 TypeScript 实现，唯一产品规范来源是官方仓库的 `SPEC.md`。本文记录固定的 baseline 与同步 / 升级规则；架构重校准的决策记录见 [align-with-upstream-spec note](../notes/accepted/architecture/2026-09-26-align-with-upstream-spec.md)。

仓库有**两条互不相同的版本轴**，各自的权威与升级流程分开维护：

| 版本轴 | 权威内容 | baseline |
|---|---|---|
| Symphony SPEC | orchestration / workspace / prompt / session / observability 的**语义**（组件职责、配置字段、验收项） | 见下方 [Symphony SPEC baseline](#symphony-spec-baseline) |
| Codex app-server 协议 | JSON-RPC method、payload、framing、protocol field 的**形状** | 见下方 [Codex app-server 协议基线](#codex-app-server-协议基线) |

两条轴冲突时的裁决来自 SPEC 自己（§10 "Protocol source of truth"：*"If this specification appears to conflict with the targeted Codex app-server protocol, the Codex protocol controls protocol shape and transport behavior"*）：**wire 形状以 pinned Codex schema 为准，orchestration 行为以 Symphony SPEC 为准**。决策与备选记录见 [Codex protocol baseline & agent contract note](../notes/accepted/architecture/2026-09-30-codex-protocol-baseline-and-agent-contracts.md)。

## Symphony SPEC baseline

| 项 | 值 |
|---|---|
| upstream 仓库 | https://github.com/openai/symphony |
| 规范文档 | `SPEC.md` |
| baseline SHA | `be10a1b79df723d6d7612b5651c8522704dafb2e` |
| baseline 链接 | [SPEC.md @ be10a1b](https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/SPEC.md) |
| 固定日期 | 2026-09-26（M0.6） |

## Codex app-server 协议基线

M4（Agent Runner / Coding Agent Integration）要与真实 Codex app-server 讲协议，因此单独固定一条协议基线。**代码只依赖这一条 commit 的 schema，不依赖 Codex `main` 的漂移。**

| 项 | 值 |
|---|---|
| upstream 仓库 | https://github.com/openai/codex |
| release tag | `rust-v0.159.2`（annotated tag，tag 对象 `8b9fa496bbf2c47aebd62e85a080b9a522a455b5`，tagging 日期 2026-09-29） |
| commit SHA | `ff6aec96948b70d94983af2641a6b67c94faeff5`（tag 直接指向它） |
| 固定日期 | 2026-09-30（M4.1 / #37） |
| 消费方 | `packages/agent` 的 protocol adapter / transport / runner；已固定的契约面见 [packages/agent/README.md](../packages/agent/README.md) |

### Schema source paths（pinned commit 内）

协议形状的唯一权威是 ts-rs 生成的 TypeScript schema（与 SPEC §5.3.6 提到的 `codex app-server generate-json-schema --out <dir>` 同源）。以下路径相对 `codex-rs/app-server-protocol/schema/typescript/`：

| 用途 | 文件 |
|---|---|
| 握手 | `InitializeParams.ts`、`InitializeCapabilities.ts`、`InitializeResponse.ts`、`ClientInfo.ts` |
| method 名总入口 | `ClientRequest.ts`、`ClientNotification.ts`、`ServerRequest.ts`、`ServerNotification.ts`、`RequestId.ts` |
| thread 生命周期 | `v2/ThreadStartParams.ts`、`v2/ThreadStartResponse.ts`、`v2/Thread.ts` |
| turn 生命周期 | `v2/TurnStartParams.ts`、`v2/TurnStartResponse.ts`、`v2/Turn.ts`、`v2/TurnStatus.ts`、`v2/TurnStartedNotification.ts`、`v2/TurnCompletedNotification.ts` |
| `codex.*` pass-through 的对照对象 | `v2/AskForApproval.ts`、`v2/SandboxMode.ts`、`v2/SandboxPolicy.ts`、`v2/NetworkAccess.ts` |
| usage / rate-limit 抽取 | `v2/ThreadTokenUsageUpdatedNotification.ts`（method `thread/tokenUsage/updated`）、`v2/RateLimitSnapshot.ts` |
| 旁证 | `codex-rs/app-server-protocol/schema/json/`（含 `v2/`）、`codex-rs/app-server-protocol/src/protocol/`（Rust 定义） |

### 升级规则

1. **显式变更**：升级协议基线必须**单独提 PR**，不与业务实现混在同一 PR。协议升级不得随本机 `codex` 版本升级静默发生——本机装了哪个 Codex 与本仓库无关。
2. **重新取 schema**：在新 commit 上重新读上表全部 source paths（或跑 `codex app-server generate-json-schema --out <dir>`），逐字段 diff `initialize` / `thread/start` / `turn/start` / turn 完成语义 / `ServerRequest` 清单。
3. **分层落点**：wire 形状的漂移只允许改 `packages/agent` 的 protocol adapter / transport 层。只有当漂移改变了 `codex.approval_policy` / `codex.turn_sandbox_policy` 的**形状类别**（例如从 string 变成 object），才需要同时改 `@symphony/domain` 的 `CodexPassThroughValue` 与 `@symphony/config` 的 pass-through 校验；单纯枚举成员增减**不改** Symphony 类型（SPEC §5.3.6 SHOULD：不手维枚举）。
4. **同步文档与门禁**：更新本节 tag / commit、[packages/agent/README.md](../packages/agent/README.md) 的基线小节、[conformance.md](conformance.md) 的 §10 / §17.5 行，并跑 `npm run gate`——`packages/agent` 的结构断言会守住"公共类型不复制 Codex generated schema"这条线。

### 审查记录（Assessment Notes）

- **2026-10-04（NEST-88 / #75）**：对 upstream release `rust-v0.160.0`（tag 对象 `79b1b666f2e8551f8abbbca34957227f67f3f553`，commit `a956835d020762cb2b570053af06f643a11c0ecc`）完成逐层协议 diff。结论：**No migration required**。`codex-rs/app-server-protocol` 目录 Git Tree SHA 完全一致（`01988e423904843f6b005fa640750aa3cd7b97b6`），24 项必查 schema surface 零漂移（zero enum/shape/method/lifecycle/usage drift）；`rust-v0.160.0` 带来的 app-server 变更仅限于内部 stderr logging span events 和 running turn count 增量统计，对 wire shape 无影响。继续保持 pinned `rust-v0.159.2`。完整证据详见 [2026-10-04-codex-protocol-drift-assessment-0.160.0 note](../notes/accepted/architecture/2026-10-04-codex-protocol-drift-assessment-0.160.0.md)。

## 规则

1. **SPEC 优先**：现有代码 / 文档与官方 SPEC 冲突时，以固定 baseline 的 `SPEC.md` 为准。上游参考实现与任何第三方 TypeScript 实现只用于设计对照（比较模块粒度、测试方式），不构成规范。
2. **不复制规范 / 不 vendoring schema**：不把 SPEC 全文抄进本仓库，避免形成第二份会漂移的规范；文档只引用 section 编号（如 `SPEC §4`）。同一条纪律适用于 Codex schema：上表给的是**路径 + commit**，不是拷进仓库的副本，只摘录"为什么形状必须这样"所必需的少量证据。实现进度与 SPEC §17 / §18 验收项的映射维护在 [conformance.md](conformance.md)。
3. **升级流程**：升级 baseline 必须**单独提 PR**，附 upstream diff 与对 [conformance.md](conformance.md) 的逐行 review；不得与业务实现混在同一个 PR。
4. **标注 section**：后续每个新增实现的 issue / PR 必须标注对应 SPEC section，避免再次形成平行架构。
