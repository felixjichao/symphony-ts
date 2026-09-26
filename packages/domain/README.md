# @symphony/domain

## Purpose

SPEC **§4 Core Domain Model** 的 owner 包：Issue、Workflow Definition、Service Config、Workspace、Run Attempt、Live Session、Retry Entry、Orchestrator Runtime State 等共享领域类型与纯逻辑的唯一权威。其他包只 import、不重声明（与 M0.5 的"单一权威包"原则一致）。

## Configuration

无运行时配置；领域类型本身即本包对外的契约面。

## Extension points

- 新增 / 修改领域实体属于跨包契约变更：必须附 Agent Note（见根 `notes/README.md`）；
- provider payload 的**归一化结果**类型定义在本包；归一化**动作**（adapter）在 `packages/tracker`。

## Known limitations

- M0.6 仅建立边界，`src/index.ts` 暂无公共 API；
- 领域类型与校验自 M1 起按 SPEC §4 / §17.1 落地，进度追踪在 `docs/conformance.md`。
