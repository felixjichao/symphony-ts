# @symphony/gateway

## Purpose

消息服务器骨架（对应上游 `gateway`/core）：`GatewayServer` 持有一个 transport 与一个 `PluginRegistry`，`start()` / `stop()` 管理生命周期；收到数据报后经 `jsonTranscoder` 解信封（校验 `proto === "sym/0"`）还原 `Message`，交插件顺序分发，未消费的转给 `"core"` 插件（内部路由占位）。

## Configuration

`GatewayConfig`：

- `listen?: { host, port }` — 传给内部 `UdpTransport`（缺省随机端口）；
- `upstream?: Address` — 上游网关地址，**M6 才使用**，当前仅存配置；
- `name?: string` — 网关名（当前未消费）。

## Extension points

- **控制器模块**：向传入的 `PluginRegistry` 注册插件（`@symphony/plugins`），即可参与 `dispatch` 顺序分发；
- **内部路由（M3）**：`dispatchTo("core", …)` 的落点是 M3 路由表的接入位；
- **认证 / 验签（M3）**：`onMessage` 中解信封与分发之间是每消息验签的预留位；
- **上游转发（M6）**：本地路由未命中时向 `config.upstream` 转发。

## Known limitations

- 无认证、无路由表、无投递保证——当前只是"收包 → 解 JSON → 问插件"的骨架；
- 信封硬编码 `jsonTranscoder`，M1 wire 编解码落地后需替换；
- `onError` 是可选属性且默认为 undefined，解码失败会被静默丢弃（M3 补错误面）；
- transport 硬编码 `UdpTransport`，构造注入留待 M2（WS 适配器）时一并处理。
