# Agent Note: @symphony/config 引入 `yaml` 作为首个运行时外部依赖（M1.2）
Status: accepted

## Problem

M1.2 要在 `packages/config` 解析 `WORKFLOW.md` 的 YAML front matter（SPEC §5.2）。
仓库此前无任何运行时外部依赖：`packages/domain` 只有 devDependencies（typescript /
vitest / @types/node），lockfile 里出现的 `js-yaml` 仅是 `@eslint/eslintrc` 的传递
dev 依赖，不可复用为运行时依赖。需要选一个 YAML 解析库作为**仓库首个运行时外部依赖**，
且要契合本仓的严格 TS 配置（`strict` + `noUncheckedIndexedAccess` +
`exactOptionalPropertyTypes`）与"第三方异常不越过包边界"的错误契约。

## Decision

在 `packages/config/package.json` 的 `dependencies` 加入 `yaml`（eemeli，`^2.9.1`），
用它解析 front matter。理由：

- **原生 TypeScript 类型**：`yaml` 自带 `.d.ts`，无需 `@types/*`，与 strict 全家桶
  契合，避免 `any` 或额外类型声明。
- **YAML 1.2 + 精确错误**：`parse()` 语法错误抛 `YAMLParseError`，带 line/column，
  利于 `workflow_parse_error` 的诊断信息（经 `cause` 保留）。
- **零依赖、ESM、体积可控**：作为首个运行时依赖，不引入传递依赖树。
- `parse()` 默认返回 plain JS 对象（map → `Object.prototype` 对象），与本包"front
  matter 根必须是 plain map"的判定一致；本包对第三方异常统一转换为
  `SymphonyConfigError`（见 workflow-loader-contract Note），不外泄 `YAMLParseError`。

lockfile 变化最小：仅新增 `node_modules/yaml` 条目并把 `yaml` 加入 `@symphony/config`
workspace 的 dependencies，不动其他包。

## Alternatives considered

- **`js-yaml`（ nodeca）**：功能成熟，但需另装 `@types/js-yaml` 才有完整类型（本仓
  严格模式下不希望引入额外 `@types` 面），且默认 `load()` 对某些输入更宽松；作为首个
  运行时依赖，`yaml` 的原生类型 + 零依赖更契合本仓约束。仓库 lockfile 里的 `js-yaml`
  是 eslint 的传递 dev 依赖，复用它会混淆 dev / runtime 依赖边界。
- **Node 内置 / 手写 YAML 子集解析**：否——Node 无内置 YAML；front matter 虽是 YAML
  子集，但手写解析器要正确处理引号、块标量、嵌套 map/list、锚点等会重新造轮子且易错，
  违背"用真实现而非简化替身"的取向。
- **推迟选型到 M1.3**：否——M1.2 的解析已需要一个真实 YAML 库，推迟会阻塞本里程碑。

## Consequences

- `yaml` 成为仓库首个运行时外部依赖；后续新增运行时依赖应同样审慎（优先零依赖、
  原生类型），并按本 Note 记录选型理由。
- 只有 `@symphony/config` 可直接依赖 `yaml`：YAML 解析是 config 包的内部实现细节，
  其他包不得各自引入 YAML 库或绕过 config 解析 `WORKFLOW.md`（依赖方向见根 AGENTS.md）。
- `yaml` 的 `YAMLParseError` 不得越过 config 包边界；消费方只见 `SymphonyConfigError`。
- 升级 `yaml` 主版本时须重跑 `npm test -w @symphony/config` 与 `npm run gate`，确认
  解析 / 错误行为未回归。
