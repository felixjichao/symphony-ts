# Agent Note: agent transport kernel 与 coding-agent launch 边界
Status: accepted

## Problem

SPEC §10 把 coding-agent 集成切成三层（Agent Runner → Codex app-server client → JSON-RPC/NDJSON transport → `bash -lc <codex.command>`），但 §10 自己**不是**协议 schema（§10 "Protocol source of truth"：wire 形状归 Codex，orchestration 语义归 SPEC）。M4.1（#37）冻结了对外契约面（`AgentError` / `AgentEvent` / `ContinuationDecider`）之后，M4.2（#38）要落地最底下那层，约束彼此拉扯：

- 这层必须**真的能起子进程并收发 NDJSON**，否则 §17.2 最后一项（"Agent launch uses the per-issue workspace path as cwd and rejects out-of-root paths"）与 §17.5 的 framing / read timeout / stderr 三条永远只是 planned；M3.2（#28）明确把 `assertWorkspacePathSafe` 定为「launch 前必须重验」的 execution-boundary primitive，并留下「M3 的 helper 测试不构成该验收项」的口径。
- 但它一旦开始理解 `initialize` / `thread/start` / `turn/start` / approval，就把 pinned Codex schema 的词汇写进了本不该理解协议的层，M4.3 / M4.4 的 policy 与 M5 的事件映射会失去唯一的替换点；README 分层也会退化成一个万能模块。
- §10.3 要求 stdio 传输下「协议流与诊断 stderr 分离」，§10.1 只 RECOMMEND "Max line size: 10 MB for safe buffering"——两者都要在**对端行为不可信**的前提下成立：对端可以发半行、一次发多行、发非 JSON、发一百万字节不换行、往 stderr 刷一整行合法 JSON-RPC response、忽略 SIGTERM、留孙进程。
- 包外应该看到什么？M4.3 的 client 在同包内消费 transport；如果把 `launchTransport` 一起公共导出，orchestrator / apps/cli 就能绕过 session 生命周期与事件映射直接起子进程。

## Decision

在 `packages/agent` 内切成两个模块，并明确它们对包外的可见性：**`src/transport.ts` 是纯协议 kernel（不 own 进程），`src/process-launcher.ts` 是唯一 spawn 点**。

`NdjsonTransport` 只按 envelope 的四个判别位分类入站消息：有 `method` 且有 `id` → 对端发起的 request（转发，不裁决）；只有 `method` → notification；只有 `id` → 结算 pending；两者皆无 → 报 `malformed_line`。`method` 全程是不透明字符串，因此本层的 fixture（`packages/agent/test-fixtures/echo-server.mjs`）刻意使用 `test/*` 虚构 method——**这个测试文件里出现真实 Codex method 就意味着边界被写穿了**。四条不变量：协议流与 stderr 物理隔离（各自独立 reader，stderr 永不调用 `handleProtocolLine`）；单行累积有界（默认 10 MiB，超限即释放缓冲并进入 discard-until-newline，之后恢复成帧）；一次调用只有一个了结算（response / read timeout / 进程退出三路竞争，`settled` 单次门闩，超时与退出都删除 pending）；listener 异常一律隔离。错误映射复用 M4.1 已冻结的 `AgentError`，不新增码：`response_timeout` / `response_error` / `port_exit` / `protocol_error` / `launch_failed` / `invalid_workspace_cwd`。

`launchTransport()` 的顺序是刻意的：**先**构造 child env、**再** `await gate.assertWorkspacePathSafe(cwd)`、**紧接着**同一同步续体里 `spawn("bash", ["-lc", command], { cwd, env, stdio: pipe×3, detached: true })`——校验与 spawn 之间不插入任何 await，避免自造 TOCTOU 窗口。command 字符串原样交给 shell，本层绝不 parse argv。gate 以**结构化接口** `WorkspacePathSafetyGate` 声明（`WorkspaceManager` 天然满足），既保持 `agent → workspace` 单向依赖，也让 launch 边界可被 stub 测试。

包出口按**方案 A**：`src/index.ts` re-export transport 的**类型与默认常量**，但 `launchTransport` / `createNdjsonTransport` **不**出现在公共面——包外只能通过 M4.3 的 client 间接触达 transport。

## Alternatives considered

