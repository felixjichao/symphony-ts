# Agent Note: Codex Delivery + Land Workflow Skill (SPEC §11.5 / MVP.2)
Status: accepted

## Problem

Coding Agent 在完成代码修改与本地测试后，需要标准、可复用的流程推进 Pull Request 创建、CI 检查监控与自动合入（SPEC §11.5 / MVP.2）：
1. **交付策略归属**：Orchestrator Core 必须保持调度与生命周期的最小职责，不应感知 PR、CI 或分支合并的业务逻辑；交付闭环策略应当归入 Agent Tooling 与 WORKFLOW 扩展层。
2. **PR 归属与复用**：在重入运行或重试中，必须能够准确识别由当前工单/工作区创建的 PR，严禁重复创建重复 PR，严禁篡改或认领非当前工单所有的外部 PR（严格校验所属标记，拒绝以普通关闭引用绕过）。
3. **CI 监控与有限修复循环**：CI 检查必须严格绑定最新 HEAD commit SHA 评估，使用跨版本兼容的 `gh pr view --json statusCheckRollup,headRefOid,mergeable,state` 读取结构化状态。当 CI 失败时，需提取失败上下文进入修复循环；但修复循环不能空转，未注入修复手段时必须立即停派，且受到持久化预算（`maxRepairAttempts`）与实际墙上时钟超时（`maxWaitSeconds`）约束。
4. **预算耗尽后的调度控制（关键用户确认决策）**：当预算耗尽或遭遇 Blocker 时，若仅输出文本而不改变调度状态，Orchestrator 调度器会不断触发重派重试；若直接关闭工单，则会误报任务完成；若在 Core 中新建暂停状态机，则违背架构边界。必须在移除标签后真实重读标签状态核验，记录真实停派结果。

## Decision

我们在 `@symphony/domain`、`@symphony/agent`、`apps/cli` 与 `skills/github-delivery/` 落地交付闭环与有界预算控制：

1. **领域模型与所属校验 (`@symphony/domain`)**：
   - `DeliveryContext`：定义交付上下文（仓库、Issue 编号、WorkspaceKey、Head/Base 分支）。
   - `PrOwnershipMarker`：以 HTML 注释规范 `<!-- symphony-delivery-marker: {...} -->` 嵌入 PR 正文底部，提供机器可读的归属校验。严禁使用普通文本关键字绕过该标记。
   - `evaluateCiChecksPolicy`：纯函数评估 CI 策略。要求所有 required checks 成功且所有 observed checks 也必须严格为 success（不允许 neutral/skipped 绕过）；0 checks、pending、failed 均拒绝合入。
   - `formatDeliveryHandoffMarkdown`：格式化 Operator 可见交接报告，诚实展示标签移除与评论发表结果。
   - `PersistedDeliveryState`：定义跨尝试预算与暂停状态持久化契约。

2. **交付闭环执行器 (`@symphony/agent`)**：
   - `runDeliverySkill`：按 `pre-mutation inspection → validate → commit → push → ensure PR → inspect CI → repair loop → opt-in land` 协议执行。
   - Pre-mutation 检查：在任何 Git/GitHub mutation 之前核对当前分支、origin 仓库、Issue 状态以及 `--state all` 的现有 PR（避免污染外来分支或重复交付已合并工单）。
   - 项目验证真实执行：通过 `runner.exec(validationCommand)` 真正执行门禁命令，失败时禁止提交、推送或合入。
   - 依赖注入接口 `DeliveryGitGhRunner`：定义 safe git/gh/exec subprocess 契约，与平台解耦，并提供 `sanitizeCredentials` 防止 token 泄漏。
   - 严格修复循环：CI 失败时，若未配置 `repairFn` 或 `repairCommand`，直接输出诊断并停止派发；修复后必须重新验证并检查生成了新的 HEAD SHA。
   - 跨尝试预算持久化：将执行状态保存至 `.symphony/delivery-state.json`，使用真实墙上时钟截止时间，中断或重启后未经 `--resume` 明确授权拒绝自动重派。

