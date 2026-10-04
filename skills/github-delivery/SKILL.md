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

首次交付动作前即保存绝对等待 deadline；pending 中断、restart 和 `--resume` 均保留 deadline 与已耗修复次数。`--resume` 仅解除暂停，不授予新预算。新的预算轮次需 operator 明确批准并归档旧状态后初始化，不能通过重复 resume 延长等待。

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

独立 `skills/` 目录文件不会被 Codex 自动载入，需通过项目 bootstrap 挂载到 Codex 可发现的技能目录（如 `.agents/skills/github-delivery`），并在 `WORKFLOW.md` 中声明标签路由和调用规则。

### 5.1 工作流配置文件 (`WORKFLOW.md`) 最小完整示例

```yaml
tracker:
  kind: github
  provider:
    repo: felixjichao/symphony-ts
    token: $GITHUB_TOKEN
  # 关键配置：只有携带 symphony-ready 标签的工单才会被调度
  # 当 delivery-skill 移除该标签后，Symphony 将自动停止派发与重试
  required_labels:
    - symphony-ready

agent:
  max_turns: 20

hooks:
  # 新建工作区时先执行仓库拉取，切到工单分支，并就绪 Codex 技能定义
  after_create: |
    set -eu
    symphony repo-bootstrap --repo https://github.com/felixjichao/symphony-ts.git --workspace-key "$SYMPHONY_WORKSPACE_KEY"
    mkdir -p .agents/skills/github-delivery
    cp skills/github-delivery/SKILL.md .agents/skills/github-delivery/SKILL.md
```

### 5.2 Agent Prompt 中显式调用示例

在 Prompt 中通过严格的 Liquid 变量（基于 `renderPrompt` 支持的规范字段 `issue.native_ref`）引导 Agent 完成编码后调用 Delivery 技能：

````liquid
You are working on issue #{{ issue.native_ref.number }} ({{ issue.identifier }}).
Task Title: {{ issue.title }}
Task Description: {{ issue.description }}

Follow the standard delivery protocol:
1. Implement requested changes in the worktree.
2. Run project verification: `npm run gate`.
3. Deliver the Pull Request and handle CI/Land:
   ```sh
   set -eu
   delivery_branch="$(git branch --show-current)"
   delivery_key="${delivery_branch#symphony/}"
   test -n "$delivery_key" && test "$delivery_branch" != "$delivery_key"
   symphony delivery-skill run --repo {{ issue.native_ref.repo }} --issue {{ issue.native_ref.number }} --workspace-key "$delivery_key" --head "$delivery_branch" --validate "npm run gate" --opt-in
   ```
4. If halted with a handoff report, summarize the outcome and stop.
````

该 YAML 是 WORKFLOW.md 的 front matter（放在 `---` 分隔符之间）；5.2 的 Prompt 放在第二个分隔符之后。主机需先构建并把包含 `repo-bootstrap` / `delivery-skill` 的 `symphony` CLI 放入 PATH。Bootstrap 默认生成 `symphony/<workspaceKey>`，Prompt 从当前 Git 分支取得同一 key，不依赖 GitHub 的空 `branch_name` 或不存在的 hook 环境变量。`after_create` 在 bootstrap 成功后复制 skill；现有 workspace 需按相同步骤安装一次。

未提供 `--required-checks` 时，工具必须成功发现 active rulesets（使用兼容 gh 2.45 的 `--paginate --jq '@json'`，逐页输出 JSON 数组并严格聚合）及 classic protection，或确认后者明确返回 Branch not protected；普通 404、权限失败、畸形响应均交接。Operator 可提供完整的 `--required-checks "gate,lint"`（包含所有规则来源）作为明确策略；空字符串代表明确无 required，仍要求 observed checks 成功。

### 5.3 凭据信任边界与子进程 Secret 隔离 (Credentials & Child Isolation)

- **主机与子进程 Secret 隔离**：遵循 `@symphony/agent` 的环境隔离原则，宿主 Orchestrator 配置的敏感 Provider Secret（如 `GITHUB_TOKEN`）应加入 `excludeEnvNames`（如 `["GITHUB_TOKEN", "GH_TOKEN"]`），禁止不受信任的子进程直接读取宿主长效 Token。
- **主机预配置凭据助手 (Git Credential Helper)**：通过主机级 `gh auth setup-git` 或系统级凭据缓存为子进程执行的 Git/gh 命令提供身份认证，子进程执行 `git push` 或 `gh pr view` 时直接走系统凭据流，无需将原始 Token 写入子进程环境变量中。
- **输出脱敏 (Credential Sanitization)**：`DeliveryGitGhRunner` 会自动对所有执行输出中的 URL Token、GitHub PAT、Fine-grained PAT 以及 Bearer 头部进行脱敏掩码（`sanitizeCredentials`），杜绝任何凭据意外写入 Issue 评论或终端日志。


### 5.4 可选真实 gh 兼容验证

默认 gate 不访问 GitHub。需要验证宿主 gh 与真实规则查询时，可显式执行：

```sh
SYMPHONY_TEST_GH_RULES_REPO=felixjichao/symphony-ts npm test -w @symphony/cli -- --run src/delivery-gh-compatibility.test.ts
```

该测试由生产 `runDeliverySkill` / `DefaultDeliveryGitGhRunner` 发出真实 active-rules 只读查询；Git、classic protection、PR/checks 与所有 mutation 使用隔离 fixture。它证明命令兼容与进入 CI 判定，不代表完整保护配置发现或真实交付 dogfood。测试目标需为 `main` 上无额外 required checks（或仅 `gate`）的受控仓库；未设置 opt-in 环境变量时显式 skipped。
