/**
 * GitHub adapter profile 测试（Core Conformance，SPEC §11.2 provider keys /
 * defaults / secret / validation errors + §6.3 preflight，NEST-55 验收
 * "config/profile" 一节的每一条勾选项）。
 *
 * 走 profile 的公开面（`validateConfig` / `resolveProviderConfig` /
 * `createAdapter`），因为那正是 registry 与 config preflight 实际调用的形状；
 * import 经包出口 `../index`（docs/testing.md：只测公共 API）。
 */
import { describe, expect, it } from "vitest";

import type { TrackerConfig } from "@symphony/domain";

import { TrackerError, createGitHubAdapterProfile, githubAdapterProfile } from "../index";
import type { GitHubFetchImpl, TrackerAdapterContext, TrackerEnv } from "../index";

const TOKEN = "ghp_S3cretValue";
const ENV: TrackerEnv = { GITHUB_TOKEN: TOKEN, MY_PAT: "pat-from-env", EMPTY: "" };

/** profile 声明了两个校验钩子；此处只是把可选方法的收窄集中在一处。 */
function resolveProvider(
  provider: Record<string, unknown> = { repo: "acme/widget" },
  env: TrackerEnv = ENV,
): Record<string, unknown> {
  const resolve = githubAdapterProfile.resolveProviderConfig;
  if (resolve === undefined) {
    throw new Error("unreachable: the GitHub profile declares resolveProviderConfig");
  }
  return { ...resolve(provider, env) };
}

function validateConfig(tracker: TrackerConfig): void {
  const validate = githubAdapterProfile.validateConfig;
  if (validate === undefined) {
    throw new Error("unreachable: the GitHub profile declares validateConfig");
  }
  validate(tracker, ENV);
}

function trackerConfig(overrides: Partial<TrackerConfig> = {}): TrackerConfig {
  return {
    kind: "github",
    provider: { repo: "acme/widget", token: TOKEN },
    requiredLabels: [],
    activeStates: null,
    terminalStates: null,
    ...overrides,
  };
}

function errorOf(run: () => unknown): TrackerError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TrackerError);
    return error as TrackerError;
  }
  throw new Error("unreachable: expected the profile to reject");
}

async function rejectionOf(run: () => Promise<unknown>): Promise<TrackerError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(TrackerError);
    return error as TrackerError;
  }
  throw new Error("unreachable: expected the adapter to fail");
}

function contextOf(provider: Record<string, unknown>): TrackerAdapterContext {
  return {
    kind: "github",
    provider,
    requiredLabels: [],
    activeStates: ["open"],
    terminalStates: ["closed"],
    env: ENV,
  };
}

/** 一个只回吐给定 payload 的假 transport（#20 的注入面）。 */
function fakeTransport(payloads: readonly unknown[]) {
  return {
    fetchPayloadsByStates: async () => payloads,
    fetchPayloadsByIds: async () => payloads,
  };
}

describe("githubAdapterProfile — profile 元数据（§11.2 compact profile）", () => {
  it("声明 supported kind、secret 面与 GitHub-native states 默认", () => {
    expect(githubAdapterProfile.kind).toBe("github");
    expect(githubAdapterProfile.documentation).toBe("packages/tracker/README.md#github-issues");
    expect(githubAdapterProfile.secretProviderKeys).toEqual(["token"]);
    expect(githubAdapterProfile.secretEnvVars).toEqual(["GITHUB_TOKEN"]);
    expect(githubAdapterProfile.defaultActiveStates).toEqual(["open"]);
    expect(githubAdapterProfile.defaultTerminalStates).toEqual(["closed"]);
  });
});

describe("resolveProviderConfig — repo", () => {
  it("owner/repo 通过并原样保留", () => {
    expect(resolveProvider({ repo: "acme/widget" }).repo).toBe("acme/widget");
    expect(resolveProvider({ repo: "openai/Symphony.ts" }).repo).toBe("openai/Symphony.ts");
  });

  for (const [name, provider] of [
    ["缺失", {}],
    ["非字符串", { repo: 42 }],
    ["空串", { repo: "" }],
    ["无 owner 段", { repo: "widget" }],
    ["两个斜杠", { repo: "acme/widget/extra" }],
    ["含空格", { repo: "acme / widget" }],
  ] as const) {
    it(`拒绝：${name} → invalid_tracker_config`, () => {
      expect(errorOf(() => resolveProvider({ ...provider })).category).toBe(
        "invalid_tracker_config",
      );
    });
  }
});

