/**
 * config ↔ workspace 端到端集成验收（NEST-64 / M3.4，SPEC §9 / §17.2 / §18.1；
 * Core Conformance）。
 *
 * 本文件把 **整条链路当作验收对象**，而不是任何一个包的内部逻辑：
 *
 * ```text
 * 真实 WORKFLOW.md（临时目录）→ @symphony/config loadEffectiveWorkflow
 *   → typed ServiceConfig（workspace.root 已 absolute、hooks 已 effective）
 *   → @symphony/workspace createWorkspaceManager（只消费 typed config）
 *   → 真实临时 filesystem → 真实 `sh -lc` hook 子进程
 * ```
 *
 * 本文件放在 **workspace** 包、`@symphony/config` 只是 devDependency——运行期依赖方向
 * 不变（`workspace → domain`），与 `packages/tracker/src/config-integration.test.ts`
 * 同构。它同时是 M4 / M5 消费形态的活证明：全程只经 `index.ts` 公共 API 与
 * domain / config 的 typed 契约驱动，不需要理解 workspace 内部的 filesystem 规则
 * （验收 2 / 3）。
 *
 * 与 `docs/testing.md` 三哲学一致：真实临时目录 / 真实文件 / 真实 symlink / 真实 shell
 * 子进程；断言"重读世界"（目录与 marker 文件的真实存在性与内容、hook 执行序列），
 * 不 mock workspace manager、path-safety helper 或 hook runner，也不检查"内部被调用过"；
 * 不读真实 `os.homedir()`（`home` 注入临时目录）、不碰当前仓库工作区、不出网；
 * timeout 用百毫秒级短值，但走的是生产 timeout / 进程组终止路径。
 */
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadEffectiveWorkflow, type EffectiveWorkflow } from "@symphony/config";
import { deriveWorkspaceKey as domainDeriveWorkspaceKey } from "@symphony/domain";

import {
  createWorkspaceManager,
  WorkspaceError,
  type WorkspaceHookEvent,
  type WorkspaceHookEventSink,
  type WorkspaceManager,
} from "./index";

