# Agent Note: WORKFLOW.md 热重载契约（检测机制、last-known-good、事件面）（M1.4）

Status: accepted

## Problem

M1.4 要在 `packages/config` 实现 SPEC §6.2 Dynamic Reload Semantics：MUST 检测
`WORKFLOW.md` 变化并无需重启地重新 read / parse / resolve；invalid reload MUST NOT
crash——保留 last-known-good effective config 并发出 **operator-visible error**；
SHOULD 在运行期防御性再校验（如 dispatch 前）。SPEC 未规定检测机制、错误事件如何
落地到 config 层、初始加载失败的行为，也没说明 reload 是否要顺带校验 prompt 模板。
这些会被 M5（orchestrator 的 live 行为切换）与 M6（observability 接线）直接依赖，
须一次定死。

## Decision

1. **公共 API**：
   ```ts
   type WorkflowReloadEvent =
     | { kind: "reloaded"; effective: EffectiveWorkflow }
     | { kind: "error"; error: SymphonyConfigError };
   interface WatchWorkflowOptions extends LoadEffectiveWorkflowOptions {
     intervalMs?: number;                       // 默认 1000
     onEvent?: (event: WorkflowReloadEvent) => void;
   }
   interface WorkflowWatchHandle {
     current(): EffectiveWorkflow;
     reload(): void;
     close(): void;
   }
   function watchWorkflow(options?: WatchWorkflowOptions): WorkflowWatchHandle;
   ```
2. **检测机制：轮询 + stamp 对比**（`mtimeMs` + `size`），默认 1000ms，`intervalMs`
   可注入。与上游参考实现 `workflow_store.ex`（1s 轮询 + mtime/size stamp）一致。
   初始 stamp **先于**首次 load 读取：文件恰在两者之间被改写时只会多触发一次无害的
   reload，而不会让新内容被漏检、把陈旧 effective config 保留到下次变化。
3. **初始加载 fail-fast**：`watchWorkflow` 同步执行首次 `loadEffectiveWorkflow`，
   失败直接 throw `SymphonyConfigError`，不返回半初始化 handle（支撑 §6.3 startup
   validation；呈现方式归调用方）。初始成功**不**发 `reloaded` 事件。
4. **last-known-good 不变量**：首次成功后 `current()` 恒为有效
   `EffectiveWorkflow`，只在 valid reload 时被替换；任何 invalid reload 都不改变它。
5. **invalid reload 不发崩溃、发 operator-visible error**：重新 load + resolve 抛
   出的 `SymphonyConfigError` 经 `onEvent({ kind: "error" })` 上报；
   `current()` 保持旧值。**stamp 在尝试前即推进**，故持续写坏的文件只上报一次，不
   每 tick 重复刷事件；文件写好（stamp 变化）后自愈。
6. **监听器（`onEvent`）异常被隔离**：`reloaded` / `error` 事件的上报都在加载失败
   域**之外**，且 `emit` 内部 catch 掉监听器抛出的一切异常。两条硬理由：
   （a）watcher 是 §6.2 crash-resistance 的载体，监听器异常若从 `setInterval` 回调
   逃逸会成为 uncaught exception 直接崩掉 daemon；（b）`error` 事件的唯一语义是
   "一次 invalid reload"，若把监听器自身缺陷（哪怕是 `SymphonyConfigError`）捕获后
   转报为 `error`，会产生误导 operator 的假事件。代价：监听器缺陷被静默吞掉，
   故监听器必须自己保证不抛（JSDoc / README 已写明契约），其错误上报由监听器侧负责。
7. **文件删除 = 一次 invalid reload**：`statSync` 失败 → stamp 变为 `<missing>` →
   触发一次 reload 尝试 → `missing_workflow_file` 事件，服务不 crash；文件恢复后
   stamp 变化 → `reloaded`。
8. **`reload()` 是防御性同步再校验**（§6.2 SHOULD / §6.3 dispatch 前）：立即
   read / parse / resolve、**不看 stamp**；成功更新 last-known-good + `reloaded`，
   失败保持旧值 + `error`。`close()` 后为 no-op。
9. **`close()` 幂等**：`clearInterval` 后不再产生事件；`current()` 仍可读。定时器
   保持默认 ref（daemon 场景 watcher 应维持事件循环存活）；测试须 `afterEach`
   `close()`，不遗留 handle。
10. **reload 不做模板 parse 校验**：§5.5 明确 workflow 文件 read / YAML 错误才阻塞
    dispatch，模板错误只 fail 当次 attempt；上游也只在 build prompt 时 parse。因此
    template failure 在结构上不可能污染 last-known-good config（**已由
    `workflow-reload.test.ts` 的 "prompt template failures stay out of reload" 用例
    显式锁定**：坏模板正文仍产生 valid `reloaded`，`renderPrompt` 单独抛
    `template_parse_error`，`current()` 不被污染）。
    `current().definition.promptTemplate` 始终反映最后一次成功读取的正文。
