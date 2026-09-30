# Agent Note: Codex Protocol Baseline and Agent Contract Layers
Status: accepted

## Problem

M4 是仓库第一次要与**外部演进中的协议**讲字节：`packages/agent` 必须与真实 Codex app-server 交换 JSON-RPC。在此之前仓库只有一条版本轴——[docs/upstream.md](../../../docs/upstream.md) 固定的 Symphony SPEC baseline（`openai/symphony@be10a1b`）。但 SPEC 自己在 §10 "Protocol source of truth" 写了裁决规则：*"If this specification appears to conflict with the targeted Codex app-server protocol, the Codex protocol controls protocol shape and transport behavior"*。也就是说：不固定"目标 Codex 是哪一版"，§10.4 / §10.6 的验收就无法判定，`codex.*` 配置字段该允许什么形状也无从回答，而每次上游漂移都会把 config / domain / orchestrator 一起牵动。

同时有三处具体的契约缺口：

1. **`CodexConfig` 的三字段（`approvalPolicy` / `threadSandbox` / `turnSandboxPolicy`）原先按 `string | null` 建模**。pinned schema（`rust-v0.159.2`）里 `AskForApproval` 是 string 与 `{"granular": {...}}` object 的 union，`SandboxPolicy` 是按 `"type"` 判别的 tagged object——string-only 类型**不能无损表达**配置文件里合法写的形状：要么拒绝它（破坏 §5.3.6 的 pass-through 语义），要么把它序列化成字符串再发给 Codex（wire 上是 string，Codex 期望 object，是失真）。
2. **agent 侧没有对外契约**：SPEC §10.6 列出九个推荐 error category、§10.4 列出事件清单，M5（orchestrator 分支 retry / terminal-state）与 M6（observability）需要一个不随 Codex payload 漂移的判别面。
3. **continuation 判定需要 tracker 语义**（active / terminal states、required labels、claim、retry），而 AGENTS.md 的硬约束是 agent 包**不得** import `@symphony/tracker`。

#37 的口径是"基线 + 契约对齐，不实现 runner"，因此本 Note 记录的是三条版本轴与契约层的**形状裁决**，执行细节留给 M4.2–M4.6。

## Decision

