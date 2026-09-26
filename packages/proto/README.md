# @symphony/proto

## Purpose

载荷转码器（对应上游 `proto-transcoder`）：`Transcoder<T>` 接口、通用信封 `JsonRoot{proto, payload}`、零依赖 JSON 实现 `jsonTranscoder`，以及按 format 索引的转码器注册表。

## Configuration

无。转码行为由注册表内容决定（见扩展点）。

## Extension points

- **新转码格式（M1）**：实现 `Transcoder<T>`（`format` / `encode` / `decode`），用 `registerTranscoder` 登记；protobuf / CBOR 对齐上游后在此接入；
- `getTranscoder<T>(format)` 是消费侧唯一取用入口，未登记格式抛 `UnsupportedFormatError`；
- `JsonRoot.proto` 字段供解码侧路由协议版本，自定义信封须保留版本判别能力。

## Known limitations

- 仅有 JSON 实现；`jsonTranscoder` 不处理二进制安全（payload 含 `Uint8Array` 时依赖上层先做 base64/信封约定，M1 wire 编解码落地后 JSON 仅用于调试面）；
- 注册表是模块级单例，无注销 / 隔离能力（测试内重复注册会互相覆盖）；
- `decode` 只校验信封形状（`proto` 为 string），不校验 payload 内部结构。
