/**
 * M2.4（NEST-57）GitHub tracker 的端到端集成路径（Core Conformance，SPEC §11.1 /
 * §11.2 / §11.3 / §11.4 / §17.1 / §17.3）。
 *
 * 本文件补的是 M2.1–M2.3 各自测试之间的**那一段空隙**：
 *
 * - `config-integration.test.ts` 走到 `registry.create()` 为止（真实
 *   `WORKFLOW.md` → resolved config → kernel），fetch 侧只验证了 §11.1 的空输入守卫；
 * - `github/transport.test.ts` 从 transport 起（provider 配置已构造好），没有 config；
 * - `github/profile.test.ts` 用 fetch 记录器验证默认 transport 的**接线**。
 *
 * 这里的链路是完整的：真实 `WORKFLOW.md` → `loadEffectiveWorkflow`（built-in
 * registry 的 config 扩展点）→ `registry.create()` → profile → REST transport →
 * 本地 GitHub REST stub server → normalized `Issue`。断言面是"世界的变化"：落在
 * stub 上的请求 method / path / query / headers，与返回的 `Issue` 字段、抛出的
 * `TrackerError` category（docs/testing.md 哲学 1 / 2 / 3）。
 *
 * **HTTPS-only 与本地明文 stub 的接缝**：`tracker.provider.api_url` 强制 https
 * （安全不变量，见
 * `notes/accepted/architecture/2026-09-28-github-rest-transport-pagination.md`），
 * 而 stub 起的是 `http://127.0.0.1:<port>`。因此端到端用例一律保持**生产默认
 * origin** `https://api.github.com`，只把 fetch 重定向到本 fixture——transport
 * 因此仍然按真实配置组装 endpoint、仍然执行 `Link` 分页的 origin 守卫，
 * `github-rest-fixture.ts` 的 `fetchImpl` 正是为此存在的测试注入点。重定向只服务
 * 被配置选中的那一个 origin，其余 URL 一律直接失败，**不会真的出网**。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadEffectiveWorkflow, SymphonyConfigError } from "@symphony/config";
import type { Issue } from "@symphony/domain";

import {
  TrackerError,
  TrackerAdapterRegistry,
  createGitHubAdapterProfile,
  createTrackerAdapterRegistry,
  type GitHubFetchImpl,
  type GitHubMalformedRecord,
} from "./index";
import { startGitHubRestFixture } from "./github/github-rest-fixture";
import type { GitHubRestFixture, RecordedRequest, StubResponse } from "./github/github-rest-fixture";

/** 缺省的 `tracker.provider.api_url`（GitHub 生产端点），也是被搬到本地 stub 的那一端。 */
const API_URL = "https://api.github.com";

/** 只存在于测试里的假凭据；断言它出现在 `Authorization` 头、且不出现在错误 message。 */
const TOKEN = "ghp_S3cretValue";

const REPO = "acme/widget";

let dir: string;
let workflowPath: string;
const openServers: GitHubRestFixture[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "symphony-github-rest-integration-"));
  workflowPath = join(dir, "WORKFLOW.md");
});

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await server.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 装配：WORKFLOW.md → config preflight（built-in registry）→ fixture-backed kernel
// ---------------------------------------------------------------------------

function writeWorkflow(frontMatter: readonly string[]): void {
  writeFileSync(workflowPath, `---\n${frontMatter.join("\n")}\n---\nWork on the issue.\n`, "utf8");
}

/** `tracker:` section 的最小可用形状：kind + provider 键（顺序与 YAML 无关）。 */
function trackerFrontMatter(
  provider: readonly string[],
  trackerKeys: readonly string[] = [],
): string[] {
  return ["tracker:", "  kind: github", ...trackerKeys, "  provider:", ...provider];
}

/**
 * 用 **built-in** registry 的扩展点跑真实 config preflight——证明这份
 * `WORKFLOW.md` 是"默认注册表 + GitHub profile"接受的配置，而不是测试自己造的形状。
 */
function loadWorkflow(env: Record<string, string | undefined> = {}) {
  return loadEffectiveWorkflow({
    cwd: dir,
    env,
    trackerExtension: createTrackerAdapterRegistry().createConfigExtension(),
  });
}

/** 起本地 REST stub 并登记，交给 afterEach 关闭。 */
async function startFixture(
  handler: (request: RecordedRequest) => StubResponse,
): Promise<GitHubRestFixture> {
  const server = await startGitHubRestFixture(handler);
  openServers.push(server);
  return server;
}

