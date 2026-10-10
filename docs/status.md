# 实现状态

本文件是本项目**开发进度与能力的唯一总览**：当前 posture、已完成能力、deferred / optional、下一阶段与历史里程碑。

- 面向使用者的安装 / 配置 / 运行指引见根 [README.md](../README.md)；
- SPEC 逐项 capability / validation 的权威矩阵仍是 [conformance.md](conformance.md)；
- 稳定架构、组件职责与依赖方向见 [architecture.md](architecture.md)。

## 当前 posture

- 开发主线：`main`。最近合入的里程碑提交为 `e6f8e25`（PR #88，GitHub Delivery MVP.5 dogfood）。
- **M0–M6 Core 已完成**：orchestrator authority 独占调度状态，默认 CI 覆盖 Core Conformance。
- **GitHub Delivery MVP 已完成并经真实验收**：从 issue 到自动合入并关闭 issue 的闭环可用。
- **M7 §15 hardening 未开始**。
- 尚无正式 npm 发布；安装形态为源码 checkout + `npm run build`。
- 不宣称整个 SPEC 或所有 provider 场景完成——见 [deferred / optional](#deferred--optional)。

## Decision Plane extension

- NEST-99 / GitHub #94: provider-neutral v1 contracts, strict runtime validation and pure task/session/lease/binding transitions in `@symphony/domain`. Exact HEAD approval and supersession have unit evidence; [protocol](decision-protocol.md) defines persistence boundaries.
- NEST-100 / GitHub #95: durable task/session snapshot store, single-writer process lock (`store.lock`), lease coordination, and localhost Web Agent Bridge HTTP server in `@symphony/decision` and `symphony decision bridge` in `@symphony/cli`.
- NEST-101 / GitHub #96: executor adapter abstraction (`DecisionExecutorAdapter`), context strategies (`connector` vs `materialized`), machine-readable result extraction (````symphony-result` fenced JSON blocks with fail-closed last-block parsing), browser-safe entrypoint `@symphony/decision/adapter`, and deterministic `FakeDecisionExecutorAdapter`.
- NEST-102 / GitHub #97: ChatGPT Web concrete executor adapter (`ChatGptWebAdapter`), Tampermonkey tab driver (`DecisionTabDriver`), multi-turn Plan → Review SHA-A → Review SHA-B execution, broken-binding rollover (N → N+1) with durable handoff in `apps/chatgpt-web`, provider-neutral context API (`PUT/GET /v1/tasks/:id/context`), session mutual exclusion, and lease-fenced binding updates in `@symphony/decision`.
- NEST-103 / GitHub #98: SHA-bound independent review gate before auto-merge in `@symphony/domain` (`DeliveryReviewGate`), `@symphony/decision` (`DecisionReviewGate`), `@symphony/tracker` (`landPr` review verification), `@symphony/agent` (`runDeliverySkill` Phase 6 review gate loop, polling, HEAD invalidation, findings repair), and `@symphony/cli` (`symphony delivery-skill run` and `symphony pr land` review gate options).
- Plan dispatch remains separate work; delivery auto-merge is now guarded by the SHA-bound review gate.

## 已完成能力

### M0–M6 Core

- M0 / M0.5 / M0.6：monorepo、strict TS、测试与文档门禁，并与官方 SPEC 重新对齐边界；
- M1：Domain 契约、`WORKFLOW.md` loader、typed config / 默认值 / env / path resolution；
- M2：provider 无关 tracker read kernel + registry，built-in `github` profile；
- M3：workspace 确定性 provisioning、路径 containment、lifecycle hooks；
- M4：Agent Runner + Codex app-server 客户端（transport / session / continuation）；
- M5：orchestrator 状态机、polling / scheduling / reconciliation、retry / backoff；
- M6：structured logging、只读 snapshot、CLI host 装配与进程生命周期。

逐项文件、用例名与可复跑命令见 [conformance.md](conformance.md)。

### GitHub Delivery MVP（#78 / NEST-89）

在 Core 之上，把「issue → Codex → PR → CI → auto merge → close → cleanup」串成可复制的闭环：

- **workspace bootstrap**（#79 / PR #84，NEST-90）：克隆目标仓库、创建 / 复用确定性 `symphony/<workspaceKey>` issue 分支，重入安全同步且不覆盖未提交修改；
- **Codex delivery + land skill**（#80，NEST-91）：inspect → validate → commit → push → PR → CI → 有界修复 → land；
- **GitHub delivery primitives**（#81，NEST-92）：PR `ensure` / `read` / `checks` / `diagnostics` / `land` / `verify`，严格所有权与 fail-closed check 策略；
- **闭环参考 profile**（#82，NEST-93）：[`examples/github-delivery/WORKFLOW.md`](../examples/github-delivery/WORKFLOW.md)；
- **真实端到端 dogfood**（#83 / PR #88，NEST-94）：opt-in 的真实 GitHub + 真实 Codex 闭环与安全拒绝证据，运行细节见 [github-delivery-dogfood.md](github-delivery-dogfood.md)。

真实 dogfood 摘要（2026-10-05 / 2026-10-06，隔离目标仓库）：

- happy delivery：PR #12，绿 CI，自动合并并关闭 issue；
- CI 修复闭环：PR #14，真实失败 CI → Codex 修复 → 绿 → 自动合并 → issue 关闭 → workspace 清理；
- 有界重启复用：PR #17，重启前后同一 PR / 分支 / head SHA，持久化绝对 deadline 未变；
- 安全拒绝：foreign / conflict 分别返回结构化 `ownership_refusal` / `merge_rejected`，PR 保持未合并。

默认 `npm run gate` 始终 credential-free：dogfood 入口需要显式 opt-in，缺凭据显式 skip，不计为 passed。

## deferred / optional

以下能力**未实现或明确保持 optional**，不计入当前已完成范围：

- HTTP / dashboard status surface（SPEC §13.7）；
- provider-native agent tools（SPEC §11.5）；
- durable scheduler state / durable recovery；
- SSH worker（Appendix A）；
- 最终 provider-native credential / tool boundary：当前 GitHub Delivery 使用 host 的 `git` + `gh`，是显式、临时的 MVP trust boundary。

> 区分两件事：**GitHub Delivery MVP 的 `git` + `gh` 闭环已经真实验收**（#83 / PR #88）；上面 deferred 的是**未来更严格的 provider-native credential / tool boundary**，不是「本仓库尚未验证真实集成」。

## 下一阶段

- M7 §15 安全 / 运维 hardening；
- 上述 deferred / optional 能力的取舍与排期。

## 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 / M0.5 | 工程基建：monorepo、strict TS、`npm run gate`、AGENTS / docs / notes | ✅ 已完成 |
| M0.6 | 对齐官方 SPEC：固定 baseline、按 §3 重建 workspace 边界、删除协议栈 scaffold、CI + doc gate | ✅ 已完成 |
| M1 | Domain + Workflow + Config（§4、§5、§6，验收 §17.1） | ✅ 已完成 |
| M2 | Issue Tracker Adapter：read kernel / registry + built-in `github` profile（§11，验收 §17.3） | ✅ 已完成 |
| M3 | Workspace Manager：确定性 provisioning、containment、lifecycle hooks（§9，验收 §17.2） | ✅ 已完成 |
| M4 | Agent Runner：prompt 组装、子进程控制、Codex app-server session（§10、§12） | ✅ 已完成 |
| M5 | Orchestrator：状态机、polling / scheduling / reconciliation、retry（§7、§8、§14、§16） | ✅ 已完成 |
| M6 | Observability + Status Surface + CLI 装配与进程生命周期（§13、§17.7、§18.1） | ✅ 已完成 |
| GitHub Delivery MVP | issue → Codex → PR → CI → auto merge → close → cleanup 闭环（#78–#83） | ✅ 已完成 |
| M7 | 安全 / 运维 hardening（§15）、可选 SSH worker 扩展（Appendix A） | ⏳ 未开始 |

> 逐 SPEC capability 状态仍以 [conformance.md](conformance.md) 为准；本表只记录里程碑级进度，是本项目唯一的里程碑进度表。

## 文档职责

- 使用者安装 / 配置 / 运行：根 [README.md](../README.md)；
- 开发进度、deferred 与 next work：本文件；
- SPEC capability / validation： [conformance.md](conformance.md)；
- 稳定架构与边界： [architecture.md](architecture.md)；
- 开发环境与工程命令： [development.md](development.md)；
- 测试策略与可复跑入口： [testing.md](testing.md)；
- Agent / 贡献者规则： [AGENTS.md](../AGENTS.md)。