- **把 transport 并进 Codex client（少一个模块）**：省一次抽象，但 `initialize` / `turn/*` 的 payload 知识会顺着同一个类扩散进来，§10.1 的 "Transport/framing: the protocol transport required by the targeted Codex app-server version" 就变成"随 Codex 版本重写整个 client"。协议漂移的着陆点必须是最小那层。
- **transport 直接依赖 `WorkspaceManager` 类**：能把 gate 调用简化成两行，但 launch 边界从此无法在不建真实 root 的情况下测试，且把 workspace 的全部公共面（hooks、removeWorkspace）拖进 agent 的类型依赖。结构化 gate 接口只承诺"会拒绝不安全的路径"这一件事。
- **在 launcher 里按 bash 退出码 127 判定 `codex_not_found`**：127 是 shell 的语义，不是 coding agent 的语义——任何自身以 127 退出的命令、或 `bash -lc` 里 `command -v` 之外的失败都会误判，而且"命令找不到"在 pass-through shell 下本来就无法与"agent 自己退出 127"区分。M4.2 宁可不映射：表现为 `port_exit`（message 携带 exitCode），`codex_not_found` 的判定留给 M4.5 runner 结合 §6.3 preflight 处理。
- **公共导出 `launchTransport`（方案 B）**：写起来更"完整"，代价是 orchestrator / cli 可以跳过 prompt 组装、session 生命周期与 `AgentEvent` 映射直接起进程——正是 §3 / §10.7 想分层隔开的事。
- **`child_process.exec` / 一次性读满再解析**：与 streaming turn 处理（§10.3）根本冲突，也让"超长行"退化成"整块内存"。
- **只 SIGTERM（不等窗口、不升级）或只 kill 直接子进程**：`bash -lc` 不 exec 时 codex 是 bash 的子进程，只 kill 直接孩子会留下持有 stdio 的孤儿，`close` 事件被拖住、fixture subprocess 残留。detached + 进程组 SIGTERM→有界等待→SIGKILL 与 M3.3 hook 执行层同一惯例，并被"后台孙进程随进程组一起消失"这条真实测试钉住。
- **用 `tsx` / `--experimental-strip-types` 跑 .ts fixture**：fixture 必须能被 `bash -lc node …` 直接执行，而仓库 engines 是 `node >= 20`（type stripping 是 22.6+ 且曾需 flag）。测试替身的可执行性不该依赖运行器的转译管线，因此 fixture 是 `.mjs`（并由 eslint 的 Node ESM block 单独覆盖），共享 harness 才留在 TS 侧接受 `tsc` 检查。

## Consequences

正面：

- §17.2 的 "agent launch cwd" 与 §17.5 的 framing / read timeout / stderr 三条从 planned 变成有真实 subprocess 入口的 `implemented`，`docs/conformance.md` 对应行翻转；M3.2 / M3.4 留下的"必须用真实 coding-agent 子进程验收"债务还清。
- M4.3 的 Codex client 拿到的是一个**只需要喂 method/params、只需要处理 response / notification / server-request 三种入站形态**的对端，协议词汇全部留在 adapter 里；换 Codex 版本（甚至换 agent 后端）不动 kernel。
- 恶意或坏掉的对端输出不再构成运维风险：不换行的 10 MiB+ 单行、非 JSON 行、伪造 stderr response、忽略 SIGTERM、`bash &` 孙进程都有对应的真实测试。
- 包外看不到 `launchTransport`，"runner 不越层"从约定变成编译期可见的事实。

负面与后续承诺：

- transport 与 launcher 现在有两份 option 结构（`LaunchTransportOptions` / `NdjsonTransportOptions`），M4.3 需要透传 `readTimeoutMs` 等；不要为此把两层再合并回去。
- `readTimeoutMs` 是 **per-launch** 生效（构造时定值），不是 per-request override；如果将来某个 method 需要更长窗口，需求应落成显式的 per-request 覆盖并写清新语义，不要靠调大全局值糊过去。
- 对端发起的 request 在 M4.2 只被**转发**，没有本地回信就悬挂到 `read_timeout_ms`——这是有意的：approval / user-input / tool 的裁决属 §10.5 documented policy（M4.4）。M4.4 必须显式处理每个已识别的 `ServerRequest` 形态，不得依赖 transport 兜底。
- 有界行采取"丢弃到下一个换行后恢复"的策略：一条被丢弃的协议消息不会被部分解析、也不会被恢复，但对端如果持续发送永不换行的字节流，本层会静默循环报告 `oversized_line`。这是"不被单个坏消息打死"与"检测到对端异常"之间的取舍，不做 backpressure 或主动断连（那属 M4.5 的 attempt 失败策略）。
- `stop()` 用进程组信号且等 `exit`/`close` 双路径；新增任何"再派生一个进程"的能力（如 provider-native tools、wrapper 脚本）都必须保持 detached + 进程组这条线，否则孤儿回归。