// symlink 能力探测：host 不支持创建 symlink 时相关用例经 describe.skipIf 显式 skip
// （vitest 报告可见 skipped，不静默 pass——与 hooks.test.ts / path-safety.test.ts 同惯例）。
const symlinkSupport = (() => {
  let probeDir: string | null = null;
  try {
    probeDir = mkdtempSync(path.join(os.tmpdir(), "sym-ws-integration-symlink-probe-"));
    symlinkSync(probeDir, path.join(probeDir, "probe"), "dir");
    return { supported: true as const, reason: "" };
  } catch (err: unknown) {
    return {
      supported: false as const,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (probeDir !== null) {
      try {
        rmSync(probeDir, { recursive: true, force: true });
      } catch {
        // 探测目录清理失败不影响结论
      }
    }
  }
})();

/** front matter 里 `$VAR` 形态 root 使用的环境变量名（值 = 本用例的临时目录）。 */
const ROOT_ENV_VAR = "SYM_WS_INTEGRATION_ROOT";

let tmp: string;
let workflowDir: string;
let wsRoot: string;
let outsideDir: string;
let seqPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sym-ws-integration-"));
  workflowDir = path.join(tmp, "workflow");
  wsRoot = path.join(tmp, "workspaces");
  outsideDir = path.join(tmp, "outside");
  seqPath = path.join(tmp, "hook-seq.log");
  await fs.mkdir(workflowDir);
  await fs.mkdir(wsRoot);
  await fs.mkdir(outsideDir);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/**
 * 写真实的 `WORKFLOW.md` 到临时目录，再走 config 的完整管道（front matter 解析 →
 * 默认值合并 / `$VAR` / tilde / 相对路径 → typed `ServiceConfig`）。
 *
 * `env` 只注入本用例声明的键、`home` 注入临时目录——测试因此不依赖进程环境或真实 home。
 */
function loadWorkflow(frontMatter: readonly string[]): EffectiveWorkflow {
  writeFileSync(
    path.join(workflowDir, "WORKFLOW.md"),
    `---\n${frontMatter.join("\n")}\n---\nWork on the issue.\n`,
    "utf8",
  );
  return loadEffectiveWorkflow({
    cwd: workflowDir,
    env: { [ROOT_ENV_VAR]: tmp },
    home: tmp,
  });
}

/** `$VAR` 形态的 root：证明 absolute 解析发生在 config，workspace 只接 typed 结果。 */
const ROOT_LINES: readonly string[] = [
  "workspace:",
  `  root: $${ROOT_ENV_VAR}/workspaces`,
];

/** 一段 hook 的 shell 体（绝对路径在生成 front matter 时展开，脚本本身不含 `$`）。 */
interface HookSpec {
  readonly afterCreate?: readonly string[] | undefined;
  readonly beforeRun?: readonly string[] | undefined;
  readonly afterRun?: readonly string[] | undefined;
  readonly beforeRemove?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * `hooks.timeout_ms` 在本文件里的两档取值，依据是"谁负责撞线、谁只负责兜底"：
 *
 * - {@link HOOK_TIMEOUT_OK_MS}（默认档）：给**必须成功**的 hook 兜底。这些脚本只是
 *   `echo` / `pwd`，正常执行远小于该值；一旦脚本挂住就快速失败，而不是等 §5.3.4 的
 *   60000 默认超时把整个用例拖到一分钟。它不承担"证明 timeout 语义"的职责。
 * - {@link HOOK_TIMEOUT_DEADLINE_MS}（显式传入）：给**必须超时**的用例——配合 `sleep 5`
 *   脚本（20x 裕量），确保走的是生产 timeout + 进程组 SIGKILL 路径，而不是巧合通过。
 */
const HOOK_TIMEOUT_OK_MS = 300;
const HOOK_TIMEOUT_DEADLINE_MS = 250;

/** 把 hook 规格渲染成 `hooks:` front matter（多行脚本用 YAML block scalar）。 */
function hookLines(spec: HookSpec): string[] {
  const lines = ["hooks:", `  timeout_ms: ${spec.timeoutMs ?? HOOK_TIMEOUT_OK_MS}`];
  const entries: readonly (readonly [key: string, body: readonly string[] | undefined])[] = [
    ["after_create", spec.afterCreate],
    ["before_run", spec.beforeRun],
    ["after_run", spec.afterRun],
    ["before_remove", spec.beforeRemove],
  ];
  for (const [key, body] of entries) {
    if (body === undefined) {
      continue;
    }
    lines.push(`  ${key}: |`);
    for (const scriptLine of body) {
      lines.push(`    ${scriptLine}`);
    }
  }
  return lines;
}

/** 记录 hook 执行顺序与 cwd 的两行体：`echo <name>` 紧跟 `pwd`。 */
function tracedHook(name: string): string[] {
  return [`echo ${name} >> ${seqPath}`, `pwd >> ${seqPath}`];
}

async function readSeq(): Promise<string[]> {
  try {
    return (await fs.readFile(seqPath, "utf8")).split("\n").filter((line) => line !== "");
  } catch {
    return [];
  }
}

async function lstatOrNull(target: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}

/** 断言 reject 的是 `WorkspaceError` 且 `code` 匹配，并把错误返回给调用方继续断言。 */
async function expectWorkspaceError(
  promise: Promise<unknown>,
  code: WorkspaceError["code"],
): Promise<WorkspaceError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err: unknown) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(WorkspaceError);
  const wsError = caught as WorkspaceError;
  expect(wsError.code).toBe(code);
  return wsError;
}

function eventCollector(): { events: WorkspaceHookEvent[]; sink: WorkspaceHookEventSink } {
  const events: WorkspaceHookEvent[] = [];
  return { events, sink: (event) => events.push(event) };
}

/** 经公共入口建立 manager：喂给它的就是 config 解析出来的 typed config 对象本身。 */
function managerFrom(eff: EffectiveWorkflow): WorkspaceManager {
  return createWorkspaceManager({ workspace: eff.serviceConfig.workspace });
}

