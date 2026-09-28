/**
 * config ↔ tracker 集成验收（NEST-54 验收 1 / 3 / 4，SPEC §6.3 / §11.1 / §11.2 /
 * §17.1 两条 tracker config 行；Core Conformance）。
 *
 * 本文件放在 **tracker** 包、而不是 config 包，是为了守住 issue 的硬约束
 * "`@symphony/config` 不 import `@symphony/tracker`"：跨包接线的证明责任在**实现
 * 扩展点的一侧**（tracker），config 只认识自己声明的结构化契约
 * （`src/tracker-extension.test.ts` 用本地 fake extension 覆盖机制本身）。这里
 * `@symphony/config` 只是 devDependency——运行期依赖方向不变（tracker → domain）。
 *
 * 覆盖的是"两边各自声明的形状真的能对接上"这件事：
 *
 * 1. fake adapter 经 registry 注册，被 `loadEffectiveWorkflow` 的 config 校验调用
 *    （验收 1）；
 * 2. 无效 tracker 配置产生 §11.4 稳定 code 的 `SymphonyConfigError`，且经
 *    `watchWorkflow` 走 §6.2 last-known-good（验收 2 / 3）；
 * 3. 注册第二个、第三个 kind 不需要动 `@symphony/config` 一行代码（验收 4）；
 * 4. 编译期锁定两侧的 `TrackerConfigExtension` 双向可赋值——结构化契约漂移会在这里
 *    而不是在运行时被发现。
 *
 * 与 `docs/testing.md` 哲学一致：真实临时目录里的真实 `WORKFLOW.md`、走两包的
 * `index.ts` 公共出口、断言外部结果（resolved config / 错误 code / kernel 返回的
 * Issue），不检查内部状态是否"被调用过"。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, afterEach, beforeEach, expect, it } from "vitest";

import {
  loadEffectiveWorkflow,
  SymphonyConfigError,
  watchWorkflow,
  type TrackerConfigExtension as ConfigSideExtension,
  type WorkflowReloadEvent,
  type WorkflowWatchHandle,
} from "@symphony/config";
import type { Issue, TrackerConfig } from "@symphony/domain";

import {
  createTrackerAdapterRegistry,
  TrackerError,
  type TrackerAdapterContext,
  type TrackerAdapterProfile,
  type TrackerConfigExtension as TrackerSideExtension,
} from "./index";

let dir: string;
let workflowPath: string;
let watcher: WorkflowWatchHandle | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "symphony-tracker-integration-"));
  workflowPath = join(dir, "WORKFLOW.md");
});

afterEach(() => {
  watcher?.close();
  watcher = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function writeWorkflow(frontMatter: readonly string[]): string {
  writeFileSync(workflowPath, `---\n${frontMatter.join("\n")}\n---\nWork on the issue.\n`, "utf8");
  return workflowPath;
}

/** 每个 kind 各自累计被请求的 provider 次数，用于证明"零 provider 请求"。 */
const providerRequests: string[] = [];

function normalizedIssue(kind: string, id: string): Issue {
  return {
    id,
    nativeRef: { [`${kind}_key`]: id },
    identifier: `${kind.toUpperCase()}-${id}`,
    title: `Issue ${id}`,
    description: null,
    priority: null,
    state: "In Progress",
    branchName: null,
    url: null,
    assigneeId: null,
    labels: ["agent"],
    blockedBy: [],
    dispatchable: true,
    createdAt: null,
    updatedAt: null,
  };
}

/**
 * 一个 provider 的完整 profile 形状（#19 的 GitHub profile 即此结构）：
 * provider-owned 键 `repo`、secret 走 `provider.token` 或 adapter-local `FAKE_TOKEN`、
 * active/terminal states 有自己的默认值。
 */
