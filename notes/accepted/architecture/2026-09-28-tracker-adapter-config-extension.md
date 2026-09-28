# Agent Note: config ↔ tracker 的 tracker 配置校验扩展契约（M2.1）
Status: accepted

## Problem

M1.3 把 `tracker.kind` 的 supported-adapter 校验显式推迟到"需要注册表的时候"
（`notes/accepted/architecture/2026-09-27-config-resolution-contract.md` Decision 2：
缺失 → `""` 哨兵，resolution 不报错，preflight 以空串 = 未配置报错）。M2.1 落地
provider 无关的 tracker read kernel（SPEC §11.1）与 adapter 注册/选择机制时，必须
回答一个跨包问题：**`@symphony/config` 怎么调用 selected adapter 的校验，而不引入
provider knowledge？**

约束互相拉扯：

- 根 `AGENTS.md` 的依赖方向把 `config` 与 `tracker` 放在同一层（两者 → `domain`），
  反向禁止；issue 把 "`@symphony/config` **不 import** `@symphony/tracker`" 列为
  硬验收项。
- §6.3 / §17.1 要求 `tracker.kind` 在 effective config preflight 就失败，
  `tracker.provider` 的 unknown keys 由 core 保留、由 **selected adapter** 校验。
  把 `if (kind === "github")` 写进 config 能最快满足这条，但直接违背设计边界。
- §11.4 的错误 category 名是跨实现契约（`unsupported_tracker_kind` /
  `invalid_tracker_config` / `missing_tracker_secret` 三个属于配置阶段），config 的
  错误契约是单一 `SymphonyConfigError` + `code` 判别式（M1.2 起固化）。
- 跨包"不复制类型或配置语义"（`AGENTS.md` 规则 4）与"两包不得互相 import"天然冲突：
  扩展点的输入输出形状必须同时存在于两侧。
- §6.2 的 reload 语义（invalid reload 保留 last-known-good + operator-visible
  error）必须自动适用于 tracker 配置错误，不能在 config 里为 tracker 另开一条路径。

## Decision

1. **契约由 `@symphony/config` 定义，由 `@symphony/tracker` 实现**：config 新增
   `src/tracker-extension.ts`，声明三个结构化类型
   （`TrackerConfigValidationContext` / `TrackerConfigExtensionFailure` /
   `TrackerConfigExtension`），并把它作为**可选**注入点
   `ResolveServiceConfigOptions.trackerExtension`（经
   `LoadEffectiveWorkflowOptions` → `WatchWorkflowOptions` 继承，热重载零改动获得）。
   tracker 侧的 `TrackerAdapterRegistry.createConfigExtension()` 产出同形对象。
   两包各自只依赖 `domain`，谁都不 import 对方。
2. **不注入 = M1 行为逐字不变**。core resolution 不依赖任何注册表：裸
   `WORKFLOW.md` 仍得到 §6.4 全量默认值的 `ServiceConfig`，任意未知 `kind` 原样通过。
   这样 M1 已冻结的"空 front matter 合法"语义不被 M2.1 悄悄收紧。
3. **preflight 是 post-resolution 阶段**：core typed 校验（tracker → polling → …
   → codex）全部成功之后，才把 resolved `tracker` 与本次 resolution 的 `env` 交给
   扩展点。adapter 拿不到半 resolved 的配置，core 也不借 adapter 之手校验自己的字段。
4. **失败用返回值传递，不用异常；抛出物在注入边界被收敛**：`validateTrackerConfig`
   返回 `TrackerConfigExtensionFailure | undefined`。config 于是无需 `instanceof` 一个
   tracker 的类（那会要求 import），也不会把 adapter 的内部缺陷误报成一次配置失败的
   **category**。但"缺陷就让它向上抛"这个初版决定在代码审查中被证伪：扩展由调用方注入
   （#19 的 adapter 代码），属于系统边界，非 `SymphonyConfigError` 会沿
   `resolveServiceConfig` → `reloadNow` 的 `!(error instanceof SymphonyConfigError)`
   分支重新抛出，逃出 `setInterval` 回调成为 uncaughtException —— 一次 `WORKFLOW.md`
   编辑即可终止长运行服务，违反 §6.2 "Invalid reloads MUST NOT crash the service"。
   现在的裁定：`resolveServiceConfig` 把扩展抛出物一律收敛为
   `SymphonyConfigError("invalid_tracker_config", …, { cause })`，message 写明
   "extension defect"。缺陷与真实配置失败仍靠 message + `cause` 区分（有测试锁定两面）。
