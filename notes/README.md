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

- [accepted/architecture/2026-09-27-domain-contracts.md](accepted/architecture/2026-09-27-domain-contracts.md) — SPEC §4 领域契约的 TypeScript 建模约定：命名映射、nullable vs optional、时钟域、不透明句柄、§4.2 纯函数归属（M1.1）
- [accepted/architecture/2026-09-26-align-with-upstream-spec.md](accepted/architecture/2026-09-26-align-with-upstream-spec.md) — 对齐官方 SPEC：固定 baseline、删除协议栈 scaffold、按 SPEC 主组件重建 workspace 边界（M0.6）
- [accepted/tooling/2026-09-25-npm-workspaces.md](accepted/tooling/2026-09-25-npm-workspaces.md) — npm workspaces 为唯一 canonical 包管理

### Superseded（保留原文，不改写历史）

- [superseded/architecture/2026-09-25-m0-scaffold.md](superseded/architecture/2026-09-25-m0-scaffold.md) — M0 脚手架：8-workspace 边界先行（被 align-with-upstream-spec 取代）
- [superseded/architecture/2026-09-26-ctl-gateway-access.md](superseded/architecture/2026-09-26-ctl-gateway-access.md) — symctl 访问网关的路径（被 align-with-upstream-spec 取代，ctl / gateway 已删除）
