/**
 * Adapter registry / factory 测试（Core Conformance，SPEC §11.2 construction +
 * §6.3 preflight 的 supported-adapter 部分，NEST-54 验收 2 与 4）。
 *
 * 重点不是"registry 内部 Map 被写过"，而是**选择与失败面**：给定一个 effective
 * `TrackerConfig`，注册表要么产出一个可用的 read kernel，要么给出 §11.4 的稳定
 * category（docs/testing.md 哲学 1）。
 *
 * 全程不 import `@symphony/config`：registry 只吃 domain 的 `TrackerConfig`，
 * 这正是"provider knowledge 留在 tracker adapter"（issue 设计边界）的结构证明。
 * 验收 4（#19 可注册 `github` 而不动 config 内部）由
 * {@link githubLikeProfile} 一条用例证明。
 */
import { describe, expect, it } from "vitest";

import type { Issue, TrackerConfig } from "@symphony/domain";

import { TrackerError } from "./index";
import type { TrackerAdapterContext, TrackerAdapterProfile, TrackerEnv } from "./index";
import { createTrackerAdapterRegistry, TrackerAdapterRegistry } from "./index";

const ENV: TrackerEnv = { FAKE_TOKEN: "s3cret", EMPTY_TOKEN: "" };

/** 最小 normalized Issue（§11.3 字段全在场）。 */
function issue(id: string): Issue {
  return {
    id,
    nativeRef: null,
    identifier: `FAKE-${id}`,
    title: "t",
    description: null,
    priority: null,
    state: "Idle",
    branchName: null,
    url: null,
    assigneeId: null,
    labels: [],
    blockedBy: [],
    dispatchable: false,
    createdAt: null,
    updatedAt: null,
  };
}

function trackerConfig(overrides: Partial<TrackerConfig> = {}): TrackerConfig {
  return {
    kind: overrides.kind ?? "fake",
    provider: overrides.provider ?? {},
    requiredLabels: overrides.requiredLabels ?? [],
    activeStates: overrides.activeStates ?? null,
    terminalStates: overrides.terminalStates ?? null,
  };
}

/**
 * 一个"像 GitHub 那样"的 fake profile：provider-owned 键是 `repo` 与
 * `github_token`（secret，支持 `FAKE_TOKEN` env fallback）、active/terminal
 * states 有自己的默认与校验。#19 的真实 profile 形状即如此。
 */
function githubLikeProfile(kind = "github"): TrackerAdapterProfile & {
  contexts: TrackerAdapterContext[];
} {
  const contexts: TrackerAdapterContext[] = [];
  return {
    kind,
    documentation: `packages/tracker/README.md#${kind}`,
    secretProviderKeys: ["github_token"],
    secretEnvVars: ["FAKE_TOKEN"],
    defaultActiveStates: ["Needs Triage", "Open"],
    defaultTerminalStates: ["Done", "Cancelled"],
    contexts,
    validateConfig(tracker) {
      if (tracker.requiredLabels.some((label) => label.trim() === "")) {
        throw new TrackerError("invalid_tracker_config", "tracker.required_labels must not contain blanks");
      }
    },
    resolveProviderConfig(provider, env) {
      const repo = provider["repo"];
      if (typeof repo !== "string" || repo === "") {
        throw new TrackerError("invalid_tracker_config", 'tracker.provider.repo must be a non-empty "owner/name" string');
      }
      const rawToken = provider["github_token"];
      // adapter-local secret fallback：provider 键优先，其次 profile 自己声明的 env 名。
      const token =
        typeof rawToken === "string" && rawToken !== "" ? rawToken : env["FAKE_TOKEN"];
      if (token === undefined || token === "") {
        throw new TrackerError("missing_tracker_secret", "tracker.provider.github_token or FAKE_TOKEN is required");
      }
      return { repo, apiBaseUrl: "https://api.github.com", pageLimit: 100 };
    },
    createAdapter(context) {
      contexts.push(context);
      return {
        kind: context.kind,
        fetchIssuesByStates: async (stateNames) =>
          stateNames.map((name) => issue(`by-state:${name}`)),
        fetchIssuesByIds: async (ids) => ids.map((id) => issue(id)),
      };
    },
  };
}

/** 只声明 kind + 构造的最简 profile（可选方法全缺席）。 */
function bareProfile(kind = "bare"): TrackerAdapterProfile {
  return {
    kind,
    documentation: "packages/tracker/README.md#bare",
    secretProviderKeys: [],
    secretEnvVars: [],
    defaultActiveStates: ["Todo"],
    defaultTerminalStates: ["Done"],
    createAdapter: (context) => ({
      kind: context.kind,
      fetchIssuesByStates: async () => [issue(`${context.kind}:1`)],
      fetchIssuesByIds: async () => [],
    }),
  };
}

