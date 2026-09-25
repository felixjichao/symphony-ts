# symphony-ts — TypeScript 版 Symphony

参考 [OpenAI Symphony](https://github.com/openai/symphony)（开源 Rust 实现）用 TypeScript 自研的 Agent 编排协议 + 运行时。当前处于 **M0（脚手架）** 阶段：monorepo 骨架、类型骨架、构建/测试/静态检查全绿；wire 协议（M1）、可靠传输（M2）等按里程碑推进（见 [docs/architecture.md](docs/architecture.md)）。

## 快速开始

要求 Node >= 20；npm 是唯一 canonical 包管理器。

```bash
npm ci                     # 安装（严格按 package-lock.json）
npm run gate               # 一键门禁：typecheck + test + lint
npm test -w @symphony/sym  # 只跑某个 workspace 的测试
```

日常开发命令、TS 布局约定见 [docs/development.md](docs/development.md)。

## 包布局

| 包 | 对应上游 | M0 内容 |
|---|---|---|
| `packages/sym` | `sym`（协议） | `Message{Route,Header,Payload}` 模型、常量、`createMessage` |
| `packages/proto` | `proto-transcoder` | 转码器接口 + 零依赖 JSON 实现 |
| `packages/transport` | `symphony-transport` | `Transport` 抽象 + 最小 UDP bind/send/close |
| `packages/gateway` | `gateway`/core | 网关骨架：依赖注入、插件分发、start/stop |
| `packages/relay` | `relay` | L4 转发规则与轮询选择（M6 落地） |
| `packages/ctl` | `symphony-ctl` | `symctl` CLI 骨架：参数解析 + 命令表 |
| `packages/plugins` | controller-modules | 插件注册表 + mdns/a2a/workspace/registry/external-runner 占位 |
| `apps/examples` | examples | echo Agent 纯逻辑骨架 |

每个包都有自己的 `README.md`（purpose / configuration / extension points / known limitations）。

## 文档导航

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | Agent / 贡献者 standing orders：命令矩阵、扩展点表、TODO 分级 |
| [docs/architecture.md](docs/architecture.md) | 系统边界、包职责与依赖方向、消息流、M0–M7 里程碑 |
| [docs/development.md](docs/development.md) | 环境搭建、日常命令、TS 布局与依赖约定 |
| [docs/testing.md](docs/testing.md) | 测试分层、验收口径、三条测试哲学 |
| [notes/](notes/README.md) | 架构 / 选型决策记录（Agent Notes） |

## 里程碑

M0 脚手架 → M1 wire 编解码/签名 → M2 可靠传输（UDP 握手/重传 + WS 适配）→ M3 网关单机闭环（hello Agent 互发消息）→ M4 插件最小可用 → M5 `symctl` 交互 → M6 relay+多网关集群 → M7 加固与可观测。各里程碑的当前状态见 [docs/architecture.md](docs/architecture.md#里程碑)。

## 注意事项

- 包间依赖使用 `*` 语义（npm workspaces 自动链接本地包），tsconfig `paths` 映射到各包 `src`；发布形态（dist 产物）在 M1 打包时切换。
- 严格模式：`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`。
- 首次推进（M1）建议先校准上游常量与 proto 字段。
