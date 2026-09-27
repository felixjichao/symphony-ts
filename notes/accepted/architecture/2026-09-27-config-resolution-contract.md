# Agent Note: typed config resolution 的管道语义与边缘裁定（M1.3）
Status: accepted

## Problem

M1.3 在 `packages/config` 实现 SPEC §6.1 resolution 管道：把 M1.2 的原始 front
matter（`WorkflowDefinition.config`）解析为 domain 已定型（M1.1 冻结形状）的
`ServiceConfig`（§6.4 全部 23 个 core fields）。SPEC 给了主路径（defaults →
显式 `$VAR` → coerce/validate、env 不得全局覆盖 YAML、by-state 归一化 + 无效条目
忽略），但若干跨里程碑依赖的裁定未逐字规定：`tracker.kind` 缺失时 resolution 是否
报错、`$VAR` 作用于哪些字段、两种 invalid-value 策略如何并存、显式 `null` / 空串 /
`~user` / key 冲突等边缘。这些会被 M1.4（热重载复用 resolver）、M2（adapter 读
`provider` / preflight 读 `kind`）、M5（scheduler 用 by-state map）直接依赖，须一次
定死，避免后续里程碑各自漂移。

## Decision

1. **公共 API**：`resolveServiceConfig(raw, { workflowDir, env?, home?, sourcePath? })`
   为纯 resolver（无 IO；env 默认 `process.env`、home 默认 `os.homedir()`，均可注入），
   M1.4 reload 直接复用；`loadEffectiveWorkflow({ path?, cwd?, env?, home? })` 为文件级
   组合入口，与 `loadWorkflow` 共用同一路径解析 helper（`resolveWorkflowPath`，包内
   导出不进 `index.ts`），返回 `{ definition, serviceConfig, workflowPath }`。
2. **`tracker.kind` 缺失 → resolution 成功，`kind: ""`（哨兵）**。§5.3.1 的 REQUIRED
   限定 "for dispatch"；§6.3 把 "kind present & supported" 列为 dispatch preflight 项，
   若 resolution 已保证 present 则 preflight 冗余；且 M1.2 已冻结"空 front matter =
   空 config"——缺 kind 即报错会让裸 `WORKFLOW.md` 永远得不到 resolved config，与
   NEST-47 验收 1 冲突。supported-adapter 校验需注册表 → M2。M2 preflight / M5
   scheduler 须以"空串 = 未配置"呼应。
3. **核心层 env / path expansion 仅作用于 `workspace.root`**。§6.1 step 4 字面通用，
   但 coercion semantics（"expansion only to values intended to be local filesystem
   paths"）+ §17.1（"$VAR for path values"）把它收窄：`codex.command` 原样保留
   （shell 命令字符串不改写），`tracker.provider` 内容原样、其 `$VAR` / secret 解析归
   所选 adapter（§6.1 "adapter-local, not a cross-provider convention"）——不建立跨
   provider 的隐式 env fallback。整数字段出现 `$VAR` 字符串 → `invalid_config`
   （无 env→number 隐式 coerce）。
4. **`$VAR` 语法**：`$NAME` 与 `${NAME}` 均识别（NAME = `[A-Za-z_][A-Za-z0-9_]*`），
   支持一值内多处内嵌展开（§6.1 "explicitly contain"）；`$` 后跟非法变量名字符
   （如 `$5`）不是引用、原样保留；无 `$$` 转义。引用的变量**未设置或为空串** →
   `missing_env_reference`（稳定 typed error，message 携带变量名；空串按 missing，
   对齐 §5.3.1 secret "empty = missing" 精神）。
5. **双 invalid-value 策略并存（SPEC 原文，不得统一）**：`agent.max_turns` 等字段
   非法 → `invalid_config` fail-fast（按 tracker → polling → workspace → hooks →
   agent → codex 的文档序抛第一个，message 携带字段路径）；
   `max_concurrent_agents_by_state` 的非法条目（非数值 / 非整数 / 非正数）静默忽略。
   by-state key 经 domain `normalizeIssueState`（trim + lowercase）归一化（与 scheduler
   的 state 比较同源，不另写一份）；归一化后冲突 last-wins——"序"**定义为 JS 对象键
   迭代序**（loader 产出 plain object）：与 YAML 文档序一致，整数样 key（如 `"7"`）
   除外，V8 将整数样键按升序前置，冲突对含整数样 key 时以迭代序为准（有测试锁定；
   真实 provider state 名均为词语，无实际影响）。归一化后为空串的 key 视为非法条目
   忽略；map 本身非 plain object → `invalid_config`（section 形状仍是 typed 的，
   "忽略"只针对条目）。
6. **数值严格度**：数值字段必须是真正的 YAML number 且为整数；并发 / 超时 / 间隔类
   一律正数（`0` 也报错，含 `read_timeout_ms` / `max_retry_backoff_ms`）。唯一例外
   `codex.stall_timeout_ms` 允许任意整数（`<= 0` = 禁用 stall 检测，§5.3.6 显式语义）。
