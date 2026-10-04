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
- **严格所有权与安全防卫**：严格验证 PR 机器标记（Marker），严禁外部或身份不明的 PR 冒充；执行前核对当前分支与 origin 远端。
- **预算有界与交接暂停**：受到 `max_turns`、修复尝试上限与 CI 等待超时约束；预算耗尽或遭遇 Blocker 时通过移除 `symphony-ready` 标签主动暂停派发，并输出 Operator 可见交接报告。

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

### 步骤 1：前置检查 (Pre-mutation Inspection)
1. **分支核对**：检查 `git branch --show-current`，必须精确匹配任务目标分支 `symphony/<workspaceKey>`（如 `symphony/GH-80`）。
2. **仓库核对**：检查 `git remote get-url origin`，必须与目标仓库（`owner/repo`）一致。
3. **工单核对**：查询 `gh issue view <issueNumber> --json state`，已关闭工单（`CLOSED`）严禁继续派发或交付。
4. **现有 PR 状态全量核对**：
   - 使用 `gh pr list --head <branch> --base <base> --state all --json number,url,title,body,state,headRefOid` 查询已有 PR。
   - 校验 PR 正文中的所属标记 `<!-- symphony-delivery-marker: ... -->`。
   - 若匹配且为 `MERGED`，直接返回已完成；若为 `CLOSED`，安全终止并提示人工介入；若无合规 PR，继续执行创建。

### 步骤 2：执行项目本地验证 (Validate)
1. 运行项目要求的本地验证门禁（如 `npm run gate` 或 `npm test`）。
2. 若本地验证失败（非零退出码），禁止进行任何提交、推送或合入操作，立即输出 Blocker 并暂停派发。

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
   - 若步骤 1 中核对到合法的 open PR，直接复用该 PR，**严禁重复创建 PR**。
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
1. **查询结构化 CI 状态**：
   - 避免使用不支持 `--json` 的 `gh pr checks`，统一使用兼容所有 GitHub CLI 版本的标准命令：
     ```bash
     gh pr view <prNumber> --json headRefOid,statusCheckRollup,mergeable,state
     ```
   - 核对 `headRefOid` 与当前本地已推送的 HEAD SHA 一致（防止将旧提交的 CI 结果当作新提交判断）。
2. **CI 状态判定**：
   - **Green (成功)**：所有 required checks 存在且成功，且所有 observed checks 均为 success，跳出循环进入 Land 阶段。
   - **Pending (运行中)**：等待轮询周期（默认 5 秒），累计实际墙上时钟等待时间。若超过 `maxWaitSeconds`（默认 300 秒），触发超时 Blocker 退出。
   - **Failed (失败)**：进入修复循环：
     - 若 `spentRepairs >= maxRepairAttempts`（默认 3 次），**终止修复，进入预算耗尽交接**。
     - 若未配置修复函数或修复命令，**绝不空转重试**，直接输出诊断并停止派发。
     - 执行修复回调或 `--repair-cmd`。
     - 修复完成后重新执行本地验证。
     - 确认工作区有新改动（非空提交），生成修复提交并推送到远端。
     - 确认远端生成新的 HEAD SHA 后，继续监控下一轮 CI。

### 步骤 7：策略满足时自动合入 (Land / Auto-merge)
1. 触发合入的前提策略：
   - PR 归属于当前 Symphony 工单与工作区；
   - 显式声明开启合入授权（`--opt-in` / `optInLand: true`）；
   - PR 处于可合并状态（`mergeable === "MERGEABLE"`）；
   - CI 严格处于全绿（Green）状态。
2. 执行 Squash Merge：
   ```bash
   gh pr merge <prNumber> --squash --match-head-commit <headSha>
   ```
3. 验证最终合并与工单关闭状态：
   ```bash
   gh pr view <prNumber> --json state,mergeCommit
   gh issue view <issueNumber> --json state
   ```
   确认 PR 状态为 `MERGED`。若工单未自动关闭，输出 reconciliation 提示。

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
   **效果**：Symphony 基于 tracker label 路由将立即判定该工单为不可调度状态，停止后续 continuation 尝试与重复重派。
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
  --repair-cmd "npm run fix" \
  --max-repairs 3 \
  --max-wait 300 \
  --opt-in
```

### 手动或异常触发交接与暂停派发
```bash
symphony delivery-skill halt \
  --repo felixjichao/symphony-ts \
  --issue 80 \
  --reason "budget_exhausted" \
  --details "Manual intervention requested for broken integration tests"
```

---

## 5. Codex 集成与 WORKFLOW.md 配置参考示例

独立 `skills/` 目录文件不会被 Codex 自动载入，需通过项目 bootstrap 脚本安装到 Codex 可发现的技能目录，并在 `WORKFLOW.md` 中声明标签路由和调用规则。

### 5.1 工作流配置文件 (`WORKFLOW.md`) 最小示例

```yaml
tracker:
  kind: github
  repo: felixjichao/symphony-ts
  # 关键配置：只有携带 symphony-ready 标签的工单才会被调度
  # 当 delivery-skill 移除该标签后，Symphony 将自动停止派发与重试
  required_labels:
    - symphony-ready

agent:
  max_turns: 20
  timeout_ms: 1800000

hooks:
  # 初始化时将 delivery skill 安装到工作区的 Codex 技能目录
  after_create: |
    mkdir -p .agents/skills/github-delivery
    cp skills/github-delivery/SKILL.md .agents/skills/github-delivery/SKILL.md
```

### 5.2 Agent Prompt 中显式调用示例

在 Prompt 中引导 Agent 完成编码后调用 Delivery 技能：

```markdown
You are working on issue #{{issue.number}}.
Follow the standard delivery protocol:
1. Implement requested changes.
2. Run project verification: `npm run gate`.
3. Deliver the Pull Request and handle CI/Land:
   `symphony delivery-skill run --repo {{tracker.repo}} --issue {{issue.number}} --validate "npm run gate" --opt-in`
4. If halted with a handoff report, leave your final summary and stop.
```

### 5.3 凭据信任边界 (Credentials & Security)
- **Token 隔离**：使用环境变量（如 `GITHUB_TOKEN` 或 `GH_TOKEN`）注入 GitHub 凭据，本地 Git 自动通过 `gh auth setup-git` 进行凭据映射。
- **敏感信息脱敏**：`DeliveryGitGhRunner` 会自动对所有命令输出中的 URL token、GitHub PAT、Bearer 凭据进行掩码处理，防止敏感信息泄漏到 Issue 评论或执行日志中。