function fakeProviderProfile(kind: string): TrackerAdapterProfile & {
  readonly built: TrackerAdapterContext[];
} {
  const built: TrackerAdapterContext[] = [];
  return {
    kind,
    documentation: `packages/tracker/README.md#extension-points`,
    secretProviderKeys: ["token"],
    secretEnvVars: ["FAKE_TOKEN"],
    defaultActiveStates: ["Needs Triage", "Open"],
    defaultTerminalStates: ["Done"],
    built,
    validateConfig(tracker) {
      if (tracker.activeStates?.includes("Bogus")) {
        throw new TrackerError("invalid_tracker_config", `tracker.active_states contains a state ${kind} does not know`);
      }
    },
    resolveProviderConfig(provider, env) {
      const repo = provider["repo"];
      if (typeof repo !== "string" || repo === "") {
        throw new TrackerError("invalid_tracker_config", 'tracker.provider.repo must be a non-empty "owner/name" string');
      }
      const token = typeof provider["token"] === "string" ? provider["token"] : env["FAKE_TOKEN"];
      if (token === undefined || token === "") {
        throw new TrackerError("missing_tracker_secret", `${kind}: tracker.provider.token or FAKE_TOKEN is required`);
      }
      return { repo };
    },
    createAdapter(context) {
      built.push(context);
      return {
        kind: context.kind,
        fetchIssuesByStates: async (stateNames) => {
          providerRequests.push(`${context.kind}:states`);
          return stateNames.map((state) => normalizedIssue(context.kind, state));
        },
        fetchIssuesByIds: async (ids) => {
          providerRequests.push(`${context.kind}:ids`);
          return ids.map((id) => normalizedIssue(context.kind, id));
        },
      };
    },
  };
}

const VALID_TRACKER = ["tracker:", "  kind: acme", "  provider:", "    repo: acme/widget", "    token: inline-token"];

describe("验收 1：registry 里注册的 adapter 被 config validation 调用", () => {
  it("合法 tracker 配置经 loadEffectiveWorkflow 通过，profile 看到的是 resolved config", () => {
    const profile = fakeProviderProfile("acme");
    const registry = createTrackerAdapterRegistry([profile]);
    writeWorkflow(VALID_TRACKER);
    const env = { FAKE_TOKEN: "env-token" };

    const eff = loadEffectiveWorkflow({ cwd: dir, env, trackerExtension: registry.createConfigExtension() });

    expect(eff.serviceConfig.tracker.kind).toBe("acme");
    // adapter-owned 键经 core 原样保留（core 不校验 provider，§5.3.1）。
    expect(eff.serviceConfig.tracker.provider).toEqual({ repo: "acme/widget", token: "inline-token" });
    // preflight 只校验，不构造 adapter；构造由 create() 负责。
    expect(profile.built).toEqual([]);
  });

  it("preflight 通过后 create() 直接产出可用 kernel，返回 normalized Issue", async () => {
    const profile = fakeProviderProfile("acme");
    const registry = createTrackerAdapterRegistry([profile]);
    writeWorkflow(VALID_TRACKER);
    const { serviceConfig } = loadEffectiveWorkflow({
      cwd: dir,
      env: {},
      trackerExtension: registry.createConfigExtension(),
    });
    // profile 的 state 默认只进 TrackerAdapterContext：resolved config 保持 M1 形状。
    expect(serviceConfig.tracker.activeStates).toBeNull();

    const kernel = registry.create(serviceConfig.tracker, {});
    expect(profile.built[0]?.activeStates).toEqual(["Needs Triage", "Open"]);
    expect(serviceConfig.tracker.activeStates).toBeNull();
    await expect(kernel.fetchIssuesByStates(["In Progress"])).resolves.toEqual([
      normalizedIssue("acme", "In Progress"),
    ]);
    await expect(kernel.fetchIssuesByIds(["42"])).resolves.toEqual([normalizedIssue("acme", "42")]);
  });

  it("kernel 的 §11.1 空输入守卫在整条链路上仍然成立（零 provider 请求）", async () => {
    const registry = createTrackerAdapterRegistry([fakeProviderProfile("acme")]);
    writeWorkflow(VALID_TRACKER);
    const { serviceConfig } = loadEffectiveWorkflow({
      cwd: dir,
      env: {},
      trackerExtension: registry.createConfigExtension(),
    });
    providerRequests.length = 0;

    const kernel = registry.create(serviceConfig.tracker, {});
    await expect(kernel.fetchIssuesByStates([])).resolves.toEqual([]);
    await expect(kernel.fetchIssuesByIds([])).resolves.toEqual([]);
    expect(providerRequests).toEqual([]);
  });
});

