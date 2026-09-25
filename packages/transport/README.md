# @symphony/transport

## Purpose

传输层抽象（对应上游 `symphony-transport`）：`Transport` 接口（`ready` / `send` / `close`）、Symphony 地址（`Address` + `formatAddress` / `parseAddress`，形如 `host:port:symphony`）、`TransportHandler` 收包回调，以及最小 UDP 实现 `UdpTransport`。

## Configuration

`UdpTransport` 构造参数：

- `handler: TransportHandler` — `onMessage(data, from)` 收完整数据报（解封装为 Message 是协议层职责）；可选 `onError`；
- `opts: { host, port }` — 默认 `{ host: "0.0.0.0", port: 0 }`（随机端口）；`host` 为 `0.0.0.0` 时 `ready` 回报 `127.0.0.1`。

## Extension points

- **可靠流（M2）**：握手、序号、ACK、重传、分片在 `UdpTransport` 之上叠加，保持 `Transport` 接口不变；
- **WebSocket 适配器（M2）**：`WsTransport` 是显式 throw 的占位，作为 `Transport` 的第二实现落地，与 UDP 可互换、可同时监听；
- 新增传输实现只需满足 `Transport` 接口 + 地址格式约定（`service` 段取 `SERVICE_NAME`）。

## Known limitations

- `UdpTransport` 无任何可靠语义：不重传、不分片、不保序；数据报上限 65507 字节；
- 仅 `udp4`，无 IPv6；
- `ready` 在 `0.0.0.0` 绑定时回报 `127.0.0.1`，不探测外部可达地址；
- `WsTransport` 构造即 throw（M2 实现）；`close()` 后的 `send` 行为未定义（依赖 dgram 原生报错）。