describe("WORKFLOW.md → config → workspace：root 由 config 解析为 absolute（SPEC §5.3.3 / §6.1 / §9.1）", () => {
  it("$VAR 形态的 workspace.root 在 config 侧成为 absolute，manager 原样消费该 typed config", () => {
    const eff = loadWorkflow(ROOT_LINES);
    const resolvedRoot = eff.serviceConfig.workspace.root;

    expect(path.isAbsolute(resolvedRoot)).toBe(true);
    expect(resolvedRoot).toBe(path.join(tmp, "workspaces"));

    const manager = managerFrom(eff);
    // workspace 只消费 typed config：构造器拿到的正是 config 产出的那个对象。
    expect(manager.workspaceConfig).toBe(eff.serviceConfig.workspace);
    expect(manager.root).toBe(resolvedRoot);
  });

  it("相对路径与 tilde 同样在 config 侧绝对化；workspace 拒绝未经解析的相对 root", () => {
    const relative = loadWorkflow(["workspace:", "  root: ws/relative"]);
    expect(relative.serviceConfig.workspace.root).toBe(path.join(workflowDir, "ws", "relative"));
    expect(managerFrom(relative).root).toBe(path.join(workflowDir, "ws", "relative"));

    // home 注入临时目录：`~` 由 config 展开，测试不读真实 os.homedir()。
    const tilde = loadWorkflow(["workspace:", "  root: ~/tilde-ws"]);
    expect(tilde.serviceConfig.workspace.root).toBe(path.join(tmp, "tilde-ws"));
    expect(managerFrom(tilde).root).toBe(path.join(tmp, "tilde-ws"));

    // 反向证明分工：workspace 不替调用方解析路径，非 absolute root 直接 invalid_root_path。
    let caught: unknown;
    try {
      createWorkspaceManager({ workspace: { root: "ws/relative" } });
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceError);
    expect((caught as WorkspaceError).code).toBe("invalid_root_path");
  });
});

describe("provisioning：deterministic create / reuse、collision、non-directory policy（SPEC §9.1–§9.2 / §17.2）", () => {
  it("同 identifier 两次 createWorkspace：同一路径、createdNow true→false、已有内容不动", async () => {
    const manager = managerFrom(loadWorkflow(ROOT_LINES));
    const identifier = "NEST-64";
    const expectedPath = path.join(wsRoot, manager.deriveWorkspaceKey(identifier));

    const created = await manager.createWorkspace(identifier);
    expect(created.path).toBe(expectedPath);
    expect(created.createdNow).toBe(true);
    expect((await lstatOrNull(created.path))?.isDirectory()).toBe(true);

    // 在 workspace 里放一个真实文件，复用时必须原样存在（证明 reuse 没有重建 / 清空）。
    const marker = path.join(created.path, "work.txt");
    await fs.writeFile(marker, "keep me\n", "utf8");

    const reused = await manager.createWorkspace(identifier);
    expect(reused.path).toBe(created.path);
    expect(reused.workspaceKey).toBe(created.workspaceKey);
    expect(reused.createdNow).toBe(false);
    expect(await fs.readFile(marker, "utf8")).toBe("keep me\n");
  });

  it("净化后同文的不同 identifier 经 domain 权威 deriveWorkspaceKey 落到不同目录", async () => {
    const manager = managerFrom(loadWorkflow(ROOT_LINES));
    const ids = ["issue/1", "issue#1", "issue:1"];

    const keys = ids.map((id) => manager.deriveWorkspaceKey(id));
    // 唯一权威在 domain：workspace 不复制净化 / hash 逻辑（行为面证明）。
    expect(keys).toEqual(ids.map((id) => domainDeriveWorkspaceKey(id)));
    expect(new Set(keys).size).toBe(ids.length);
    for (const key of keys) {
      expect(key).toMatch(/^issue_1--[0-9a-f]{16}$/);
    }

    const workspaces = [];
    for (const id of ids) {
      workspaces.push(await manager.createWorkspace(id));
    }
    expect(new Set(workspaces.map((ws) => ws.path)).size).toBe(ids.length);
    for (const [index, workspace] of workspaces.entries()) {
      expect(workspace.workspaceKey).toBe(keys[index]);
      expect((await lstatOrNull(workspace.path))?.isDirectory()).toBe(true);
    }
  });

  it("已存在的同名 regular file 触发 existing_non_directory，且对象未被删除或替换", async () => {
    const manager = managerFrom(loadWorkflow(ROOT_LINES));
    const identifier = "NEST-64-file";
    const target = path.join(wsRoot, manager.deriveWorkspaceKey(identifier));
    await fs.writeFile(target, "someone else's file\n", "utf8");

    const error = await expectWorkspaceError(manager.createWorkspace(identifier), "existing_non_directory");
    expect(error.path).toBe(target);
    expect(error.identifier).toBe(identifier);

    // 重读世界：Fail Safely = 不删不换，内容逐字节不变。
    const stat = await lstatOrNull(target);
    expect(stat?.isFile()).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("someone else's file\n");
  });

  describe.skipIf(!symlinkSupport.supported)("已存在的同名 symlink", () => {
    it("指向 root 外的 symlink 先被 containment gate 拒绝（unsafe_path / symlink_escape），链接与目标都原样保留", async () => {
      const manager = managerFrom(loadWorkflow(ROOT_LINES));
      const identifier = "NEST-64-symlink-escape";
      const target = path.join(wsRoot, manager.deriveWorkspaceKey(identifier));
      const victim = path.join(outsideDir, "victim");
      await fs.mkdir(victim);
      await fs.writeFile(path.join(victim, "payload.txt"), "do not touch\n", "utf8");
      await fs.symlink(victim, target, "dir");

      const error = await expectWorkspaceError(manager.createWorkspace(identifier), "unsafe_path");
      expect(error.unsafeReason).toBe("workspace_symlink_escape");

      expect((await lstatOrNull(target))?.isSymbolicLink()).toBe(true);
      // symlink 没被穿透删除：root 外的目标目录与内容仍在。
      expect(await fs.readFile(path.join(victim, "payload.txt"), "utf8")).toBe("do not touch\n");
    });

    it("在 canonical root 内指向普通文件的 symlink 触发 existing_non_directory，链接本身不被删除或替换", async () => {
      const manager = managerFrom(loadWorkflow(ROOT_LINES));
      const identifier = "NEST-64-symlink-inroot";
      const target = path.join(wsRoot, manager.deriveWorkspaceKey(identifier));
      const fileInsideRoot = path.join(wsRoot, "a-plain-file.txt");
      await fs.writeFile(fileInsideRoot, "not a workspace\n", "utf8");
      await fs.symlink(fileInsideRoot, target, "file");

      const error = await expectWorkspaceError(manager.createWorkspace(identifier), "existing_non_directory");
      expect(error.path).toBe(target);

      expect((await lstatOrNull(target))?.isSymbolicLink()).toBe(true);
      expect(await fs.readFile(fileInsideRoot, "utf8")).toBe("not a workspace\n");
    });
  });
});