/**
 * 把生产 endpoint 的请求搬到本地 stub 上：只替换 URL 的 **origin**，`api_url` 的
 * path 前缀（GHES 的 `/api/v3`）、query 与分页线索原样留在 stub 收到的请求里。
 * 配置 `api_url` 之外的任何 URL 直接失败——端到端路径不会真的出网。
 */
function redirectFetchToFixture(server: GitHubRestFixture, apiBaseUrl: string): GitHubFetchImpl {
  const origin = new URL(apiBaseUrl).origin;
  return (input, init) => {
    if (!input.startsWith(`${apiBaseUrl}/`)) {
      throw new Error(`integration fixture only redirects ${apiBaseUrl}, got ${input}`);
    }
    return server.fetch(input.replace(origin, server.baseUrl), init);
  };
}

/**
 * 与 built-in 同一个 profile 工厂（`createGitHubAdapterProfile`），只多一个
 * 测试用的 fetch 重定向。这里用 `new TrackerAdapterRegistry` 而不是
 * `createTrackerAdapterRegistry`：后者会把 built-in 的 `github` profile 也注册进来，
 * 而同 kind 重复注册按 §11.2 是被拒绝的——替换条目正是"把默认 transport 指到本地
 * server"应有的做法（见 `github/profile.ts` 的 `fetchImpl` 注释）。
 */
function fixtureRegistry(
  server: GitHubRestFixture,
  options: {
    /** 配置里的 `tracker.provider.api_url`（缺省 = 生产默认 origin）。 */
    apiUrl?: string;
    onMalformedRecord?: (record: GitHubMalformedRecord) => void;
  } = {},
): TrackerAdapterRegistry {
  return new TrackerAdapterRegistry([
    createGitHubAdapterProfile({
      fetchImpl: redirectFetchToFixture(server, options.apiUrl ?? API_URL),
      onMalformedRecord: options.onMalformedRecord,
    }),
  ]);
}

/** preflight 产出的 tracker config → 走 fixture 的 read kernel。 */
async function kernelFrom(
  frontMatter: readonly string[],
  handler: (request: RecordedRequest) => StubResponse,
  options: {
    env?: Record<string, string | undefined>;
    apiUrl?: string;
    onMalformedRecord?: (record: GitHubMalformedRecord) => void;
  } = {},
): Promise<{ kernel: ReturnType<TrackerAdapterRegistry["create"]>; server: GitHubRestFixture }> {
  writeWorkflow(frontMatter);
  const { serviceConfig } = loadWorkflow(options.env ?? {});
  const server = await startFixture(handler);
  const registry = fixtureRegistry(server, options);
  return { kernel: registry.create(serviceConfig.tracker, options.env ?? {}), server };
}

// ---------------------------------------------------------------------------
// payload / 期望值
// ---------------------------------------------------------------------------

const CREATED_AT = "2026-09-27T10:00:00Z";
const UPDATED_AT = "2026-09-28T11:00:00Z";

/** GitHub REST issue payload（真实响应的形状：`labels` 是对象数组、时间是 ISO 串）。 */
function restIssue(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4_000_000 + number,
    node_id: `I_${number}`,
    number,
    title: `Issue ${number}`,
    state: "open",
    body: `body of ${number}`,
    labels: [{ name: `Label-${number}` }, { name: " Agent " }],
    html_url: `https://github.com/${REPO}/issues/${number}`,
    assignee: { login: "octocat" },
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

/** 上述 payload 期望归一化成的 `Issue`（§11.3 规则的落点，逐字段可见）。 */
function expectedIssue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    id: String(number),
    nativeRef: { repo: REPO, number, id: 4_000_000 + number, node_id: `I_${number}` },
    identifier: `GH-${number}`,
    title: `Issue ${number}`,
    description: `body of ${number}`,
    priority: null,
    state: "open",
    branchName: null,
    url: `https://github.com/${REPO}/issues/${number}`,
    assigneeId: "octocat",
    labels: [`label-${number}`, "agent"],
    blockedBy: [],
    dispatchable: true,
    createdAt: Date.parse(CREATED_AT),
    updatedAt: Date.parse(UPDATED_AT),
    ...overrides,
  };
}

function json(items: unknown, headers: Record<string, string> = {}): StubResponse {
  return { status: 200, body: JSON.stringify(items), headers };
}

