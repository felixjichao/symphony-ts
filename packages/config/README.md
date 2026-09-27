# @symphony/config

## Purpose

SPEC **§5 Workflow Specification (Repository Contract)** 与 **§6 Configuration Specification** 的 owner 包，对应 §3 的 Workflow Loader + Config Layer：`WORKFLOW.md` 发现与解析（YAML front matter + 原始 prompt 正文）、front matter schema（追踪过滤、轮询间隔、目录根、生命周期脚本、并发上限、沙箱策略）、typed config 校验、默认值合并、`$VAR` 环境解析、tilde 展开与相对路径规范化、严格模板渲染、无效配置的类型化报错与安全回退（验收项见 §17.1）。

**新增 / 修改 WORKFLOW front matter 字段的唯一落点在本包。**

## Public API（M1.2）

公共出口是 `src/index.ts`（唯一 API 面）。M1.2 落地 SPEC §5.1–§5.3 的 workflow
发现与基础解析：

```ts
import { loadWorkflow, SymphonyConfigError } from "@symphony/config";

const def = loadWorkflow({ path: "/repo/WORKFLOW.md" }); // 或 loadWorkflow({ cwd })
// def.config          → front matter 根对象（未经校验的原始 YAML 值）
// def.promptTemplate  → trim 后的 Markdown 正文
```

- `loadWorkflow(options?)`：同步发现并加载 `WORKFLOW.md`，返回 `@symphony/domain`
  的 `WorkflowDefinition`。路径优先级（§5.1）——显式 `options.path` 优先（相对路径按
  `options.cwd` 解析）；未提供 `path` 时用 `options.cwd`（默认 `process.cwd()`）下的
  `WORKFLOW.md`。`cwd` 可注入，测试不依赖机器环境。
- `SymphonyConfigError` / `ConfigErrorCode`：稳定 typed error（§5.5）。第三方 fs /
  YAML 异常不越过包边界，一律转换后经 `cause` 保留、`path` 携带已解析绝对路径。
  M1.2 的码：`missing_workflow_file`（缺失或不可读，含 ENOENT / EACCES / EISDIR）、
  `workflow_parse_error`（YAML 语法错误或 front matter 未闭合）、
  `workflow_front_matter_not_a_map`（根为 list / 标量）。

**M1.2 产出的 `config` 是未经校验的原始 YAML 根对象**——不做 schema 校验、默认值、
`$VAR` 解析或路径规范化（这些归 §6 / M1.3），也不做模板渲染（§5.4 / M1.4）。

### 边缘语义（本包定死，M1.3 / M1.4 不得各自漂移）

SPEC 未逐字规定的边缘情形，本包择一并固化（决策记录见
[notes](../../notes/accepted/architecture/2026-09-27-workflow-loader-contract.md)）：

- **无 front matter**（首行非 `---`）→ 整篇为 prompt body，`config` 为空对象；首行
  之后出现的 `---`（Markdown 水平线）不触发 front matter。
- **空 front matter 块**（`---` 紧跟 `---`）或**仅注释**的 front matter（YAML 解析为
  `null`）→ 等价于无配置，`config` 为空对象（不报 not_a_map）。
- **未闭合 front matter**（有起始 `---` 但无结束 `---`）→ `workflow_parse_error`，
  避免 YAML 文本静默漏进 prompt。
- **空正文** → `promptTemplate: ""`，不报错（空正文的 fallback 策略属 §5.4 / M1.4）。
- **unknown top-level keys** → 原样保留、不校验、不报错（§5.3 forward compatibility；
  丢弃会破坏扩展）。
- **定界符**：`---` 行容忍行尾空白；前导单个 BOM 被剥离；CRLF 归一为 LF，保证定界符
  匹配与正文的确定性。`promptTemplate` 只 trim 正文首尾边界，不改内部行。

## Configuration

本包定义了 Symphony 自身如何读取与校验 `WORKFLOW.md`（仓库契约）；开发本包不需要额外配置。

## Extension points

- 新增 front matter 字段：在本包扩展 schema，并同步 `docs/conformance.md` 的 §5 / §6 行；
- 新的配置来源 / 覆盖层：走本包的 resolution 管道，其他包不得自行解析配置；
- 配置消费方（tracker / workspace / orchestrator…）只接受本包产出的 typed config，不接触原始文件。

## Known limitations

- M1.2 只实现发现与**基础解析**（原始 YAML 值 + trimmed 正文）；`config` 未经校验。
- front matter schema 校验、typed `ServiceConfig` resolution、默认值合并、`$VAR`
  环境解析、tilde / 相对路径规范化归 M1.3（§6）；严格模板渲染、热重载与安全回退归
  M1.4（§5.4 / §6.2）——均尚未落地（进度见 [docs/conformance.md](../../docs/conformance.md)）。