1. **两条独立版本轴**，都记在 [docs/upstream.md](../../../docs/upstream.md)：Symphony SPEC baseline 管**语义**（组件职责、配置字段、验收项），Codex app-server baseline 管**形状**（method、payload、framing）。Codex 轴固定到 tag `rust-v0.159.2`（annotated tag 对象 `8b9fa49`，tag 直接指向 commit `ff6aec96…`，已用 `gh api` 核实 tag→commit 关系），并列出 pinned commit 内的 schema source paths（`codex-rs/app-server-protocol/schema/typescript/` 下的 `v2/AskForApproval.ts`、`v2/SandboxPolicy.ts`、`v2/ThreadStartParams.ts`、`v2/TurnStartParams.ts`、`ServerRequest.ts` 等）。升级规则四条：**单独 PR**、在新 commit 重读全部 source paths 逐字段 diff、漂移只允许改 `packages/agent` 的 adapter / transport 层、同步文档并跑 `npm run gate`。
2. **只摘录形状类别，不复制枚举**：`packages/domain` 新增 `CodexPassThroughValue = string | Readonly<Record<string, unknown>>`，`approvalPolicy` / `turnSandboxPolicy` 改用它的 `| null` 形式；`threadSandbox` 保持 `string | null`——pinned `SandboxMode` 是纯 string union，schema 没有 object 能力就不给类型加（不做投宽）。
3. **config 校验只守 JSON-safety，不守枚举成员**：`readPassThroughValue` 接受 string 或 plain map 原样保留；`assertJsonSafeValue` 递归要求 null / string / boolean / **有限** number / list / plain map，并按完整路径报错（`codex.turn_sandbox_policy.networkAccess`）。理由是分工不同：序列化不失真是 **Symphony 的义务**（§6.2 last-known-good、§5.3.6 pass-through），枚举合法性是 **Codex 的裁决权**。被拒的形态都能造成 wire 失真或进程崩溃：`!!binary` → `Buffer`、`.inf` / `.nan` → 非有限数、`undefined` → 兄弟键静默丢失，而 YAML anchor alias 造出的**循环引用**会让 `JSON.stringify` 直接 throw——那不是"配置无效"，是把 crash-resistance 的不变量击穿。循环引用在递归中按 ancestor 路径检出并拒绝。
4. **错误面**：`AgentErrorCode` 前九条与 SPEC §10.6 逐字同名（不造第二套词汇），另加三条 implementation-defined：`approval_required`（headless policy 无法满足 approval）、`protocol_error`（字节不符合 pinned framing / payload 不可解释）、`launch_failed`（spawn 本身失败）。`AgentError` 只携带 Symphony 侧标识符（thread / turn / session id、PID、method 名、path），底层异常经 `cause` 保留且不构成判别面。
5. **事件面**：`AgentEvent` 的 `event` 取值是 Symphony 词汇（§10.4 清单，逐字采用），类型是 domain 的**开放 string 别名** `CodexEventName`——§10.4 是 "include, for example" 的开放集合，冻结成 enum 会随 Codex 漂移而破裂；`AGENT_EVENT_NAMES` 因此表述为"保证存在"而非"仅此这些"。`rateLimits` 沿用 domain 既有的 opaque `CodexRateLimits`（原样转发、不 schema 化），Codex method 名只以不透明诊断字段 `protocolMethod` 出现。
6. **continuation 以注入点定型**：`TurnCompletedContext`（issue 快照 + thread / turn / turnCount + 已映射的 `AgentEvent`）→ `ContinuationDecision = {kind:"stop"} | {kind:"continue"; issue}`，由 `ContinuationDecider` 提供，M5 注入。agent 包拥有"同一 live thread 上再启一个 turn"的执行能力，tracker eligibility 归注入方；本任务不加 runner 行为。
7. **边界由可执行断言守着**：`packages/agent/src/contracts.test.ts` 的结构测试扫描 domain / config / agent 三包的运行期源码，禁止出现 pinned schema 的类型名与字段名 token（`AskForApproval`、`SandboxPolicy`、`granular`、`sandbox_approval`、`writableRoots`…），禁止 agent import tracker / orchestrator / observability 或任何 `codex` 模块，并锁定 agent `package.json` 依赖集合恰为 config / domain / workspace。文档里的 Codex 类型表达式放在**测试不扫描**的 markdown 中，作为"为什么形状必须这样"的证据而非第二份 schema。

## Alternatives considered

