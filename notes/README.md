# Agent Notes — 决策记录

轻量决策记录（简化版 Agent Notes）：架构 / 选型 / 跨包契约的**已定结论**写在这里，代码只保留结论、Note 保留为什么。

## 什么时候写

- 新增或改变包边界、依赖方向、协议模型；
- 工具链 / 包管理 / 测试策略选型；
- 任何"下一个人（或 Agent）会问为什么不用另一种做法"的决定。

日常 bugfix、单包内部实现细节不需要 Note。

## 目录与命名

```
notes/{lifecycle}/{class}/yyyy-mm-dd-topic.md
```

- `{lifecycle}`：`accepted`（已生效）｜ `proposed`（评审中）｜ `superseded`（被取代，保留原文，头部注明取代者）
- `{class}`：`architecture` / `tooling` / `testing` / `product`（按需新增）
- 文件名用短横线小写，如 `2026-09-25-npm-workspaces.md`

提案先落 `proposed/`，接受后移入 `accepted/`（git mv 保留历史）。

## 格式契约

头两行固定，随后四个小节**全部必填**：

```markdown
# Agent Note: <title>
Status: proposed | accepted | superseded

## Problem
<当时的处境与约束>

## Decision
<定了什么，一段话说清>

## Alternatives considered
<至少一条被否掉的替代方案 + 否掉的理由；本小节强制存在且不允许只有空标题>

## Consequences
<正面与负面后果、后续承诺（例如"不得再引入 X"）>
```

M0.5 暂不引入机器校验（validator 归后续 doc gate 批次）；review 时按上述契约人工把关。

## 现有 Notes