describe("resolveProviderConfig — token（explicit / $VAR / GITHUB_TOKEN fallback）", () => {
  it("显式字面值优先", () => {
    expect(resolveProvider({ repo: "acme/widget", token: "explicit-literal" }).token).toBe(
      "explicit-literal",
    );
  });

  it("显式 $VAR 与 ${VAR} 都按变量名展开", () => {
    expect(resolveProvider({ repo: "acme/widget", token: "$MY_PAT" }).token).toBe("pat-from-env");
    expect(resolveProvider({ repo: "acme/widget", token: "${MY_PAT}" }).token).toBe("pat-from-env");
  });

  it("键缺席 → adapter-local GITHUB_TOKEN fallback", () => {
    expect(resolveProvider({ repo: "acme/widget" }).token).toBe(TOKEN);
  });

  it("键为空串 / null → 同缺失（与 config 的 env 语义一致）", () => {
    expect(resolveProvider({ repo: "acme/widget", token: "" }).token).toBe(TOKEN);
    expect(resolveProvider({ repo: "acme/widget", token: null }).token).toBe(TOKEN);
  });

  it("两处都取不到 → missing_tracker_secret，message 只引用键名与变量名", () => {
    const error = errorOf(() => resolveProvider({ repo: "acme/widget" }, {}));
    expect(error.category).toBe("missing_tracker_secret");
    expect(error.message).toContain("tracker.provider.token");
    expect(error.message).toContain("GITHUB_TOKEN");
    expect(error.message).not.toContain(TOKEN);
  });

  it("显式 $VAR 取不到 → 失败，不静默改用 GITHUB_TOKEN", () => {
    const error = errorOf(() =>
      resolveProvider({ repo: "acme/widget", token: "$NOT_SET" }, { GITHUB_TOKEN: TOKEN }),
    );
    expect(error.category).toBe("missing_tracker_secret");
    expect(error.message).toContain("$NOT_SET");
    expect(error.message).not.toContain(TOKEN);
  });

  it("空环境变量按缺失处理（fallback 与显式 $VAR 两条路径都是）", () => {
    expect(errorOf(() => resolveProvider({ repo: "acme/widget" }, { GITHUB_TOKEN: "" })).category).toBe(
      "missing_tracker_secret",
    );
    expect(errorOf(() => resolveProvider({ repo: "acme/widget", token: "$EMPTY" }, ENV)).category).toBe(
      "missing_tracker_secret",
    );
  });

  it("token 非字符串 → invalid_tracker_config（形状错，不是没给）", () => {
    expect(errorOf(() => resolveProvider({ repo: "acme/widget", token: 42 })).category).toBe(
      "invalid_tracker_config",
    );
  });
});

