# @symphony/plugins

## Purpose

控制器模块注册表与占位插件（对应上游 controller-modules）：`Plugin` 接口、`PluginRegistry`（注册 / 顺序分发 / 定向分发）、`makePlaceholderPlugin` 工厂，以及 5 个占位模块与 `createDefaultRegistry()`。

## Configuration

无运行时配置。插件即配置面：网关行为由注册进 `PluginRegistry` 的插件集合决定。

## Extension points

实现 `Plugin { name, handle(input): boolean }` 并 `registry.register()` 即接入分发链：

- `handle` 返回 `true` 表示消费（短路，不再问后续插件）；返回 `false` 继续传递；
- `dispatch(input)` 按注册顺序询问全部插件；`dispatchTo(name, input)` 定向分发（网关的内部路由用 `"core"`）；
- 重名注册抛错，插件名是稳定标识。

M4 里程碑映射（当前全部为占位，`handle` 恒返回 `false`）：

| 插件 | M4 目标 |
|---|---|
| `mdns` | 局域网 mDNS 发现网关与 Agent |
| `a2a-inbound` | HTTP(S) A2A 入站，外部请求转内部 Message |
| `workspace` | 数据/脚本存取与受控执行（进程 runner） |
| `registry` | Agent 目录 + 健康检查 |
| `external-runner` | 外部执行器（如 CI）回传结果 |

## Known limitations

- 5 个模块均为占位，不消费任何消息；
- 分发顺序 = 注册顺序，无优先级 / 匹配规则（按消息类型路由留待 M4）；
- `"core"` 插件并未由本包提供——`dispatchTo("core", …)` 当前总是 no-op，等 M3 网关注册路由插件；
- 插件无生命周期钩子（init/dispose），M4 视需要引入。