5. **三个配置阶段 category 名进入 `ConfigErrorCode`**（而非"单码 + message 区分"）：
   `unsupported_tracker_kind` / `invalid_tracker_config` / `missing_tracker_secret`
   与 §11.4 一字不差，仍抛单一 `SymphonyConfigError`，`code` 即稳定判别式，`path`
   为 workflow 文件绝对路径，`cause` 可选保留 adapter 侧原始异常。
   `invalid_config` 与 `invalid_tracker_config` **不合并**：前者是 core §5.3 / §6
   的 typed shape 校验，后者是 adapter-owned 语义校验；合并会让 §17.1 "validated
   through the selected adapter" 失去可追溯性。
6. **adapter-owned 的默认值不回写 `ServiceConfig`**：`tracker.active_states === null`
   意味着"采用所选 adapter profile 文档化的默认"（§5.3.1 / §6.4），该默认值由
   `TrackerAdapterProfile.defaultActiveStates` / `defaultTerminalStates` 提供、
   在 `TrackerAdapterRegistry` 内解析进 `TrackerAdapterContext` 喂给 adapter。
   `ServiceConfig` 形状保持 M1.1 冻结，domain 不增加 provider-specific 类型。
7. **profile 的校验/解析以抛出 `TrackerError` 表达失败**（§11.4 明确允许
   language-native exception 代替 literal error object）；registry 把
   `TrackerError` 的 category 原样呈现，把**非** `TrackerError` 的抛出归一化为
   `invalid_tracker_config` 并经 `cause` 保留原异常——§11.4 要求的"public form →
   category 映射稳定"由 registry 兜底，profile 不必各自实现。
8. **registry 无全局单例**：`TrackerAdapterRegistry` 是实例，由组合根持有
   （M2.1 = 测试，M6 = `apps/cli`）。`BUILT_IN_TRACKER_ADAPTER_PROFILES` +
   `createTrackerAdapterRegistry(extra)` 是 #19 的稳定注册点；`kind === ""` 与重复
   kind 在注册期即被拒绝（空串是保留哨兵，注册它会让"未配置"静默通过）。
9. **`""` 哨兵在扩展点内解释**：`tracker.kind === ""` → `invalid_tracker_config`
   （"未配置"），**不是** `unsupported_tracker_kind`。M1.3 的哨兵语义因此不需要
   config 自己报错，也不需要 domain 改形状。
10. **跨包形状各自声明**：三个结构化类型在 config 与 tracker 各写一份（值域名字相同、
    均来自 SPEC §11.4）。由 `packages/tracker/src/config-integration.test.ts` 做
    **双向**赋值断言锁定漂移；`@symphony/config` 只作为 tracker 的 **devDependency**
    出现在测试里，运行期依赖方向不变。

## Alternatives considered

- **在 `@symphony/config` 里硬编码 provider 分支**（`if (kind === "github") validateGithub()`）
  否——issue 设计边界与 §11.2 都要求 provider knowledge 留在 adapter；且每加一个
  provider 都要改 config，§17.1 第二行（"validated through the selected adapter"）
  在结构上就不可能成立。
- **让 `@symphony/config` import `@symphony/tracker`**（tracker 单向依赖 config 或反之）
  否——issue 把"config 不 import tracker"列为验收项；反向让 tracker import config
  会把 config 变成 adapter 的构造依赖，M5 的 orchestrator 接线（→ config + tracker）
  也会因此出现两个方向的耦合。
- **把扩展契约放进 `@symphony/domain`**（唯一权威类型层，彻底消除两份声明）
  否——`domain` 是 §4 领域实体层，不放跨包 DI 接口；且 §17.1 的三项错误 category 是
  **配置阶段**语义（SPEC 把它们列在 §11.4 tracker 错误契约里），抬进 domain 等于让
  §4 契约层承载 §11 的实现细节，M1.1 冻结的建模约定会先破例。两份声明的漂移风险由
  Decision 10 的编译期双向断言压住，代价小于把 domain 变成接口仓库。
- **`trackerExtension` 抛异常而非返回 failure**：否——config 需要 `instanceof
  TrackerError` 才能判别，而那要求 import tracker；返回结构化 failure 是唯一让
  "零 import + 稳定判别"同时成立的形式。
- **三个 tracker category 复用 `invalid_config` + message 区分**：否——本仓已固化的
  错误契约是"消费方按 `code` 精确分支"（M1.2 loader Note、M1.4 模板两码走同一路径）；
  message 是诊断面、不是判别面，文案可演进。