describe("验收 2 / 3：稳定错误面覆盖两条 §17.1 tracker config 行", () => {
  /** 走完整 config 入口，返回抛出的 code。 */
  function failureCodeOf(frontMatter: readonly string[], env: Record<string, string | undefined>): string {
    const registry = createTrackerAdapterRegistry([fakeProviderProfile("acme")]);
    writeWorkflow(frontMatter);
    try {
      loadEffectiveWorkflow({ cwd: dir, env, trackerExtension: registry.createConfigExtension() });
    } catch (error) {
      expect(error).toBeInstanceOf(SymphonyConfigError);
      return (error as SymphonyConfigError).code;
    }
    throw new Error("expected the tracker preflight to fail");
  }

  it("kind 未注册 → unsupported_tracker_kind（§17.1 第一行）", () => {
    expect(failureCodeOf(["tracker:", "  kind: linear"], {})).toBe("unsupported_tracker_kind");
  });

  it("kind 缺失（M1 的空串哨兵）→ invalid_tracker_config", () => {
    expect(failureCodeOf(["tracker:", "  provider:", "    repo: a/b"], { FAKE_TOKEN: "t" })).toBe(
      "invalid_tracker_config",
    );
  });

  it("裸 WORKFLOW.md（整个 tracker section 缺席）→ invalid_tracker_config", () => {
    expect(failureCodeOf(["polling:", "  interval_ms: 5000"], {})).toBe("invalid_tracker_config");
  });

  it("provider-owned 键非法 → invalid_tracker_config（§17.1 第二行，由 selected adapter 判定）", () => {
    expect(failureCodeOf(["tracker:", "  kind: acme", "  provider:", "    repo: 7"], { FAKE_TOKEN: "t" })).toBe(
      "invalid_tracker_config",
    );
  });

  it("secret 两处都取不到 → missing_tracker_secret；env fallback 生效时通过", () => {
    // repo 合法、provider 无 token、env 里也没有 → 只剩 secret 一条失败原因。
    const repoOnly = ["tracker:", "  kind: acme", "  provider:", "    repo: acme/widget"];
    expect(failureCodeOf(repoOnly, {})).toBe("missing_tracker_secret");

    const registry = createTrackerAdapterRegistry([fakeProviderProfile("acme")]);
    writeWorkflow(repoOnly);
    expect(() =>
      loadEffectiveWorkflow({ cwd: dir, env: { FAKE_TOKEN: "from-env" }, trackerExtension: registry.createConfigExtension() }),
    ).not.toThrow();
  });

  it("adapter 认识的 active_states 非法 → invalid_tracker_config；provider 的 unknown keys 由 adapter 决定", () => {
    expect(
      failureCodeOf(
        [...VALID_TRACKER, "  active_states:", "    - Bogus"],
        {},
      ),
    ).toBe("invalid_tracker_config");

    // core 从不因 provider 里的 unknown key 报错（§5.3.1：保留、由 adapter 决定）。
    const registry = createTrackerAdapterRegistry([fakeProviderProfile("acme")]);
    writeWorkflow([...VALID_TRACKER, "    future_provider_key: 42"]);
    const eff = loadEffectiveWorkflow({ cwd: dir, env: {}, trackerExtension: registry.createConfigExtension() });
    expect(eff.serviceConfig.tracker.provider["future_provider_key"]).toBe(42);
  });

  it("错误对象的 path 是真实 workflow 文件，message 保留 adapter 文案", () => {
    const registry = createTrackerAdapterRegistry([fakeProviderProfile("acme")]);
    writeWorkflow(["tracker:", "  kind: acme", "  provider:", "    repo: acme/widget"]);

    try {
      loadEffectiveWorkflow({ cwd: dir, env: {}, trackerExtension: registry.createConfigExtension() });
      throw new Error("unreachable: the adapter must reject a config without any token");
    } catch (error) {
      expect(error).toBeInstanceOf(SymphonyConfigError);
      const configError = error as SymphonyConfigError;
      expect(configError.code).toBe("missing_tracker_secret");
      expect(configError.path).toBe(workflowPath);
      expect(configError.message).toContain("FAKE_TOKEN");
    }
  });
});

