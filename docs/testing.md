# 测试

## 分层与验收口径

分层对齐官方 SPEC §17 Test and Validation Matrix 的三个 validation profile（`Core Conformance` / `Extension Conformance` / `Real Integration Profile`，§17.1–§17.7 默认属 Core，可选特性属 Extension，§17.8 为 Real Integration）；进度以 [conformance.md](conformance.md) 矩阵为准。

| 层 | 范围 | 状态 |
|---|---|---|
| L1 单元测试（§17.1–§17.7，Core Conformance） | 每 workspace `src/*.test.ts`（vitest），纯逻辑优先：config 解析与默认值、路径净化、backoff 数学、模板渲染、dispatch 排序 | M1 起随各包落地 |
| L2 组件集成（Core Conformance；随可选特性落地时适用 Extension Conformance） | 真实文件系统的 workspace provisioning / containment、fake tracker provider 的归一化读取、真实 `WORKFLOW.md` → registry → adapter → 本地 GitHub REST stub（`packages/tracker/src/github-rest-integration.test.ts`）、真实 `WORKFLOW.md` → resolved config → WorkspaceManager → temp filesystem → shell hook（`packages/workspace/src/config-integration.test.ts`）、真实 `WORKFLOW.md` → loadEffectiveWorkflow → WorkspaceManager → real temp fs + hooks → runAgentAttempt → fake app-server subprocess → JSON-RPC session/events（`packages/agent/src/config-integration.test.ts`，fixture 见 `packages/agent/test-fixtures/`）、session 事件流 | M2 tracker + M3 workspace + M4 agent（含 M4.6 端到端 Core Conformance）已落地 |
| L3 完整 loop（§17.4 / §18.1 orchestration core，Core Conformance） | 真实 WORKFLOW + registry / 本地 tracker adapter + WorkspaceManager / temp filesystem + runAgentAttempt / bash fake app-server，覆盖 claim → dispatch → events → outcome → retry → refresh → reconciliation / cleanup / stop | M5 已落地（`packages/orchestrator/src/workflow-integration.test.ts`、`workflow-shutdown.test.ts`） |
| 外部真实集成（§17.8 / §18.3 Real Integration Profile） | 外部 GitHub / 真 Codex，需要显式凭据与独立测试 scope | opt-in 已落地（#83 / PR #88，见 [github-delivery-dogfood.md](github-delivery-dogfood.md)）；不在默认 gate 内，也不作为本地 fixture 测试通过的含义 |
| L4 recorded-session | 录制真实 provider / agent 会话回放 | M7 前后评估 |

验收口径：`npm run gate`（typecheck + test + lint + docs:check）全绿是合并的最低要求；涉及 workspace / tracker / orchestrator 行为的 PR，必须附带"重读世界"式断言（见下），不接受只验证内部状态被调用过。

## 三条测试哲学（强约束）

### 1. verify the world, not the self-report

断言外部可观察的结果，而不是被测代码自己汇报的状态。

- ❌ `provision()` 的 Promise resolve 了就当 workspace 建好了。
- ✅ 在真实临时目录里断言**目录确实存在**、路径确实在 containment 边界内、cleanup 后确实被移除（L2 的基准写法）。
- ❌ 断言 `tracker.fetch` 被调用过（spy 计数）。
- ✅ 断言归一化之后世界的变化：返回的 Issue 字段、状态、优先级与 provider payload 的映射正确。

### 2. prefer the real implementation over a mock

能用真实现就不用 mock；mock / fake 只留给真正的外部世界（时钟、网络故障注入、外部 tracker provider、coding agent 子进程）。

- ✅ config 测试写真实的 `WORKFLOW.md` 到临时目录，走完整解析 / 校验 / 热重载链路。
- ✅ backoff / retry 直接对真实纯函数断言数学结果（§16 参考算法）。
- ❌ 为测 orchestrator 而 mock 掉 config 解析，结果只验证了"调用了 mock"。

### 3. test the real entry path

从用户 / 上游真正进入代码的入口测，不要在测试里复刻一份入口逻辑。

- ✅ `apps/cli`：对 `main(parseArgs(argv))` 的真实入口链路断言行为（M6.3 已通过 `src/bin.test.ts` 真实 spawn 进程运行）；不要在测试里重新实现一遍参数校验再测它。
- ✅ config：从文件路径入口 `load(path)` 测起，而不是喂一个预构造好的对象再测校验器。
- ❌ 只测内部 helper，绕过 `index.ts` 的公共出口——`src/index.ts` 是包的唯一 API 面，测试必须经过它。