- **profile 默认状态直接写回 `ServiceConfig.tracker.activeStates`**：否——M1.1 冻结的
  resolved 语义是 `null = 交给 profile 默认`；写回会让 config 的产出依赖 adapter
  知识（§17.1 "Config defaults apply when OPTIONAL values are missing" 的 core 默认
  表也会凭空多出 provider 值）。M5 scheduler 需要 resolved states 时经
  `registry.create()` 产出的 context 获取。
- **`tracker.kind` 匹配做 trim + lowercase**：否——§11.2 要求 profile 声明 "exact
  supported `tracker.kind` value"；归一化会让 `github` 与 `GitHub` 变成同一个 adapter，
  而 SPEC 没给这条等价关系。拼错 kind 报 `unsupported_tracker_kind` 并在 message 里
  列出支持面，诊断已足够。
- **registry 用模块级全局单例**（`registerAdapter()` 到处调用）：否——profile 集合会变成
  import 顺序的函数，测试之间互相污染，apps/cli 也失去"显式装配"这一 §18 要求。
- **扩展抛出物处理**（审查 blocker 的三个候选）：
  - *原样向上抛*（本 Note 初版决定）：否——§6.2 是 MUST，"extension 是内部缺陷"不构成
    让定时器回调崩溃的理由；且 `reloadNow` 对非 typed error 的重抛是**既有**契约
    （loader/resolver 的自有代码确实不该被吞掉），把外部注入的代码塞进那条通道等于用
    内部信任级别对待边界输入。
  - *catch 后只记日志、继续用旧 config*：否——静默吞掉缺陷会让 #19 的 adapter bug
    表现为"配置没生效"，比崩溃更难查；而且 §6.2 要求 operator-visible error，日志不在
    config 的错误面里。
  - *catch 后转 `SymphonyConfigError`*（采用）：启动期仍是 typed fail-fast（§6.3），
    reload 期自动走既有 last-known-good + `error` 事件路径，零新增机制。代价是缺陷与真实
    配置失败共用 `invalid_tracker_config`，靠 message + `cause` 区分——可接受，因为
    `cause` 保留原抛出物、诊断链没断。

## Consequences

- config 的错误面扩大到 10 个码；消费方 MUST 容忍未知码并按 `code` 分支（既有约定）。
  M6 的 observability / apps/cli 若要把 `code` 映射成人话，须覆盖三个新码。
- #19 落地 GitHub adapter 时：往 `BUILT_IN_TRACKER_ADAPTER_PROFILES` 加 profile 即可
  （验收 4 有测试证明"注册第三个 kind 不需要动 config"）；provider 键、
  `GITHUB_TOKEN` 之类的 secret/env fallback、active/terminal 默认值全部写在 profile 里，
  并按 §11.2 在 `packages/tracker/README.md` 发布 compact profile（8 项齐全）。
- §11.1 的 malformed-record 策略（state-list 可省略单条畸形记录并记日志、ID-refresh
  MUST fail）与 provider-side scope / pagination、§11.3 的 payload 归一化尚未落地：
  它们要求真实的 provider payload，归 #19 / #20。conformance 已为此单列
  `planned M2（#19 / #20）` 行，§11.1 的 `implemented` 行只覆盖调用面（两个
  operation 的接口 + 空输入 MUST + normalized `Issue` 形状），#19 不要把 §11.1 当作已收口。
- 两侧形状各自声明是**长期代价**：任何一方改字段名/值域，
  `packages/tracker/src/config-integration.test.ts` 的双向赋值断言会编译失败——这是
  刻意的摩擦，不要靠 `as unknown as` 绕过。若将来出现第三个消费方（例如 M5 想在
  scheduler 侧复用同一契约），应重新评估把契约上移到某个下游包，而不是继续加声明份数。
- `trackerExtension` 是 config 唯一的"外部校验注入"通道：不得再加第二个 hook
  （如 `pollingExtension`）而不先写 Note；workspace / agent 的同类需求应复用本模式并
  记录为何不需要共享类型。
- 扩展点**仍须以返回值表达失败**：抛出物虽然被 config 接住、不再击穿 §6.2
  crash-resistance，但会一律落到 `invalid_tracker_config`，丢掉
  `unsupported_tracker_kind` / `missing_tracker_secret` 的判别精度。返回值是唯一的
  "稳定 category"通道；抛出通道只用于报告缺陷。