describe("验收 4：新增 provider 不需要改 @symphony/config", () => {
  it("同一份 config 代码先后注册 acme 与 linear，选择完全由 registry 决定", () => {
    const registry = createTrackerAdapterRegistry([fakeProviderProfile("acme"), fakeProviderProfile("linear")]);

    writeWorkflow(["tracker:", "  kind: linear", "  provider:", "    repo: acme/other", "    token: t"]);
    const linear = loadEffectiveWorkflow({ cwd: dir, env: {}, trackerExtension: registry.createConfigExtension() });
    expect(linear.serviceConfig.tracker.kind).toBe("linear");

    writeWorkflow(["tracker:", "  kind: acme", "  provider:", "    repo: acme/widget", "    token: t2"]);
    const acme = loadEffectiveWorkflow({ cwd: dir, env: {}, trackerExtension: registry.createConfigExtension() });
    expect(acme.serviceConfig.tracker.kind).toBe("acme");

    // 只有被选中的 profile 被要求解释自己的配置；built-in 的 github 与调用方追加的
    // 两个 kind 共存，config 一侧零改动。
    expect(registry.supportedKinds).toEqual(["acme", "github", "linear"]);
  });

  it("不注入扩展点时，config 对任何 kind 都无感（core 里没有 provider 分支）", () => {
    writeWorkflow(["tracker:", "  kind: whatever-m2.1-does-not-know"]);

    const eff = loadEffectiveWorkflow({ cwd: dir, env: {} });
    expect(eff.serviceConfig.tracker.kind).toBe("whatever-m2.1-does-not-know");
  });
});

describe("§6.2 继承：无效 tracker 配置的 reload 保留 last-known-good", () => {
  it("invalid reload → error 事件 + 旧 effective config；修好后 → reloaded", () => {
    const registry = createTrackerAdapterRegistry([fakeProviderProfile("acme")]);
    const extension = registry.createConfigExtension();
    writeWorkflow(VALID_TRACKER);
    const events: WorkflowReloadEvent[] = [];

    watcher = watchWorkflow({
      cwd: dir,
      intervalMs: 10,
      env: {},
      trackerExtension: extension,
      onEvent: (event) => events.push(event),
    });
    expect(watcher.current().serviceConfig.tracker.provider).toEqual({
      repo: "acme/widget",
      token: "inline-token",
    });

    // repo 被删 → selected adapter 判定非法；last-known-good 不被覆盖。
    writeWorkflow(["tracker:", "  kind: acme", "  provider:", "    token: inline-token"]);
    watcher.reload();
    expect(watcher.current().serviceConfig.tracker.provider).toEqual({
      repo: "acme/widget",
      token: "inline-token",
    });
    expect(events.map((event) => event.kind)).toEqual(["error"]);
    if (events[0]?.kind !== "error") {
      throw new Error("unreachable");
    }
    expect(events[0].error.code).toBe("invalid_tracker_config");

    // 换成未注册的 kind → error 事件的 code 随 category 变化。
    writeWorkflow(["tracker:", "  kind: jira", "  provider:", "    repo: a/b"]);
    watcher.reload();
    if (events[1]?.kind !== "error") {
      throw new Error("unreachable");
    }
    expect(events[1].error.code).toBe("unsupported_tracker_kind");

    // 配置修好 → 新值生效。
    writeWorkflow([...VALID_TRACKER, "    page_size: 100"]);
    watcher.reload();
    expect(watcher.current().serviceConfig.tracker.provider).toEqual({
      repo: "acme/widget",
      token: "inline-token",
      page_size: 100,
    });
    expect(events.map((event) => event.kind)).toEqual(["error", "error", "reloaded"]);
  });
});

/**
 * M2.2（NEST-55）：built-in `github` profile 走完整 config 链路。
 *
 * 与上面各节的分工是刻意的——那些用 fake profile 证明**机制**（注册即可被校验），
 * 这里证明**注册真的发生了**：`createTrackerAdapterRegistry()` 不追加任何 profile
 * 就认识 `github`，且 `@symphony/config` 一侧零改动。
 */
