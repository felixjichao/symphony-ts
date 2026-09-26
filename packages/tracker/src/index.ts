/**
 * @symphony/tracker — SPEC §11 Issue Tracker Integration Contract 的
 * owner 包（§3 的 Issue Tracker Adapter）。
 *
 * M0.6 只确立边界，尚无公共 API。后续在此落地 provider 无关的读取
 * 接口、认证与 payload → Issue 归一化（进度见 docs/conformance.md）。
 *
 * 边界约束：tracker 永不 import orchestrator —— 轮询节奏、claim、
 * 调度属于 coordination 层，只有 orchestrator 拥有。
 */
export {};
