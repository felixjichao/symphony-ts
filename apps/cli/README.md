# @symphony/cli

## Purpose

Symphony 宿主的 **CLI / 进程生命周期**入口：解析命令行、加载配置、把各组件（config / tracker / workspace / agent / orchestrator / observability）装配为长运行服务并管理 start / stop。验收对齐 SPEC §17 的 CLI lifecycle 项与 §18 Implementation Checklist。

## Configuration

启动参数（如 `WORKFLOW.md` 路径覆盖）在装配时交给 `@symphony/config` 解析；本 app 不定义自己的配置语义。

CLI 命令行契约：
```text
symphony [path-to-WORKFLOW.md]
```
- 支持显式 positional `path-to-WORKFLOW.md`；
- 无 positional 参数时默认解析 `./WORKFLOW.md`；
- 文件缺失或不可读触发类型化 `missing_workflow_file` 洁净失败（exit code 1）；
- 支持 `--help` / `-h` 与 `--version` / `-v`。

仓储工作区引导子命令契约（NEST-90 / #79）：
```text
symphony repo-bootstrap --repo <url> [--target <path>] [--branch <name>] [--workspace-key <key>] [--timeout-ms <ms>] [--user-name <name>] [--user-email <email>]
```
- 别名支持：`bootstrap-repo`、`workspace bootstrap`；
- 直接运行 `runRepositoryBootstrapCli` 完成目标工作区 Git clone 与确定性 Issue 分支同步（默认分支 `symphony/<workspaceKey>`），不启动 Orchestrator 守护进程；
- 目标目录缺省为当前工作目录（CWD），`workspace-key` 缺省从环境变量 `SYMPHONY_WORKSPACE_KEY` 或目标目录基名推导；
- 适合在 `WORKFLOW.md` 的 `after_create` 或 `before_run` hook 脚本中直接调用：
  ```yaml
  hooks:
    after_create: |
      symphony repo-bootstrap --repo https://github.com/org/repo.git
  ```

GitHub 交付原语子命令契约（NEST-92 / #81）：
```text
symphony pr <action> --repo <owner/repo> --issue <number> --workspace-key <key> [options]
```
- 别名支持：`symphony delivery <action>`；
- Actions：
  - `ensure`：创建或复用 PR（精确保留机器可读所有权 marker 与 `Fixes` 关联，拒绝外国 PR、歧义候选与 closed-unmerged）；
  - `read`：读取 PR 详情、合入状态与 mergeability；
  - `checks`：拉取 head commit 绑定的 CI checks 并执行门禁策略判定；
  - `diagnostics`：打印失败/等待中的 CI 检查脱敏诊断信息；
  - `land`：显式 opt-in（`--opt-in`）下以 squash 自动合并，使用 `--match-head-commit` 并在合并后重读事实确认最终 `MERGED` 状态；
  - `verify`：验证 PR 是否已合入并提取 merge commit SHA；
- 支持 `--json` 选项输出纯 JSON，便于自动化工具或 Codex 消费。

## Extension points

- 新子命令：在本 app 内注册，业务逻辑一律下沉到对应 owner 包；
- app 只做装配与进程管理，不承载领域规则——判断"这段逻辑该不该在 cli"时以各包 README 的 Purpose 为准。

## Host Lifecycle & Composition (M6.3–M6.5)

`createHost(options)` 建立组合根：
`parse argv → resolveWorkflowPath → initial config/tracker preflight → runtime/observability composition → install shell handlers → startMonitoring → loop.start`

`createHost()` initializes without timers. `host.start()` explicitly starts monitoring before the loop. `runCli()` owns signals/fatal fallbacks and returns the final exit code; bin sets `process.exitCode` and lets the event loop exit naturally. Host installs no process handlers and never calls `process.exit()`. Duplicate starts/stops share promises; stopped hosts cannot restart. Stop synchronously closes runtime commits and monitoring, then invokes existing loop.stop before awaiting startup/workers/cleanup. Handlers remain installed throughout cleanup and only this runner's listeners are removed.

- **EffectiveRuntime 单一权威（M6.4）**：
  `EffectiveRuntimeController` 独占维护不可变快照，原子结合 `EffectiveWorkflow`、`ServiceConfig`、所选 tracker profile/adapter、child env `excludeEnvNames`、`WorkspaceManager` 与调度配置投影。配置热更新通过 watcher `store` 与 `preflight` 同步校验，零双重真相源，校验失败 fail-fast 回滚且保留前一版本；