describe("execution-boundary 安全不变量（SPEC §9.5，root 来自 config 解析结果）", () => {
  it("root equality / out-of-root / symlink escape 各自映射到细分 unsafeReason", async () => {
    const manager = managerFrom(loadWorkflow(ROOT_LINES));

    const equalsRoot = await expectWorkspaceError(
      manager.assertWorkspacePathSafe(manager.root),
      "unsafe_path",
    );
    expect(equalsRoot.unsafeReason).toBe("workspace_equals_root");

    const outside = await expectWorkspaceError(
      manager.assertWorkspacePathSafe(path.join(outsideDir, "somewhere")),
      "unsafe_path",
    );
    expect(outside.unsafeReason).toBe("workspace_outside_root");

    const escaping = await expectWorkspaceError(
      manager.assertWorkspacePathSafe(path.join(wsRoot, "NEST-64", "..", "..", "outside", "escape")),
      "unsafe_path",
    );
    expect(escaping.unsafeReason).toBe("workspace_outside_root");

    // 正面：由 config root + domain key 组成的正常 workspace 路径通过同一 primitive。
    const legal = path.join(wsRoot, manager.deriveWorkspaceKey("NEST-64-ok"));
    await expect(manager.assertWorkspacePathSafe(legal)).resolves.toBeUndefined();
  });

  describe.skipIf(!symlinkSupport.supported)("workspace 目录事后被换成逃逸 symlink", () => {
    it("safety primitive 与 removeWorkspace 都拒绝出根目标，且不删除 root 外目录", async () => {
      const manager = managerFrom(loadWorkflow(ROOT_LINES));
      const identifier = "NEST-64-escape";
      const workspacePath = path.join(wsRoot, manager.deriveWorkspaceKey(identifier));
      await manager.createWorkspace(identifier);

      // TOCTOU 形态：创建之后目录被换成指向 root 外的 symlink。
      const escaped = path.join(outsideDir, "escaped");
      await fs.mkdir(escaped);
      await fs.writeFile(path.join(escaped, "keep.txt"), "outside content\n", "utf8");
      await fs.rm(workspacePath, { recursive: true });
      await fs.symlink(escaped, workspacePath, "dir");

      const error = await expectWorkspaceError(
        manager.assertWorkspacePathSafe(workspacePath),
        "unsafe_path",
      );
      expect(error.unsafeReason).toBe("workspace_symlink_escape");

      // M5 消费形态：cleanup primitive 自己拦住出根目标，返回可判别 refused。
      const result = await manager.removeWorkspace(identifier);
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.reason).toBe("workspace_symlink_escape");
      }
      // 重读世界：root 外的真实目录毫发无损，链接本身也还在。
      expect(await fs.readFile(path.join(escaped, "keep.txt"), "utf8")).toBe("outside content\n");
      expect((await lstatOrNull(workspacePath))?.isSymbolicLink()).toBe(true);
    });
  });
});