- [accepted/architecture/2026-09-30-workspace-path-safety-contract.md](accepted/architecture/2026-09-30-workspace-path-safety-contract.md) — workspace path filesystem safety boundary 跨包契约（SPEC §9.5，M3.2 / #28）：lexical + canonical（每次实时 `realpath`、不缓存）双层 containment、尚不存在路径按最近已存在 ancestor 推定、dangling symlink fail-closed、`unsafe_path` 经 `unsafeReason` 子字段细分四类拒绝面（顶层错误码集合不变）、M4 launch 前与 #29 / M5 cleanup 前必须重验 `assertWorkspacePathSafe`
- [accepted/architecture/2026-09-29-workspace-non-directory-policy.md](accepted/architecture/2026-09-29-workspace-non-directory-policy.md) — 已存在非目录对象的安全失败策略（SPEC §17.2，M3.1 / #27）：对已有常规文件、符号链接等非目录对象绝不自动删除或替换，抛出稳定类型化 `existing_non_directory` 错误，并在 EEXIST 竞态下重检可用目录不变量
- [accepted/architecture/2026-09-28-github-rest-transport-pagination.md](accepted/architecture/2026-09-28-github-rest-transport-pagination.md) — GitHub REST transport（M2.3 / #20）：默认 transport 在 `createAdapter` 内按 context 构造并删除 M2.2 的 unconfigured 桩、`Link` 分页的 origin 守卫与"读不懂即失败"、state 过滤不判 malformed、ID refresh 串行 + 坏 ID 整批前置失败、`fetchImpl` 注入点而非放宽 HTTPS-only 校验
- [accepted/architecture/2026-09-28-github-adapter-transport-boundary.md](accepted/architecture/2026-09-28-github-adapter-transport-boundary.md) — GitHub adapter 的 transport 注入边界（M2.2 / #19 方案 B）：`GitHubIssueTransport` 单端口、未配置 transport 抛 `tracker_request`、归一化失败用抛出而非 union、payload 保持 `unknown`、§11.1 "SHOULD log" 以 `onMalformedRecord` 注入点交付、显式 `$VAR` 不做二次 env 回落（其中"built-in 注册 unconfigured transport"已由 M2.3 取代，见上一条）
- [accepted/architecture/2026-09-28-tracker-adapter-config-extension.md](accepted/architecture/2026-09-28-tracker-adapter-config-extension.md) — tracker adapter 注册表与 `@symphony/config` 的跨包扩展点契约：契约归 config / 实现归 tracker 的结构化对接、失败以返回值而非异常表达、三个 tracker 错误码进 `ConfigErrorCode`、profile 默认不回写 `ServiceConfig`，M2.1（SPEC §6.3 / §11.1 / §11.2 / §11.4 / §17.1）
- [accepted/architecture/2026-09-27-prompt-rendering-contract.md](accepted/architecture/2026-09-27-prompt-rendering-contract.md) — 严格 prompt 渲染契约：snake_case 变量面、`attempt` 恒在场、空正文默认 prompt、ISO 时间戳、错误归类与 `<inline>` 哨兵，M1.4（SPEC §5.4 / §12.2）
- [accepted/architecture/2026-09-27-workflow-reload-contract.md](accepted/architecture/2026-09-27-workflow-reload-contract.md) — 热重载契约：轮询 + stamp 检测、last-known-good 不变量、valid / invalid reload 与事件面、`reload()` 防御性再校验，M1.4（SPEC §6.2 / §6.3）
- [accepted/tooling/2026-09-27-config-liquidjs-dependency.md](accepted/tooling/2026-09-27-config-liquidjs-dependency.md) — `@symphony/config` 引入 `liquidjs` 作为第二个运行时依赖的选型与严格模式行为（M1.4）
- [accepted/architecture/2026-09-27-config-resolution-contract.md](accepted/architecture/2026-09-27-config-resolution-contract.md) — typed config resolution 的管道语义与边缘裁定：`tracker.kind` 空串哨兵、`$VAR` 仅限 `workspace.root`、双 invalid-value 策略、显式 null / `~user` / by-state last-wins，M1.3（SPEC §5.3 / §6）
- [accepted/architecture/2026-09-27-workflow-loader-contract.md](accepted/architecture/2026-09-27-workflow-loader-contract.md) — WORKFLOW.md loader 的公共 API、`SymphonyConfigError` 错误契约与边缘语义（空块 / 未闭合 / 非 map 根 / BOM·CRLF），M1.2（SPEC §5.1–§5.3）
- [accepted/tooling/2026-09-27-config-yaml-dependency.md](accepted/tooling/2026-09-27-config-yaml-dependency.md) — `@symphony/config` 引入 `yaml` 作为仓库首个运行时外部依赖的选型（M1.2）
- [accepted/tooling/2026-09-27-typescript-5x-pin.md](accepted/tooling/2026-09-27-typescript-5x-pin.md) — 根级 TypeScript 收敛到 5.x（devDependencies + overrides）并移除已弃用的 `baseUrl`（TS5101 隐患）
- [accepted/architecture/2026-09-27-domain-contracts.md](accepted/architecture/2026-09-27-domain-contracts.md) — SPEC §4 领域契约的 TypeScript 建模约定：命名映射、nullable vs optional、时钟域、不透明句柄、§4.2 纯函数归属（M1.1）
- [accepted/architecture/2026-09-26-align-with-upstream-spec.md](accepted/architecture/2026-09-26-align-with-upstream-spec.md) — 对齐官方 SPEC：固定 baseline、删除协议栈 scaffold、按 SPEC 主组件重建 workspace 边界（M0.6）
- [accepted/tooling/2026-09-25-npm-workspaces.md](accepted/tooling/2026-09-25-npm-workspaces.md) — npm workspaces 为唯一 canonical 包管理

### Superseded（保留原文，不改写历史）

- [superseded/architecture/2026-09-25-m0-scaffold.md](superseded/architecture/2026-09-25-m0-scaffold.md) — M0 脚手架：8-workspace 边界先行（被 align-with-upstream-spec 取代）
- [superseded/architecture/2026-09-26-ctl-gateway-access.md](superseded/architecture/2026-09-26-ctl-gateway-access.md) — symctl 访问网关的路径（被 align-with-upstream-spec 取代，ctl / gateway 已删除）
