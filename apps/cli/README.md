# @symphony/cli

## Purpose

Symphony 宿主的 **CLI / 进程生命周期**入口：解析命令行、加载配置、把各组件（config / tracker / workspace / agent / orchestrator / observability）装配为长运行服务并管理 start / stop。验收对齐 SPEC §17 的 CLI lifecycle 项与 §18 Implementation Checklist。

## Configuration

启动参数（如 `WORKFLOW.md` 路径覆盖）在装配时交给 `@symphony/config` 解析；本 app 不定义自己的配置语义。

## Extension points

- 新子命令：在本 app 内注册，业务逻辑一律下沉到对应 owner 包；
- app 只做装配与进程管理，不承载领域规则——判断"这段逻辑该不该在 cli"时以各包 README 的 Purpose 为准。

## Known limitations

- M6.2 已实现 `createRuntimeLogObservers` 与 `registerTrackerLogSecrets`；尚无可运行 CLI host / argv / signal 入口；
- 装配与生命周期管理在 orchestrator 落地后接线（SPEC §17 / §18）。

## Runtime log observers (M6.2)

`createRuntimeLogObservers(logger)` supplies authority `onEvent/onOutcome/onCleanupDiagnostic`, loop `onDiagnostic`, watcher `onWorkflowEvent`, initial/preflight catch `onConfigFailure`, GitHub profile `onMalformedRecord`, lifecycle fact logging, `observeTracker(adapter)` and `observeAttempt(options)`. Use `new TrackerAdapterRegistry([createGitHubAdapterProfile({ onMalformedRecord: observers.onMalformedRecord })])` rather than registering github twice via the built-in registry factory. Register candidate raw provider/env secrets before validation and resolved provider values before adapter construction; keep old secret values until logger close. Helpers do not resolve configuration or own effective runtime.

Attempt wrappers invoke existing reduction callbacks first and independently isolate logging. Hook bodies and free agent summaries are omitted; thread-only starts have no fabricated session. Use `observeCleanup(manager, () => currentConfig.hooks)` for authority cleanup: its optional `removeWorkspaceForIssue` port receives explicit issue ID/identifier, reads current hooks and supplies the isolated `onHookEventForIssue(context)` callback. Standalone hook callers can also use that callback; never infer issue identity from workspace paths. Tracker wrappers preserve returned issues and original thrown errors, logging stable `operation=fetch_issues_by_states` or `fetch_issues_by_ids` with the error category. Watcher success means watcher acceptance, not effective host-runtime commit. Lifecycle callers report completed only after actual start/stop completion.

`npm test -w @symphony/cli -- src/logging.test.ts` verifies real config, registry, workspace, authority/loop and fake app-server subprocess wiring. This harness does not claim production CLI lifecycle completion.