/** 按 `request.url` 是否含 `needle` 二选一（分页用例需要区分第 1 / 第 2 页）。 */
function pages(first: StubResponse, secondPageNeedle: string, second: StubResponse) {
  return (request: RecordedRequest): StubResponse =>
    request.url.includes(secondPageNeedle) ? second : first;
}

async function rejectionOf(run: () => Promise<unknown>): Promise<TrackerError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(TrackerError);
    return error as TrackerError;
  }
  throw new Error("unreachable: expected the tracker read to fail");
}

function configErrorOf(run: () => unknown): SymphonyConfigError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SymphonyConfigError);
    return error as SymphonyConfigError;
  }
  throw new Error("unreachable: expected config preflight to fail");
}

const DEFAULT_PROVIDER = [`    repo: ${REPO}`, `    token: ${TOKEN}`];

// ---------------------------------------------------------------------------
// §17.3：candidate fetch（state + scope + 归一化 + dispatchable + 不越界过滤）
// ---------------------------------------------------------------------------

describe("端到端 candidate fetch：WORKFLOW.md → registry → adapter → REST fixture（§11.1 / §11.3 / §17.3）", () => {
  it("默认 api_url 与 profile 默认 states 下的完整请求面 + 全字段归一化", async () => {
    const payloads = [
      restIssue(12),
      // PR 与 issue 共用编号序列：candidate fetch MUST 仍把它带回来（§11.1
      // "must include dispatchable=false active issues"），过滤归 orchestrator。
      restIssue(13, { pull_request: { url: `https://github.com/${REPO}/pull/13` }, title: "Docs typo fix" }),
      restIssue(14, { labels: [{ name: "docs" }] }),
    ];
    const { kernel, server } = await kernelFrom(
      trackerFrontMatter(DEFAULT_PROVIDER, ["  required_labels:", "    - Agent"]),
      () => json(payloads),
    );

    const issues = await kernel.fetchIssuesByStates(["open"]);

    // 真实落在 stub 上的请求：生产默认 endpoint + scope path + §11.2 披露的查询面。
    expect(server.requests.map((request) => request.url)).toEqual([
      "/repos/acme/widget/issues?state=open&sort=created&direction=asc&per_page=100",
    ]);
    const request = server.requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers["accept"]).toBe("application/vnd.github+json");
    expect(request?.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(request?.headers["user-agent"]).toBe("symphony-ts/tracker");

    expect(issues).toEqual([
      expectedIssue(12),
      expectedIssue(13, { title: "Docs typo fix", dispatchable: false }),
      expectedIssue(14, { labels: ["docs"] }),
    ]);
  });

  it("required_labels 原样进 config、adapter 不做过滤（跨包边界：过滤归 coordination）", () => {
    writeWorkflow(
      trackerFrontMatter(DEFAULT_PROVIDER, ["  required_labels:", "    - Agent", "    - 安全"]),
    );
    const { serviceConfig } = loadWorkflow({});
    expect(serviceConfig.tracker.requiredLabels).toEqual(["Agent", "安全"]);
    expect(serviceConfig.tracker.activeStates).toBeNull();
    expect(serviceConfig.tracker.terminalStates).toBeNull();
    // provider 里没写 api_url：core 不回填 adapter-owned 默认值（§5.3.1 / §6.4）。
    expect(serviceConfig.tracker.provider["api_url"]).toBeUndefined();
  });

  it("显式 active/terminal states 经 GitHub 校验通过，双 state 请求走 state=all 且分页保序", async () => {
    const first = [restIssue(15), restIssue(16)];
    const second = [restIssue(17, { state: "closed" })];
    const nextUrl = `${API_URL}/repos/acme/widget/issues?state=all&sort=created&direction=asc&per_page=100&page=2`;
    const { kernel, server } = await kernelFrom(
      trackerFrontMatter(DEFAULT_PROVIDER, [
        "  active_states:",
        "    - Open",
        "  terminal_states:",
        "    - Closed",
      ]),
      pages(
        json(first, { Link: `<${nextUrl}>; rel="next"` }),
        "page=2",
        json(second),
      ),
      { env: {} },
    );

    // §4.2 的比较规则：大小写 / 空白变体都映射到同一个 GitHub state。
    const issues = await kernel.fetchIssuesByStates(["Open", "Closed"]);

    expect(issues.map((issue) => issue.id)).toEqual(["15", "16", "17"]);
    expect(server.requests.map((request) => request.url)).toEqual([
      "/repos/acme/widget/issues?state=all&sort=created&direction=asc&per_page=100",
      "/repos/acme/widget/issues?state=all&sort=created&direction=asc&per_page=100&page=2",
    ]);
  });

  it("非法 GitHub state 在 config preflight 即失败，且一次请求都不发", () => {
    const error = configErrorOf(() => {
      writeWorkflow(
        trackerFrontMatter(DEFAULT_PROVIDER, ["  active_states:", "    - In Progress"]),
      );
      loadWorkflow({});
    });
    expect(error.code).toBe("invalid_tracker_config");
    expect(error.message).toContain("not a GitHub Issues state");
    expect(error.path).toBe(workflowPath);
  });
});

