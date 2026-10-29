# #168 验证结果（2026-10-29）

这是一次只读证据审计，没有重跑产品验收、恢复任务或修改运行态。SPEC §13 邻接、§17/§18。验收基线为 PR #196 最终 HEAD `0f2affa8de1a37667c37294e4a1ad12a0ec82d94`，merge commit `9fd0f6d4834c9ca0e96f445d4a29c9de87d57775`。本地旧 checkout 不作为完整 V2 产品验收基线。

## 结论

| 项目 | 结果 | 范围 |
| --- | --- | --- |
| 最终 HEAD CI 与生产浏览器产物 | 通过 | 报告身份、源码 hash、生产链路、20 个已声明场景；不证明外部 live source 验收 |
| #176 最终 HEAD 原生 Decision 批准 | 证据缺失 | 当前 store 无对应 task/result/receipt；旧 HEAD task 仍 claimed |
| #176 Delivery/recovery 对账 | 未通过 | GitHub 已 merged/closed，原生 delivery 仍 paused、补偿未完成 |
| 历史 child 原生批准盘点 | 部分通过 | #169/#170/#171/#172/#174 匹配；#173/#175 缺最终 HEAD 批准 |
| 全链路自主交付验收 | 尚未成立 | workspace 执行、历史 stable-host 和自动 Delivery 等阶段未全部核实 |

## 生产浏览器证据

