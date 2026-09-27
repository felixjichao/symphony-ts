# Agent Note: 对齐官方 OpenAI Symphony SPEC——重校准运行时架构
Status: accepted

## Problem

M0 / M0.5 按"Agent 编排协议栈"模型建立了 scaffold：`sym/0` 消息协议、protobuf wire、可靠 UDP 传输、gateway、relay、插件注册表、`symctl`。对照官方 openai/symphony 的 `SPEC.md`（baseline `be10a1b79df723d6d7612b5651c8522704dafb2e`），官方定义的产品完全不同：一个长运行的 orchestrator，从 issue tracker 读取工作、为每个 issue 建立隔离 workspace、运行 coding agent，并负责 retry / reconciliation / observability，运行模型是 `WORKFLOW.md → Config → Issue Tracker → Orchestrator → Workspace → Agent Runner → Observability`。两个模型几乎无交集；继续沿协议栈方向演进等于在错误抽象上持续投入，M1 及以后的每个里程碑都会被带偏。

## Decision

以官方 `SPEC.md` 为唯一产品规范来源，baseline 固定为 `openai/symphony@be10a1b79df723d6d7612b5651c8522704dafb2e`（同步 / 升级规则见 [docs/upstream.md](../../../docs/upstream.md)）。删除全部与 SPEC 无对应关系的旧 scaffold（sym / proto / transport / gateway / plugins / relay / ctl / examples），由 Git 历史保留，不设 legacy 目录。按 SPEC 主组件重建 workspace 边界，owner 映射：domain（§4）、config（§3 Workflow Loader / Config Layer，§5、§6）、tracker（§3 Issue Tracker Adapter，§11）、workspace（§3 Workspace Manager，§9）、orchestrator（§3 Orchestrator，§7、§8、§14）、agent（§3 Agent Runner，§10、§12）、observability（§3 Logging / Status Surface，§13）、apps/cli（CLI / host lifecycle）。保留 M0.5 的全部工程基建（npm workspaces、strict TS、`npm run gate`、AGENTS 契约、Agent Notes、测试哲学），并补齐 CI 与轻量 doc gate。实现进度以 `docs/conformance.md` 矩阵追踪到 SPEC §17 / §18 验收项；后续每个 issue 必须标注对应 SPEC section。

## Alternatives considered

- **继续当前协议栈，把项目重新定义为自研 Agent 编排协议**：与"实现官方 SPEC"这一仓库目标相悖；需要自行发明规范与生态，而仓库名与文档又持续暗示与上游的关联，长期误导所有协作者。否。
- **保留旧 scaffold 作为 deprecated 兼容层**：当前没有生产 API、没有用户兼容负担；保留会让后续 Agent 在检索代码时继续误判 owner（"改消息模型去 sym 还是 domain？"），维护成本高于收益，历史已由 Git 完整保留。否。
- **直接按第三方 TypeScript 实现重写**：第三方实现本身是对 SPEC 的一种解读，照搬会把它的取舍与偏差一并带入，违反"不照搬第三方实现"的迁移原则；只可用于比较模块粒度与测试方式。否。

## Consequences

- 正面：SPEC section → owner package → test surface 一一映射；M1（Domain + Workflow + Config，§4 / §5 / §17.1）可以直接开工，不需要再讨论基础架构归属；文档不再把 Symphony 描述为 `sym/0` / protobuf / UDP / gateway / relay 协议栈。
- 负面 / 承诺：M0 八个包的代码与测试被整体删除，只能从 Git 历史找回；`2026-09-25-m0-scaffold` 与 `2026-09-26-ctl-gateway-access` 两条 note 随本次决策失效，移入 `notes/superseded/` 并链接本 note，原文不改写；新边界与依赖方向（见 [docs/architecture.md](../../../docs/architecture.md)）一经接受不得随手更改，调整必须先写新 Note；升级 SPEC baseline 必须单独 PR + conformance diff review。
