# #168 遗留状态对账方案

基于 [只读审计](README.md)。SPEC §4 Delivery 扩展、§8/§14 coordination 邻接、§17/§18 验收。此文件不授权发布评论、恢复执行或关闭 issue，也不新增已存在的 CLI 命令。

## 1. 先修交接报告长度

当前状态：已在 `codex/bounded-handoff-reports` 本地分支实现，尚未部署或作用于原生运行态。验证详情见 [本地格式化复验](bounded-handoff-check.json)。步骤 2/3 仍待实施与收口。

Owner：`packages/domain` 的统一格式化契约，以及 `packages/agent` 的首次交接/补偿调用；CLI 只负责装配。

在保留完整原始诊断的前提下，发布有界摘要，保留 WorkKey、handoff ID、原因、HEAD、预算和定位信息。保留原始 details 的 hash/长度及截断声明，不把数百 KB gate 输出直接发送到 GitHub。首次发布与 recover 使用同一规则，稳定 marker 必须保留在长度界限内；不因截断生成新 handoff ID。不把长日志上传到公共位置作为默认行为。

验收：真实 #173/#175/#176 脱敏 shape 的大文本、Unicode 和超长单行仍生成受限正文；首次/补偿输出规则一致；ACK 丢失后按原 marker 核验，不重复发布；原始持久诊断和预算保持不变。

该修复只解决超长报告，不解决 #169/#175 旧 HEAD 校验，也不能补齐原生 Decision 历史批准。

## 2. 增加或确定外部交付后的原生结算路径

当前已核验路径不足以安全结算全部对象：`recover-handoff` 只补报告；`run --resume` 会先补偿并重新进入原生交付检查。#173/#176 的人工 PR 无 ownership marker；#169/#175 handoff 的 HEAD 已过期。

先记录具体授权目标，设计单独的外部结算操作；不得复用普通 retry/authorize 来表达“外部已完成”。跨包协议变化按仓库要求写 Agent Note，并评审 alternatives。Owner：domain 提供类型，agent 保持 Delivery 原生状态权威，CLI/host 负责持久化与 coordination；tracker 提供权威 GitHub 事实，不拥有调度策略。

| 对象 | GitHub 完成目标 | 本地遗留对象 |
| --- | --- | --- |
| #169 / #178 | 最终 HEAD `c0d38f54…`，merge `cb671b74…` | handoff `handoff-felixjichao-symphony-ts-169-1792942138132-m9rgz7` 仍绑定 `47b3c3f1…` |
| #173 / #191 | 最终 HEAD `caa16c9c…`，merge `3b5eb8ff…` | paused handoff 无 PR/HEAD；compensate invocation `a16ed3b9-3115-44d0-8ac0-9212609e90ed` |
| #175 / #195 | 最终 HEAD `be7dc2f5…`，merge `53d6d1b0…` | handoff 仍绑定 `95a8c2e9…`，continuation 为 repair_pending |
| #176 / #196 | 最终 HEAD `0f2affa8…`，merge `9fd0f6d4…` | paused handoff 无 PR/HEAD；compensate invocation `eeb57254-7a0e-40de-9a73-ee9ed068e8ec`；旧 HEAD ReviewTask 仍 claimed |

完整 SHA、handoff、fence 与源文件 hash 分别见 [原生审计](native-audit.json)、[PR 归属](ownership.json)。执行前必须重新观测，以上不能作为永久授权。

结算门禁：确认旧执行器无法再产生效果；在原有 authority/mutex 与 writer 内，以当前快照身份、handoff ID、intent/invocation、task revision/generation 做精确比较；重新验证 GitHub merged/closed、仓库、分支、最终 HEAD 和 merge SHA。人工 PR 缺 marker 时，必须独立的显式授权，不能伪造 marker 后假称为原生交付。

输出应记录 external/manual completion receipt，保留旧失败、预算和原始回执。精确退役陈旧 intent/request，并通过原生 API 取消/取代已无效任务；不得伪造 approve result、把 commentPosted 改成 true、重置预算或删除 ledger。遇到新 owner、新 HEAD 或证据不明立即拒绝。

验收：正常外部结算、进程重启、重复提交、过期授权、新 owner/HEAD、无 marker 人工 PR、ACK 不明、旧 task 晚到结果及 cleanup admission；证明不再启动 coding/review/merge，也不重复发交接评论。

当前 sandbox 的进程查询被拒绝，不能确认实际 host/旧执行器的存活与停止事实；本轮未尝试停止或修改进程。任何结算实施都必须先补这一门禁。

## 3. 补验收与接受历史例外

生产 browser matrix 补明确 failed attention 的 source-fact 场景，以及 source/executor 展示逐项断言；保持 operations 派生语义，不能用前端构造领域结论。新增证据是当前复验，不回填为历史成功。

#173/#175/#176 最终 HEAD 的原生 Decision 批准在当前 store 和已盘点备份中缺失。合入后的 PR 不满足现有 Web review admission 的 OPEN 条件，因此不能直接补跑原任务。可另做标明事后性质的审查；历史例外由维护者明确接受，不能替代合入前 exact-HEAD 批准。

分别确认产品验收、人工介入例外和原生状态结算结果后，再更新 canonical status/conformance/closeout ledger 与 #168 清单。提交前跑完整 gate；浏览器覆盖变化跑对应 exact-HEAD CI。父任务关闭属于最终独立动作。
