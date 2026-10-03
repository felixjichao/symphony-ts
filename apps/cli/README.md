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

## Host Lifecycle & Composition (M6.3)

`createHost(options)` 建立组合根：
`argv → resolveWorkflowPath → TrackerAdapterRegistry → loadEffectiveWorkflow → registerTrackerLogSecrets → observeTracker → WorkspaceManager → OrchestratorAuthority → OrchestratorLoop → SymphonyHost`

提供可直接在 integration test 中构造的 `SymphonyHost` 实例（`start()` / `stop()` / `authority` / `loop` / `state` / `effective` / `logger`），且 core 库无 `process.exit()`。`apps/cli/package.json` 建立真实 `bin: { "symphony": "./dist/bin/symphony.js" }` 契约，经 `npm run build` 打包为 Node >= 20 可独立运行的 ESM 脚本。

真实子进程可复跑测试见 `npm test -w @symphony/cli -- src/bin.test.ts`。

## Known limitations

- 动态 workflow live reload 与单一 `EffectiveRuntime` authority、tracker secret → agent child env exclusion 留属 M6.4（NEST-84）；
- 信号竞态（signal race）、重复 signal 幂等处理与最终 exit-code matrix 留属 M6.5（NEST-85）；
- HTTP status surface 属可选扩展。

## Runtime log observers (M6.2)

`createRuntimeLogObservers(logger)` supplies authority `onEvent/onOutcome/onCleanupDiagnostic`, loop `onDiagnostic`, watcher `onWorkflowEvent`, initial/preflight catch `onConfigFailure`, GitHub profile `onMalformedRecord`, lifecycle fact logging, `observeTracker(adapter)` and `observeAttempt(options)`. Use `new TrackerAdapterRegistry([createGitHubAdapterProfile({ onMalformedRecord: observers.onMalformedRecord })])` rather than registering github twice via the built-in registry factory. Register candidate raw provider/env secrets before validation and resolved provider values before adapter construction; keep old secret values until logger close. Helpers do not resolve configuration or own effective runtime.

Attempt wrappers invoke existing reduction callbacks first and independently isolate logging. Hook bodies and free agent summaries are omitted; thread-only starts have no fabricated session. Use `observeCleanup(manager, () => currentConfig.hooks)` for authority cleanup: its optional `removeWorkspaceForIssue` port receives explicit issue ID/identifier, reads current hooks and supplies the isolated `onHookEventForIssue(context)` callback. Standalone hook callers can also use that callback; never infer issue identity from workspace paths. Tracker wrappers preserve returned issues and original thrown errors, logging stable `operation=fetch_issues_by_states` or `fetch_issues_by_ids` with the error category. Watcher success means watcher acceptance, not effective host-runtime commit. Lifecycle callers report completed only after actual start/stop completion.

`npm test -w @symphony/cli -- src/logging.test.ts` verifies real config, registry, workspace, authority/loop and fake app-server subprocess wiring.