3. **预算耗尽停派决策（用户确认）**：
   - 当修复次数耗尽（`ci_failed_max_repairs`）或 CI 等待超时（`ci_wait_timeout`）时：
     - 保持 GitHub Issue 处于 **Open** 状态（绝不误关闭）；
     - 自动调用 `gh issue edit <issueNumber> --remove-label symphony-ready` 移除就绪标签，并重新查询 Issue 标签事实核验；
     - Orchestrator 的 label 路由立即将该工单判定为不可调度，**停止 continuation 循环与未来派发**；
     - 若移除标签失败，CLI 返回非零退出码并在报告中明确标警；
     - 在 Issue/PR 发表交接报告，说明已耗预算与人工排查后的恢复指引（加回标签恢复派发）。

4. **CLI 工具集成与 Skill 标准文档**：
   - `apps/cli` 提供 `symphony delivery-skill [run|halt]` 命令，支持 `--opt-in` 显式合入授权、`--repair-cmd`、`--resume` 与安全整数校验。
   - `skills/github-delivery/SKILL.md` 提供完整步骤、约定规范、WORKFLOW.md 配置与 bootstrap 参考样例。

## Alternatives considered

- **Alternative 1: 预算耗尽时自动关闭 GitHub Issue**:
  被否决。工单未达成实际目标或 CI 失败时关闭 Issue 会误向团队和外部系统传达“任务已正常完成”的假象，混淆状态语义。
- **Alternative 2: 在 Orchestrator Core 中新增专门的 Delivery 状态机与暂停状态**:
  被否决。SPEC §11.5 与架构原则明确规定 Delivery 属于 Agent Tooling / WORKFLOW 领域，Orchestrator 仅通过 Tracker 归一化状态和 Label 进行调度。通过移除既有的 `symphony-ready` 标签，既复用了现有路由规则，又保持了 Core 的精简与解耦。
- **Alternative 3: 仅依赖 PR 标题匹配复用既有 PR**:
  被否决。标题容易被外部编辑或发生冲突。采用嵌入 PR 正文底部的序列化 JSON 注释标记（`PrOwnershipMarker`）结合 Issue 编号校验，能够杜绝误抢占外部 PR。

## Consequences

- Symphony 获得了从代码验证到 PR Squash Merge 的可复用 GitHub 交付能力。
- 预算耗尽或 Blocker 发生时具备清晰的 Operator-visible 输出与自动停止派发保障，防止死循环与算力浪费。
- 彻底解决了 PR 伪造所有权、CI 版本兼容性、命令空转与未授权合入等安全隐患。
- 符合 SPEC §11.5 / MVP.2 要求与 AGENTS.md 依赖方向规范。

## Review hardening (2026-10-04)

- Persist the absolute wait deadline before delivery operations and pending sleeps. Restart and `--resume` preserve that deadline and spent repairs; resume does not grant a fresh budget. State write failures stop before further delivery operations.
- Discover required checks from both paginated active branch rules and classic protection. A generic 404, permission error or malformed response is unknown policy, requiring handoff or an explicit complete `requiredChecks` configuration. A ruleset success cannot mask a classic-protection failure. See [active branch rules API](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch) and [authentication errors](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api).
- Match failed jobs to their Actions run URLs for the pushed commit. Every failed check must have usable diagnostics; inaccessible, empty or partial logs stop before spending repair budget. External check providers without Actions logs require operator handoff in this MVP.
- Bootstrap examples use the existing `repo-bootstrap` command and actual hook workspace key. Delivery derives the key from the current `symphony/<key>` branch rather than GitHub's null `branchName`.
- Rejected alternatives: treating any 404 as no protection, using only one successful rules source, matching workflow/job names by substring, or extending the wait deadline on restart. Each can lose safety or budget guarantees. Local fixture regressions verify these paths; real Codex/GitHub delivery remains #83's external dogfood.