- **Workspace 生命周期三层隔离（M6.4）**：
  调度派发由 `WorkspaceLifecycleCoordinator` 锁定当前 attempt 的 workspace root 与 manager，运行中 worker 绝不重启或中断；终态清理精准路由至该 attempt 派发时的旧 root，根路径切换不跨根误删，旧 root 绝不被盲目扫描；
- **Secret Boundary 物理隔离（M6.4）**：
  宿主环境变量中的敏感 token 供 tracker adapter 认证使用，但在派发 agent 子进程时由 `excludeEnvNames` 物理排除，子进程环境仅保留无害基础配置。

真实子进程可复跑测试见：
- `npm test -w @symphony/cli -- src/bin.test.ts`
- `npm test -w @symphony/cli -- src/host-reload.test.ts`
- `npm test -w @symphony/cli -- src/secret-boundary.test.ts`

## Known limitations

- M0–M6 Core 已完成；当前 executable CLI host 已完成生产组件装配，M6.1–M6.5 已合入并通过 main CI，验收证据见 [conformance](../../docs/conformance.md#m65-core-证据索引)。M7 §15 hardening 未开始。
- HTTP status surface 属可选扩展。

## Runtime log observers (M6.2)

`createRuntimeLogObservers(logger)` supplies authority `onEvent/onOutcome/onCleanupDiagnostic`, loop `onDiagnostic`, watcher `onWorkflowEvent`, initial/preflight catch `onConfigFailure`, GitHub profile `onMalformedRecord`, lifecycle fact logging, `observeTracker(adapter)` and `observeAttempt(options)`. Use `new TrackerAdapterRegistry([createGitHubAdapterProfile({ onMalformedRecord: observers.onMalformedRecord })])` rather than registering github twice via the built-in registry factory. Register candidate raw provider/env secrets before validation and resolved provider values before adapter construction; keep old secret values until logger close. Helpers do not resolve configuration or own effective runtime.

Attempt wrappers invoke existing reduction callbacks first and independently isolate logging. Hook bodies and free agent summaries are omitted; thread-only starts have no fabricated session. Use `observeCleanup(manager, () => currentConfig.hooks)` for authority cleanup: its optional `removeWorkspaceForIssue` port receives explicit issue ID/identifier, reads current hooks and supplies the isolated `onHookEventForIssue(context)` callback. Standalone hook callers can also use that callback; never infer issue identity from workspace paths. Tracker wrappers preserve returned issues and original thrown errors, logging stable `operation=fetch_issues_by_states` or `fetch_issues_by_ids` with the error category. Watcher success means watcher acceptance, not effective host-runtime commit. Lifecycle callers report completed only after actual start/stop completion.

`npm test -w @symphony/cli -- src/logging.test.ts` verifies real config, registry, workspace, authority/loop and fake app-server subprocess wiring.

## Exit status and evidence

| 场景 | 结果 |
|---|---|
| help/version、graceful SIGINT/SIGTERM、信号取消正常 startup 且收口成功 | 0 |
| initial config/tracker preflight、startup、致命 host 或非预期 shutdown failure | 1；后续 graceful signal 不覆盖失败 |
| invalid live reload、普通 tracker/agent failure、best-effort hooks、log sink failure | 保持恢复语义，不自行退出 |
| SIGKILL | abnormal termination；无 graceful 清理保证 |

`src/bin.test.ts` 每轮 rebuild 真正 package bin，使用 loopback HTTPS + test CA (`NODE_EXTRA_CA_CERTS`)；请求、session、文件 marker 作 readiness barrier。两根 workspace 的 agent PID、cwd、transcript、prompt 与 after_run marker 均重读核验；stubborn agent 沿用 transport deadline。测试用 key/cert 仅服务本地 fixture，生产 HTTPS 校验不变。`test-fixtures/lifecycle-harness.ts` 仅补充退出码证据，不代替正式 bin 链路。

`npm test -w @symphony/cli -- src/bin.test.ts src/lifecycle.test.ts` 覆盖 signals、startup/reload race、timer 清零/迟到回调、failure priority 和资源释放；`npm test -w @symphony/config -- src/workflow-reload.test.ts` 验证显式 monitoring 兼容性。每个 M6 Core 项的用例名见 [conformance](../../docs/conformance.md#m65-core-证据索引)。HTTP §13.7、provider-native tools §11.5、durable recovery、SSH 和外部 Real Integration 未在此实现。
