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

npm workspaces，两个通配：`packages/*` 与 `apps/*`，共 8 个 workspace：

```
packages/sym         @symphony/sym        协议消息模型（wire 编解码 M1）
packages/proto       @symphony/proto      载荷转码器（JSON 实现 + 注册表）
packages/transport   @symphony/transport  Transport 抽象 + 最小 UDP
packages/gateway     @symphony/gateway    网关骨架（插件分发接线）
packages/plugins     @symphony/plugins    插件注册表 + 占位模块
packages/relay       @symphony/relay      L4 转发规则（M6）
packages/ctl         @symphony/ctl        symctl CLI 骨架（M5）
apps/examples        @symphony/examples   echo Agent（M3 闭环）
```

每个 workspace 自带 `README.md`（purpose / configuration / extension points / known limitations）——改哪个包先读哪个包的 README。

## 日常命令

```bash
npm run gate        # 一键门禁 = typecheck + test + lint（提交前 / CI 必须全绿）

npm run typecheck   # 全仓 tsc 严格编译（noEmit）
npm test            # 全仓单元测试（vitest）
npm run lint        # eslint

# 单 workspace（-w 用包名或路径均可）：
npm test -w @symphony/transport
npm run build -w @symphony/sym

# 运行示例（apps/examples）：
npm run echo -w @symphony/examples     # tsx src/echoAgent.ts
```

约定：**本地跑最小相关检查**（受影响 workspace 的测试 + 根 typecheck），**全量归 CI / 提交前**（`npm run gate`）。

## TypeScript 布局约定

- 严格模式全家桶：`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noFallthroughCasesInSwitch`（见根 `tsconfig.base.json`，各包 tsconfig 继承它）。
- 每个包结构固定：`src/index.ts`（公共 API 唯一出口）、`src/*.test.ts`（vitest 单测，与被测文件同目录）。
- `package.json` 的 `main`/`exports` 直接指向 `src/index.ts`（TS 源码即入口，无 dist 产物）；根 tsconfig 的 `paths` 把 `@symphony/*` 映射到各包 `src/index.ts`。**发布形态（dist 产物）在 M1 打包时切换。**
- 跨包 import 一律用包名（`import { createMessage } from "@symphony/sym"`），不要写跨包相对路径。
- 包间依赖在 `package.json` 里用语义 `*`（npm workspaces 自动链接本地包）；新增依赖边前先确认方向符合 [architecture.md](architecture.md) 的依赖表。
- 不跨包复制类型 / 协议定义；wire 模型的唯一权威是 `@symphony/sym`。

## 新增行为落点

见 [AGENTS.md](../AGENTS.md) 的 "Where New Behavior Goes" 扩展点表。拿不准归属时：先查表，再查目标包 README 的 extension points，仍不确定就写一条 `XXX` 注释并在 PR 里提问。

## 决策记录

架构 / 选型 / 跨包契约的决定要写 Agent Note（`notes/{lifecycle}/{class}/yyyy-mm-dd-topic.md`），模板与强制小节见 [notes/README.md](../notes/README.md)。
