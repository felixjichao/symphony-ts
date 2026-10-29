# 外部交付离线结算

适用场景：GitHub issue 已关闭且指定 PR 已合并，但本地 Delivery、Decision 或 recovery/retry 仍保留旧任务。此入口记录 operator 确认的 `external_completion`，不会补造独立 Review、自动交付或历史 self-hosting 回执。

## 操作步骤

先停止使用该 workspace root 的 host、Decision Bridge、Web Driver 和 coding/review executor，确认旧进程及其子进程均已退出。升级后的 host 持有 root 维护锁；旧版本没有此协议，因此 `executorsStopped: true` 是 operator 的明确核验声明。所有路径使用现有目录的 canonical 绝对路径；Decision store 必须包含该 issue 的原生 session。

将以下内容保存为受保护的 `draft.json`，替换路径、目标 SHA 与操作人。`allowUnmarkedPr` 仅对人工创建、没有 Symphony marker 的 PR 显式授权；外来或损坏 marker 始终拒绝。

```json
{
  "schemaVersion": 1,
  "workspace": "/absolute/workspaces/issue-workspace",
  "decisionStore": "/absolute/decision-store",
  "context": {
    "repo": "owner/repo",
    "issueNumber": 123,
    "workspaceKey": "issue-workspace",
    "headBranch": "symphony/issue-workspace",
    "baseBranch": "main"
  },
  "target": {
    "prNumber": 124,
    "headSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "mergeCommitSha": "cccccccccccccccccccccccccccccccccccccccc"
  },
  "authorization": {
    "operator": "operator-name",
    "reason": "Confirmed manual delivery; retain missing native Review evidence",
    "executorsStopped": true,
    "allowUnmarkedPr": true
  }
}
```

```sh
umask 077
symphony delivery-skill prepare-external --request draft.json > authorized.json
symphony delivery-skill settle-external --request authorized.json
symphony delivery-skill settle-external --request authorized.json --apply
```

`prepare-external` 只读本地 snapshot 和 GitHub，生成 operation ID、原生 Delivery/Decision/recovery/retry 指纹及 Decision sequence。检查输出后保留该文件；不带 `--apply` 的 `settle-external` 仅做 schema 校验及打印预览，不重新读取现场。`--apply` 在三类原生互斥锁内重验 snapshot 和 GitHub closed/merged、repo、PR、HEAD、merge SHA、branch 与 ownership。只支持 public `github.com`；远端仅两个 GET，不发布评论、不执行编码/Review/merge。

## 故障恢复与保留语义

跨文件结算先写 workspace 外的 `.symphony-host/external-settlements/` journal，再原子完成 Decision session、取消待执行/claimed/running task、写 Delivery 外部回执，最后按原记录精确退役该 WorkKey 的 recovery/retry。其他 work 和已有 result/submission receipt 不变。Delivery 原始 flags、details、预算、deadline 以及 recovery ledger incidents 全部保留；旧 Review HEAD 不会成为最终 HEAD 的 approval。

中断后仅重试**同一份** `authorized.json --apply`。保留字段顺序和内容；空白格式变化不影响解析。新的 operation ID、预算/租约/预约变化或新 owner 均拒绝。不要手工删锁或 journal。`prepared` journal 阻止普通 dispatch、交付重放与 workspace cleanup，必须先完成原操作；`complete` journal 允许原生 cleanup，且删除 workspace 后仍保留 dispatch fence 和原始证据。同一 WorkKey 的重新开工需要另行设计的明确授权协议，普通 reopen/resume 不可绕过。活跃 host 检查所有已提交 root。root 迁移是 operator 维护操作：迁移前必须盘点原 root 的 journal；存在 `prepared` 或状态不明记录时，禁止迁移及在新 root 启动 host。必须先用原授权文件和原路径恢复到 `complete`，不得复制、改写、删除 journal 或重新生成授权。完成后迁移 root 必须保留原 Decision store/Bridge 配置，终态回执独立于 planning 开关阻止 admission。prepared 尚未提交 Decision 时的 fence 只对所属 root 及保留它的活跃 host 生效；不支持该阶段的透明跨 root 重启。完全独立的新部署不能自动发现其他目录或其他 Decision 后端。

Decision snapshot 新增 `external-work-completion` receipt kind；旧版 reader 会拒绝此记录。应用后不要降级旧 host/Bridge 读取该 store。Bridge 新增认证只读 `GET /v1/sessions/:id/external-completion` 控制 admission 查询；旧 Bridge 不支持该查询时，新 host 拒绝派发。因此受控升级先更新 Bridge，再启动 host。当前入口不提供 Dashboard 投影或 HTTP mutation。

设计见 [Agent Note](../notes/accepted/architecture/2026-10-29-offline-external-delivery-settlement.md)；验证入口见 [testing](testing.md#外部交付离线结算)。
