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

## Extension points

- 新子命令：在本 app 内注册，业务逻辑一律下沉到对应 owner 包；
- app 只做装配与进程管理，不承载领域规则——判断"这段逻辑该不该在 cli"时以各包 README 的 Purpose 为准。

## Host Lifecycle & Composition (M6.3 / M6.4)

`createHost(options)` 建立组合根：
`argv → resolveWorkflowPath → TrackerAdapterRegistry → watchWorkflow(store) → EffectiveRuntimeController → registerTrackerLogSecrets → observeTracker → WorkspaceLifecycleCoordinator → OrchestratorAuthority → OrchestratorLoop → SymphonyHost`

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

- 信号竞态（signal race）、重复 signal 幂等处理与最终 exit-code matrix 留属 M6.5（NEST-85）；
- HTTP status surface 属可选扩展。

## Runtime log observers (M6.2)

`createRuntimeLogObservers(logger)` supplies authority `onEvent/onOutcome/onCleanupDiagnostic`, loop `onDiagnostic`, watcher `onWorkflowEvent`, initial/preflight catch `onConfigFailure`, GitHub profile `onMalformedRecord`, lifecycle fact logging, `observeTracker(adapter)` and `observeAttempt(options)`. Use `new TrackerAdapterRegistry([createGitHubAdapterProfile({ onMalformedRecord: observers.onMalformedRecord })])` rather than registering github twice via the built-in registry factory. Register candidate raw provider/env secrets before validation and resolved provider values before adapter construction; keep old secret values until logger close. Helpers do not resolve configuration or own effective runtime.

Attempt wrappers invoke existing reduction callbacks first and independently isolate logging. Hook bodies and free agent summaries are omitted; thread-only starts have no fabricated session. Use `observeCleanup(manager, () => currentConfig.hooks)` for authority cleanup: its optional `removeWorkspaceForIssue` port receives explicit issue ID/identifier, reads current hooks and supplies the isolated `onHookEventForIssue(context)` callback. Standalone hook callers can also use that callback; never infer issue identity from workspace paths. Tracker wrappers preserve returned issues and original thrown errors, logging stable `operation=fetch_issues_by_states` or `fetch_issues_by_ids` with the error category. Watcher success means watcher acceptance, not effective host-runtime commit. Lifecycle callers report completed only after actual start/stop completion.

`npm test -w @symphony/cli -- src/logging.test.ts` verifies real config, registry, workspace, authority/loop and fake app-server subprocess wiring.
