# Agent Note: symctl 访问网关的路径——M5 起经 transport/proto 直连
Status: accepted

## Problem

`packages/ctl/README.md` 曾写"交互经 transport 直连网关"，但 ctl 的 `package.json` 依赖只有 `@symphony/sym`，根 `AGENTS.md` 与 `docs/architecture.md` 也记录 `ctl` 只依赖 `sym`——三处文档对 M5 是否允许引入 transport 依赖互相矛盾（PR #2 review 指出）。symctl 对齐上游 `symphony ctl --gateway <addr>`：它本身是一个**普通 Agent 客户端**，要提供 list / send / spawn / inspect，必须能经网络收发消息。

## Decision

定死契约：ctl 以普通 Agent 客户端身份直连网关。M0 阶段依赖保持只有 `@symphony/sym`（参数解析 + 消息模型已够用）；**M5 实现交互时允许新增 `@symphony/transport`（收发数据报）与 `@symphony/proto`（信封编解码）两个依赖，除此之外不新增跨包依赖，且永不依赖 `@symphony/gateway`**——ctl 与网关是协议对端，客户端不得 import 服务端实现。`packages/ctl/README.md`、`AGENTS.md`、`docs/architecture.md` 已同步该表述；M5 落地时在 ctl 的 `package.json` 声明依赖并同步 lockfile。

## Alternatives considered

- **允许 ctl 依赖 `@symphony/gateway` 复用其客户端逻辑**：把服务端实现拉进 CLI，依赖方向倒置（终端工具与服务器是对端而非上下游），且违背 M0 定下的依赖表。否。
- **网关另加独立管理面（如 HTTP admin API），ctl 走管理面**：需要发明第二套协议边界，与上游"ctl 就是普通 Agent"的设计不符，M5 前无从验证收益。否——若将来确需非 Agent 管理面，另行提案取代本条。
- **保持 sym-only，transport 由使用方运行时注入**：CLI 没有"使用方注入"场景，类型契约落空，M5 实现与测试都被迫绕路。否。

## Consequences

- 正面：四处文档（ctl README / AGENTS / architecture / 本 note）口径一致，M5 无需再议依赖边界，直接声明 `transport`/`proto` 即可开工。
- 负面 / 承诺：ctl 依赖面将在 M5 扩大，集成时注意 lockfile 与根 tsconfig `paths` 同步；"永不依赖 gateway"作为长期约束接受 review 监督；若 M5 实际发现需要管理面而非 Agent 直连，先写新 note 取代本条再动代码。