describe("resolveProviderConfig — api_url", () => {
  it("默认 https://api.github.com", () => {
    expect(resolveProvider().api_url).toBe("https://api.github.com");
  });

  it("尾斜杠归一化（单个与多个）", () => {
    expect(resolveProvider({ repo: "a/b", api_url: "https://api.github.com/" }).api_url).toBe(
      "https://api.github.com",
    );
    expect(resolveProvider({ repo: "a/b", api_url: "https://ghes.example.com///" }).api_url).toBe(
      "https://ghes.example.com",
    );
  });

  it("保留 path（GHES 的 /api/v3）", () => {
    expect(resolveProvider({ repo: "a/b", api_url: "https://ghes.example.com/api/v3/" }).api_url).toBe(
      "https://ghes.example.com/api/v3",
    );
  });

  it("嵌入凭据的 api_url 直接失败——auth 只走 token", () => {
    expect(errorOf(() => resolveProvider({ repo: "a/b", api_url: "https://user:pass@ghes.example.com" })).category).toBe(
      "invalid_tracker_config",
    );
    expect(errorOf(() => resolveProvider({ repo: "a/b", api_url: "https://user@ghes.example.com" })).category).toBe(
      "invalid_tracker_config",
    );
  });

  it("api_url 的诊断回显脱敏 userinfo，不泄漏凭据", () => {
    const error = errorOf(() => resolveProvider({ repo: "a/b", api_url: "http://user:hunter2@ghes.example.com" }));
    expect(error.message).toContain("//<redacted>@ghes.example.com");
    expect(error.message).not.toContain("hunter2");
    expect(error.message).not.toContain("user:");
  });

  for (const api_url of ["http://ghes.example.com", "ssh://ghes.example.com", "api.github.com", "https://", "", "42"]) {
    it(`只接受可用的 HTTPS URL：拒绝 ${JSON.stringify(api_url)}`, () => {
      expect(errorOf(() => resolveProvider({ repo: "a/b", api_url })).category).toBe(
        "invalid_tracker_config",
      );
    });
  }
});

describe("resolveProviderConfig — provider 键集", () => {
  it("unknown key 直接失败（拼错的键不该被静默忽略）", () => {
    const error = errorOf(() => resolveProvider({ repo: "a/b", tokne: TOKEN }));
    expect(error.category).toBe("invalid_tracker_config");
    expect(error.message).toContain("tokne");
    expect(error.message).toContain("repo, token, api_url");
  });

  it("resolved map 只含披露过的三个键", () => {
    expect(Object.keys(resolveProvider({ repo: "a/b" })).sort()).toEqual(["api_url", "repo", "token"]);
  });
});

describe("validateConfig — active / terminal states（trim + 大小写不敏感）", () => {
  it("未配置（null）与空列表都不校验", () => {
    expect(() => validateConfig(trackerConfig())).not.toThrow();
    expect(() =>
      validateConfig(trackerConfig({ activeStates: [], terminalStates: [] })),
    ).not.toThrow();
  });

  it("GitHub-native 值的大小写 / 空白变体通过", () => {
    expect(() =>
      validateConfig(trackerConfig({ activeStates: ["Open", " open "], terminalStates: ["CLOSED"] })),
    ).not.toThrow();
  });

  for (const [name, tracker] of [
    ["active_states 写了 closed", trackerConfig({ activeStates: ["closed"] })],
    ["terminal_states 写了 open", trackerConfig({ terminalStates: ["open"] })],
    ["active_states 是别家 provider 的状态", trackerConfig({ activeStates: ["In Progress"] })],
    ["terminal_states 是空串", trackerConfig({ terminalStates: [""] })],
  ] as const) {
    it(`拒绝：${name} → invalid_tracker_config`, () => {
      expect(errorOf(() => validateConfig(tracker)).category).toBe("invalid_tracker_config");
    });
  }
});

