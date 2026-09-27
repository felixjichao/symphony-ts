# @symphony/workspace

## Purpose

SPEC **§9 Workspace Management and Safety** 的 owner 包，对应 §3 的 Workspace Manager：per-issue 隔离目录的 provisioning（issue id 净化、防碰撞命名）、路径 containment 校验、生命周期脚本（startup / cleanup hooks）的执行。**修改 workspace lifecycle hook 的唯一落点在本包。**

## Configuration

workspace 根目录、沙箱策略等参数由 `@symphony/config` 产出的 typed config 提供；本包不自行解析 `WORKFLOW.md`。

## Extension points

- 生命周期脚本的新阶段：在本包的 hook 序列中登记，执行语义遵循 SPEC §9；
- 目录布局 / 净化规则调整属于跨包契约变更：附 Agent Note 并同步 `docs/conformance.md`。

## Known limitations

- M0.6 仅建立边界，`src/index.ts` 暂无公共 API；
- provisioning、containment 校验与 hooks 随后续里程碑落地（SPEC §9、§17）。
