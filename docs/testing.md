# 测试

## 分层与验收口径

| 层 | 范围 | 状态 |
|---|---|---|
| L1 单元测试 | 每 workspace `src/*.test.ts`（vitest），纯逻辑优先：协议模型、转码、参数解析、路由规则 | ✅ M0 已有，`npm test` |
| L2 真实 UDP smoke | 起两个真实 `UdpTransport` 实例互发数据报，断言对端收到的字节 | M2 随可靠传输落地 |
| L3 集成脚本 | 网关单机闭环：hello Agent 经真实网关互发消息（echo 示例） | M3 落地 |
| L4 recorded-session | 录制真实会话回放（对齐上游 keyless 快照思路） | M7 前后评估 |

验收口径：`npm run gate`（typecheck + test + lint）全绿是合并的最低要求；涉及传输 / 网关行为的 PR，必须附带"重读世界"式断言（见下），不接受只验证内部状态被调用过。

## 三条测试哲学（强约束）

### 1. verify the world, not the self-report

断言外部可观察的结果，而不是被测代码自己汇报的状态。

- ❌ `send()` 的 Promise resolve 了就当发送成功。
- ✅ 在另一个端口 bind 一个真实 socket，`UdpTransport.send` 之后断言**对端实际收到的字节**等于发出的字节（M2 smoke 的基准写法）。
- ❌ 断言 `plugin.handle` 被调用过（spy 计数）。
- ✅ 断言分发之后世界的变化：消息被消费、返回的 Message 内容正确。

### 2. prefer the real implementation over a mock

能用真实现就不用 mock；mock 只留给真正的外部世界（时钟、网络故障注入）。

- ✅ gateway 测试用真的 `jsonTranscoder` 解信封、真的 `PluginRegistry` 分发；JSON 转码零依赖，没有 mock 的理由。
- ✅ relay 的 `pickBackend` 直接对真实规则数组断言轮询序列。
- ❌ 为测 `GatewayServer` 而 mock 掉 `PluginRegistry`，结果只验证了"调用了 mock"。

### 3. test the real entry path

从用户 / 上游真正进入代码的入口测，不要在测试里复刻一份入口逻辑。

- ✅ `symctl`：对 `main(parseArgs(argv))` 的真实入口链路断言输出（将来直接 spawn `cli.ts`）；不要在测试里重新实现一遍参数校验再测它。
- ✅ echo Agent：用 `createMessage` 构造真实 `Message` 喂给 `echoHandler`，断言回包 route 反转、`parent` 指向请求 id。
- ❌ 只测内部 helper，绕过 `index.ts` 的公共出口——`src/index.ts` 是包的唯一 API 面，测试必须经过它。

## 运行

```bash
npm test                          # 全仓
npm test -w @symphony/gateway     # 单 workspace
npm run gate                      # typecheck + test + lint 一键门禁
```

测试文件与被测文件同目录（`src/foo.ts` ↔ `src/foo.test.ts`）；每包 `npm test` 即 `vitest run`。
