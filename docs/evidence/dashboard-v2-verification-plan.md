# Dashboard V2 / #168 分步验证计划

日期：2026-10-29。范围：SPEC §13 邻接、§17/§18 验收；不新增产品能力。

## 判定规则

每项记录结论、证据链接、绑定的 commit/task/revision、限制与下一步。结论使用：通过、失败、证据缺失、不适用。人工替代单独标记，不计为自动执行通过；历史事实不能靠今天补跑追认。

## 1. 固定验收基线（已完成）

- #196 最终 PR HEAD：`0f2affa8de1a37667c37294e4a1ad12a0ec82d94`。
- merge commit / 当前远端 main：`9fd0f6d4834c9ca0e96f445d4a29c9de87d57775`。
- #196 已合入；#168 仍 open。
- 最终 PR HEAD 的 gate、detail-browser、operational-browser、production-status-browser 均 success。
- 本地 checkout 为 `c7581629c4bec7191e144efd415781971c4cef58`，不作为完整 V2 的验收基线。

证据：[PR #196](https://github.com/felixjichao/symphony-ts/pull/196)、[最终 HEAD CI](https://github.com/felixjichao/symphony-ts/actions/runs/40881313087)、[父任务](https://github.com/felixjichao/symphony-ts/issues/168)。

## 2. 核验生产路径与浏览器证据（已核验，范围与限制见结果）

读取最终 HEAD 的 production-status-closeout artifact，而非仅看 job 绿灯。核对 report 的 sourceCommit、sourceTree、workingTree、harness/fixture/asset hashes、场景结果和页面错误；检查五个页面桌面/窄屏截图与导航、WorkKey 隔离、四态 freshness、独立 HEAD、部分失败、transport 恢复断言。

通过标准：报告确实绑定最终 PR HEAD 的 clean tree，生产 composition 路径及要求场景通过。截图仅作为补充。记录 artifact 到期时间；归档允许导出的报告与证据索引。若不可下载或已过期，标记证据缺失，再在独立基线 checkout 补跑；补跑只证明当前复验。

## 3. 核验 #176 原生 Decision 回执

先定位现有 Bridge 的只读查询或原子持久化快照，按完整 WorkKey 查 task/result/receipt；避免打开第二个 writer 或影响运行中的 store。对照最终 HEAD、task ID、revision、target、verdict、supersession 与接受回执，区分公开 review comment 和原生 Decision result。输出脱敏字段与 hash，不输出 token、cookie 或会话全文。

通过标准：最终 HEAD 对应的有效批准与原生接受回执完整匹配。若不存在，记录缺口；PR 已合入，先核实审查 admission 规则，不直接重放历史 ReviewTask，也不把新增事后审查写成合入前审查。

## 4. 核验 #176 Delivery 与 recovery 对账

只读比对 delivery state、handoff、recovery ledger、子进程回执与 GitHub PR/issue 事实。逐项检查 outcome_unknown、manual_intervention_required、补偿报告和未完成 intent 的最终处置，区分人工 merge 与自动 Delivery。使用现有 recovery list/show；验证阶段不执行 authorize、resume 或 recover-handoff。

通过标准：merge SHA、PR、issue 和原生状态一致；每个遗留 intent/incident 均有可解释处置。存在未对账状态时先列出精确对象、fence 和修复方案；修复作为后续独立动作，不在盘点时清空记录或重置预算。

## 5. 补齐 #169–#175 历史矩阵

每个 child 一行，核对 PlanTask、workspace 执行、validation/CI、最终 HEAD Decision review、repair、Delivery、issue close、stable host/restart。先读 GitHub issue/PR/CI，再补可读取的原生记录；禁止从 issue closed 或 PR merged 推断整链自动成功。

通过标准：每个阶段都有证据，或明确标记人工替代/证据缺失；无法恢复的历史证据保持例外，另做实验只能证明当前能力。重复 incident 评论不当作独立故障次数。

## 6. 收口文档与最终判定

基于步骤 2–5 更新现有 closeout ledger、docs/status.md、docs/conformance.md 和 #168 验收映射，保留原始历史证据。文档变更跑 docs:check；提交前按仓库要求跑 gate。仅在需要补跑验收、发生新变更或发现证据问题时重跑相关浏览器检查。

分别给出：产品验收、自托管证据、原生状态对账三个结论。若历史例外尚待接受，保留 #168 open，并列出具体例外；维护者接受后才能表述为“在列明限制内验收通过”。发布评论和关闭 issue 留到结果可审阅且得到用户明确授权时执行。

## 执行顺序

1 → 2 → 3 → 4 → 5 → 6。每步结束更新结果再推进；某项因外部访问受阻时保留缺失状态，继续不依赖该项的只读核验。产品能力通过不自动代表自托管通过。

## 当前执行结果

2026-10-29 已完成步骤 2 的产物核验、步骤 3/4 的只读原生状态核验，以及步骤 5 的 GitHub/CI/Plan/Review/现存 Delivery 第一轮盘点；历史 coding/host 全链路仍待核验。步骤 6 已形成独立[验证结果](dashboard-v2-verification/README.md)，canonical 文档收口待缺口处置。已定位最终 HEAD Decision 回执缺失和遗留 handoff 补偿未完成，未执行任何恢复或状态变更。

第二轮补充八个 PR 的提交链/基线关联、部分 session 文件的精确 blob 对应，以及六个 child 的 Delivery push 回执关联；复验超长报告并确认普通恢复路径不足。已形成[对账方案](dashboard-v2-verification/reconciliation-plan.md)，待实施修复/接受历史例外后再收口，未将证据缺失改为通过。
