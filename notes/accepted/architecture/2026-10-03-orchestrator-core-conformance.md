# Agent Note: Orchestrator Core Conformance 与宿主接线契约
Status: accepted

## Problem

M5.6 / NEST-79 要收口 SPEC §7 / §8 / §14 / §16 / §17.4；已有单包调度证据不能证明真实 WORKFLOW、adapter、workspace 与 agent 接线。M6 需要稳定公共契约，不能用测试装配提前实现 CLI 或新的 scheduler facade。

## Decision

完整链路装配留在 orchestrator 测试侧，从各包 public API 与 `OrchestratorLoop.start()` 进入。tracker 外部边界用 registry 注册的无网络 fixture profile；workspace、文件 loader、hooks、agent runner 与 bash app-server 子进程均真实。poll/retry 使用分开的手动 scheduler；retry due 与 UTC event/stall 分属两个时钟域。用有界世界观测而非真实 backoff sleep。

宿主 preflight 必须先 load/resolve、selected profile 校验、检查非空 codex.command、构造 adapter；成功才提交一个 effective store 并返回 scheduling config。profile 默认 active/terminal states 从 selected profile 取，不能假设 config 回写默认 states。candidate、ID refresh 与 startup sweep 共享当前 adapter，attempt workflow/config、cap、stall 与 cleanup hooks 都读同一成功版本。非法文件保留旧值并跳过 dispatch；tick 的 reconciliation 先使用此前 effective，然后 preflight 才 apply 新值。已挂 poll/retry timer 不因 reload 改期；新 dispatch/retry/continuation 使用最新 policy；并发下调不停止现有 worker。

沿用已有 implementation-defined lifecycle policy：terminal 在 worker/after_run 收尾后安全删除，其余不可运行状态停止并保留目录；startup/cleanup 实际失败 best-effort，能力缺失 fail startup；completed 仅记账；state/timer 不持久化。stop 同步关闭 authority，再等待已开始 worker/cleanup 与 loop startup/tick；不为永久挂起的外部端口新增全局服务超时语义（由后续 host lifecycle 定义）。

TypeScript AST 结构测试约束生产 import/export/import()/require()、私有路径与 runtime dependencies；原始 Codex JSON 解析只留 agent/fixture 边界。13 项非 conditional §17.4 逐项映射至 conformance 文档。snapshot API、structured logs 与 CLI 仍留 M6。

## Alternatives considered

- 所有场景都使用 fake runner/config：无法证明文件解析、真实进程关停、cwd 和 lifecycle hook/删除次序；保留纯逻辑与竞态 suite，同时补完整链路。
- 为每个纯函数边界新启 subprocess：昂贵且扩大握手抖动；真实流程测试与既有单元矩阵共同收口。
- 新建生产 composition facade / CLI：超出 M5，隐藏已有 public ports；测试装配展示接线，M6 再建立宿主。
- 重新存储 cap/stall 或失败时更新部分 config：制造多个真相来源和混合版本；统一成功提交 store。
- 将本地 fake app-server loop 标为 §17.8 Real Integration：不能证明外部网络/凭证/真实 Codex；它属于默认 CI 的 Core Conformance。

## Consequences

M6 可以消费现有 authority/loop 端口与同一 effective store，无需重写 scheduler。默认 CI 无外部网络/凭证，但依赖本地 bash 与进程/文件系统；fixture 测试不等于生产就绪。未来 runtime dependency 或私有跨包 import 会触发结构守卫；新增 host lifecycle/observability 行为须独立验收。外部 provider/Codex 与 §18.1 其余条目继续按矩阵跟踪。
