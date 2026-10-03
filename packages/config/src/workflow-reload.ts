/**
 * `WORKFLOW.md` 动态热重载（SPEC §6.2 Dynamic Reload Semantics；`reload()`
 * 兼作 §6.3 dispatch preflight 的防御性再校验）。
 *
 * 契约（§6.2）：
 *
 * - MUST 检测 `WORKFLOW.md` 变化，并在变化时无需重启地重新 read / parse / resolve
 *   config 与 prompt 模板；
 * - MUST 让新 config 作用于**未来**的 dispatch / retry / reconciliation / hook /
 *   agent launch（本层只负责产出新的 {@link EffectiveWorkflow}，如何接入 live 行为
 *   归 orchestrator，M5）；
 * - invalid reload MUST NOT crash：保留 last-known-good effective config，并发出
 *   operator-visible error；
 * - SHOULD 在运行期防御性再校验（如 dispatch 前）——由 {@link WorkflowWatchHandle.reload}
 *   提供。
 *
 * 检测机制：**轮询 + stamp 对比**（`mtimeMs` + `size`），与上游参考实现
 * `workflow_store.ex` 一致。选轮询而非 `fs.watch` 的理由（跨平台 rename 语义、
 * 编辑器原子写、重复事件）记录于
 * `notes/accepted/architecture/2026-09-27-workflow-reload-contract.md`。
 *
 * 本层不 import tracker / workspace / agent / orchestrator（依赖方向见根
 * `AGENTS.md`）：`onEvent` 回调即 operator-visible error contract 的 config 层载体，
 * 接线到日志 / dashboard 归 observability（M6）。
 */
import { statSync } from "node:fs";

import {
  loadEffectiveWorkflow,
  type EffectiveWorkflow,
  type LoadEffectiveWorkflowOptions,
} from "./config-resolution";
import { SymphonyConfigError } from "./errors";
import { resolveWorkflowPath } from "./workflow-loader";

/** 默认轮询间隔（§6.2 MUST 检测变化；1s 对齐上游参考实现）。 */
const DEFAULT_INTERVAL_MS = 1000;

/** 文件不存在 / 不可 stat 时的 stamp（与真实 stamp 必然不同，触发一次 reload 尝试）。 */
const MISSING_STAMP = "<missing>";

/**
 * reload 结果事件（§6.2 / §5.5 的 operator-visible 语义）：
 *
 * - `reloaded`：一次 valid reload 已生效，`effective` 即新的 last-known-good；
 * - `error`：一次 invalid reload；`current()` 此时仍为旧的 last-known-good。
 */
export type WorkflowReloadEvent =
  | { readonly kind: "reloaded"; readonly effective: EffectiveWorkflow }
  | { readonly kind: "error"; readonly error: SymphonyConfigError };

/**
 * 允许外部注入的 Effective 存储 / 状态同步接口（M6.4）。
 * 组合根（CLI）可藉此将 watcher 与 EffectiveRuntimeController 连接。
 */
export interface WorkflowEffectiveStore {
  /** 获取当前提交的 EffectiveWorkflow。 */
  current(): EffectiveWorkflow;
  /**
   * 接受新 EffectiveWorkflow 并原子提交。
   * 若提交准备失败（如 adapter 构造失败），应抛出异常（如 SymphonyConfigError），
   * 阻止 watcher 发布该版本并保留旧状态。
   */
  accept(effective: EffectiveWorkflow): void;
}

/**
 * reload 操作的显式结果（SPEC §6.2 / §6.3 dispatch preflight 消费）。
 */
export type WorkflowReloadResult =
  | { readonly ok: true; readonly effective: EffectiveWorkflow }
  | { readonly ok: false; readonly error: SymphonyConfigError };

export interface ReloadWithResultOptions {
  /** 若为 true，且文件 stamp 未变且上次 reload 成功，则直接返回上次结果，不重复重读与重构。默认 false。 */
  readonly ifChanged?: boolean | undefined;
}

/** {@link watchWorkflow} 的注入点（在 {@link LoadEffectiveWorkflowOptions} 之上追加）。 */
export interface WatchWorkflowOptions extends LoadEffectiveWorkflowOptions {
  /** 轮询间隔（ms）；默认 1000。测试可注入 10–20 以确定性复跑。 */
  readonly intervalMs?: number;
  /**
   * 重载事件回调（operator-visible error contract 的载体）。初始加载**不**触发
   * 事件——初始失败由 {@link watchWorkflow} 直接 throw。
   *
   * **监听器不得抛异常**：watcher 会隔离（catch + 忽略）监听器抛出的任何异常，
   * 既不让它逃逸出轮询定时器崩溃进程，也不把监听器自身缺陷误报为一次 config
   * `error` 事件。监听器侧的错误上报由监听器自己负责（M6 接线日志 / dashboard）。
   */
  readonly onEvent?: (event: WorkflowReloadEvent) => void;
  /** 可选注入的 effective store。不传时使用内部 last-known-good 引用。 */
  readonly store?: WorkflowEffectiveStore | undefined;
}

