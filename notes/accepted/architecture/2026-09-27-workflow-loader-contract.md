# Agent Note: WORKFLOW.md loader 的公共契约与边缘语义（M1.2）
Status: accepted

## Problem

M1.2 在 `packages/config` 从零实现 SPEC §5.1–§5.3 的 workflow 发现与基础解析，产出
`@symphony/domain` 的 `WorkflowDefinition`。SPEC 明确了主路径（显式 path 优先、默认
cwd 下 `WORKFLOW.md`、无 front matter → 空 config、front matter 根必须是 map、正文
trim），但若干边缘情形未逐字规定；父 issue §7 要求第三方异常不作为对外契约。这些
选择会被 M1.3（typed resolution）、M1.4（模板渲染 / 热重载）与所有下游消费方依赖，
属跨包契约，须一次定死并记录，避免后续里程碑各自漂移。

## Decision

1. **公共 API**：唯一出口 `src/index.ts` 暴露 `loadWorkflow(options?: { path?; cwd? })`
   （同步 `readFileSync`）、`SymphonyConfigError`、`ConfigErrorCode`。`cwd` 可注入
   （默认 `process.cwd()`），满足"测试不依赖机器环境"；返回类型 `WorkflowDefinition`
   仍由 `@symphony/domain` 权威定义，本包不重声明、不重复 re-export。
2. **错误契约**：单一 `SymphonyConfigError`（`extends Error`）携带判别式 `code`、已解析
   绝对 `path`、以及 `cause`（保留底层 fs / YAML 异常）。M1.2 只用 SPEC §5.5 的三个码：
   `missing_workflow_file` / `workflow_parse_error` / `workflow_front_matter_not_a_map`。
   联合类型对 M1.3 / M1.4 追加新码开放，消费方须容忍未知码。
3. **missing vs read failure 合流**：ENOENT 与 EACCES / EISDIR 等读取失败统一用
   `missing_workflow_file`（§5.1 原文"If the file cannot be read, return
   `missing_workflow_file`"），具体 fs 错误经 `cause.code` 区分，不新增顶层码。
4. **config = front matter 根对象本身**（不嵌套在 `config` key 下，§5.2），且是**未经
   校验的原始 YAML 值**；unknown top-level keys 原样保留、不校验、不报错（§5.3 forward
   compatibility，丢弃会破坏 extension）。schema 校验 / 默认值 / typed 化归 M1.3。
5. **边缘语义**（SPEC 未逐字规定，本包定死）：
   - 无 front matter（首行非 `---`）→ 整篇为正文、config 空对象；正文中间的 `---`
     （Markdown 水平线）不触发 front matter。
   - 空 front matter 块（`---` 紧跟 `---`）或仅注释 front matter（YAML → `null`）→
     按空 config 处理，**不**报 `workflow_front_matter_not_a_map`（对齐 §5.2"缺 front
     matter 用空 config map"的语义；空块不携带任何配置键）。
   - 未闭合 front matter（有起始无结束 `---`）→ `workflow_parse_error`（避免 YAML 文本
     静默漏进 prompt）。
   - 非 map 根（list / 标量 / Date 等非 plain object）→ `workflow_front_matter_not_a_map`。
   - 空正文 → `promptTemplate: ""`，不报错（空正文 fallback 策略属 §5.4 / M1.4）。
   - 定界符 `---` 容忍行尾空白；剥离前导单个 BOM；CRLF 归一为 LF；`promptTemplate`
     只 trim 正文首尾边界，不改内部行。

## Alternatives considered

- **每 code 一个 Error 子类（`MissingWorkflowFileError` 等）**：否——判别式 `code` 已足够
  分支，子类会膨胀 API 面且 `instanceof` 链对未知码不友好；单类 + `code` 联合更利于
  M1.3 / M1.4 扩展且消费方 `switch (err.code)` 即可。
- **空 front matter 块按 `workflow_front_matter_not_a_map` 报错**（严格照 §5.2"非 map
  即错误"，`null` 也是非 map）：否——`---\n---` 是常见的"无配置"写法，报错会对合法
  仓库契约误伤；按空 config 处理与"front matter absent → 空 map"同源，语义更一致。
  该分歧点在此定死，M1.3 不得反过来把空块当校验失败。
- **未闭合 front matter 当作"无 front matter"整篇进 prompt**：否——会把 `foo: bar`
  等 YAML 文本静默塞进 promptTemplate，掩盖用户书写错误；报 `workflow_parse_error`
  更早暴露问题。
- **`loadWorkflow` 做成 async（`fs/promises`）**：否——M1.2 无并发加载需求，同步 API
  更简单且与"从文件路径入口 load(path) 测起"的测试哲学一致；热重载（M1.4）若需异步
  可另加 async 变体，不改本同步入口的契约。
- **本包 re-export `WorkflowDefinition` 以省一处 import**：否——领域类型唯一权威在
  domain（standing order 4 / M1.1 Note），re-export 会让消费方误以为 config 拥有该类型。

## Consequences

- 下游只经 `@symphony/config` 的 `loadWorkflow` 加载 workflow、只经 `SymphonyConfigError`
  的 `code` 分支错误，不得捕获原始 fs / YAML 异常，也不得自行解析 `WORKFLOW.md`。
- M1.3 在此 `config`（原始 YAML）之上做 typed resolution，**不得**改变本 Note 定死的
  边缘语义（空块 = 空 config、未闭合 = parse error、unknown keys 保留）；需要新错误码时
  向 `ConfigErrorCode` 联合追加并更新本包 README 与 conformance。
- 新增 `code` 时消费方须容忍未知码（不 `switch` 到 default 即崩）。
- `missing_workflow_file` 同时覆盖"缺失"与"不可读"是契约的一部分；需要区分时读
  `cause`，不得新增第二个顶层码。
