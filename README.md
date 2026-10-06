# symphony-ts — OpenAI Symphony 的 TypeScript 实现

按 [OpenAI Symphony](https://github.com/openai/symphony) 官方 `SPEC.md` 实现的 TypeScript 版本：**一个长运行的 orchestrator**，从 issue tracker 读取工作（issue），为每个 issue 建立隔离的 workspace，运行 coding agent（如 Codex）完成工作，并负责 retry / reconciliation / observability。

## 能做什么

- 以 `WORKFLOW.md` 声明式配置运行一个长驻 host：轮询 issue tracker、按并发上限派发、为每个 issue provisioning 隔离 workspace、启动 coding agent、重试与对账、输出结构化日志与只读状态出口。
- 内置 `github` issue tracker profile。
- 提供 **GitHub 自动交付闭环**（GitHub Delivery MVP）：把 `open` + `symphony-ready` 的 issue 一路推进到合入并关闭。

```text
open issue + symphony-ready
  → Symphony 派发 + workspace bootstrap（clone + 确定性 issue 分支）
  → Codex 实现 + 验证
  → commit + push → 创建 / 复用 PR
  → CI 检查 + 有界修复
  → squash merge（opt-in）→ Fixes #N 关闭 issue
  → Symphony 对账 + workspace 清理
```

整体实现状态与里程碑见 [docs/status.md](docs/status.md)；SPEC 逐项验收矩阵见 [docs/conformance.md](docs/conformance.md)。

## Prerequisites

- **Node.js >= 20** 与 npm。npm 是唯一 canonical 包管理器（仓库只有 `package-lock.json`）。
- **Codex**：已安装并完成登录，`codex app-server` 能启动——host 通过它驱动 coding agent。
- **GitHub 交付场景**另外需要：`git`、[`gh`](https://cli.github.com)，以及与目标仓库匹配的凭据（见 [GitHub closed-loop quick start](#github-closed-loop-quick-start)）。
- 当前进程与 hook 使用 POSIX `sh` / `bash`：优先 Linux / macOS，或具备相应 shell 的 WSL。原生 Windows 未验证。

## 安装与构建

从源码 checkout 安装（当前没有发布到 npm 的全局包）：

```bash
npm ci            # 严格按 package-lock.json 安装
npm run build     # 构建各 workspace，产出 apps/cli/dist/bin/symphony.js
```

把 CLI 放入 `PATH`，或直接执行 package binary：

```bash
export PATH="$PWD/apps/cli/dist/bin:$PATH"   # 之后可直接用 symphony
node apps/cli/dist/bin/symphony.js --help    # 或不改 PATH，直接执行
```

## First run

在任意目录准备一个最小 `WORKFLOW.md`（YAML front matter + prompt 正文）：

```markdown
---
tracker:
  kind: github
  provider:
    repo: <owner/repo>      # 必填：从这里读取 issue
    token: $GITHUB_TOKEN    # 必填：export 一个具 repo scope 的 token
  active_states: [open]
  terminal_states: [closed]
workspace:
  root: ./workspaces        # 相对 WORKFLOW.md 所在目录解析
codex:
  command: codex app-server
---

You are working on {{ issue.identifier }}: {{ issue.title }}

{{ issue.description }}
```

其余字段（`polling`、`agent`、`hooks`、`codex.*` 等）都有默认值；字段语义与默认值表见 [packages/config/README.md](packages/config/README.md)。

启动 host：

```bash
export GITHUB_TOKEN=...
node apps/cli/dist/bin/symphony.js ./WORKFLOW.md
# 无 positional 参数时，默认读取 cwd 下的 ./WORKFLOW.md
```

- **确认已运行**：结构化日志会输出 `startup` / completed（reason `startup_completed`）。没有符合条件的 issue 时 host 保持轮询等待，这是正常的。
- **停止**：`Ctrl-C`（SIGINT）或 SIGTERM；host 等待 worker 与清理收口后以 `0` 退出。startup / fatal / shutdown 失败以 `1` 退出。
- 当前没有 HTTP 健康检查入口（属 optional extension）。

> 上面的最小 workflow 只启动 host，不做仓库 clone。要真正跑「issue → PR」闭环，用下面的参考 profile。

## GitHub closed-loop quick start

完整 start / run / stop 生命周期与安全边界见 [docs/github-delivery-workflow.md](docs/github-delivery-workflow.md)；可复制的 workflow 在 [examples/github-delivery/WORKFLOW.md](examples/github-delivery/WORKFLOW.md)，复制步骤与需替换的值见 [examples/github-delivery/README.md](examples/github-delivery/README.md)。

前提：

1. Node >= 20，已 build，并把 CLI 的**绝对** `apps/cli/dist/bin` 放入 `PATH`——`after_create` hook 里的 `symphony repo-bootstrap` 依赖它在 shell 中可用。
2. 目标仓库有 `symphony-ready` label；只有 `open` 且带该 label 的 issue 会被派发。
3. 目标仓库的 CI 会在 PR 上产生 checks（这是「合并前全绿」的事实来源）。
4. `GITHUB_TOKEN`（repo scope）供 tracker 使用；`git` 与 `gh` 独立具备可用认证（例如 `gh auth setup-git`）；Codex 已登录。派发给 agent 的子进程不会继承 tracker token。
5. 目标仓库提供自己的验证命令与 CI 修复入口。参考 profile 默认 `--validate "npm run gate"`、`--repair-cmd "npm run ci:fix"`；本产品仓库没有 `ci:fix`，所以目标仓库必须提供该命令，或用 `SYMPHONY_DELIVERY_VALIDATE` / `SYMPHONY_DELIVERY_REPAIR_CMD` 覆盖。

步骤：

1. 把 `examples/github-delivery/WORKFLOW.md` 复制到目标仓库根目录，替换其中的 `<owner/repo>` 占位符。
2. 把本仓库的 `skills/github-delivery/` 复制进目标仓库并提交——`after_create` 会把它安装进 workspace，供 Codex 发现。
3. 提交这两个文件，然后启动 host：

   ```bash
   GITHUB_TOKEN=... symphony /path/to/WORKFLOW.md
   ```

之后，一个 `open` 且带 `symphony-ready` 的 issue 会在下一次轮询被派发。

## 安全与运维行为

- **自动合入只针对显式的 Symphony-owned PR**：派发需要 `symphony-ready` label；delivery 需要显式 `--opt-in`；PR 必须属于当前 issue / workspace（foreign、歧义、closed-unmerged 一律拒绝）。
- **检查失败关闭（fail closed）**：只有 PR open、mergeable 且所有 required 与 observed checks 全部成功才合入；pending / failed / unknown / 零 checks 一律不合入。
- **交接与恢复**：需求歧义、破坏性变更、无法安全合入或预算耗尽时，delivery skill 保持 issue open、移除 `symphony-ready` 停止继续派发，并输出交接报告。修好根因后重新加 label 即恢复；`--resume` 保留已消耗的修复次数与绝对 CI 等待 deadline，不会重置预算。
- **凭据边界**：MVP 下 delivery 使用 host 提供的 `git` / `gh` 凭据；tracker 读取 host 的 `GITHUB_TOKEN`，但派发给 agent 的子进程会通过 `excludeEnvNames` 排除它。这是显式、临时的 MVP trust boundary，不是最终安全模型；provider-native tools / credential boundary 仍属 deferred。细节见 [credential / trust boundary](docs/github-delivery-workflow.md#credential--trust-boundary-mvp)。

## 配置、CLI 与文档

- 配置：front matter 字段、默认值与校验由 [`@symphony/config`](packages/config/README.md) owner；GitHub tracker 键见 [`@symphony/tracker`](packages/tracker/README.md)。
- CLI：所有子命令（`repo-bootstrap`、`delivery-skill`、`pr`、`dogfood` 等）见 [`apps/cli/README.md`](apps/cli/README.md)。

| 文档 | 内容 |
|---|---|
| [docs/status.md](docs/status.md) | 当前实现状态、里程碑、deferred 与 next work（进度唯一权威） |
| [docs/conformance.md](docs/conformance.md) | 实现 ↔ SPEC §17 / §18 验收项矩阵（SPEC capability 唯一权威） |
| [docs/architecture.md](docs/architecture.md) | 稳定架构、组件职责与依赖方向（SPEC §3 映射） |
| [docs/development.md](docs/development.md) | 环境搭建、日常命令、TS 布局与依赖约定 |
| [docs/testing.md](docs/testing.md) | 测试分层（对齐 SPEC §17 profiles）与三条测试哲学 |
| [docs/github-delivery-workflow.md](docs/github-delivery-workflow.md) | GitHub 自动交付闭环（start / run / stop、安全边界） |
| [docs/github-delivery-dogfood.md](docs/github-delivery-dogfood.md) | opt-in 真实 GitHub + 真实 Codex 端到端验证 |
| [docs/upstream.md](docs/upstream.md) | 两条上游 baseline（Symphony SPEC、Codex app-server 协议） |
| [AGENTS.md](AGENTS.md) | Agent / 贡献者 standing orders |
| [notes/](notes/README.md) | 架构 / 选型决策记录（Agent Notes） |
