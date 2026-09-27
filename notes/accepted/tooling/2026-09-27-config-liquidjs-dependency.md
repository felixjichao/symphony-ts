# Agent Note: @symphony/config 引入 `liquidjs` 作为严格模板引擎（M1.4）

Status: accepted

## Problem

M1.4 要实现 SPEC §5.4 Prompt Template Contract：`WORKFLOW.md` 正文是 per-issue prompt
模板，必须用 **strict template engine**（"Liquid-compatible semantics are sufficient"）
渲染，且 **未知变量 / 未知 filter MUST fail rendering**（§5.4、§5.5、§12.2）。
仓库此前唯一的运行时依赖是 M1.2 引入的 `yaml`（见
[config-yaml-dependency](2026-09-27-config-yaml-dependency.md)），选型标准已确立：
**优先零运行时依赖、原生 TypeScript 类型、第三方异常不越过包边界**。需要在此标准下
再选一个模板引擎，或自研。

## Decision

在 `packages/config/package.json` 的 `dependencies` 加入 `liquidjs`（`^10.29.0`），
作为仓库第二个运行时外部依赖。理由：

- **Liquid 语义 + 严格模式开箱**：`liquidjs` 是 SPEC 所指 "Liquid-compatible" 的
  原生 TS 实现，直接提供 `strictVariables`（未定义变量求值抛
  `UndefinedVariableError`）与 `strictFilters`（未注册 filter 抛错）两个开关，逐条
  对应 §5.4 的 MUST。
- **原生 TypeScript 类型、传递依赖极少**：`liquidjs` 自带 `.d.ts`，无需 `@types/*`，
  契合仓库 `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` 与
  "优先原生类型"的选型标准（与 `yaml` Note 同源）。其唯一传递依赖是 `commander`
  （供 `liquidjs` 自带 CLI bin 使用），运行时依赖树仍很小。
- **同步 API**：`parse()` + `renderSync()` 提供纯同步渲染，符合本包"纯函数、无 IO"
  的可复跑测试取向，避免把渲染变成 async 传染。
- **异常可折叠**：`liquidjs` 的错误类（`LiquidError` / `UndefinedVariableError` /
  `ParseError` / `TokenizationError`）统一经 `cause` 折叠进
  `SymphonyConfigError`，不越过包边界（父 issue §7）。

实现要点：模块级单例严格引擎；`renderPrompt` 不把引擎异常、`any` 返回类型或 filter
集合暴露给消费方——公共面只有 `string` 入参 / `string` 返回与
`SymphonyConfigError`。

## Alternatives considered

- **手写严格模板子集渲染器**：否——与 `yaml` Note "不重新造轮子"的既有决策一致；
  Liquid 的标签 / filter / 迭代语法（§12.2 要求保留嵌套集合供模板迭代）手写会迅速
  膨胀成不可维护的半成品，且"严格 / 宽松"边界难以与 SPEC 对齐。
- **`nunjucks` / `handlebars` / `ejs`**：否——语义与 SPEC 指定的 Liquid 不一致，
  严格变量检查能力参差（如 handlebars 默认静默渲染缺失值为空串，需额外 hack 才能
  失败）；`nunjucks` 体量与传递依赖更大。SPEC 明示 Liquid-compatible 即可，选
  语义最贴合的 `liquidjs`。
- **只做 `{{ var }}` 字符串插值（正则替换）**：否——无法支持 §12.2 要求的
  `labels` / `blockers` 迭代与 filter，也无法可靠区分"未知变量"与"合法空值"。
- **引入通用模板 + 自定义 AST 校验两层**：否——过度设计；`liquidjs` 的
  `strictVariables` / `strictFilters` 已覆盖 MUST，额外 AST 层只会增加与上游版本
  耦合面。

## Consequences

- `liquidjs` 成为仓库第二个运行时外部依赖。只有 `@symphony/config` 可直接依赖它；
  模板渲染是 config 包的内部实现细节，其他包不得自行引入模板引擎或渲染 WORKFLOW
  正文（依赖方向见根 `AGENTS.md`）。
- **`liquidjs` 在 `parse()` 阶段即解析 filter 名**（`Output` 构造时经
  `getFilter` 断言），因此未注册 filter 的失败**发生阶段**是 parse，而 SPEC §5.5
  把 "unknown variable/filter" 归入 `template_render_error`。本包据
  `undefined filter:` 前缀把它归为 `template_render_error`（其余 parse 失败 →
  `template_parse_error`），见
  [prompt-rendering-contract](../architecture/2026-09-27-prompt-rendering-contract.md)。升级
  `liquidjs` 主 / 次版本时须重跑模板测试，确认该前缀与严格模式行为未变。
- `liquidjs` 的异常类型不得越过 config 包边界；消费方只见 `SymphonyConfigError`。
- 升级 `liquidjs` 时须重跑 `npm test -w @symphony/config` 与 `npm run gate`。
