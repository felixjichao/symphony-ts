# @symphony/relay

## Purpose

网关前端的 L4/UDP 负载均衡骨架（对应上游 `relay`）：为网关群提供一个稳定入口，UDP 数据报按规则转发到某台网关，网关无需固定 DNS。M0 只含纯逻辑：`RelayRule`、`pickBackend` 轮询选择器、`Relay.findRule`。

## Configuration

`RelayRule`：

- `service: string` — 服务段（如 `symphony`），对应地址 `host:port:symphony` 的第三段；
- `backends: Array<{host, port}>` — 后台网关地址列表（不含服务名）。

`Relay` 构造时传入规则数组（缺省空）。

## Extension points

- **真实转发（M6）**：在 `findRule` + `pickBackend` 之上接线 transport，落地数据报转发；
- **选择策略**：`pickBackend(rule, counter)` 当前是朴素轮询（`counter % backends.length`）；一致性哈希 / 负载感知策略以同签名替换或包装；
- 规则来源（静态配置 / mDNS 动态发现）留待 M6 与 `mdns` 插件协同。

## Known limitations

- 不监听任何端口、不转发任何字节——当前只有可单测的纯函数；
- `backends` 为空时 `pickBackend` 抛错，无健康检查 / 摘除机制；
- counter 由调用方维护，relay 自身无状态。
