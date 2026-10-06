# 开发指南

## 环境

- Node.js **>= 20**（`engines` 已声明）
- npm（随 Node 附带）。**npm 是唯一 canonical 包管理器**：仓库只有 `package-lock.json`，不要引入 pnpm/yarn 或提交第二份 lockfile（决策记录见 [notes/accepted/tooling/2026-09-25-npm-workspaces.md](../notes/accepted/tooling/2026-09-25-npm-workspaces.md)）。

## Setup

```bash
npm ci        # CI / 干净环境：严格按 package-lock.json 安装
npm install   # 日常：增删依赖后更新 lockfile（lockfile 变化要随代码一起提交）
```

## Monorepo 布局

npm workspaces，两个通配：`packages/*` 与 `apps/*`，共 8 个 workspace（owner 映射详见 [architecture.md](architecture.md)）：

```
packages/domain         @symphony/domain         领域类型唯一权威（SPEC §4）
packages/config         @symphony/config         WORKFLOW.md 解析 + typed config（§5、§6）
packages/tracker        @symphony/tracker        issue tracker adapter（§11）
packages/workspace      @symphony/workspace      per-issue 隔离目录 + hooks（§9）
packages/agent          @symphony/agent          coding agent runner + prompt 组装（§10、§12）
packages/orchestrator   @symphony/orchestrator   状态机 / 调度 / retry（§7、§8、§14）
packages/observability  @symphony/observability  结构化日志 + 只读状态出口（§13）
apps/cli                @symphony/cli            CLI / 进程生命周期（§17、§18）
```

每个 workspace 自带 `README.md`（purpose / configuration / extension points / known limitations）——改哪个包先读哪个包的 README。

## 日常命令

```bash
npm run gate        # 一键门禁 = typecheck + test + lint + docs:check（提交前 / CI 必须全绿）

npm run typecheck   # 全仓 tsc 严格编译（noEmit）
npm test            # 全仓单元测试（vitest）
npm run lint        # eslint
npm run docs:check  # 文档门禁：Markdown 相对链接存在 + AGENTS.md ≤ 150 行 + docs/status.md 里程碑表

# 单 workspace（-w 用包名或路径均可）：
npm test -w @symphony/config
npm run build -w @symphony/domain
```

约定：**本地跑最小相关检查**（受影响 workspace 的测试 + 根 typecheck），**全量归 CI / 提交前**（`npm run gate`）。

## CI 与文档门禁

- CI（`.github/workflows/ci.yml`）：PR 与 main push 上执行 `npm ci && npm run gate`——本地与 CI 使用同一个验收口径。
- doc gate（`scripts/docs-check.mjs`，零依赖）：
  1. 仓库内所有 Markdown 的**相对链接必须指向存在的文件 / 目录**（外部 URL 与纯 anchor 跳过）；
  2. **`AGENTS.md` ≤ 150 行**——standing orders 保持短小可导航，详细内容下沉到 `docs/` 与各包 README；
  3. 开发进度里程碑只能存在于 `docs/status.md`：该文件必须存在且含非空 `## 里程碑` 表（拒绝重复名称、无法分类的状态与 `✅ 本次` 这类会随时间失真的状态），且 `README.md` 与 `docs/architecture.md` 不得再出现里程碑进度表；
  4. workspace 一旦已有 `src/**/*.test.ts`，其 `test` 脚本不得继续带 `--passWithNoTests`。
- 移动 / 重命名 Markdown 文件或目录时，跑一次 `npm run docs:check` 再提交。

## TypeScript 布局约定

- 严格模式全家桶：`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noFallthroughCasesInSwitch`（见根 `tsconfig.base.json`，各包 tsconfig 继承它）。
- library 包（`packages/*`）结构固定：`src/index.ts`（公共 API 唯一出口）、`src/*.test.ts`（vitest 单测，与被测文件同目录）；`apps/*` 以可运行入口为准，测试同样是同目录 `.test.ts`。
- `package.json` 的 `main`/`exports` 直接指向 TS 源码（library 包为 `src/index.ts`），无 dist 产物；根 tsconfig 的 `paths` 把 `@symphony/*`（library 包）映射到各自 `src/index.ts`。**发布形态（dist 产物）在首个打包里程碑切换。**
- 跨包 import 一律用包名（`import type { Issue } from "@symphony/domain"`），不要写跨包相对路径。
- 包间依赖在 `package.json` 里用语义 `*`（npm workspaces 自动链接本地包）；新增依赖边前先确认方向符合 [architecture.md](architecture.md) 的依赖表。
- 不跨包复制类型定义；领域模型的唯一权威是 `@symphony/domain`。
- 尚无测试的 scaffold workspace 可暂用 `--passWithNoTests`；一旦落地首个 `src/**/*.test.ts` 必须移除该 flag，`docs:check` 会阻止回退。

## 新增行为落点

见 [AGENTS.md](../AGENTS.md) 的 "Where New Behavior Goes" 扩展点表。拿不准归属时：先查表，再查目标包 README 的 extension points，仍不确定就写一条 `XXX` 注释并在 PR 里提问。每个新增实现的 issue / PR 必须标注对应 SPEC section（baseline 见 [upstream.md](upstream.md)）。

## 决策记录

架构 / 选型 / 跨包契约的决定要写 Agent Note（`notes/{lifecycle}/{class}/yyyy-mm-dd-topic.md`），模板与强制小节见 [notes/README.md](../notes/README.md)。
