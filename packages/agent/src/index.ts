/**
 * @symphony/agent — SPEC §10 Agent Runner Protocol 与 §12 Prompt
 * Construction and Context Assembly 的 owner 包（§3 的 Agent Runner）。
 *
 * M0.6 只确立边界，尚无公共 API。后续在此落地上下文组装、coding
 * agent 子进程（如 Codex app-server）的启动与 live session 事件流
 * 转发（进度见 docs/conformance.md）。
 *
 * 边界约束：runner 不拥有 scheduler / retry policy —— 属 orchestrator。
 */
export {};
