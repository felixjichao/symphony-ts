# @symphony/cli

## Purpose

Symphony 宿主的 **CLI / 进程生命周期**入口：解析命令行、加载配置、把各组件（config / tracker / workspace / agent / orchestrator / observability）装配为长运行服务并管理 start / stop。验收对齐 SPEC §17 的 CLI lifecycle 项与 §18 Implementation Checklist。

## Configuration

启动参数（如 `WORKFLOW.md` 路径覆盖）在装配时交给 `@symphony/config` 解析；本 app 不定义自己的配置语义。

## Extension points

- 新子命令：在本 app 内注册，业务逻辑一律下沉到对应 owner 包；
- app 只做装配与进程管理，不承载领域规则——判断"这段逻辑该不该在 cli"时以各包 README 的 Purpose 为准。

## Known limitations

- M0.6 仅建立边界，`src/index.ts` 尚无可运行入口；
- 装配与生命周期管理在 orchestrator 落地后接线（SPEC §17 / §18）。
