# 测试

## 分层与验收口径

分层对齐官方 SPEC §17 Test and Validation Matrix 的三个 validation profile（`Core Conformance` / `Extension Conformance` / `Real Integration Profile`，§17.1–§17.7 默认属 Core，可选特性属 Extension，§17.8 为 Real Integration）；进度以 [conformance.md](conformance.md) 矩阵为准。

| 层 | 范围 | 状态 |
|---|---|---|
| L1 单元测试（§17.1–§17.7，Core Conformance） | 每 workspace `src/*.test.ts`（vitest），纯逻辑优先：config 解析与默认值、路径净化、backoff 数学、模板渲染、dispatch 排序 | M1 起随各包落地 |
| L2 组件集成（Core Conformance；随可选特性落地时适用 Extension Conformance） | 真实文件系统的 workspace provisioning / containment、fake tracker provider 的归一化读取、session 事件流 | M2–M4 随各组件落地 |
| L3 端到端（§17.8 Real Integration Profile / §18） | orchestrator 完整 loop：本地 fake tracker + stub coding agent，覆盖 claim → dispatch → retry → reconciliation | M5 落地 |
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

- ✅ `apps/cli`：对 `main(parseArgs(argv))` 的真实入口链路断言行为（将来直接 spawn 进程）；不要在测试里重新实现一遍参数校验再测它。
- ✅ config：从文件路径入口 `load(path)` 测起，而不是喂一个预构造好的对象再测校验器。
- ❌ 只测内部 helper，绕过 `index.ts` 的公共出口——`src/index.ts` 是包的唯一 API 面，测试必须经过它。

## 运行

```bash
npm test                          # 全仓
npm test -w @symphony/config      # 单 workspace
npm run gate                      # typecheck + test + lint + docs:check 一键门禁
```

测试文件与被测文件同目录（`src/foo.ts` ↔ `src/foo.test.ts`）；每包 `npm test` 即 `vitest run`。