describe("TrackerAdapterRegistry — 注册与选择（§11.2）", () => {
  it("按精确 kind 命中 profile", () => {
    const registry = new TrackerAdapterRegistry([bareProfile("fake")]);
    expect(registry.lookup("fake")?.kind).toBe("fake");
    expect(registry.lookup("Fake")).toBeUndefined();
    expect(registry.lookup(" fake")).toBeUndefined();
    expect(registry.supportedKinds).toEqual(["fake"]);
  });

  it("register 可链式追加，supportedKinds 恒为升序快照", () => {
    const registry = new TrackerAdapterRegistry().register(bareProfile("zeta")).register(bareProfile("alpha"));
    expect(registry.supportedKinds).toEqual(["alpha", "zeta"]);
  });

  it("拒绝注册空 kind：那是 tracker.kind 的「未配置」哨兵", () => {
    expect(() => new TrackerAdapterRegistry([bareProfile("")])).toThrowError(
      /reserved "not configured" sentinel/,
    );
  });

  it("拒绝同一 kind 的重复注册", () => {
    const registry = new TrackerAdapterRegistry([bareProfile("dup")]);
    expect(() => registry.register(bareProfile("dup"))).toThrowError(
      /Duplicate tracker adapter registration for kind "dup"/,
    );
  });

  it("createTrackerAdapterRegistry = built-in 注册点 + 调用方追加", () => {
    const registry = createTrackerAdapterRegistry([bareProfile("extra")]);
    expect(registry.lookup("extra")).toBeDefined();
    // M2.1 尚无 built-in：#19 往 BUILT_IN_TRACKER_ADAPTER_PROFILES 加 github 后
    // 这里会多出该 kind，而 config 一行都不用改（验收 4）。
    expect(registry.supportedKinds).toEqual(["extra"]);
  });
});

describe("TrackerAdapterRegistry.create — 构造 read kernel", () => {
  it("profile 收到的 context 已解析 provider / states / labels", async () => {
    const profile = githubLikeProfile();
    const registry = new TrackerAdapterRegistry([profile]);

    const kernel = registry.create(
      trackerConfig({
        kind: "github",
        provider: { repo: "acme/widget", github_token: "inline-token" },
        requiredLabels: ["agent"],
        activeStates: ["In Progress"],
        terminalStates: ["Human Review"],
      }),
      ENV,
    );

    const context = profile.contexts[0] as TrackerAdapterContext;
    expect(context.kind).toBe("github");
    // provider 键经 profile 解析：secret 不进 context，profile 自己的默认值进来了。
    expect(context.provider).toEqual({ repo: "acme/widget", apiBaseUrl: "https://api.github.com", pageLimit: 100 });
    expect(context.requiredLabels).toEqual(["agent"]);
    expect(context.activeStates).toEqual(["In Progress"]);
    expect(context.terminalStates).toEqual(["Human Review"]);
    expect(context.env).toBe(ENV);

    // 构造出来的是 §11.1 kernel，返回 normalized Issue。
    await expect(kernel.fetchIssuesByIds(["42"])).resolves.toEqual([issue("42")]);
  });

  it("active/terminal states 为 null 时采用 profile 默认（§5.3.1 / §6.4）", () => {
    const profile = githubLikeProfile();
    new TrackerAdapterRegistry([profile]).create(trackerConfig({ kind: "github", provider: { repo: "a/b" } }), ENV);

    const context = profile.contexts[0] as TrackerAdapterContext;
    expect(context.activeStates).toEqual(["Needs Triage", "Open"]);
    expect(context.terminalStates).toEqual(["Done", "Cancelled"]);
  });

  it("可选方法缺席的 profile 原样透传 provider，仍可构造", async () => {
    const kernel = new TrackerAdapterRegistry([bareProfile("bare")]).create(trackerConfig({ kind: "bare" }), ENV);
    expect(kernel.kind).toBe("bare");
    await expect(kernel.fetchIssuesByStates(["Todo"])).resolves.toEqual([issue("bare:1")]);
  });

  it("造出来的 kernel 带 §11.1 空输入守卫（provider 完全不被请求）", async () => {
    let providerCalls = 0;
    const profile: TrackerAdapterProfile = {
      ...bareProfile("counting"),
      createAdapter: (context) => ({
        kind: context.kind,
        fetchIssuesByStates: async () => {
          providerCalls += 1;
          return [];
        },
        fetchIssuesByIds: async () => {
          providerCalls += 1;
          return [];
        },
      }),
    };
    const kernel = new TrackerAdapterRegistry([profile]).create(trackerConfig({ kind: "counting" }), ENV);

    await kernel.fetchIssuesByStates([]);
    await kernel.fetchIssuesByIds([]);
    expect(providerCalls).toBe(0);

    await kernel.fetchIssuesByStates(["Todo"]);
    expect(providerCalls).toBe(1);
  });

  it("env 缺省取 process.env（组合根可省略）", () => {
    const profile = githubLikeProfile();
    process.env["FAKE_TOKEN"] = "from-process-env";
    try {
      expect(() =>
        new TrackerAdapterRegistry([profile]).create(trackerConfig({ kind: "github", provider: { repo: "a/b" } })),
      ).not.toThrow();
    } finally {
      delete process.env["FAKE_TOKEN"];
    }
  });
});

