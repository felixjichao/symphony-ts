/**
 * Tracker 配置校验扩展点测试（SPEC §6.3 dispatch preflight + §17.1 两条 tracker
 * config 验收项；M2.1）。
 *
 * 本文件**只**用 `@symphony/config` 自己声明的结构化契约（`./index`）与本地 fake
 * extension：不 import `@symphony/tracker`。这正是扩展点存在的意义——core 对
 * provider 一无所知，`unsupported_tracker_kind` / `invalid_tracker_config` /
 * `missing_tracker_secret` 的语义由注入方决定。tracker 注册表接入真实 config 的
 * 端到端用例在 `packages/tracker/src/config-integration.test.ts`。
 *
 * 沿用仓库既有做法：真实临时目录里的真实 `WORKFLOW.md`，走 `./index` 唯一公共出口
 * （docs/testing.md 三条哲学）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, afterEach, beforeEach, expect, it, vi } from "vitest";

import type { TrackerConfig } from "@symphony/domain";

import {
  loadEffectiveWorkflow,
  resolveServiceConfig,
  SymphonyConfigError,
  watchWorkflow,
  type TrackerConfigExtension,
  type TrackerConfigExtensionFailure,
  type TrackerConfigValidationContext,
  type WorkflowReloadEvent,
  type WorkflowWatchHandle,
} from "./index";

let dir: string;
let workflowPath: string;
let watcher: WorkflowWatchHandle | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "symphony-tracker-extension-"));
  workflowPath = join(dir, "WORKFLOW.md");
});

afterEach(() => {
  watcher?.close();
  watcher = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** 写入 WORKFLOW.md 并返回其绝对路径（内容长度恒变化，reload stamp 必然不同）。 */
function writeWorkflow(frontMatter: string): string {
  writeFileSync(workflowPath, `---\n${frontMatter}\n---\nWork on the issue.\n`, "utf8");
  return workflowPath;
}

/**
 * 记录每次收到的 context，并按脚本返回失败 / 通过。`setFailure` 让 reload 用例能
 * 在两次 reload 之间改变脚本（`TrackerConfigExtension` 的属性是 readonly，因此
 * 状态藏在闭包里而不是被重新赋值）。
 */
function fakeExtension(initial: TrackerConfigExtensionFailure | undefined = undefined) {
  const calls: TrackerConfigValidationContext[] = [];
  let failure = initial;
  const extension: TrackerConfigExtension = {
    validateTrackerConfig: (context) => {
      calls.push(context);
      return failure;
    },
  };
  return {
    extension,
    calls,
    lastContext: (): TrackerConfigValidationContext => calls[calls.length - 1] as TrackerConfigValidationContext,
    setFailure: (next: TrackerConfigExtensionFailure | undefined): void => {
      failure = next;
    },
  };
}

const RAW_TRACKER: TrackerConfig = {
  kind: "github",
  provider: { repo: "acme/widget", github_token: "$MY_TOKEN" },
  requiredLabels: ["agent"],
  activeStates: null,
  terminalStates: ["Done"],
};

describe("不注入扩展点 = M1 行为逐字不变（core resolution 不依赖注册表）", () => {
  it("裸 WORKFLOW.md 仍得到全默认值的 ServiceConfig", () => {
    writeWorkflow("");
    const eff = loadEffectiveWorkflow({ cwd: dir });

    expect(eff.serviceConfig.tracker).toEqual({
      kind: "",
      provider: {},
      requiredLabels: [],
      activeStates: null,
      terminalStates: null,
    });
  });

  it("core 不认识任何 provider：未被支持的 kind 与任意 provider 键都原样通过", () => {
    writeWorkflow(
      ["tracker:", "  kind: some-unknown-provider", "  provider:", "    endpoint: https://example.internal", "    token: $UNSET_VAR"].join("\n"),
    );

    const eff = loadEffectiveWorkflow({ cwd: dir, env: {} });

    expect(eff.serviceConfig.tracker.kind).toBe("some-unknown-provider");
    // provider 内容不校验、不展开（§6.1 adapter-local）。
    expect(eff.serviceConfig.tracker.provider).toEqual({
      endpoint: "https://example.internal",
      token: "$UNSET_VAR",
    });
  });
});

