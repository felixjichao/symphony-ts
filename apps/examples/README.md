# @symphony/examples

## Purpose

可运行示例（对应上游 examples）。当前只有一个：echo Agent——收到消息后原样回给发送方。M0 提供纯函数核心 `echoHandler`（route 反转、`parent` 指向请求 id、payload 原样回带）与占位启动器 `startEchoAgent`。

## Configuration

无。运行方式：

```bash
npm run echo -w @symphony/examples   # tsx src/echoAgent.ts（当前仅打印占位说明）
```

## Extension points

- **新示例**：每个示例一个 `src/<name>.ts` + 同名 `.test.ts`；示例只准用各包公共 API（`@symphony/*`），作为 API 好用程度的试金石；
- **M3 闭环**：`startEchoAgent` 是预留位——启动真实网关、把 `echoHandler` 注册为插件、走真实 UDP 收发消息。

## Known limitations

- 未接入网关：`startEchoAgent` 只返回占位字符串（M3 落地）；
- `echoHandler` 不验签、不校验 `protoVersion`，假设输入已是可信 `Message`；
- 直接运行入口的判断（`import.meta.url === \`file://${process.argv[1]}\``）在 Windows 路径下不成立，示例脚本暂不保证跨平台。