## 运行

```bash
npm test                          # 全仓
npm test -w @symphony/config      # 单 workspace
npm test -w @symphony/agent -- src/config-integration.test.ts # M4 端到端 Core Conformance
npm run gate                      # typecheck + test + lint + docs:check 一键门禁
```

测试文件与被测文件同目录（`src/foo.ts` ↔ `src/foo.test.ts`）；每包 `npm test` 即 `vitest run`。

## M5 完整 loop 与配置接线

运行 `npm test -w @symphony/orchestrator -- src/workflow-integration.test.ts src/workflow-shutdown.test.ts src/boundaries.test.ts`。测试从 `OrchestratorLoop.start()` 进入，使用 `loadEffectiveWorkflow` + registry extension 校验真实文件；每次成功 preflight 同时提交 config、adapter 和调度 policy，失败保留 last-known-good 并跳过 dispatch。retry cap、stall、attempt options 与 cleanup hooks 都读同一个 effective store。文件 reload 测试实际验证 global/per-state limit、active/terminal states、labels、prompt、cap、stall 与运行中 continuation policy；startup preflight 另验证 unsupported tracker 与 empty command。测试装配位于 `src/workflow.test-helpers.ts`，不是 CLI 或生产宿主。

### Fixture tracker

测试专用 `fixture` profile 无 provider keys、secret、环境 fallback 或网络请求。scope 为该 harness 的内存 Issue 集合，无分页和请求上限；输入已经是完整归一化 Issue，opaque ID / nativeRef / priority / timestamps / dispatchable 原样返回，labels 由 fixture 使用规范小写。state-list 按状态筛选，ID refresh 返回匹配快照（missing 省略）；故障由测试显式注入。无 provider-native tools，不模拟 provider payload 的 normalization/error mapping（那些由 tracker 包 suite 验证）。注册表与空输入 read kernel 使用 tracker 的真实 public API。

poll/retry scheduler 分离且可手动推进，不等待真实 backoff；retry due 用单调 clock，stall 将注入 UTC clock 对齐真实 AgentEvent 时间。短有界等待只用于进程/文件/异步收尾观测。断言 PID/cwd、目录 marker、after_run 与删除次序，finally/afterEach 先 stop 再删除临时目录。关停 barrier 覆盖 candidate fetch、retry refresh、startup cleanup 与 terminal cleanup 在途；既有 `loop-shutdown.test.ts` 补齐迟到回调与自然退出竞态。

新增 integration suite 在交付前连续复跑；`npm run gate` 是完整门禁。外部 provider 与真实 Codex 已由 opt-in 的 dogfood harness 真实验证（#83 / PR #88，见 [github-delivery-dogfood.md](github-delivery-dogfood.md)）；默认 gate 保持 credential-free，fixture 通过仍不替代 Real Integration profile。

## M6.1 snapshot evidence

运行 `npm test -w @symphony/observability`：empty/session-null/session-established、双时钟各采样一次、稳定排序、monotonic delay、active/ended duration 不双计、absolute totals、双向深复制隔离、handles 白名单排除及同步 unavailable；`snapshot-boundaries.test.ts` 对生产入口/投影 AST 检查 import、async/await 和 I/O/timer 边界。

运行 `npm test -w @symphony/orchestrator -- src/observability-integration.test.ts`：真实 authority 的 onEvent 经真实 applyAgentEvent，配受控 runner / 手动 clocks / timer ports，验证重复/回退/异 thread usage、多 turn、normal exit 与 shutdown 结算、观察失败不改变 claim/重派、retry URL outcome → refresh failure → slot/dispatch failure（含 null）。完整 `npm test -w @symphony/orchestrator` 同时继续回归 M5 真实 subprocess。根 `npm run typecheck` 与 `npm run gate` 为交付门禁。同步 projector 没有获取层 timeout；logging/CLI 的其他证据见 M6 Core 索引，HTTP 仍为 optional extension。

## M6.2 logging Core Conformance

Four entrypoints: `npm test -w @symphony/observability` (snapshot + logger), `npm test -w @symphony/tracker -- src/github/adapter.test.ts`, `npm test -w @symphony/orchestrator -- src/event-boundaries.test.ts`, and `npm test -w @symphony/cli -- src/logging.test.ts`. Tests observe actual committed state/timers and captured safe lines. CLI harness uses real temp WORKFLOW/config/registry/WorkspaceManager/authority/loop and fake app-server subprocess, including two turns, hook failure, fragmented stderr, 10MiB line overflow/recovery, sink/clock failures and filesystem reload rejection. Only external provider/process behavior and clocks/timers are fixtures. Existing M5 integration/shutdown and M6.1 snapshot suites run in the same `npm run gate`.

