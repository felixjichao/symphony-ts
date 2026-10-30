# #168 production browser matrix — 2026-10-30

SPEC §13 邻接、§17/§18。本轮补齐 [对账方案 §3](../dashboard-v2-verification/reconciliation-plan.md#3-补验收与接受历史例外) 的产品浏览器覆盖缺口。

[原始报告](report.json) 绑定干净源码提交 `7f62ee3977c46a64fdc91d33919501b3e67ed746`，tree `b91186ba71580bdb43fc63f447dcbcd5bcc80afb`、harness/fixture 与 built assets SHA-256。报告写入 checkout 外部后原样归档；后续证据文档提交与该源码提交分别标识。

- 22 个场景全部 passed，49 次 API GET，零 pageErrors；包含真实 production composition 与不同 cwd 的 built executable 空 scope。
- fresh failed ReviewTask、无 result，由既有 operations projector 产生 alpha failed；同号 beta 仍 coding/normal。Overview、Work、Detail 都有明确断言。
- Overview/System/Executors 逐项验证 source/instance、freshness class/status、观测/尝试时间、reason 和 WorkKey；executor 验证 role/adapter/status/host/heartbeat/currentWork，空值、关联卡片隔离和跨仓库同号链接实际点击。
- inventory 的 fresh/stale/unknown/unavailable 区分保留；source unavailable 与 HTTP transport success 分别断言。原有三组 HEAD、路由/刷新、键盘焦点、390px 布局和断线恢复检查继续运行。

25 组页面/视口目标生成 45 张截图。为避免本机 Chromium 长图分块重复，使用原始 1280×900 / 390×844 视口，长页另采底部；每张记录 viewport、scrollY、documentHeight 和 SHA-256。它们是代表性顶部/底部采样，不是完整长页，也不声称逐像素检查全部内容。已抽查 failed 窄屏顶部/底部、active 桌面 Executors/System 及 stale 窄屏 inventory/source，未见重复页首或横向裁切。完整字段由 DOM 断言验证。

| 代表状态 | 桌面 | 390px |
| --- | --- | --- |
| failed Overview | [顶部](failed-overview-desktop.png) | [顶部](failed-overview-narrow.png)、[底部](failed-overview-narrow-bottom.png) |
| failed Detail | [顶部](failed-detail-desktop.png) | [顶部](failed-detail-narrow.png) |
| active Executors | [顶部](active-inventory-executors-desktop.png) | [底部](active-inventory-executors-narrow-bottom.png) |
| stale Executors | [底部](stale-inventory-executors-desktop-bottom.png) | [底部](stale-inventory-executors-narrow-bottom.png) |
| stale System | [顶部](stale-inventory-system-desktop.png) | [底部](stale-inventory-system-narrow-bottom.png) |
| empty / unknown / unavailable | [empty](empty-inventory-executors-desktop.png)、[unknown](unknown-inventory-executors-desktop.png)、[unavailable](unavailable-inventory-executors-desktop.png) | — |

完整 gate：2,651 passed / 1 既有 opt-in skipped，typecheck/lint/docs 通过；验证指纹见 [validation](validation.json)，报告与截图完整性见 [manifest](manifest.json)。

范围：固定时钟与受控外部 source facts，真实 operations → HTTP → built Dashboard；`externalLive=not run`。未读取/修改生产 host、Bridge、Driver 或原生状态，未将本轮复验回填为历史成功。#173/#175/#176 缺失的合入前最终 HEAD 原生 Review 仍未被补齐或接受；#168 保持 open。