[最终 CI run](https://github.com/felixjichao/symphony-ts/actions/runs/40881313087) 的 gate、production-status-browser、detail-browser、operational-browser 均 success。

- 生产 artifact ID `12900048913`，原始有效期至 `2026-11-28T13:28:42Z`；报告和十张原始截图已归档，避免仅依赖短期 CI 保留。
- [生产报告](production/report.json)：sourceCommit 对应最终 HEAD；workingTree 为空；sourceTree `1febceea31620c068f4f29e52bd45b61fcd106b9` 与 GitHub commit API 一致。
- 从该 HEAD 的原始仓库文件独立计算 SHA-256，harness `0d33668c…`、fixture `993e08d6…` 均与报告完全匹配。
- 报告记录 20 个 passed 场景、42 次 API GET、零 pageErrors；harness 使用真实 `startStatusSurface`、operations、HTTP 和 built Dashboard，并额外运行不同 cwd 下的实际 CLI executable 空 scope。
- 静态检查 harness 确认 WorkKey 跨仓库隔离、快照计数、三组独立 SHA、路由/刷新、键盘焦点、390px 布局与 transport 中断恢复断言。十张截图总览已检查，存在五个页面的桌面/窄屏输出；未逐像素审查所有长页细节。
- [Operational 补充报告](operational/browser.json) 来自 artifact `12900288368`，HEAD 和 assets 与生产报告一致；独立核对 harness hash 及五张截图 hash 全部一致。该 harness 明确断言 active/idle executor、四态 freshness、global/work anomaly、executor→Work 导航与 transport 错误保留；使用 demo service + prepared snapshot，只是展示补充证据。

限制：生产报告明确 externalLive=not run；生产 smoke 没有独立命名的 failed-work 场景，截图来自 result-mismatch 固定样例，其 executor inventory 为空。不能把这些截图说成所有状态的视觉验收，也不能把补充 demo 断言说成生产端到端证明。若父任务要求每个列举状态均有生产端到端断言，应补 failed-work 及逐项 source/executor 展示断言或链接已有覆盖；本次未将该缺口归类为产品实现缺陷。

截图示例：[Overview](production/overview-desktop.png)、[Work](production/work-narrow.png)、[Detail](production/detail-desktop.png)、[Executors](production/executors-narrow.png)、[System](production/system-desktop.png)。完整原始文件的 hash 见 [manifest](manifest.json)。

## 原生 Decision 回执

只读读取 `/Volumes/Data/symphony-runtime/state/decision/store.json`，transactionSequence `648`；调用仓库 `validateStoreRecord` 通过，未打开 store writer。结果只导出目标、状态、时间和布尔核验，不导出 claim token、认证信息或对话正文。来源文件 hash 与观察时间见 [原生审计](native-audit.json)。这是单个文件的原子读取；不同文件间不宣称事务一致快照。

| Issue / PR | 最终 HEAD 原生批准 | 详细结果 |
| --- | --- | --- |
| #169 / #178 | 通过 | review revision 2、completed、approve |
| #170 / #181 | 通过 | review revision 2、completed、approve |
| #171 / #183 | 通过 | review revision 2、completed、approve |
| #172 / #190 | 通过 | review revision 2、completed、approve |
| #173 / #191 | 缺失 | 当前 session 只有 completed/ready PlanTask；全 store 无最终 HEAD task |
| #174 / #194 | 通过 | review revision 2、completed、approve |
| #175 / #195 | 缺失 | 仅旧 HEAD `95a8c2e…` 的 changes_requested；全 store 无最终 HEAD task |
| #176 / #196 | 缺失 | 仅旧 HEAD `d62f071…` 的 claimed task，无 result/receipt；全 store 无最终 HEAD task |

五项通过均核对 task/result/receipt 的 ID、session、revision、target、claimGeneration、claim token 相等性、receipt payload、acceptedAt 早于 merge，且最终 task 未 superseded。八个 child 的 PlanTask 均 completed/ready 并有 result receipt。

对本机 backups 下九份可识别 store/decision-store JSON 快照搜索 #173/#175/#176 最终 HEAD，未发现匹配；详见 [备份搜索](backup-search.json)。该结论只涵盖当前本机 store 与已列出的备份，不代表不存在其他归档。公开 GitHub review 评论不替代原生 Decision 回执；事后补跑也不能追认为合入前批准。

## Delivery 与 recovery 对账

#176 在 GitHub 于 `2026-10-29T13:36:39Z` 合入，issue 于 `13:37:33Z` 关闭。[GitHub 原始字段摘录](github-facts.json) 同时保存全部 child 最终 HEAD、merge SHA 和 CI checks。

但 `GH-176/.symphony/delivery-state.json` 仍为：

- `isPaused=true`、`pauseReason=manual_intervention_required`；lastUpdated `2026-10-29T10:15:18.808Z`。
- `pendingCompensation=true`、`commentPosted=false`、`commentVerifyStatus=unverified`。
- handoff `handoff-felixjichao-symphony-ts-176-1793268777421-5go0o2`，PR/HEAD 均 null。
- host recovery.json 仍有 invocation `eeb57254-7a0e-40de-9a73-ee9ed068e8ec` 的 handoff compensate request；当前 delivery:recover、delivery:blocked、handoff:recover budgets 仍引用 incident。
- delivery log 明确记录 `Body is too long (maximum is 65536 characters)`，发布 handoff comment 失败；details 约 280 KB。超长评论失败是直接日志证据，不是推测。

#173、#175 也保留 paused delivery；#173 仍有 pending recovery request。#169 保留旧 HEAD 的 paused delivery，即使最终 HEAD 原生审查已通过。#170/#171/#172/#174 当前 workspace 未找到 delivery-state，不能据此认定自动交付通过或失败。ledger 的历史 incidents 不自动等同当前未解决故障；本次按 current budget 引用与具体 intent/state 交叉核查。

下一步修复应先定义“外部人工交付完成后退役旧 intent/handoff”的现有支持路径，精确绑定 PR、最终 HEAD、merge、handoff ID 和 invocation/fence；另处理超长报告的有界摘要/附件策略。不能直接 authorize 重放旧任务、删除 ledger 或重置预算。该修复不属于本次只读审计。

## 历史链路与收口

已完成八个 child 的 GitHub merge/closure、最终 HEAD checks、当前原生 Plan/Review 回执和现存 delivery-state 盘点。另扫描本机 2026-10-25 至 29 的 Codex session metadata，八个 child 均有对应独立 GH workspace 的会话和 task_complete 事件，摘录见 [coding session metadata](coding-sessions.json)。这些记录含多轮执行、修复或无有效工作重试；会话数量及 task_complete 事件不代表成功 coding 次数，也不单独证明其产物对应最终 PR。尚未逐一完成 session 修改产物、修复执行及 supervising host/restart 的交叉核验，因此不宣称历史全链路审计完成。现有 #176 stable-host 记录仍仅在原证据范围内成立。

父任务保留 open。先解决或明确接受 #173/#175/#176 最终 HEAD Decision 证据例外、遗留 delivery/recovery 对账和生产覆盖限制，再更新 canonical status/conformance 与父任务验收清单。本次仅增加独立审计记录，未在旧本地 checkout 中覆盖远端已演进的 canonical 状态文档。

## 第二轮：会话产物关联与恢复路径核验

已从 GitHub 读取八个 PR 的完整提交列表、首次及最终提交的 blob tree，结果分别归档在 [PR 提交链](pr-commits.json) 和 [产物关联](artifact-linkage.json)。解析本机 session 中的字面量 heredoc 与白名单字符串替换，静态重建部分写入内容并计算 Git blob SHA；没有执行日志里的 shell/Python。该方法验证文件内容关联，不证明所有最终差异均由该 session 完成。

| Child | 会话内容与最终/首次 PR blob 完全一致的示例 | Delivery 推送提交与 PR 提交链对应 |
| --- | --- | --- |
| #169 | routing.ts、Agent Note | 是 |
| #170 | primitives.ts、primitives.test.ts | 是 |
| #171 | overview.test.ts、Overview evidence README | 是 |
| #172 | explorer.test.ts；Agent Note 对应首次提交 | 是 |
| #173 | detail.ts、Agent Note | 日志未找到推送回执 |
| #174 | detail.ts、evidence.ts、anomaly.ts | 是 |
| #175 | executors.ts、Agent Note | 是 |
| #176 | 存在基线会话及写入记录，但本轮未建立精确 blob 匹配 | 日志未找到推送回执 |

全部 child 都存在 session 起始 commit 与首次 PR commit parent 相符的记录。#176 多个会话包括修复/重试，不按数量衡量成功。日志仅导出指定 Delivery 事件、行号与源文件 hash，不导出完整执行输出。#173/#176 的人工提交仍保留为例外；文件和部分推送证据不能追认为全自动交付。

恢复路径以最终 PR HEAD 源码核查：`recover-handoff` 与 `work-continuity`、cleanup、review admission 源码的 blob 均与本地对应文件相同；runner/formatter 的完整文件已独立读取最终 HEAD 后核对关键分支。

- `recover-handoff` 只处理 label/report 补偿；不把外部已合入转换为原生 Delivery 完成。
- `resume` 在观察已合入前先尝试 pending compensation；paused 未显式 resume 时直接拒绝。
- #169/#175 旧 handoff 绑定的 HEAD 不同于最终 PR HEAD，补偿的 ownership/HEAD 门禁会拒绝；不能简单改 HEAD 重试。
- [PR 归属核验](ownership.json)：#173/#176 的人工 PR 无 Symphony delivery marker，原生自动交付不能直接接管；#169/#175 有 marker。
- 现有 Web review admission 要求 PR OPEN 且 HEAD 匹配；三个缺失回执不能靠对已合入 PR 重放旧任务补齐。

对真实持久化 handoff 仅调用纯 formatter，确认其函数文本与最终 HEAD 一致，没有发出网络写请求。#173/#175/#176 的完整评论分别为 279,641 / 278,917 / 280,582 个 Unicode code points，均远超日志中 GitHub 返回的 65,536 字符上限，见 [格式化复验](handoff-format-check.json)。原实现没有对 details 做长度限制；因此普通重试不能修复此问题。

第二轮没有改变第一轮结论：已有产品证据通过，历史全链路自动交付与原生状态结算尚未通过。具体后续工作、精确目标与验证门禁见 [对账方案](reconciliation-plan.md)。历史稳定 host/修复全过程仍未完全核实；当前 sandbox 也不允许进程查询，因此未验证正在运行的执行器身份，不作安全退役操作。

## 第三轮：交接正文长度本地修复

修复基于最新主线 `9fd0f6d…`，在 `codex/bounded-handoff-reports` 分支实施。唯一生产行为改动位于 domain 的统一 formatter；首次发布与 recover 沿用既有调用，不改原生状态协议。短报告输出不变，长详情保留前缀并附原长度、SHA-256 和截断提示；完整报告不超过 60,000 UTF-16 单元，不切断 surrogate pair，不丢 handoff marker。无法容纳身份元数据时明确失败，不静默删减回执身份。设计取舍见 [Agent Note](../../../notes/accepted/architecture/2026-10-29-bounded-delivery-handoff-comments.md)。

domain 回归首先复现原正文 320,663 单元超限，修复后覆盖 ASCII、四种 Unicode 截断边界和极端元数据。agent 回归覆盖首次发布失败后补偿、已接受评论 ACK 丢失、重复恢复不重发、原始诊断/预算不变且不 commit/push。

使用三个实际遗留 handoff 做只读格式化，[复验结果](bounded-handoff-check.json) 均为 60,000 单元、marker 与原诊断 digest 完整；逐文件比对确认原生 state 未改变。该复验只说明本地 formatter 修复，不是已发布评论或生产恢复。步骤 2 的外部结算和缺失 Decision 历史回执依旧未闭合。

完整 `TMPDIR=/private/tmp npm run gate` 已在宿主权限下通过：12 个 workspace 共 2,609 passed、1 个既有 opt-in skipped，typecheck、lint 和文档检查通过。第一次 sandbox 执行在进程组清理检查受限时失败，停止后按原 gate 重跑；没有改超时或跳过测试。同步主线后先按锁文件执行 `npm ci` 补齐缺失的 Playwright 包，未下载浏览器、未修改 lockfile。[验证记录](bounded-handoff-validation.json) 绑定基线、三个源码/测试文件 hash 和完整 gate 日志 hash。后续仅更新本段证据文档，再运行 docs:check 与 diff-check。