/** {@link watchWorkflow} 返回的 handle。 */
export interface WorkflowWatchHandle {
  /** 当前 effective workflow（last-known-good）：创建成功后恒有值，只被 valid reload 替换。 */
  current(): EffectiveWorkflow;
  /**
   * 防御性同步再校验（§6.2 SHOULD / §6.3）：立即重新 read / parse / resolve，
   * 不看 stamp。成功则更新 last-known-good 并发 `reloaded`；失败保持旧值并发
   * `error`。`close()` 后为 no-op。
   */
  reload(): void;
  /**
   * 同步再校验并返回显式结果。
   */
  reloadWithResult(options?: ReloadWithResultOptions): WorkflowReloadResult;
  /** 显式停止轮询。幂等；`close()` 后不再产生事件，`current()` 仍可读。 */
  close(): void;
}

/**
 * 启动 `WORKFLOW.md` 热重载 watcher。
 *
 * **初始加载 fail-fast**（§6.3 startup validation）：同步执行首次 load + resolve，
 * 失败直接 throw {@link SymphonyConfigError}，不产生半初始化 handle。首次成功后
 * `current()` 永不为空——这是"last-known-good 不被坏配置覆盖"的最简不变量。
 *
 * watcher 实例绑定创建时的 workflow 路径；运行期换路径需新建实例（M1.4 非目标）。
 * 定时器保持默认 ref（daemon 场景应维持事件循环存活）；测试须在 `afterEach`
 * 显式 `close()`，不遗留 handle。
 *
 * 监听器（`onEvent`）异常被**隔离**：见 {@link WatchWorkflowOptions.onEvent}。
 */
export function watchWorkflow(options: WatchWorkflowOptions = {}): WorkflowWatchHandle {
  const workflowPath = resolveWorkflowPath(options);
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const onEvent = options.onEvent;

  // stamp 先于初始 load 读取：文件恰在两者之间被改写时，只会多触发一次（无害的）
  // reload，而不是让新内容被漏检、把陈旧 effective config 一直保留到下次变化。
  let stamp = readWorkflowStamp(workflowPath);
  let closed = false;

  let internalLastKnownGood: EffectiveWorkflow | undefined;
  const store: WorkflowEffectiveStore = options.store ?? {
    current: () => {
      if (internalLastKnownGood === undefined) {
        throw new Error("Store is not initialized");
      }
      return internalLastKnownGood;
    },
    accept: (effective) => {
      internalLastKnownGood = effective;
    },
  };

  const initial = loadEffectiveWorkflow(options);
  store.accept(initial);

  let lastReloadResult: WorkflowReloadResult = { ok: true, effective: initial };

  /**
   * 上报事件并隔离监听器异常：watcher 是 §6.2 crash-resistance 的载体，不能因下游
   * 接线的 bug 崩溃（从定时器逃逸为 uncaught exception），也不得把监听器缺陷误报成
   * config 错误——`error` 事件的唯一语义是"一次 invalid reload"。
   */
  const emit = (event: WorkflowReloadEvent): void => {
    if (onEvent === undefined) {
      return;
    }
    try {
      onEvent(event);
    } catch {
      // 有意忽略：见上；监听器须自行保证不抛（JSDoc / Agent Note 已记录契约）。
    }
  };

  const performReload = (force = true): WorkflowReloadResult => {
    if (closed) {
      return {
        ok: false,
        error: new SymphonyConfigError("invalid_config", "Workflow watcher is closed", { path: workflowPath }),
      };
    }

    const currentStamp = readWorkflowStamp(workflowPath);
    if (!force && currentStamp === stamp && lastReloadResult.ok) {
      return lastReloadResult;
    }

    stamp = currentStamp;
    let next: EffectiveWorkflow;
    try {
      next = loadEffectiveWorkflow(options);
    } catch (error) {
      if (!(error instanceof SymphonyConfigError)) {
        // loader / resolver 的契约保证 typed error；非契约异常是内部缺陷，不静默吞掉。
        throw error;
      }
      // §6.2：invalid reload 保留 last-known-good，只上报 operator-visible error。
      lastReloadResult = { ok: false, error };
      emit({ kind: "error", error });
      return lastReloadResult;
    }

    try {
      store.accept(next);
    } catch (error) {
      const configError = error instanceof SymphonyConfigError
        ? error
        : new SymphonyConfigError(
            "invalid_config",
            error instanceof Error ? error.message : String(error),
            { path: workflowPath, cause: error },
          );
      lastReloadResult = { ok: false, error: configError };
      emit({ kind: "error", error: configError });
      return lastReloadResult;
    }

    // 成功路径：事件在 try 之外上报——监听器异常绝不能被当成加载失败。
    lastReloadResult = { ok: true, effective: next };
    emit({ kind: "reloaded", effective: next });
    return lastReloadResult;
  };

  const timer = setInterval(() => {
    const next = readWorkflowStamp(workflowPath);
    if (next === stamp) {
      return;
    }
    // 先记录新 stamp：持续写坏的文件只上报一次，不每 tick 重复刷事件。
    performReload(false);
  }, intervalMs);

  return {
    current: () => store.current(),
    reload: () => {
      if (closed) {
        return;
      }
      performReload(true);
    },
    reloadWithResult: (opts?: ReloadWithResultOptions) => {
      return performReload(!opts?.ifChanged);
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(timer);
    },
  };
}

/**
 * 计算文件 stamp：`mtimeMs:size`。两者同取，避免仅靠 mtime 的精度 / 同毫秒重写
 * 漏检（内容变化通常也改变 size）。文件缺失或不可 stat → {@link MISSING_STAMP}。
 */
function readWorkflowStamp(filePath: string): string {
  try {
    const stats = statSync(filePath);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return MISSING_STAMP;
  }
}
