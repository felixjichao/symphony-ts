# symphony-ts — TypeScript 版 Symphony（M0 脚手架）

参考 [OpenAI Symphony](https://github.com/openai/symphony)（开源 Rust 实现）用 TypeScript 自研的 Agent 编排协议 + 运行时。本仓库当前处于 **M0（脚手架）** 阶段：monorepo 骨架、类型骨架、构建/测试/静态检查全绿；wire 协议（M1）、可靠传输（M2）等按[方案](plan.md)里程碑推进。

## 布局

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

## 快速开始

```bash
npm install                # 可选：corepack enable && pnpm install（依赖锁定更严格）
npm run build              # 全仓 tsc 严格编译（typecheck，noEmit）
npm test                   # 全仓单元测试（vitest）
npm run lint               # eslint（可选）
```

## 里程碑

M0 本骨架 → M1 wire 编解码/签名 → M2 可靠传输（UDP 握手/重传 + WS 适配）→ M3 网关单机闭环（hello Agent 互发消息）→ M4 插件最小可用 → M5 `symctl` 交互 → M6 relay+多网关集群 → M7 加固与可观测。详见 `plan.md`。

## 注意事项

- 包间依赖使用 `workspace:*`，tsconfig `paths` 映射到各包 `src`；发布形态（dist 产物）在 M1 打包时切换。
- 严格模式：`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`。
- 首次推进（M1）建议先校准上游常量与 proto 字段（见方案 §3/§8）。