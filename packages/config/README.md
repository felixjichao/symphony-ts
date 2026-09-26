# @symphony/config

## Purpose

SPEC **§5 Workflow Specification (Repository Contract)** 与 **§6 Configuration Specification** 的 owner 包，对应 §3 的 Workflow Loader + Config Layer：`WORKFLOW.md` 发现与解析（YAML front matter + 原始 prompt 正文）、front matter schema（追踪过滤、轮询间隔、目录根、生命周期脚本、并发上限、沙箱策略）、typed config 校验、默认值合并、`$VAR` 环境解析、tilde 展开与相对路径规范化、严格模板渲染、无效配置的类型化报错与安全回退（验收项见 §17.1）。

**新增 / 修改 WORKFLOW front matter 字段的唯一落点在本包。**

## Configuration

本包定义了 Symphony 自身如何读取与校验 `WORKFLOW.md`（仓库契约）；开发本包不需要额外配置。

## Extension points

- 新增 front matter 字段：在本包扩展 schema，并同步 `docs/conformance.md` 的 §5 / §6 行；
- 新的配置来源 / 覆盖层：走本包的 resolution 管道，其他包不得自行解析配置；
- 配置消费方（tracker / workspace / orchestrator…）只接受本包产出的 typed config，不接触原始文件。

## Known limitations

- M0.6 仅建立边界，`src/index.ts` 暂无公共 API；
- WORKFLOW loader、typed 校验、热重载与模板渲染自 M1 起落地（SPEC §5 / §6 / §17.1）。
