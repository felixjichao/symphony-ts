# @symphony/ctl

## Purpose

控制平面 CLI `symctl` 骨架（对应上游 `symphony-ctl`）：自身是一个普通 Agent 客户端，直连网关后提供子命令。M0 只固化参数解析（`parseArgs`）、命令表（`SYMCTL_USAGE`）与入口（`main` / `src/cli.ts`，bin 名 `symctl`）。

## Configuration

命令行即配置：

```
symctl <host:port:symphony> <command> [args...]

commands:
  list               列出连接的 Agent（M5）
  send <dst> <text>  发一条消息（M5）
  spawn <name>       启动一个 Agent（M5）
  inspect <id>       查看链路（M5）
```

第一个位置参数必须是网关地址（`host:port:symphony` 形式）。

## Extension points

- **子命令（M5）**：命令表在 `SYMCTL_USAGE`，`main` 是真实入口——新子命令沿 `parseArgs → main` 链路扩展，交互经 transport 直连网关；
- 输出契约：`main` 返回 string（无参 / 非法参时返回 usage），便于按 [testing.md](../../docs/testing.md) "test the real entry path" 直接断言。

## Known limitations

- 所有子命令均未实现（M5），`main` 只回显"已连接"占位文案，不建立任何网络连接；
- `parseArgs` 的地址校验宽松：除 `host:port:symphony` 外还接受任意 `…:1.0` 后缀（历史分支，M5 收敛为单一地址语法）；
- 无全局 flag（`--json`、超时、重试等）约定。