7. **显式 `null` = 未配置**：字段或 section 为 `null`（含 YAML 裸 `~`——YAML 里它是
   null 字面量）按缺失处理、走默认值 / `null` 语义；与"空 front matter 块 = 空
   config"同源。例外：`workspace.root: ""`（空串 / 纯空白）→ `invalid_config`
   （root 必须是非空路径，空串 resolve 成 workflowDir 属静默误读）。要指 home 须写
   引号形式 `"~"` 或 `~/…`；`~user/…` **不展开**（无 portable 的 user-home 查询，
   按字面路径段随相对路径规则解析）。
8. **unknown keys 两级同策略**：top-level unknown keys 原样保留在
   `definition.config`（M1.2 已冻结）；已知 section 内部的 unknown 字段（如
   `agent.max_turn` 拼错）忽略、不报错——与 top-level forward-compat 策略一致，严格
   模式会把上游新增字段变成 breaking change。
9. **pass-through 字段不建枚举**：`codex.approval_policy` / `thread_sandbox` /
   `turn_sandbox_policy` 缺失 → `null`，present 仅校验 string（§5.3.6 SHOULD "not
   rely on a hand-maintained enum"）；`active_states` / `terminal_states` present 须
   string 列表、元素原样保留（trim / 大小写不敏感匹配是 scheduler 语义，M5）。
10. **错误码**：向 `ConfigErrorCode` 联合追加 `invalid_config` 与
    `missing_env_reference`（loader Note Consequences 已授权该路径）；沿用单类
    `SymphonyConfigError` + `code` 判别式。`path` = workflow 文件绝对路径（纯
    resolver 未给 `sourcePath` 时 = `workflowDir`）；字段路径与变量名进 message
    （类形状 code/path/cause 不变）。
11. **手写校验，零新增运行时依赖**（`node:os` / `node:path` 内置足够），维持
    "唯一运行时依赖 `yaml`" 现状；不改 domain `ServiceConfig` 形状（M1.1 冻结）。

## Alternatives considered

- **引入 zod / valibot 等 schema 库**：否——验收要求"effective config 不泄漏第三方
  parser/schema 异常作为主要契约"，schema 库的异常需要再包一层转换，收益归零；23 个
  字段手写校验完全可控、报错可精确到字段路径，且不破坏仓库"唯一运行时依赖"现状。
- **`$VAR` 展开作用于所有 string 字段（照 §6.1 step 4 字面）**：否——coercion
  semantics 与 §17.1 把它限定为 path values；对 `codex.command` / hook 脚本展开会让
  shell 文本里的 `$VAR`（本应由 `bash -lc` 在运行时解释）被提前替换，语义双写必漂移。
- **`tracker.kind` 缺失 → `invalid_config`（严格照 "REQUIRED"）**：否——见 Decision 2，
  与 §6.3 preflight、M1.2 冻结语义、NEST-47 验收 1 三处冲突。
- **聚合全部非法字段后一次报错（而非 fail-fast）**：否——错误类形状（单 code + 单
  message）不携带结构化列表，聚合只能拼长 message，消费方仍须解析文本；fail-fast +
  字段路径已满足诊断需求，M1.4 reload 失败即保留 last-known-good，也不依赖聚合。
- **by-state 非法条目报 `invalid_config`（与其余字段统一）**：否——SPEC 原文
  "are ignored"，与 `max_turns` 的 "fail validation" 是刻意对比；统一任一侧都违背原文。
- **`workspace.root: ""` 按默认值处理（与显式 null 同策略）**：否——空串是"写了但
  写错"（如 env 拼接事故），静默落回默认目录会把 workspace 建到意外位置；报错更早暴露。
- **整数样 by-state key（如 `"7"`）视为 invalid entry 忽略，以保严格 YAML 文档序**：
  否——SPEC 的"忽略"只按 value 定义（非正整数），按 key 形状过滤是超出原文的收紧，
  且纯数字 state 名理论上可能存在；把 last-wins 的"序"如实定义为 JS 对象键迭代序
  并用测试锁定即可消除 M5 引用歧义，不改行为。

## Consequences

- 下游（M1.4 reload、M2 adapter、M5 scheduler、apps/cli）只经
  `loadEffectiveWorkflow` / `resolveServiceConfig` 获取 typed config，不得自行解析
  front matter、不得对 `provider` 之外的字段再做 env 展开。
- M2：adapter 从 `tracker.provider`（原始 map）自行校验键与 secret `$VAR`；preflight
  以 `kind === ""` 为"未配置"报错，并负责 supported-adapter 校验（conformance §11 行，
  本里程碑不预标）。
- M5：scheduler 的 state 匹配必须走 `normalizeIssueState`（by-state key 已按同源归一化）；
  空串 key 不存在于 resolved map。
- M1.4：reload = 重新 `loadWorkflow` + `resolveServiceConfig`，任一错误 → 保留
  last-known-good；resolver 保持纯函数是本复用的前提。
- 新错误码消费方须容忍未知码；`invalid_config` 的 message 是诊断面、非判别面
  （判别只用 `code`），文案可演进。