describe("四 hook 的 timing / cwd / timeout / fatal-vs-best-effort（SPEC §5.3.4 / §9.4 / §17.2，真实 sh 子进程）", () => {
  it("after_create → before_run → after_run → before_remove 各恰好一次，cwd 恒为 workspace path", async () => {
    const eff = loadWorkflow([
      ...ROOT_LINES,
      ...hookLines({
        afterCreate: tracedHook("after_create"),
        beforeRun: tracedHook("before_run"),
        afterRun: tracedHook("after_run"),
        beforeRemove: tracedHook("before_remove"),
      }),
    ]);
    const manager = managerFrom(eff);
    const hooks = eff.serviceConfig.hooks;
    const identifier = "NEST-64-hooks";
    const events = eventCollector();

    const workspace = await manager.createWorkspace(identifier, {
      hooks,
      onHookEvent: events.sink,
    });
    await manager.runBeforeRunHook(workspace, { hooks, identifier, onHookEvent: events.sink });
    await manager.runAfterRunHook(workspace, { hooks, identifier, onHookEvent: events.sink });
    const removed = await manager.removeWorkspace(identifier, {
      hooks,
      onHookEvent: events.sink,
    });

    expect(removed.status).toBe("removed");
    // 每个 hook 两行：名字 + 该 hook 的 `pwd`——同时证明执行时机、次数与 cwd。
    expect(await readSeq()).toEqual([
      "after_create",
      workspace.path,
      "before_run",
      workspace.path,
      "after_run",
      workspace.path,
      "before_remove",
      workspace.path,
    ]);
    // cleanup 之后 marker 序列文件仍在（它刻意位于 workspace 之外），目录已消失。
    expect(await lstatOrNull(removed.path)).toBeNull();
    // 全部成功 → 无 operator 事件（success 不发事件）。
    expect(events.events).toEqual([]);
  });

  it("reuse 路径不运行 after_create；重新加载后的 effective hooks 被下一次调用采用", async () => {
    const first = loadWorkflow([...ROOT_LINES, ...hookLines({ afterCreate: tracedHook("after_create") })]);
    const manager = managerFrom(first);
    const identifier = "NEST-64-reload";
    const created = await manager.createWorkspace(identifier, { hooks: first.serviceConfig.hooks });
    expect(created.createdNow).toBe(true);
    expect(await readSeq()).toEqual(["after_create", created.path]);

    // 复用同一目录：after_create 绝不再运行。
    const reused = await manager.createWorkspace(identifier, { hooks: first.serviceConfig.hooks });
    expect(reused.createdNow).toBe(false);
    expect(await readSeq()).toHaveLength(2);

    // 组合根形态：config 重新加载后，下一次调用传的是新的 effective hooks（manager 不持快照）。
    const second = loadWorkflow([
      ...ROOT_LINES,
      ...hookLines({ afterCreate: tracedHook("after_create_reloaded") }),
    ]);
    const other = await manager.createWorkspace("NEST-64-reload-2", {
      hooks: second.serviceConfig.hooks,
    });
    expect(other.createdNow).toBe(true);
    expect(await readSeq()).toEqual([
      "after_create",
      created.path,
      "after_create_reloaded",
      other.path,
    ]);
  });

  it("`hooks.timeout_ms` 走生产 timeout / 进程组终止路径：after_create → hook_timeout", async () => {
    const eff = loadWorkflow([
      ...ROOT_LINES,
      ...hookLines({
        timeoutMs: HOOK_TIMEOUT_DEADLINE_MS,
        afterCreate: ["sleep 5", `touch ${seqPath}`],
      }),
    ]);
    const manager = managerFrom(eff);
    const identifier = "NEST-64-timeout";
    const workspacePath = path.join(wsRoot, manager.deriveWorkspaceKey(identifier));
    const events = eventCollector();

    const error = await expectWorkspaceError(
      manager.createWorkspace(identifier, {
        hooks: eff.serviceConfig.hooks,
        onHookEvent: events.sink,
      }),
      "hook_timeout",
    );
    expect(error.identifier).toBe(identifier);
    expect(events.events.map((event) => [event.hook, event.outcome, event.signal])).toEqual([
      ["after_create", "timeout", "SIGKILL"],
    ]);
    // 半成品目录被 best-effort 清理；sleep 之后的 touch 没发生（整个进程组已终止）。
    expect(await lstatOrNull(workspacePath)).toBeNull();
    expect(await lstatOrNull(seqPath)).toBeNull();
  });

  it("after_create 失败：新建目录被清理；已存在目录既不运行 hook 也绝不被删", async () => {
    const eff = loadWorkflow([
      ...ROOT_LINES,
      ...hookLines({ afterCreate: [`echo after_create_failed >> ${seqPath}`, "exit 3"] }),
    ]);
    const manager = managerFrom(eff);
    const hooks = eff.serviceConfig.hooks;

    const fresh = "NEST-64-partial";
    const freshPath = path.join(wsRoot, manager.deriveWorkspaceKey(fresh));
    const error = await expectWorkspaceError(manager.createWorkspace(fresh, { hooks }), "hook_execution_failed");
    expect(error.path).toBe(freshPath);
    expect(await lstatOrNull(freshPath)).toBeNull();
    // 失败脚本确实跑过一次（marker 先写、再 exit 3），随后目录被清理。
    expect((await readSeq()).length).toBe(1);

    // 复用场景：after_create 不参与，失败脚本连一次都不会再执行。
    const existing = "NEST-64-existing";
    const existingPath = path.join(wsRoot, manager.deriveWorkspaceKey(existing));
    await fs.mkdir(existingPath);
    await fs.writeFile(path.join(existingPath, "keep.txt"), "intact\n", "utf8");

    const reused = await manager.createWorkspace(existing, { hooks });
    expect(reused.createdNow).toBe(false);
    expect(await fs.readFile(path.join(existingPath, "keep.txt"), "utf8")).toBe("intact\n");
    expect((await readSeq()).length).toBe(1);
  });

  it("before_run fatal / after_run best-effort：同一次失败只执行一次，且不覆盖调用方结果", async () => {
    const eff = loadWorkflow([
      ...ROOT_LINES,
      ...hookLines({
        beforeRun: [`echo before_run >> ${seqPath}`, "exit 7"],
        afterRun: [`echo after_run >> ${seqPath}`, "exit 9"],
      }),
    ]);
    const manager = managerFrom(eff);
    const hooks = eff.serviceConfig.hooks;
    const identifier = "NEST-64-attempt";
    const workspace = await manager.createWorkspace(identifier);
    const events = eventCollector();

    const error = await expectWorkspaceError(
      manager.runBeforeRunHook(workspace, { hooks, identifier, onHookEvent: events.sink }),
      "hook_execution_failed",
    );
    expect(error.identifier).toBe(identifier);
    expect(error.workspaceKey).toBe(workspace.workspaceKey);
    // 本包不调度 retry：一次调用恰好一次执行。
    expect(await readSeq()).toEqual(["before_run"]);

    // best-effort：after_run 失败照常返回，只产生 operator 事件。
    await expect(
      manager.runAfterRunHook(workspace, { hooks, identifier, onHookEvent: events.sink }),
    ).resolves.toBeUndefined();

    expect(events.events.map((event) => [event.hook, event.outcome, event.exitCode])).toEqual([
      ["before_run", "failed", 7],
      ["after_run", "failed", 9],
    ]);
    expect(events.events[0]?.workspacePath).toBe(workspace.path);
    expect((await lstatOrNull(workspace.path))?.isDirectory()).toBe(true);
  });

  it("after_run timeout 与 before_remove 失败都是 best-effort：不 throw、cleanup 继续", async () => {
    const eff = loadWorkflow([
      ...ROOT_LINES,
      ...hookLines({
        timeoutMs: HOOK_TIMEOUT_DEADLINE_MS,
        afterRun: ["sleep 5"],
        beforeRemove: [`echo before_remove >> ${seqPath}`, "exit 5"],
      }),
    ]);
    const manager = managerFrom(eff);
    const hooks = eff.serviceConfig.hooks;
    const identifier = "NEST-64-best-effort";
    const workspace = await manager.createWorkspace(identifier);
    const events = eventCollector();

    await manager.runAfterRunHook(workspace, { hooks, identifier, onHookEvent: events.sink });
    // attempt 后的 workspace 仍然存在——after_run 的超时不影响世界。
    expect((await lstatOrNull(workspace.path))?.isDirectory()).toBe(true);

    const removed = await manager.removeWorkspace(identifier, { hooks, onHookEvent: events.sink });
    expect(removed.status).toBe("removed");
    expect(events.events.map((event) => [event.hook, event.outcome, event.exitCode])).toEqual([
      ["after_run", "timeout", undefined],
      ["before_remove", "failed", 5],
    ]);
    expect(events.events[0]?.signal).toBe("SIGKILL");
    // before_remove 确实跑过（cwd = workspace，脚本的 echo 早于 exit 5）。
    expect(await readSeq()).toEqual(["before_remove"]);
    expect(await lstatOrNull(workspace.path)).toBeNull();
  });

  it("safe cleanup + missing 幂等：目录已消失后不再运行 hook", async () => {
    const eff = loadWorkflow([...ROOT_LINES, ...hookLines({ beforeRemove: tracedHook("before_remove") })]);
    const manager = managerFrom(eff);
    const hooks = eff.serviceConfig.hooks;
    const identifier = "NEST-64-cleanup";
    const workspace = await manager.createWorkspace(identifier);

    const first = await manager.removeWorkspace(identifier, { hooks });
    expect(first.status).toBe("removed");
    expect(await readSeq()).toEqual(["before_remove", workspace.path]);

    const second = await manager.removeWorkspace(identifier, { hooks });
    expect(second.status).toBe("missing");
    // 目录已不存在 → 幂等成功，hook 一次都不多跑。
    expect(await readSeq()).toHaveLength(2);
  });
});

