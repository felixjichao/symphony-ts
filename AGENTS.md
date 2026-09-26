# AGENTS.md — Standing Orders

symphony-ts：用 TypeScript 重实现 OpenAI Symphony（Agent 编排协议 + 运行时）。当前里程碑 **M0（脚手架）**——monorepo 骨架与类型骨架已就绪；wire 协议（M1）、可靠传输（M2）等按 [docs/architecture.md](docs/architecture.md) 的里程碑推进。本文件只放 standing orders；详细内容一律看文末"文档导航"。

## Command Matrix

| 目的 | 命令 |
|---|---|
| 安装（CI / 干净环境） | `npm ci` |
| 安装（增删依赖后） | `npm install` |
| 类型检查（strict tsc，noEmit） | `npm run typecheck` |
| 全仓测试（vitest） | `npm test` |
| 单个 workspace 测试 | `npm test -w @symphony/sym` |
| 静态检查 | `npm run lint` |
| 一键门禁（typecheck + test + lint） | `npm run gate` |

npm 是唯一 canonical 包管理器（npm workspaces + `package-lock.json`）。不要引入 pnpm/yarn，不要提交第二份 lockfile。要求 Node >= 20。

## Working Rules

1. 修改前先定位所属 workspace（见下方扩展点表），在该包内改代码、补该包的测试。
2. 本地跑最小相关检查（受影响 workspace 的 `test` + 根 `typecheck`）；提交前 / CI 跑全量 `npm run gate`。
3. 不跨包复制协议或类型定义——先确认 owner package（wire 消息模型的唯一权威是 `@symphony/sym`），跨包只 import，不重声明。
4. 架构 / 选型 / 跨包契约的决策要写 Agent Note（流程与模板见 [notes/README.md](notes/README.md)）；`## Alternatives considered` 为强制小节，不允许空标题。
5. TypeScript 严格模式（`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`）；不要为过编译加 `any` / `@ts-expect-error`，除非 Note 中记录理由。
6. 包间 import 走包名（如 `@symphony/sym`），由根 `tsconfig.base.json` 的 `paths` 映射到各包 `src`；不要写跨包相对路径。

## Where New Behavior Goes

| 你要新增 / 修改… | 去这里 |
|---|---|
| wire / message schema、协议常量 | `packages/sym` |
| 编解码 / 转码（JSON → protobuf/CBOR） | `packages/proto` |
| 传输与可靠性（UDP / WS、握手、重传、分片） | `packages/transport` |
| 编排 / 路由、网关行为（认证、连接管理） | `packages/gateway` |
| 插件 / 集成（mdns、a2a、workspace、registry…） | `packages/plugins` |
| relay / 多网关联邦 / L4 转发 | `packages/relay` |
| CLI / 控制面（symctl） | `packages/ctl` |
| 可运行示例 | `apps/examples` |

依赖方向（下游可依赖上游，反向禁止）：
`sym` ← `transport` / `proto` ← `plugins` ← `gateway` ← `apps/examples`；`relay` 只依赖 `transport`；`ctl` 当前只依赖 `sym`，M5 起允许加 `transport` / `proto` 以直连网关，永不依赖 `gateway`（决策见 [notes/accepted/architecture/2026-09-26-ctl-gateway-access.md](notes/accepted/architecture/2026-09-26-ctl-gateway-access.md)）。

## TODO 三级标记

| 标记 | 含义 |
|---|---|
| `FIXME` | 正确性问题，**阻断发布**；相关里程碑合并前必须处理 |
| `TODO` | 具体的近期待办，尽快跟进 |
| `XXX` | 未决设计问题 / 存疑；保留到结论落成 Agent Note 为止 |

## 文档导航

- [docs/architecture.md](docs/architecture.md) — 系统边界、8 个 workspace 职责、消息流、M0–M7 里程碑
- [docs/development.md](docs/development.md) — 环境搭建、日常命令、TS 布局与依赖约定
- [docs/testing.md](docs/testing.md) — 测试分层与验收口径（三条测试哲学）
- [notes/README.md](notes/README.md) — 决策记录（Agent Notes）契约
- 各包 `README.md` — 该包 purpose / configuration / extension points / known limitations
