# Agent Note: npm workspaces 为唯一 canonical 包管理
Status: accepted

## Problem

M0 种子提交同时留下了 npm（`package.json` workspaces + `package-lock.json`）与 pnpm（`pnpm-workspace.yaml`，README 写"可选 corepack enable && pnpm install"）双路径；README 还声称包间依赖用 `workspace:*`，而各包 `package.json` 实际写的是 `*`。Agent 冷启动时无法判断哪套是权威：锁文件可能分叉、CI 与本地安装语义不一致、文档与代码互相矛盾。

## Decision

npm workspaces + `package-lock.json` 是唯一 canonical 包管理路径：删除 `pnpm-workspace.yaml`，文档不再提供 pnpm 双路径；安装命令统一为 `npm ci`（CI / 干净环境）与 `npm install`（增删依赖）；README 中与代码不符的 `workspace:*` 表述改为如实描述（`*` 语义，由 npm workspaces 链接本地包）；新增根脚本 `npm run gate`（typecheck + test + lint）作为一键门禁。

## Alternatives considered

- **切换到 pnpm**：更严格的依赖隔离与磁盘效率对 monorepo 有吸引力；但仓库现状（lockfile、CI 习惯、`package.json` 中 `*` 依赖写法）都已按 npm 成形，切换要重写全部依赖声明为 `workspace:*` 并迁移锁文件，M0.5 的收益不成比例。留待后续如有硬需求再提案。否。
- **npm + pnpm 双支持**：两套 lockfile 必然漂移，Agent 每次都要判断该用哪套，与"冷启动只有一条路径"的目标相反。否。
- **只删文件不改文档**：README 的 pnpm / `workspace:*` 表述会继续误导，事实校准必须一次做完。否。

## Consequences

- 正面：安装语义唯一，`package-lock.json` 是单一事实来源；`npm run gate` 给 CI 与本地提供同一个验收口径；文档与仓库事实一致（无 pnpm、无 `workspace:*`、无 `plan.md` 引用）。
- 负面 / 承诺：**后续不得同时维护两套 lock / workspace 流程**——引入任何其他包管理器必须先写新 Note 取代本条；放弃 pnpm 的严格 node_modules 隔离，幽灵依赖风险由 eslint + 各包显式声明依赖约束；若 M1+ 需要 pnpm 独有能力，走 superseded 流程而不是直接加回 `pnpm-workspace.yaml`。