describe("built-in github profile 经 config 端到端（SPEC §11.2 / §6.3）", () => {
  function resolve(frontMatter: readonly string[], env: Record<string, string | undefined>) {
    writeWorkflow(frontMatter);
    return loadEffectiveWorkflow({
      cwd: dir,
      env,
      trackerExtension: createTrackerAdapterRegistry().createConfigExtension(),
    });
  }

  const REPO_ONLY = ["tracker:", "  kind: github", "  provider:", "    repo: acme/widget"];

  it("kind: github 无需调用方注册即被支持", () => {
    expect(createTrackerAdapterRegistry().supportedKinds).toEqual(["github"]);
    expect(resolve(REPO_ONLY, { GITHUB_TOKEN: "ghp_env" }).serviceConfig.tracker.kind).toBe(
      "github",
    );
  });

  it("provider 的 $VAR 由 adapter 解释；resolved config 原样保留字面量（§6.1）", () => {
    const eff = resolve(
      ["tracker:", "  kind: github", "  provider:", "    repo: acme/widget", "    token: $GITHUB_TOKEN"],
      { GITHUB_TOKEN: "ghp_env" },
    );
    expect(eff.serviceConfig.tracker.provider).toEqual({
      repo: "acme/widget",
      token: "$GITHUB_TOKEN",
    });
  });

  it("token 两处都取不到 → missing_tracker_secret 进 config 错误面", () => {
    writeWorkflow(REPO_ONLY);
    try {
      loadEffectiveWorkflow({
        cwd: dir,
        env: {},
        trackerExtension: createTrackerAdapterRegistry().createConfigExtension(),
      });
      throw new Error("unreachable: preflight must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(SymphonyConfigError);
      expect((error as SymphonyConfigError).code).toBe("missing_tracker_secret");
    }
  });

  it("别家 provider 的 active_states 在 config preflight 即被拒", () => {
    writeWorkflow([...REPO_ONLY, "  active_states:", "    - In Progress"]);
    expect(() =>
      loadEffectiveWorkflow({
        cwd: dir,
        env: { GITHUB_TOKEN: "ghp_env" },
        trackerExtension: createTrackerAdapterRegistry().createConfigExtension(),
      }),
    ).toThrowError(/not a GitHub Issues state/);
  });

  it("preflight 通过后 create() 的 kernel 只等到 #20 的 transport", async () => {
    const env = { GITHUB_TOKEN: "ghp_env" };
    const { serviceConfig } = resolve(REPO_ONLY, env);
    const kernel = createTrackerAdapterRegistry().create(serviceConfig.tracker, env);

    expect(kernel.kind).toBe("github");
    // §11.1 的空输入 MUST 仍然先于 transport 生效：不发任何请求。
    await expect(kernel.fetchIssuesByStates([])).resolves.toEqual([]);
    await expect(kernel.fetchIssuesByIds([])).resolves.toEqual([]);

    try {
      await kernel.fetchIssuesByStates(["open"]);
      throw new Error("unreachable: M2.2 has no REST transport");
    } catch (error) {
      expect(error).toBeInstanceOf(TrackerError);
      expect((error as TrackerError).category).toBe("tracker_request");
    }
  });
});

describe("结构化契约的编译期锁定（两侧独立声明必须对接得上）", () => {
  it("tracker 产出的 extension 可赋给 config 的契约类型，且反向亦成立", () => {
    const registry = createTrackerAdapterRegistry([fakeProviderProfile("acme")]);

    // tracker → config：注入用的方向，漂移即编译失败。
    const asConfigSide: ConfigSideExtension = registry.createConfigExtension();
    // config → tracker：证明两侧声明互为结构等价，不是一方宽松一方恰好能塞。
    const asTrackerSide: TrackerSideExtension = asConfigSide;
    expect(asTrackerSide).toBe(asConfigSide);

    const tracker: TrackerConfig = {
      kind: "acme",
      provider: { repo: "acme/widget", token: "t" },
      requiredLabels: [],
      activeStates: null,
      terminalStates: null,
    };
    expect(asConfigSide.validateTrackerConfig({ tracker, env: {} })).toBeUndefined();
    expect(
      asConfigSide.validateTrackerConfig({ tracker: { ...tracker, kind: "nope" }, env: {} })?.category,
    ).toBe("unsupported_tracker_kind");
  });
});