describe("TrackerAdapterRegistry — 稳定错误面（§11.4 / 验收 2）", () => {
  it("kind 未注册 → unsupported_tracker_kind，message 列出支持面", () => {
    const registry = new TrackerAdapterRegistry([bareProfile("fake"), bareProfile("another")]);
    const error = captureError(() => registry.create(trackerConfig({ kind: "linear" }), ENV));

    expect(error.category).toBe("unsupported_tracker_kind");
    expect(error.message).toContain('"linear"');
    expect(error.message).toContain('"another", "fake"');
  });

  it("注册表为空时也报 unsupported，并说明没有任何已注册 adapter", () => {
    const error = captureError(() => new TrackerAdapterRegistry().create(trackerConfig({ kind: "github" }), ENV));
    expect(error.category).toBe("unsupported_tracker_kind");
    expect(error.message).toContain("(none registered)");
  });

  it("kind 为空串（未配置哨兵）→ invalid_tracker_config，而非 unsupported", () => {
    const registry = new TrackerAdapterRegistry([bareProfile("fake")]);
    const error = captureError(() => registry.create(trackerConfig({ kind: "" }), ENV));

    expect(error.category).toBe("invalid_tracker_config");
    expect(error.message).toContain("tracker.kind is not configured");
    expect(error.providerDetail).toEqual({ supportedKinds: ["fake"] });
    expect(registry.lookup("")).toBeUndefined();
  });

  it("provider 键非法 → invalid_tracker_config（由 selected adapter 判定，§17.1）", () => {
    const registry = new TrackerAdapterRegistry([githubLikeProfile()]);
    const error = captureError(() =>
      registry.create(trackerConfig({ kind: "github", provider: { repo: 12 } }), ENV),
    );

    expect(error.category).toBe("invalid_tracker_config");
    expect(error.message).toContain("tracker.provider.repo");
  });

  it("secret 缺失 → missing_tracker_secret；provider 键与 env fallback 都落空才算缺", () => {
    const registry = new TrackerAdapterRegistry([githubLikeProfile()]);
    const withoutFallback: TrackerEnv = { FAKE_TOKEN: undefined };

    const error = captureError(() =>
      registry.create(trackerConfig({ kind: "github", provider: { repo: "a/b" } }), withoutFallback),
    );
    expect(error.category).toBe("missing_tracker_secret");
    expect(error.message).toContain("github_token");

    // env 里存在同名变量即视为已配置（adapter-local fallback，§6.1）。
    expect(() =>
      registry.create(trackerConfig({ kind: "github", provider: { repo: "a/b" } }), ENV),
    ).not.toThrow();
  });

  it("env fallback 值为空串按缺失处理（对齐 §5.3.1 secret empty = missing）", () => {
    const registry = new TrackerAdapterRegistry([githubLikeProfile()]);
    const error = captureError(() =>
      registry.create(trackerConfig({ kind: "github", provider: { repo: "a/b" } }), { FAKE_TOKEN: "" }),
    );
    expect(error.category).toBe("missing_tracker_secret");
  });

  it("profile 抛出非 TrackerError（adapter 缺陷）→ 归一化为 invalid_tracker_config 且保留 cause", () => {
    const registry = new TrackerAdapterRegistry([
      {
        ...bareProfile("broken"),
        validateConfig: () => {
          throw new TypeError("profile bug: cannot read");
        },
      },
    ]);
    const error = captureError(() => registry.create(trackerConfig({ kind: "broken" }), ENV));

    expect(error.category).toBe("invalid_tracker_config");
    expect(error.message).toContain("TypeError: profile bug: cannot read");
    expect(error.message).toContain("while validating the tracker config");
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it("createAdapter 阶段的非 TrackerError 异常同样被归类", () => {
    const registry = new TrackerAdapterRegistry([
      {
        ...bareProfile("exploding"),
        createAdapter: () => {
          throw new Error("transport init failed");
        },
      },
    ]);
    const error = captureError(() => registry.create(trackerConfig({ kind: "exploding" }), ENV));

    expect(error.category).toBe("invalid_tracker_config");
    expect(error.message).toContain("constructing the tracker adapter");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("校验失败时不调用 createAdapter（不产出半构造 adapter）", () => {
    const profile = githubLikeProfile();
    const registry = new TrackerAdapterRegistry([profile]);

    expect(() => registry.create(trackerConfig({ kind: "github", provider: {} }), ENV)).toThrowError(
      TrackerError,
    );
    expect(profile.contexts).toEqual([]);
  });
});

describe("TrackerAdapterRegistry — whole-config 校验的执行顺序（§6.3）", () => {
  it("先选 adapter 再校验 provider：kind 不支持时 provider 校验根本不运行", () => {
    let providerChecked = false;
    const registry = new TrackerAdapterRegistry([
      {
        ...bareProfile("fake"),
        resolveProviderConfig: (provider) => {
          providerChecked = true;
          return provider;
        },
      },
    ]);

    const error = captureError(() => registry.create(trackerConfig({ kind: "nope", provider: { junk: 1 } }), ENV));
    expect(error.category).toBe("unsupported_tracker_kind");
    expect(providerChecked).toBe(false);
  });

  it("validateConfig 先于 resolveProviderConfig", () => {
    const order: string[] = [];
    const registry = new TrackerAdapterRegistry([
      {
        ...bareProfile("fake"),
        validateConfig: () => {
          order.push("validateConfig");
        },
        resolveProviderConfig: (provider) => {
          order.push("resolveProviderConfig");
          return provider;
        },
      },
    ]);

    registry.create(trackerConfig({ kind: "fake" }), ENV);
    expect(order).toEqual(["validateConfig", "resolveProviderConfig"]);
  });

  it("required_labels 的 adapter 语义由 validateConfig 把关", () => {
    const registry = new TrackerAdapterRegistry([githubLikeProfile()]);
    const error = captureError(() =>
      registry.create(
        trackerConfig({ kind: "github", provider: { repo: "a/b" }, requiredLabels: ["  "] }),
        ENV,
      ),
    );
    expect(error.category).toBe("invalid_tracker_config");
    expect(error.message).toContain("required_labels");
  });
});

describe("createConfigExtension — 交给 @symphony/config 的结构化契约", () => {
  it("通过时返回 undefined", () => {
    const extension = new TrackerAdapterRegistry([githubLikeProfile()]).createConfigExtension();
    expect(
      extension.validateTrackerConfig({
        tracker: trackerConfig({ kind: "github", provider: { repo: "a/b" } }),
        env: ENV,
      }),
    ).toBeUndefined();
  });

  it("失败时给出 category + message，不抛异常、不泄漏 TrackerError 实例", () => {
    const extension = new TrackerAdapterRegistry([githubLikeProfile()]).createConfigExtension();
    const failure = extension.validateTrackerConfig({
      tracker: trackerConfig({ kind: "github", provider: { repo: "a/b" } }),
      env: { FAKE_TOKEN: undefined },
    });

    expect(failure).toEqual({
      category: "missing_tracker_secret",
      message: expect.stringContaining("github_token"),
    });
    expect("cause" in (failure as object)).toBe(false);
  });

  it("unsupported kind 在扩展面上也是 unsupported_tracker_kind", () => {
    const extension = new TrackerAdapterRegistry([bareProfile()]).createConfigExtension();
    expect(
      extension.validateTrackerConfig({ tracker: trackerConfig({ kind: "jira" }), env: ENV })?.category,
    ).toBe("unsupported_tracker_kind");
  });

  it("adapter 校验期抛出的运行时 category 收敛为配置阶段错误", () => {
    const extension = new TrackerAdapterRegistry([
      {
        ...bareProfile("fake"),
        validateConfig: () => {
          throw new TrackerError("tracker_request", "profile reached out to the network during validation");
        },
      },
    ]).createConfigExtension();

    const failure = extension.validateTrackerConfig({ tracker: trackerConfig(), env: ENV });
    expect(failure?.category).toBe("invalid_tracker_config");
    expect(failure?.message).toContain("tracker_request");
    expect(failure?.cause).toBeInstanceOf(TrackerError);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function captureError(action: () => unknown): TrackerError {
  try {
    action();
  } catch (error) {
    expect(error, "registry 失败必须以 TrackerError 抛出").toBeInstanceOf(TrackerError);
    return error as TrackerError;
  }
  throw new Error("expected a TrackerError, but nothing was thrown");
}