Fixed lifecycle templates are the MVP; free AgentEvent summaries/hooks/protocol payloads are omitted. The helper harness verifies composition helpers; production executable/signals and host reload commit are additionally verified by M6.3–M6.5 below. Richer §13.6 humanization is conditional/deferred.

## M6.3 CLI host and executable Core Conformance

运行 `npm test -w @symphony/cli`：
- `src/args.test.ts`：纯逻辑测试 `parseCliArgs`（positional workflow path、`--help` / `-h`、`--version` / `-v`）与 `resolveWorkflowPath`（显式路径 vs. 默认 `./WORKFLOW.md` 回退）；
- `src/host.test.ts`：组件装配与生命周期测试，验证可直接在测试进程中构造 `createHost()`、内置 GitHub profile 默认装配与配置校验、缺失文件 / 非法配置 / 未支持 tracker 洁净失败并记录结构化日志、`start()` 启动与 `stop()` 优雅停机；
- `src/bin.test.ts`：真实子进程集成测试，验证 `package.json` 的 `bin` 契约（`dist/bin/symphony.js` shebang 与执行权限）、显式与 CWD 默认 workflow 加载、缺失文件 / 非法配置退出码 1 且输出结构化错误、以及 `SIGINT` / `SIGTERM` 优雅停机并以 0 退出；
- `src/logging.test.ts`：M6.2 logging helpers 回归。

历史 M6.3 范围不含 live reload/signals race；这些证据由 M6.4/M6.5 补齐，见下。

## M6.5 process lifecycle and closure

```bash
npm test -w @symphony/cli -- src/bin.test.ts src/lifecycle.test.ts
npm test -w @symphony/cli -- src/host-reload.test.ts src/secret-boundary.test.ts src/effective-runtime.test.ts
npm test -w @symphony/config -- src/workflow-reload.test.ts
npm run gate
```

`bin.test.ts` 每轮 build 当前源码对应的真实 package executable；测试不复用旧 dist。内置 GitHub profile 经 loopback HTTPS + committed test-only CA/key + child `NODE_EXTRA_CA_CERTS` 访问；无公网和生产 HTTPS 豁免。path/default/missing/preflight/logs/signals/reload/真实 agent termination 经正式 bin；`lifecycle-harness.ts` 调用同一 runCli 但注入故障资源，只补充 abnormal/shutdown exit codes。

readiness 用真实 request/session/transcript/prompt/after_run marker，无固定 sleep、共享 request 计数或旧 bundle fallback。计数仅在单实例 barrier 建立后捕获；attempt/root 分开归因。startup terminal fetch barrier 内发送信号，after_run barrier 内发送第二信号；后者先重读 PID 确认消失再写 marker，父测试读取 `dead` 与 cwd 并再次检查 PID。忽略 SIGTERM 的 app-server 沿用已有 TERM→KILL deadline；SIGKILL 单独仅证明 abnormal termination。finally 通过嵌套 try/finally 先关闭 child 并等待 close，再关 tracker/删目录；proc.result 的超时 rejection 仍使测试失败，不会短路后续清理。`bin.test.ts` 的 `cleans HTTPS listener and temp directory after a real child timeout without hiding rejection` 推进父测试 watchdog 后核对真实 child SIGKILL/PID 消失、HTTPS TCP 连接被拒绝及临时目录已删除。全仓回归发现既有 transport stderr flood 断言错误地将 stdout 回包当作独立 stderr pipe 的 barrier，已改为等实际 200 行与 oversized diagnostic 完整接收，未改变 transport 实现。

`lifecycle.test.ts` 使用真实 config/host/loop，受控 watcher/poll/retry ports 核对资源归零；先制造真实 failed attempt 的 retry，停止后重放已捕获 callbacks 验证无 tracker request、新提交或 dispatch。startup 和 watcher-close 故障仍释放其他资源；shell tests 检查自己安装的 handlers、failure priority。M6.4 的回归装配保留，仅将依赖构造时自动 monitoring 的用例改为显式 start + 不自动执行 poll 的 scheduler。

逐项文件、用例名、命令见 [M6 Core 索引](conformance.md#m65-core-证据索引)。M6 Core 已完成并通过 main CI，验收记录见上述索引；本地 gate 不替代 main CI。当前进度与 deferred 见 [status.md](status.md)。
