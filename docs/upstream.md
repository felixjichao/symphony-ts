# 上游规范基线

本仓库是 OpenAI Symphony 的 TypeScript 实现，唯一产品规范来源是官方仓库的 `SPEC.md`。本文记录固定的 baseline 与同步 / 升级规则；架构重校准的决策记录见 [align-with-upstream-spec note](../notes/accepted/architecture/2026-09-26-align-with-upstream-spec.md)。

## Baseline

| 项 | 值 |
|---|---|
| upstream 仓库 | https://github.com/openai/symphony |
| 规范文档 | `SPEC.md` |
| baseline SHA | `be10a1b79df723d6d7612b5651c8522704dafb2e` |
| baseline 链接 | [SPEC.md @ be10a1b](https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/SPEC.md) |
| 固定日期 | 2026-09-26（M0.6） |

## 规则

1. **SPEC 优先**：现有代码 / 文档与官方 SPEC 冲突时，以固定 baseline 的 `SPEC.md` 为准。上游参考实现与任何第三方 TypeScript 实现只用于设计对照（比较模块粒度、测试方式），不构成规范。
2. **不复制 SPEC**：不把 SPEC 全文抄进本仓库，避免形成第二份会漂移的规范；文档只引用 section 编号（如 `SPEC §4`）。实现进度与 SPEC §17 / §18 验收项的映射维护在 `docs/conformance.md`。
3. **升级流程**：升级 baseline 必须**单独提 PR**，附 upstream diff 与对 `docs/conformance.md` 的逐行 review；不得与业务实现混在同一个 PR。
4. **标注 section**：后续每个新增实现的 issue / PR 必须标注对应 SPEC section，避免再次形成平行架构。