// ---------------------------------------------------------------------------
// §17.1：两条延后项在端到端路径上的表现
// ---------------------------------------------------------------------------

describe("§17.1 的 tracker config 两行：端到端 preflight（§6.3 / §11.2）", () => {
  it("未注册的 kind 在 preflight 失败，message 披露 built-in 支持的 kinds", () => {
    expect(createTrackerAdapterRegistry().supportedKinds).toEqual(["github"]);

    const error = configErrorOf(() => {
      // built-in 注册表只认识 github：linear 是 issue 里点名的"未注册 provider"。
      writeWorkflow(["tracker:", "  kind: linear", "  provider:", `    repo: ${REPO}`, "    token: t"]);
      loadWorkflow({ GITHUB_TOKEN: "ghp_env" });
    });
    expect(error.code).toBe("unsupported_tracker_kind");
    expect(error.message).toContain('"github"');
  });

  it("token 的 $VAR 与 GITHUB_TOKEN fallback 都真的落到 Authorization 头", async () => {
    const fromVar = await kernelFrom(
      trackerFrontMatter([`    repo: ${REPO}`, "    token: $GITHUB_TOKEN"]),
      () => json([restIssue(31)]),
      { env: { GITHUB_TOKEN: "ghp_from_env" } },
    );
    await fromVar.kernel.fetchIssuesByStates(["open"]);
    expect(fromVar.server.requests[0]?.headers["authorization"]).toBe("Bearer ghp_from_env");

    const fromFallback = await kernelFrom(
      trackerFrontMatter([`    repo: ${REPO}`]),
      () => json([restIssue(32)]),
      { env: { GITHUB_TOKEN: "ghp_fallback" } },
    );
    await fromFallback.kernel.fetchIssuesByStates(["open"]);
    expect(fromFallback.server.requests[0]?.headers["authorization"]).toBe("Bearer ghp_fallback");
  });

  it("两处都取不到 token → preflight missing_tracker_secret，message 不回显任何凭据", () => {
    const error = configErrorOf(() => {
      writeWorkflow(trackerFrontMatter([`    repo: ${REPO}`]));
      loadWorkflow({ GITHUB_TOKEN: "" });
    });
    expect(error.code).toBe("missing_tracker_secret");
    expect(error.message).toContain("GITHUB_TOKEN");
  });

  it("明文 api_url 在 preflight 失败：端到端路径不为了本地 stub 放宽 HTTPS-only", async () => {
    const server = await startFixture(() => json([]));
    const error = configErrorOf(() => {
      writeWorkflow(
        trackerFrontMatter([`    repo: ${REPO}`, `    token: ${TOKEN}`, `    api_url: ${server.baseUrl}`]),
      );
      loadWorkflow({});
    });
    expect(error.code).toBe("invalid_tracker_config");
    expect(error.message).toContain("must use https://");
    expect(server.requests).toEqual([]);
  });

  it("GHES 形态的 https api_url 保留 path 前缀，分页 origin 守卫同样成立", async () => {
    const ghesApiUrl = "https://ghe.example.com/api/v3";
    const { kernel, server } = await kernelFrom(
      trackerFrontMatter([`    repo: ${REPO}`, `    token: ${TOKEN}`, `    api_url: ${ghesApiUrl}`]),
      pages(
        json([restIssue(41)], {
          Link: `<${ghesApiUrl}/repos/acme/widget/issues?state=open&sort=created&direction=asc&per_page=100&page=2>; rel="next"`,
        }),
        "page=2",
        json([restIssue(42)]),
      ),
      { apiUrl: ghesApiUrl },
    );

    const issues = await kernel.fetchIssuesByStates(["open"]);

    expect(issues.map((issue) => issue.identifier)).toEqual(["GH-41", "GH-42"]);
    expect(server.requests.map((request) => request.url)).toEqual([
      "/api/v3/repos/acme/widget/issues?state=open&sort=created&direction=asc&per_page=100",
      "/api/v3/repos/acme/widget/issues?state=open&sort=created&direction=asc&per_page=100&page=2",
    ]);
  });
});

