## NEST-104 真实环境续验：主交付闭环通过（2026-10-11 19:09 CST）

用户明确批准恢复交付后，已完成 **真实 Plan → 发布计划 → host dispatch → Codex 实现 → GitHub CI → 同会话、精确 HEAD Review → 生产 delivery skill 自动 squash 合并 → 工单关闭 → 终态 workspace 清理**。

- 产品验证版本仍为 PR #107 HEAD `4c991876bb7dc6ac2aab1817d5008c09a9e165f1`；产品 PR #107 未合并。
- 真实目标：[工单 #20](https://github.com/felixjichao/symphony-delivery-dogfood/issues/20) → [PR #21，已合并](https://github.com/felixjichao/symphony-delivery-dogfood/pull/21)。最终 feature diff 仅 `src/math.mjs` 和 `test/math.test.mjs`；目标 9/9 tests、lint 通过。
- 审查及 CI HEAD：`e24c7585e4f98f379d9e8739bdbd6aba7ff8b749`。[该 SHA 的真实 CI](https://github.com/felixjichao/symphony-delivery-dogfood/actions/runs/38134414338) conclusion=success。
- `PlanTask` revision 1 与 `ReviewTask` revision 2 均属于 `github:felixjichao/symphony-delivery-dogfood#20`；整个链路绑定同一 ChatGPT conversation `6acb6a38-a5fc-83ea-9a4f-8580f0e510fc`，generation 1。Review context 包含已发布的当前 plan。真实 Web `approve` 已被 Bridge 持久化，target 精确匹配上述最终 HEAD。
- 生产 CLI 日志确认 `Review approved ... Proceeding to land`，随后自动合并；merge commit `2525eb4412f24601226a1efbd539f8a697b14980`，GitHub 读取回执确认 PR MERGED、Issue CLOSED。
- 合并后重启真实 host 做 terminal reconciliation，日志 `workspace_cleanup ... issue_id="20" ... status="removed"`；GH-20 目录已删除，workspace-root sentinel 保留。清理在重启时观察，非原进程连续运行证据。

### 恢复及人工介入，完整保留
1. 原 `--resume` 正确保留已过期截止时间，提交/推送/创建 PR 后以 `ci_wait_timeout` 停止。保存原状态后开启新的 900s 限时尝试，复用同一 PR/session/plan；不是延长原 attempt 的持久预算。
2. 保存旧状态时误将归档放进工作区，delivery CLI 将其提交。发现后把归档移到 workspace 外，再通过生产交付入口提交删除；未手工实现、修改功能代码或手工 merge。最终 diff 已核验仅包含实现及测试。
3. 旧 HEAD `5645f80…` 的真实 Web Review 指出归档文件超出计划范围并输出 `changes_requested`；该任务已被新 HEAD supersede，因此旧结果未被 Bridge 接收。Driver 报 `Cannot fail superseded task` 并停止，需手动点 Start。新 HEAD 创建独立 revision 2 Review，重新得到并持久化 `approve`。这是一个真实恢复问题，不包装为完全无人干预的运行，也不把未接收旧结果称为完成的 repair/re-review 自动闭环。
4. Web Driver 使用既有安装版，未校验 bundle SHA；#107 的 CLI/host/Bridge 固定版本已校验，但不能将浏览器安装版视为 #107 自包含的实现证据。

### 验收边界
主交付链路与正常 Plan→Review 会话复用已实测通过。真实 clarification/human 分支、丢失 conversation 的 rollover、修改 GitHub 需求后新 plan revision 的完整流程尚未实测；此前的 `requirements_changed` 是真实 Bridge 上只读负向探针。

**本机全量 gate 仍不能报告通过**：此前记录的 macOS 路径差异、agent timeout 后 after_run marker 缺失、workspace Git 超时清理失败保留；单 worker 复跑 agent 1 fail、workspace 2 fail。typecheck/lint/docs:check 与相关规划测试通过、GitHub 产品 HEAD gate 为 pass。主链路成功不等同于所有验收项均已满足。
