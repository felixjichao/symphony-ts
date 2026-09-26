# @symphony/agent

## Purpose

SPEC **§10 Agent Runner Protocol (Coding Agent Integration)** 与 **§12 Prompt Construction and Context Assembly** 的 owner 包，对应 §3 的 Agent Runner：组装注入 issue 上下文的 prompt、启动 coding agent 子进程（如 Codex app-server client）、把 live session 事件（token 消耗、turn 进度、PID）向上转发。**修改 Codex app-server 交互的唯一落点在本包。**

## Configuration

daemon 启动命令、并发 / 沙箱限制等由 `@symphony/config` 产出的 typed config 提供；模板变量注入契约见 SPEC §5（渲染在 config）与 §12（组装在本包）。

## Extension points

- 新的 coding-agent 后端：实现本包的 runner 协议，对 orchestrator 暴露统一的 session 事件流；
- prompt 上下文的新来源：在本包的组装管道中登记，不在 orchestrator 或 workspace 里拼 prompt。

## Known limitations

- M0.6 仅建立边界，`src/index.ts` 暂无公共 API；
- 子进程控制、事件流与 prompt 组装随后续里程碑落地（SPEC §10 / §12、§17）；
- 边界约束：**不拥有 scheduler / retry policy**——coordination 属 `@symphony/orchestrator`。