describe("repo-wide 边界：workspace 是 §9 的唯一 owner（SPEC §9 / §17.2 / AGENTS.md 依赖方向）", () => {
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(srcDir, "..");

  /** 包内运行期源码（排除 `*.test.ts`）。 */
  function runtimeSources(): string[] {
    return readdirSync(srcDir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => path.join(srcDir, name));
  }

  it("运行期依赖只有 @symphony/domain，@symphony/config 仅作为 devDependency", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as {
      readonly dependencies?: Record<string, string>;
      readonly devDependencies?: Record<string, string>;
    };

    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@symphony/domain"]);
    expect(Object.keys(manifest.devDependencies ?? {})).toContain("@symphony/config");
  });

  it("运行期源码不 import config / orchestrator / agent / observability，不读 WORKFLOW.md，不复制 deriveWorkspaceKey", () => {
    const sources = runtimeSources();
    expect(sources.length).toBeGreaterThan(0);

    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      const label = path.basename(file);
      expect(source, label).not.toMatch(
        /from\s*["']@symphony\/(?:config|orchestrator|agent|observability)["']/,
      );
      expect(source, label).not.toMatch(/["']WORKFLOW\.md["']/);
      expect(source, label).not.toMatch(/function\s+deriveWorkspaceKey/);
    }

    // key 派生的唯一权威在 domain：本包只 import 复用。
    expect(readFileSync(path.join(srcDir, "manager.ts"), "utf8")).toMatch(
      /deriveWorkspaceKey[\s\S]{0,120}\}\s*from\s*["']@symphony\/domain["']/,
    );
  });
});
