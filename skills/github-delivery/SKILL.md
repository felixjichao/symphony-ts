---
name: github-delivery
description: Reusable delivery and land workflow skill for Symphony agents on GitHub repositories
---

# GitHub Delivery + Land Workflow Skill

## 1. 概述与目标

本 Skill 为 Coding Agent 提供稳定、可复用的 GitHub 交付与自动合入（Delivery & Land）行为标准，驱动任务从“代码修改与本地验证”最终推进到“创建/复用 PR、通过 CI 校验、在满足策略时自动 Squash Merge 并在异常时安全交接”。

核心原则：
- **交付策略在 Agent/Tooling 层**：Orchestrator Core 保持极简调度与生命周期管理，不理解 PR 与 CI 业务语义。
- **Git/GitHub 事实为准**：基于工作区真实状态与远程 GitHub 事实决策，确保重入幂等。
- **预算有界与交接暂停**：受到 `max_turns`、修复尝试上限与 CI 等待超时约束；预算耗尽时通过移除 `symphony-ready` 标签主动暂停派发，并输出 Operator 可见交接报告。

---

## 2. 交付与合入协议链路 (Delivery Protocol)

```text
inspect issue/context
→ implement
→ run project validation
→ commit
→ push
→ create/reuse PR
→ inspect CI
→ fix failures loop (bounded)
→ push again
→ land when policy satisfied
→ [if budget exhausted / blocker] output handoff report & halt dispatch
```

### 步骤 1：检查工单与工作区状态 (Inspect)
1. 读取 Issue 标题、描述与目标仓库（`owner/repo`）。
2. 核对当前 Git 分支：per-issue 工作区分支命名遵循确定性规范 `symphony/<workspaceKey>`（如 `symphony/GH-80`）。
3. 检查是否有未保存的工作文件或未跟踪改动（`git status --porcelain`）。

### 步骤 2：执行项目本地验证 (Validate)
1. 运行项目要求的本地验证门禁（如 `npm run gate` 或 `npm test`）。
2. 本地验证未通过前，不得提交和推送破损代码到远程分支。

### 步骤 3：确定性提交 (Commit)
1. 暂存所有必要改动（`git add -A`）。
2. Commit 规范采用 `<type>(<scope>): <summary> (<identifier>)`，例如：
   ```bash
   git commit -m "feat(delivery): implement codex delivery skill (GH-80)"
   ```
3. 绝不在提交信息中包含 GitHub PAT、密码或其它敏感凭据。

### 步骤 4：推送到远端分支 (Push)
1. 将当前分支推送到远程 `origin`：
   ```bash
   git push origin symphony/GH-80
   ```
2. 获取当前最新的 HEAD commit SHA：
   ```bash
   git rev-parse HEAD
   ```

### 步骤 5：创建或复用 Pull Request (Ensure PR)
1. **优先复用已有 PR**：
   - 查询当前分支和目标基准分支之间是否存在 open PR：
     ```bash
     gh pr list --head symphony/GH-80 --base main --state open --json number,url,title,body,headRefOid
     ```
   - 若存在，校验 PR 正文中的所属标记 `<!-- symphony-delivery-marker: ... -->` 与 `Fixes #<N>`。若归属匹配，直接复用该 PR，**严禁重复创建 PR**。
2. **无 PR 时新建**：
   - 标题：`feat: <需求简述> (<workspaceKey>)`
   - 正文：去除前导空白后的首行为关联工单关键字，末尾附带机器所属标记：
     ```markdown
     Fixes #80

     Automated delivery for issue #80.

     <!-- symphony-delivery-marker: {"workspaceKey":"GH-80","issueNumber":80,"repo":"felixjichao/symphony-ts","headBranch":"symphony/GH-80","baseBranch":"main"} -->
     ```
   - 执行创建：
     ```bash
     gh pr create --head symphony/GH-80 --base main --title "..." --body "..."
     ```

