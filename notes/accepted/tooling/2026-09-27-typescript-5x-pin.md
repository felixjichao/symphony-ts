# Agent Note: 根级 TypeScript 收敛到 5.x 并移除 baseUrl
Status: accepted

## Problem

`typescript-eslint ^8.8.0` 的 peer 范围（`>=4.8.4 <6.1.0`）使 npm 把根级 `typescript` 自动解析安装为 **6.0.3**，而各 workspace 的 `^5.6.2` 以嵌套 **5.9.3** 安装——依赖树里同时存在两个 tsc。任何解析到根 `node_modules/.bin/tsc`（6.0.3）的类型检查会因 `tsconfig.base.json` 的 `baseUrl` 直接报 **TS5101**（baseUrl 在 TS 6 弃用、TS 7 停止工作）；`npm run gate` 恰好只走 workspace 嵌套副本才保持绿色（NEST-48 代码审查发现；隐患继承自 main，非该 PR 引入）。工具链行为取决于 tsc 的解析路径，违背本仓"单一权威"原则。

## Decision

1. **根级显式收敛**：根 `package.json` 增加 `devDependencies.typescript: ^5.6.2` 并加 `overrides.typescript: ^5.6.2`——整棵树（含 typescript-eslint 的 auto-installed peer）只解析一个 5.x。lockfile 重生成后根 hoist 为 5.9.3，全部 8 个 workspace 的嵌套副本消失（`npm ls typescript` 全 deduped）。
2. **移除 `baseUrl`**：`tsconfig.base.json` 删除 `baseUrl`，`paths` 条目改为显式 `./` 前缀（无 baseUrl 时 TS 要求相对路径；相对声明文件即仓库根解析，语义与原 baseUrl 方案完全一致）。此后即使 TS 6.x 再进入依赖树也不会触发 TS5101。
3. lockfile 变化随代码同提交（`npm install` 语义，见 development.md）。

## Alternatives considered

- **只 pin 根版本、保留 baseUrl**：否——pin 只推迟问题；TS 7 会强制移除 baseUrl，现在做零成本（`paths` 解析语义不变），晚做要再动一次全仓 tsconfig。
- **只移除 baseUrl、不 pin 版本**：否——双 tsc 并存本身就是隐患：根 6.0.3 与 workspace 5.9.3 的类型检查结果可能分叉（5.x / 6.x 行为差异不止 baseUrl 一项），单一权威工具链版本更符合仓库原则。
- **顺势升级到 TypeScript 6**：否——M0.6 刚确立 `^5.6.2` 严格模式基线；TS 大版本升级（含 `ignoreDeprecations` 审计与新诊断评估）应作为独立批次决策，不夹带在隐患收敛里。

## Consequences

- 全仓唯一 typescript 权威版本 = lockfile 根级条目（当前 5.9.3，范围 `^5.6.2`）。未来升级（含 eventual TS 6）必须同步改根 `devDependencies` + `overrides` 与各 workspace `devDependencies`，避免再次分叉。
- `paths` 新条目必须带 `./` 前缀（如 `"./packages/<name>/src/index.ts"`），照抄现有行即可。
- `npm audit` 报出的 vitest / vite / esbuild 系 5 个已知漏洞为 M0.6 既有（dev-only 测试工具链），与本决定无关，留待测试工具链升级批次处理。
