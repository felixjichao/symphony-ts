/**
 * @symphony/orchestrator — SPEC §7 Orchestration State Machine、
 * §8 Polling / Scheduling / Reconciliation、§14 Failure Model 的
 * owner 包（§3 的 Orchestrator）。
 *
 * M0.6 只确立边界，尚无公共 API。后续在此落地轮询节奏、claim 集合、
 * 并发上限、retry / backoff 与单一权威 runtime state 的维护
 * （进度见 docs/conformance.md）。
 *
 * 边界约束：本包是唯一的 coordination 层 —— tracker / workspace /
 * agent 不得反向持有调度或 retry 策略。
 */
export {};