describe("注入扩展点：preflight 的输入面", () => {
  it("扩展收到的是 resolved tracker 与本次 resolution 的 env 视图", () => {
    writeWorkflow(
      ["tracker:", "  kind: github", "  provider:", "    repo: acme/widget", "    github_token: $MY_TOKEN", "  required_labels:", "    - agent", "  terminal_states:", "    - Done"].join("\n"),
    );
    const env = { MY_TOKEN: "inline-secret" };
    const { extension, calls, lastContext } = fakeExtension();

    const eff = loadEffectiveWorkflow({ cwd: dir, env, trackerExtension: extension });

    expect(calls).toHaveLength(1);
    expect(lastContext().tracker).toEqual(RAW_TRACKER);
    expect(lastContext().env).toBe(env);
    // 扩展点只有读权限：它看到的就是 core 产出的那个 tracker 对象（identity）。
    expect(lastContext().tracker).toBe(eff.serviceConfig.tracker);
  });

  it("core 校验失败先抛，扩展点根本不被调用（preflight 只在 resolution 之后）", () => {
    writeWorkflow(["tracker:", "  kind: 123"].join("\n"));
    const { extension, calls } = fakeExtension();

    expect(() => loadEffectiveWorkflow({ cwd: dir, trackerExtension: extension })).toThrowError(
      /Invalid value for `tracker\.kind`/,
    );
    expect(calls).toEqual([]);
  });

  it("纯 resolver 同样支持注入，path 用 sourcePath", () => {
    const { extension, calls } = fakeExtension({
      category: "invalid_tracker_config",
      message: "tracker.provider.repo is required",
    });

    const error = captureConfigError(() =>
      resolveServiceConfig(
        { tracker: { kind: "github" } },
        { workflowDir: dir, sourcePath: workflowPath, trackerExtension: extension },
      ),
    );

    expect(error.code).toBe("invalid_tracker_config");
    expect(error.path).toBe(workflowPath);
    expect(calls).toHaveLength(1);
  });
});

describe("注入扩展点：preflight 的错误面（§11.4 category → ConfigErrorCode）", () => {
  const cases: readonly {
    readonly category: TrackerConfigExtensionFailure["category"];
    readonly message: string;
  }[] = [
    { category: "unsupported_tracker_kind", message: 'Unsupported tracker.kind "linear"' },
    { category: "invalid_tracker_config", message: "tracker.provider.repo must be owner/name" },
    { category: "missing_tracker_secret", message: "GITHUB_TOKEN is not set" },
  ];

  for (const { category, message } of cases) {
    it(`${category} → 同名 code 的 SymphonyConfigError，message 原样、path 为 workflow 文件`, () => {
      writeWorkflow(["tracker:", "  kind: linear"].join("\n"));
      const { extension } = fakeExtension({ category, message });

      const error = captureConfigError(() =>
        loadEffectiveWorkflow({ cwd: dir, trackerExtension: extension }),
      );

      expect(error).toBeInstanceOf(SymphonyConfigError);
      expect(error.code).toBe(category);
      expect(error.message).toBe(message);
      expect(error.path).toBe(workflowPath);
    });
  }

  it("扩展给出的 cause 经 Error.cause 保留供诊断", () => {
    writeWorkflow(["tracker:", "  kind: linear"].join("\n"));
    const cause = new Error("adapter-side detail");
    const { extension } = fakeExtension({ category: "invalid_tracker_config", message: "bad", cause });

    const error = captureConfigError(() =>
      loadEffectiveWorkflow({ cwd: dir, trackerExtension: extension }),
    );

    expect(error.cause).toBe(cause);
  });

  it("扩展抛异常（违反契约）在注入边界收敛为 typed error：缺陷靠 message + cause 判别", () => {
    writeWorkflow(["tracker:", "  kind: linear"].join("\n"));
    const bug = new TypeError("extension bug");
    const throwing: TrackerConfigExtension = {
      validateTrackerConfig: () => {
        throw bug;
      },
    };

    const error = captureConfigError(() =>
      loadEffectiveWorkflow({ cwd: dir, trackerExtension: throwing }),
    );

    expect(error.code).toBe("invalid_tracker_config");
    // 与"一次真实配置失败"可区分：message 写明扩展自身抛出，原抛出物完整保留。
    expect(error.message).toContain("extension defect");
    expect(error.message).toContain("TypeError");
    expect(error.cause).toBe(bug);
  });

  it("扩展抛出的非 Error 值也走同一边界，cause 原样保留", () => {
    writeWorkflow(["tracker:", "  kind: linear"].join("\n"));
    const throwing: TrackerConfigExtension = {
      validateTrackerConfig: () => {
        throw "plain string bug";
      },
    };

    const error = captureConfigError(() =>
      loadEffectiveWorkflow({ cwd: dir, trackerExtension: throwing }),
    );

    expect(error.code).toBe("invalid_tracker_config");
    expect(error.message).toContain("string");
    expect(error.cause).toBe("plain string bug");
  });
});