### 步骤 6：CI 检查监控与有限修复循环 (Inspect CI & Repair Loop)
1. **绑定 HEAD Commit SHA 评估 CI**：
   - 消费当前最新 HEAD SHA 对应的 check-runs 与 status-contexts。
   - 读取命令：
     ```bash
     gh pr checks <prNumber> --json name,state,bucket,conclusion,link
     ```
2. **CI 状态判定**：
   - **Green (成功)**：所有 required checks 成功且所有观测到的 checks 成功（或无 required checks 时所有 checks 为 success），跳出循环进入 Land 阶段。
   - **Pending (运行中)**：等待轮询周期（默认 5 秒），累计等待时间 `spentWaitSeconds`。若超过 `maxWaitSeconds`（默认 300 秒），触发超时 Blocker 退出。
   - **Failed (失败)**：进入修复逻辑：
     - 若 `spentRepairs >= maxRepairAttempts`（默认 3 次），**终止修复，进入预算耗尽交接**。
     - 递增 `spentRepairs`。
     - 读取失败 Job 的日志或详情链接（`gh pr checks` 或 `gh run view`），提取具体错误。
     - 针对性修复代码并重新执行本地验证。
     - 提交修复提交并推送到远端：
       ```bash
       git commit -m "fix(ci): repair failed test (attempt 1) (GH-80)"
       git push origin symphony/GH-80
       ```
     - 刷新当前 HEAD SHA，继续监控 CI checks。

### 步骤 7：策略满足时自动合入 (Land / Auto-merge)
1. 触发合入的前提策略：
   - PR 归属于当前 Symphony 工单与工作区；
   - PR 处于 open 且可合并状态（mergeable）；
   - CI 严格处于全绿（Green）状态；
   - 工作流显式开启自动合入（`optInLand !== false`）。
2. 执行 Squash Merge：
   ```bash
   gh pr merge <prNumber> --squash --match-head-commit <headSha>
   ```
3. 验证最终合并状态：
   ```bash
   gh pr view <prNumber> --json state,mergeCommit
   ```
   确认 `state === "MERGED"`。

---

## 3. 预算耗尽与调度暂停机制 (Handoff & Halting Dispatch)

当任务遇到以下情况时，**严禁猜测、严禁无限重试**：
- CI 修复次数达到上限（`ci_failed_max_repairs`）；
- CI 等待总时长超时（`ci_wait_timeout`）；
- PR 存在合并冲突或不可自动合入（`unmergeable`）；
- 涉及产品业务未决决策或破坏性变更。

### 处置动作（用户确认方案）
1. **保持 GitHub Issue 为 Open 状态**：绝不误关闭未达成目标的工单。
2. **移除 `symphony-ready` 标签**：
   ```bash
   gh issue edit <issueNumber> --remove-label symphony-ready
   ```
   **效果**：Symphony Orchestrator 基于 tracker label 路由将立即判定该工单为不可调度状态，停止后续 continuation 尝试与重复重派。
3. **输出 Operator 可见交接报告**：
   在 Issue 或 PR 上发表清晰 Markdown 评论，说明：
   - 触发原因与详细失败上下文；
   - 已消耗的修复次数与等待时长；
   - 当前分支、PR 链接与 Head SHA；
   - 人工介入与恢复指引（修复后重新添加 `symphony-ready` 恢复调度）。

---

## 4. CLI 工具辅助命令

Symphony 提供了内置辅助命令支持本 Skill 的快速调用与测试：

### 运行完整交付闭环
```bash
symphony delivery-skill run \
  --repo felixjichao/symphony-ts \
  --issue 80 \
  --head symphony/GH-80 \
  --base main \
  --validate "npm test" \
  --max-repairs 3 \
  --max-wait 300
```

### 手动或异常触发交接与暂停派发
```bash
symphony delivery-skill halt \
  --repo felixjichao/symphony-ts \
  --issue 80 \
  --reason "budget_exhausted" \
  --details "Manual intervention requested for broken integration tests"
```
