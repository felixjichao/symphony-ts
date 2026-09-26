# 架构

> 本文描述 symphony-ts 的**当前真实状态**（M0 脚手架）与里程碑规划。写作原则：不把 scaffold 写成已实现能力——凡标注 M1+ 的部分，代码中要么不存在、要么是显式 throw 的占位。

## 系统边界（M0 现状）

symphony-ts 是 [OpenAI Symphony](https://github.com/openai/symphony)（Rust 实现）的 TypeScript 重实现：Agent 编排协议（`sym/0`）+ 运行时（网关、插件、relay、CLI）。

当前 M0 只有：

- monorepo 骨架：8 个 npm workspace，构建 / 测试 / lint 全绿；
- 协议消息模型（类型 + 常量 + `createMessage`），**wire 编解码未实现**（`encode`/`decode` 显式 throw，M1 落地）;
- 最小 UDP 传输（bind / send / close，**无可靠语义**，M2 叠加握手 / 重传 / 分片）；
- 网关骨架（start/stop + 插件分发接线，**无认证、无路由表**，M3 落地）；
- JSON 转码器（零依赖，端到端打通用）+ 转码器注册表；
- 插件注册表 + 5 个占位插件（M4 逐个实现）；
- relay 规则与轮询选择（纯逻辑，M6 接线）；
- `symctl` 参数解析与命令表骨架（M5 实现交互）；
- echo Agent 纯函数逻辑（M3 接入网关闭环）。

## Workspace 职责与依赖方向

| 包 | 对应上游 | 职责 | 依赖 |
|---|---|---|---|
| `packages/sym` | `sym` | `sym/0` 协议：`Message{Route,Header,Payload}` 模型、常量、`createMessage`；M1 加 wire 编解码 | 无 |
| `packages/proto` | `proto-transcoder` | 载荷转码器：`Transcoder<T>` 接口 + JSON 实现 + 注册表；M1 接入 protobuf/CBOR | 无 |
| `packages/transport` | `symphony-transport` | `Transport` 抽象（`ready`/`send`/`close`）+ 地址格式化；最小 UDP 实现；M2 加可靠流与 WS 适配器 | `sym` |
| `packages/plugins` | controller-modules | `Plugin` 接口 + `PluginRegistry`（注册 / 顺序分发 / 定向分发）+ 5 个占位模块 | `sym`, `transport` |
| `packages/gateway` | `gateway`/core | `GatewayServer`：持有 transport 与插件注册表，收包 → JSON 解信封 → 插件分发；M3 加认证与路由表，M6 加上游转发 | `sym`, `proto`, `transport`, `plugins` |
| `packages/relay` | `relay` | L4/UDP 前端：`RelayRule`、`pickBackend` 轮询；M6 落地真实转发 | `transport`（仅类型） |
| `packages/ctl` | `symphony-ctl` | `symctl` CLI：参数解析 + 用法表；M5 以普通 Agent 客户端身份直连网关，实现 list/send/spawn/inspect | `sym`（M5 起加 `transport`/`proto`，见 [note](../notes/accepted/architecture/2026-09-26-ctl-gateway-access.md)） |
| `apps/examples` | examples | echo Agent：`echoHandler` 纯函数；M3 接入网关 | `sym`, `gateway` |

依赖只允许自上表"依赖"列的方向流动；新增跨包依赖前先读 [AGENTS.md](../AGENTS.md) 的扩展点表。

## 当前消息流（M0 已接通的部分）

```
createMessage (sym)                     ── 构造 Message 模型（仅内存对象）
  → jsonTranscoder.encode (proto)       ── {proto:"sym/0", payload:Message} → bytes
  → UdpTransport.send (transport)       ── bytes → UDP 数据报（不可靠）
  → GatewayServer.onMessage (gateway)   ── bytes → JSON 解信封 → Message
  → PluginRegistry.dispatch (plugins)   ── 顺序询问插件；未消费则 dispatchTo("core")
```

注意：这条链路目前是**逐段单测打通**，尚无端到端运行的网关 + Agent 进程；M1 用 wire 编解码替换 JSON 信封，M3 完成单机闭环。

## 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | monorepo 脚手架、类型骨架、构建/测试/静态检查全绿 | ✅ 已完成 |
| M0.5 | AI coding 基础设施：AGENTS.md、docs/、包 README 契约、Agent Notes、`npm run gate` | ✅ 本次 |
| M1 | wire 编解码 / 签名（对齐上游 protobuf 语义，校准常量与字段） | 未开始 |
| M2 | 可靠传输：UDP 握手 / 序号 / ACK / 重传 / 分片 + WebSocket 适配器 | 未开始 |
| M3 | 网关单机闭环：hello Agent 互发消息（echo 示例接入） | 未开始 |
| M4 | 插件最小可用（mdns / a2a-inbound / workspace / registry / external-runner 逐个落地） | 未开始 |
| M5 | `symctl` 交互（list / send / spawn / inspect） | 未开始 |
| M6 | relay + 多网关集群（上游转发、L4 负载均衡接线） | 未开始 |
| M7 | 加固与可观测 | 未开始 |

后续基建批次（随里程碑另行跟踪）：schema-first（`packages/sym` 协议定义 → 生成 `docs/specs/sym-protocol.json` + freshness gate）、测试分层落地（unit + 真实 UDP smoke + M3 集成脚本）、CI lane 化、轻量 doc gate（md 链接校验、AGENTS.md 词数上限）。
