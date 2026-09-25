# @symphony/sym

## Purpose

`sym/0` 协议的**唯一权威**：消息模型 `Message { Route, Header, Payload }`、协议常量（`PROTO_VERSION` / `TRANSPORT_VERSION` / `SERVICE_NAME`）、`PayloadKind` 枚举与 `createMessage` 工厂。对应上游 `sym` crate。

## Configuration

无运行时配置。协议常量即本包对外的"配置面"：

- `PROTO_VERSION = "sym/0"` — 信封 / Header 的协议版本串；
- `TRANSPORT_VERSION = "1.0"` — 附加在地址上的传输版本；
- `SERVICE_NAME = "symphony"` — 地址后缀（`host:port:symphony`）。

## Extension points

- **wire 编解码（M1）**：`encode` / `decode` 目前是显式 throw 的占位，M1 在此实现长度前缀 + protobuf 语义字段；
- **Header 扩展**：`HeaderOption{key, value}` 是开放的键值对列表，新增头字段先走 opts，稳定后再提升为强类型字段；
- 修改 `Message` 模型 / 常量属于跨包契约变更：必须附 Agent Note（见根 `notes/README.md`）。

## Known limitations

- `encode` / `decode` 未实现（调用即 throw，M1 落地）；
- `Route.src/dst` 是裸 string，尚未约定 Ed25519 公钥编码格式（M1 校准）；
- 无签名 / 验签（M1）；`Header.gateway` 语义（对端可达地址）到 M3 才被网关真正使用。