1. **在 `CodexConfig` 里手抄 pinned enum**（`approvalPolicy: "untrusted" | "on-request" | "never" | GranularApprovalConfig…`）。否掉：§5.3.6 明确要求 pass-through；手抄的枚举是第二份会漂移的规范快照，升级 Codex 时要改 domain + config + 测试，而实际上 operator 写的东西只需要能原样到 wire。结构性测试还禁止这类 token 出现在运行期代码里。
2. **保持 `string | null`，要求 operator 把 object 写成字符串 / YAML 字符串标量**。否掉：配置里合法写出的 object 形状会被直接拒绝，等于 Symphony 比 Codex 更严格 yet 又没有语义收益；wire 上把 object 塞成 string 是失真，Codex 侧解不开。
3. **三字段一律标 `unknown` 原样透传**。否掉：`unknown` 允许 `Buffer`、非有限数、`undefined`、循环引用一路走到序列化——`JSON.stringify` 要么静默丢字段（`undefined`）、要么 throw（cycle），"配置里写的" ≠ "发给 Codex 的"。pass-through 的承诺是**无损**，不是**无校验**；本决策只做无损所必需的最小校验（JSON-safety + 无环），并给出可判定的路径化错误。
4. **vendor / 代码生成 Codex 的 TS schema 进 `packages/agent`**。否掉（当前）：把上游 repo 的文件布局、ts-rs 生成物与 license 刷新负担变成构建依赖，而契约层需要的是**形状类别**而非字段清单；一旦 vendored，"公共类型不复制 Codex generated schema"这条验收就只能靠自觉。落地的替代是：`docs/upstream.md` 记 path + commit，按需现读，README 只摘录三条类型表达式作证据。若将来漂移痛到需要 codegen，再单独立项（那属于协议升级 PR，不是业务 PR）。
5. **照抄 Symphony 官方参考实现（Elixir）里观测到的 wire payload**。否掉：参考实现是**另一条版本轴上的消费者**，它自己绑的是它发布时的那一版 Codex schema，payload 键名、`thread/start` vs `turn/start` 的字段集合、`TurnStatus` 取值都随 Codex 漂移；SPEC §10 把 wire 形状的裁决权明确交给"Codex protocol"，不是"参考实现当时看到的样子"。我们的权威是 pinned commit 内生成的 schema 文件本身，读的是 `v2/AskForApproval.ts` / `v2/SandboxPolicy.ts` 而不是某次对话录下的 JSON。参考实现只用于设计对照（§10 的 resolution：比较组件粒度与测试方式），不构成规范。
6. **`AgentEvent` / `AgentError` 直接透出 raw Codex payload（或 `payload: unknown`）**。否掉：M5 / M6 将被迫理解 app-server 协议才能分支，Codex 任何字段改名都是跨包破坏性变更；契约层的意义正是把"哪个 turn 结束了、为什么失败、用了多少 token"翻译成 Symphony 词汇。诊断需要 raw 时走 `summary`（humanized、脱敏、非判别面）与 `cause`（原始异常），而不是把结构暴露成公共 API。
7. **`event` 用闭合 union 而非 domain 的 `CodexEventName = string`**。否掉：§10.4 是开放示例集合，闭合 union 会在第一个未列出的事件上编译失败，且与 M1.1 已合入 domain 的"不固化会漂移的枚举"决策冲突。改为运行时常量表 `AGENT_EVENT_NAMES` + `satisfies` 保证拼写不漂。
8. **把 continuation 判定做成 agent 包内的默认策略（读 `ServiceConfig` 的 active / terminal states 自行判断）**。否掉：eligibility 的语义归 tracker adapter（provider 原生状态拼写、`dispatchable`、required labels 匹配），agent 包 import tracker 是 AGENTS.md 的硬禁止；而 core 也不该预校验（§11.3 adapter-owned）。注入点是唯一同时满足"agent 拥有 turn 生命周期、orchestrator 拥有 coordination"的形状。

## Consequences

- **正面**：`codex.approval_policy` 写 granular object、`codex.turn_sandbox_policy` 写 `workspaceWrite` 结构化对象现在能**无损**到 wire（回归测试逐字比对 `JSON.stringify` 顺序）；旧的 string 配置行为有回归测试锁定，升级 Codex 枚举成员不要求改 Symphony 类型；M5 / M6 有了稳定判别面（`code` / `event`），不必读 Codex 文档就能分支；"不复制 schema"从一句约定变成 CI 里的结构断言。
- **负面与承诺**：
  - pass-through 校验只保证 JSON-safety，**不保证 Codex 接受**——形状对了但枚举错了（`approval_policy: on-fires`）要到 runtime 才由 Codex 报错。这是 §5.3.6 pass-through 语义的自觉代价，不补静态枚举校验。
  - `CodexPassThroughValue` 的 object 分支接受任意 nested map，因此 config 层无法区分"合法的 granular 对象"与"拼错的 granular 对象"；键名拼写错误的可观察症状是 Codex 侧的 `response_error` / `protocol_error`，随 M4.4 才有诊断信息。
  - 本机装了哪个 Codex 与本仓库无关：**不得**因本地 CLI 升级而静默改变 baseline；升级必须走上面四条规则、单独 PR。
  - 后续里程碑不得把 raw Codex JSON 提升为公共契约字段；新增 error code / event name 属契约变更，需同步 README、`docs/conformance.md` §10 / §17.5 与本 Note。
  - domain / config 的"只校验形状"纪律同样适用于未来 `codex.*` 新字段：先问"wire 上是什么形状类别"，只有类别变化才动 `@symphony/domain`。
- **本任务明确不做**（留给 M4.2–M4.6）：child process launch、JSON-RPC transport 与 framing、`initialize` / `thread/start` / `turn/start` 往返、`ServerRequest` 的 approval 处理与自动满足 policy、`turn/*` → `AgentEvent` 的映射、continuation 执行与 `agent.max_turns` 强制、workspace / hook / prompt 组装。`§17.2` "agent launch cwd" 与 `§10` / `§12` 主体仍非 implemented。