// ---------------------------------------------------------------------------
// §17.3：ID refresh / malformed / 错误映射
// ---------------------------------------------------------------------------

describe("端到端 ID refresh 与 malformed-record 的两副面孔（§11.1 / §17.3）", () => {
  it("refresh 返回完整 normalized snapshot；已不可见的 ID 被省略而非伪造 state", async () => {
    const refreshed = restIssue(21, {
      labels: [{ name: "WIP" }],
      updated_at: "2026-09-28T15:30:00Z",
      body: "body of 21 (edited)",
    });
    const { kernel, server } = await kernelFrom(trackerFrontMatter(DEFAULT_PROVIDER), (request) =>
      request.url.includes("/issues/22")
        ? { status: 404, body: JSON.stringify({ message: "Not Found" }) }
        : json(refreshed),
    );

    const issues = await kernel.fetchIssuesByIds(["21", "22"]);

    expect(issues).toEqual([
      expectedIssue(21, {
        labels: ["wip"],
        description: "body of 21 (edited)",
        updatedAt: Date.parse("2026-09-28T15:30:00Z"),
      }),
    ]);
    expect(server.requests.map((request) => request.url)).toEqual([
      "/repos/acme/widget/issues/21",
      "/repos/acme/widget/issues/22",
    ]);
  });

  it("refresh 请求的 ID 自身 malformed → 整次调用失败；同一次列表读里坏记录只会被省略", async () => {
    const { kernel: refreshKernel } = await kernelFrom(
      trackerFrontMatter(DEFAULT_PROVIDER),
      () => json({ number: 23, state: "open" }), // 缺 title
    );
    const error = await rejectionOf(() => refreshKernel.fetchIssuesByIds(["23"]));
    expect(error.category).toBe("tracker_response");
    expect(error.message).toContain("Malformed GitHub issue payload");

    const malformedRecord = restIssue(24, { title: "" });
    const captured: GitHubMalformedRecord[] = [];
    const { kernel: listKernel } = await kernelFrom(
      trackerFrontMatter(DEFAULT_PROVIDER),
      () => json([restIssue(25), malformedRecord]),
      { onMalformedRecord: (record) => captured.push(record) },
    );
    const issues = await listKernel.fetchIssuesByStates(["open"]);

    expect(issues).toEqual([expectedIssue(25)]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.operation).toBe("fetchIssuesByStates");
    expect(captured[0]?.reason).toContain("`title` is missing");
  });
});

describe("端到端 §11.4 错误面：读取期失败不被改写成 config 错误、也不泄漏 token", () => {
  it("401 → tracker_status（providerStatus + GitHub message，不可重试）", async () => {
    const { kernel } = await kernelFrom(trackerFrontMatter(DEFAULT_PROVIDER), () => ({
      status: 401,
      body: JSON.stringify({ message: "Bad credentials" }),
    }));

    const error = await rejectionOf(() => kernel.fetchIssuesByStates(["open"]));

    expect(error.category).toBe("tracker_status");
    expect(error.providerStatus).toBe(401);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("Bad credentials");
    expect(error.message).not.toContain(TOKEN);
  });

  it("429 + Retry-After → tracker_rate_limited（retryable + retryAfterMs 交给上层节奏）", async () => {
    const { kernel } = await kernelFrom(trackerFrontMatter(DEFAULT_PROVIDER), () => ({
      status: 429,
      body: JSON.stringify({ message: "API rate limit exceeded" }),
      headers: { "retry-after": "5" },
    }));

    const error = await rejectionOf(() => kernel.fetchIssuesByStates(["open"]));

    expect(error.category).toBe("tracker_rate_limited");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(5_000);
    expect(error.message).not.toContain(TOKEN);
  });

  it("空 states / 空 ID 列表在整条链路上零请求（§11.1 MUST）", async () => {
    const { kernel, server } = await kernelFrom(trackerFrontMatter(DEFAULT_PROVIDER), () => json([]));

    await expect(kernel.fetchIssuesByStates([])).resolves.toEqual([]);
    await expect(kernel.fetchIssuesByIds([])).resolves.toEqual([]);
    expect(server.requests).toEqual([]);
  });
});

