/**
 * @symphony/cli — Symphony 宿主的 CLI / 进程生命周期入口。
 *
 * M0.6 只确立边界，尚无可运行入口。后续在此落地进程 start / stop、
 * 配置加载与组件装配（把 config / tracker / workspace / agent /
 * orchestrator / observability 接线为长运行服务），验收对齐
 * SPEC §17 的 CLI lifecycle 项与 §18（进度见 docs/conformance.md）。
 */
export {};
