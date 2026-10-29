# Agent Note: Offline external delivery settlement
Status: accepted

## Problem

#168 审计发现远端人工交付完成后，旧 Delivery handoff、Decision lease 与 recovery/retry 仍可存活。普通 resume 会重放交付，直接删除状态则丢失诊断和缺失 Review 的事实。涉及 SPEC §4、§11.5 邻接扩展及 §8/§14、§17/§18，Core 不变。

## Decision

domain 唯一拥有严格 request/receipt 与 snapshot 指纹；tracker 只验证 public GitHub 的 closed/merged 精确目标；agent 只追加外部回执；Decision 在原生单 writer 事务中取消未完成 task、完成 session 并持久化独立的 external-work-completion receipt。CLI 装配离线协议：root maintenance → Delivery lifecycle/authority → Decision writer，先写外部 journal，再依次结清各原生存储。host 持有所有已使用 root 的锁直到完整退出，热重载提交前先锁新 root。只接受 operator 对已停止所有 executor 的明确声明。

prepared/complete journal 位于 workspace 外，固定完整授权与原状态，作为 dispatch/cleanup fence；同一请求可在崩溃后重入。精确原记录退役 recovery/retry，保留预算、deadline、flags、原始 details 和 ledger。已完成 Decision result/receipt 不改，不生成最终 HEAD Review。completed session 不能普通 reopen，普通 delivery/recover-handoff 不能穿透 fence。host admission 检查所有已提交 root，以及独立于 planning 的原生 Decision 完成回执；本地使用 Decision owner 的只读 committed-snapshot reader，Bridge 使用认证只读查询且不缓存，故障拒绝。显式 store 优先于环境 Bridge，沿用后端配置优先级。

CLI 外部结算入口使用静态装配：coordinator 复用原生 CLI storage，动态分块会反向导入含顶层 await 的 executable entry，造成未解决 await 循环。真实打包 executable 的 preview 回归验证退出码和原生状态不变。

## Alternatives considered

- 在线结算：旧 executor 与 Bridge 的跨进程效果不由一把锁覆盖；先采用可核验的离线维护，避免隐含撤销活跃执行权。
- 直接标记自动 completed 或伪造 approval：混淆人工外部完成与原生验收证据，拒绝。
- 删除旧 snapshot / 清空预算：破坏审计与恢复所有权，拒绝。
- 多存储单次原子提交：现有原生存储各自事务边界独立；使用先行 durable journal 和精确幂等恢复，不引入第二份领域权威。

## Consequences

请求批准后现场变化会拒绝，operator 必须停稳所有写入者；旧 host 不参与维护锁，声明仍需真实进程核验。journal 保留原始诊断，文件按私有权限写入；应用后旧 Decision reader 会拒绝新 receipt kind，不能随意降级。迁移 root 前必须将原 root 全部 prepared/未知结算恢复到 complete，再保留原 Decision 后端重启；不支持 prepared 阶段透明跨 root 重启，独立部署不能推断其他部署路径。先升级 Bridge 再启动 host，旧 Bridge 缺少 terminal 查询会使 admission 拒绝。外部结算不会弥补历史 self-hosting 或 Review 证据，也不包含 production deployment、Dashboard mutation 或同一 WorkKey 新轮次协议。