11. **watcher 绑定创建时的 workflow 路径**：路径变化 = 新建实例（上游支持运行期换
    路径，M1.4 非目标，记入 Known limitations）。
12. **本层不 import tracker / workspace / agent / orchestrator**：`onEvent` 即
    operator-visible error contract 的 config 层载体，接线到日志 / dashboard 归
    observability（M6）。

## Alternatives considered

- **`fs.watch`（inotify / FSEvents）**：否——跨平台事件语义不一致（Linux rename /
  编辑器原子写 / 重复事件），测试难确定性复跑，且 SPEC 只要求 "detect changes"，不
  规定机制；轮询在三个平台上行为一致、可用真实临时文件确定性验证（docs/testing.md
  哲学 2）。留作后续延迟优化，不进 M1.4 契约。
- **只对比 mtime（不带 size）**：否——文件系统 mtime 精度有限、同一毫秒内重写可能
  漏检；`mtimeMs + size` 两者同取，内容变化通常也改变 size，双重保险。
- **invalid reload 时每 tick 重试并重复上报**：否——会造成日志 / dashboard 事件风暴；
  用 stamp 先行推进实现"每份坏内容只报一次"，operator 仍能在文件再次变化或调用
  `reload()` 时获得新信息。
- **初始加载失败也降级为 error 事件、返回惰性 handle**：否——§6.3 要求 startup
  validation 失败即 fail startup；返回一个 `current()` 无值的 handle 会让下游处处
  处理"未初始化"，违背 last-known-good 的最简不变量。fail-fast + throw 更清晰。
- **reload 时顺带 parse / 缓存 prompt 模板**：否——§5.5 的 gating 语义是"文件
  read/YAML 错误阻塞 dispatch，模板错误只 fail 当次 attempt"；在 reload 期做模板
  parse 会把模板错误提升为 config 错误，改变 SPEC 语义并可能阻断 dispatch。
- **支持运行期切换 workflow 路径**：否——超出 M1.4 范围；上游有该能力但无 SPEC 强制，
  记入 Known limitations，需要时另开里程碑。
- **监听器异常异步 rethrow（如 `queueMicrotask(() => { throw error })`）**：否——只是
  把崩溃从定时器栈挪到微任务栈，进程仍会退出，§6.2 的 "MUST NOT crash the service"
  不成立；真正需要的是隔离，且不能让监听器异常反向影响 watcher 自身状态。
- **把监听器异常转报为 `error` 事件**：否——`error` 的语义被固定为"一次 invalid
  reload"，用它承载监听器缺陷会让 operator 误以为 `WORKFLOW.md` 出了问题（且第二次
  回调调用同样可能抛）。隔离 + 监听器自担错误上报是唯一不污染语义的方案。
- **初始 stamp 在首次 load 之后读取**：否——见 Decision 2；两者对调后竞态方向从
  "新内容被漏检、陈旧 config 长期驻留"变成"多一次无害的 reload"，成本相同、后果更轻。

## Consequences

- M5（orchestrator）：用 `watchWorkflow` 拿 last-known-good，在 dispatch 前调用
  `reload()` 做防御性再校验；把 `onEvent` 的 `error` 接到 §6.3 的 operator-visible
  上报路径。live 行为切换（轮询节奏、并发、state 集、codex 设置、prompt 内容）由
  orchestrator 从 `current().serviceConfig` / `definition.promptTemplate` 读取。
- M6（observability）：把 `WorkflowReloadEvent` 映射为结构化日志 / status surface；
  config 层不自行 import observability。
- 持续写坏的文件不会反复刷事件，operator 需理解"事件 = 内容相对上次尝试有变化"。
- watcher 只在文件内容 / 存在性变化时动作；纯环境变量变化（如 `workspace.root` 引用
  的 env）不会触发 reload，需文件变化或显式 `reload()`。
- `close()` 后实例不可再启动；需要重启 watcher 请新建实例。
- **监听器异常被静默隔离**（Decision 6）：`onEvent` 抛出的异常不会出现在任何面上。
  M5 / M6 接线时必须让监听器自身不抛（try/catch + 自带日志），否则其缺陷不可见。
- 模板正文损坏（坏模板但合法 front matter）**不是** invalid reload：它以 `reloaded`
  事件更新 `promptTemplate`，错误只在 `renderPrompt` 调用处暴露（§5.5 gating）。