describe("热重载自动继承扩展点（WatchWorkflowOptions §6.2 语义）", () => {
  it("tracker 配置变无效：保留 last-known-good 并发 operator-visible error，修好后自愈", () => {
    writeWorkflow(["tracker:", "  kind: github", "  provider:", "    repo: acme/widget"].join("\n"));
    const { extension, calls, setFailure } = fakeExtension();
    const events: WorkflowReloadEvent[] = [];

    watcher = watchWorkflow({
      cwd: dir,
      intervalMs: 10,
      trackerExtension: extension,
      onEvent: (event) => events.push(event),
    });

    expect(watcher.current().serviceConfig.tracker.provider).toEqual({ repo: "acme/widget" });
    expect(calls).toHaveLength(1);

    // repo 被删掉 → selected adapter 判定非法。
    setFailure({
      category: "invalid_tracker_config",
      message: "tracker.provider.repo is required",
    });
    writeWorkflow(["tracker:", "  kind: github"].join("\n"));
    watcher.reload();

    expect(watcher.current().serviceConfig.tracker.provider).toEqual({ repo: "acme/widget" });
    expect(events.map((event) => event.kind)).toEqual(["error"]);
    if (events[0]?.kind !== "error") {
      throw new Error("unreachable");
    }
    expect(events[0].error.code).toBe("invalid_tracker_config");
    expect(events[0].error.message).toBe("tracker.provider.repo is required");

    // 配置修好 → 新 last-known-good 生效。
    setFailure(undefined);
    writeWorkflow(["tracker:", "  kind: github", "  provider:", "    repo: acme/widget", "    page_size: 100"].join("\n"));
    watcher.reload();

    expect(watcher.current().serviceConfig.tracker.provider).toEqual({ repo: "acme/widget", page_size: 100 });
    expect(events.map((event) => event.kind)).toEqual(["error", "reloaded"]);
  });

  it("扩展在定时器 reload 中抛异常：不崩服务，typed error 事件 + last-known-good，之后自愈", async () => {
    writeWorkflow(["tracker:", "  kind: github", "  provider:", "    repo: acme/widget"].join("\n"));
    // 扩展缺陷（而不是配置失败）：reload 路径上抛出，必须被注入边界接住。
    let throwing = false;
    const bug = new TypeError("extension bug");
    const extension: TrackerConfigExtension = {
      validateTrackerConfig: () => {
        if (throwing) {
          throw bug;
        }
        return undefined;
      },
    };
    const events: WorkflowReloadEvent[] = [];

    watcher = watchWorkflow({
      cwd: dir,
      intervalMs: 10,
      trackerExtension: extension,
      onEvent: (event) => events.push(event),
    });
    expect(watcher.current().serviceConfig.tracker.provider).toEqual({ repo: "acme/widget" });

    throwing = true;
    writeWorkflow(["tracker:", "  kind: github", "  provider:", "    repo: acme/other"].join("\n"));
    await vi.waitFor(() => expect(events.length).toBe(1));

    if (events[0]?.kind !== "error") {
      throw new Error("unreachable");
    }
    expect(events[0].error.code).toBe("invalid_tracker_config");
    expect(events[0].error.cause).toBe(bug);
    // 服务仍在运行：缺陷那次 reload 既不生效也不终止进程。
    expect(watcher.current().serviceConfig.tracker.provider).toEqual({ repo: "acme/widget" });

    // 反证崩溃已消除：缺陷修好后同一个 watcher 正常应用新配置。
    throwing = false;
    writeWorkflow(["tracker:", "  kind: github", "  provider:", "    repo: acme/other", "    page_size: 50"].join("\n"));
    await vi.waitFor(() => expect(events.length).toBe(2));

    expect(events[1]?.kind).toBe("reloaded");
    expect(watcher.current().serviceConfig.tracker.provider).toEqual({ repo: "acme/other", page_size: 50 });
  });

  it("初始加载即无效 → fail-fast throw，不产生半初始化 handle", () => {
    writeWorkflow(["tracker:", "  kind: unsupported-by-registry"].join("\n"));
    const { extension } = fakeExtension({
      category: "unsupported_tracker_kind",
      message: 'Unsupported tracker.kind "unsupported-by-registry"',
    });

    expect(() => watchWorkflow({ cwd: dir, trackerExtension: extension })).toThrowError(
      SymphonyConfigError,
    );
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function captureConfigError(action: () => unknown): SymphonyConfigError {
  try {
    action();
  } catch (error) {
    expect(error, "配置失败必须是 SymphonyConfigError").toBeInstanceOf(SymphonyConfigError);
    return error as SymphonyConfigError;
  }
  throw new Error("expected a SymphonyConfigError, but nothing was thrown");
}
