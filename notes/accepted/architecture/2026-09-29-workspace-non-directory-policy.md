# Agent Note: Workspace Existing Non-Directory Policy
Status: accepted

## Problem

SPEC §17.2 规定："Existing non-directory path at workspace location is handled safely (replace or fail per implementation policy)"。

在本地文件系统中，当 `WorkspaceManager.createWorkspace(identifier)` 派生出确定性路径 `<workspace.root>/<workspace_key>`（SPEC §9.1）并准备 ensure 目录时，该路径可能已被外部操作、意外放置的文件或符号链接占用。SPEC 明确将"替换（replace）还是失败（fail）"作为实现裁定项（implementation policy）。系统必须在此明确行为规范与安全底线。

## Decision

symphony-ts 针对已有非目录对象明确选择 **Fail Safely（安全失败）** 策略：

1. **绝对不自动删除**：绝不隐式调用 `rm`、`unlink` 或递归删除已存在的未知文件、符号链接、FIFO 或设备节点；
2. **绝对不自动替换**：绝不对已有非目录文件进行覆盖写入或强行替换为目录；
3. **抛出稳定类型化错误**：抛出 {@link WorkspaceError}，其判别式 `code` 恒为 `"existing_non_directory"`，并携带发生冲突的 `path`、`workspaceKey` 与 `identifier` 诊断上下文；
4. **并发与 EEXIST 重检不变量**：在文件系统存在竞态（`mkdir` 捕获 `EEXIST`）时，必须通过 `lstat` 重新核验实际对象类型；仅当确认为目录时方可复用（`createdNow = false`），若为非目录对象一律拒绝，绝不仅凭异常捕获假定目标已是合法目录。

## Alternatives considered

1. **自动覆盖 / 破坏性替换（`rm -rf` 后重建目录）**：
   - 否掉理由：极度危险。若用户、操作人员或外部脚本在 `workspace.root` 下意外放置了同名文件，或存在指向宿主关键路径的符号链接（symlink escape），破坏性删除会导致不可逆的数据丢失，甚至在安全 containment 边界检查（#28）生效前引发越界删除漏洞。
2. **自动路径规避 / 增量后缀（如 `<workspace_key>_1` 或 `<workspace_key>-fallback`）**：
   - 否掉理由：严重违反 SPEC §9.1 与 §17.2 的"确定性单工单隔离路径（deterministic per-issue workspace path）"基本保证。若因冲突而产生派生后缀，后续重试、reconciliation 以及跨尝试状态复用将失去稳定寻址基准，造成工作区割裂与状态漂移。

## Consequences

- **正面后果**：
  - 杜绝静默破坏与意外数据丢失风险，保障本地文件系统安全；
  - 错误诊断清晰可辨，操作者或监控系统能立即定位阻塞原因并采取人工干预；
  - 保持与 SPEC §9.1 确定性路径的一致性。
- **负面后果与后续承诺**：
  - 若 `workspace.root` 下存在残留的冲突文件，该 issue 的调度尝试将持续失败为 `existing_non_directory`，直至人工清理或未来的清理工具调度介入；
  - 任何后续里程碑（含 M3.3 hooks、M5 cleanup）均**不得**在此类冲突发生时绕过该策略隐式删除未知非目录对象。