describe("createAdapter — 从 effective context 构造", () => {
  it("产出的 adapter kind 是 github", () => {
    const adapter = githubAdapterProfile.createAdapter(contextOf(resolveProvider({ repo: "a/b" })));
    expect(adapter.kind).toBe("github");
  });

  it("未注入 transport 时默认挂上真实 REST transport（不再是 M2.2 的 unconfigured 桩）", async () => {
    // 这条测的是**接线**：默认 transport 会真实发请求、按 §11.2 组装鉴权头。
    // HTTP 层的完整行为由 `transport.test.ts` 用真实本地 server 覆盖；这里用
    // fetch 记录器，因为 profile 的 `api_url` 校验强制 HTTPS，而本地 stub server
    // 是明文 HTTP——不该为了测试放宽那条安全不变量。
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const recordingFetch: GitHubFetchImpl = async (input, init) => {
      requests.push({ url: input, headers: init.headers });
      const closed = input.includes("state=closed");
      return {
        status: closed ? 404 : 200,
        ok: !closed,
        headers: { get: () => null },
        async json() {
          return closed ? { message: "Not Found" } : [{ number: 3, title: "hello", state: "open" }];
        },
      };
    };
    const profile = createGitHubAdapterProfile({ fetchImpl: recordingFetch });
    const adapter = profile.createAdapter(contextOf(resolveProvider({ repo: "acme/widget" })));

    const issues = await adapter.fetchIssuesByStates(["open"]);
    expect(issues.map((issue) => issue.identifier)).toEqual(["GH-3"]);
    expect(requests[0]?.url).toBe(
      "https://api.github.com/repos/acme/widget/issues?state=open&sort=created&direction=asc&per_page=100",
    );
    expect(requests[0]?.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(requests[0]?.headers["Accept"]).toBe("application/vnd.github+json");

    const error = await rejectionOf(() => adapter.fetchIssuesByStates(["closed"]));
    expect(error.category).toBe("tracker_status");
    expect(error.message).not.toContain(TOKEN);
  });

  it("显式注入的 transport 优先于默认 REST 实现（#20 的注入面不变）", async () => {
    const adapter = createGitHubAdapterProfile({
      transport: fakeTransport([{ number: 5, title: "t", state: "open" }]),
    }).createAdapter(contextOf(resolveProvider({ repo: "a/b" })));
    await expect(adapter.fetchIssuesByStates(["open"])).resolves.toEqual([
      expect.objectContaining({ identifier: "GH-5" }),
    ]);
  });

  it("context.provider 未经解析（缺 repo）→ invalid_tracker_config，不产出半构造 adapter", () => {
    expect(errorOf(() => githubAdapterProfile.createAdapter(contextOf({})))).toMatchObject({
      category: "invalid_tracker_config",
    });
  });

  it("transport 注入点让 #20 只替换 transport 一层", async () => {
    const requested: string[][] = [];
    const adapter = createGitHubAdapterProfile({
      transport: {
        fetchPayloadsByStates: async (stateNames) => {
          requested.push([...stateNames]);
          return [{ number: 7, title: "t", state: "open" }];
        },
        fetchPayloadsByIds: async () => [{ number: 7, title: "t", state: "open" }],
      },
    }).createAdapter(contextOf(resolveProvider({ repo: "acme/widget" })));

    const issues = await adapter.fetchIssuesByStates(["open"]);
    expect(requested).toEqual([["open"]]);
    expect(issues.map((issue) => issue.identifier)).toEqual(["GH-7"]);
    expect((await adapter.fetchIssuesByIds(["7"])).map((issue) => issue.id)).toEqual(["7"]);
  });
});

describe("secret 不泄露（NEST-55 验收）", () => {
  it("全部失败路径的 message 与 providerDetail 都不含 token 值", () => {
    const failures: (() => unknown)[] = [
      () => resolveProvider({ repo: "" }),
      () => resolveProvider({ repo: "a/b", token: "$NOT_SET" }),
      () => resolveProvider({ repo: "a/b" }, {}),
      () => resolveProvider({ repo: "a/b", token: 42 }),
      () => resolveProvider({ repo: "a/b", api_url: "http://x.example.com" }),
      () => resolveProvider({ repo: "a/b", bogus: 1 }),
      () => validateConfig(trackerConfig({ activeStates: ["done"] })),
      () => githubAdapterProfile.createAdapter(contextOf({})),
    ];
    for (const run of failures) {
      const error = errorOf(run);
      expect(JSON.stringify(error.message)).not.toContain(TOKEN);
      expect(JSON.stringify(error.providerDetail ?? null)).not.toContain(TOKEN);
    }
  });

  it("native_ref 里没有 token：resolved provider 的配置面不混进 payload 面", async () => {
    const adapter = createGitHubAdapterProfile({ transport: fakeTransport([
      { id: 1, node_id: "I_1", number: 9, title: "t", state: "open", body: null },
    ]) }).createAdapter(contextOf(resolveProvider({ repo: "acme/widget" })));

    const [issue] = await adapter.fetchIssuesByStates(["open"]);
    expect(issue).toBeDefined();
    expect(JSON.stringify(issue?.nativeRef)).not.toContain(TOKEN);
  });
});
