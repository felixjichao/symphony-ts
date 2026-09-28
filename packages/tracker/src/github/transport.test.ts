/**
 * GitHub REST transport 测试（Core Conformance，SPEC §11.1 scope selection /
 * pagination、§11.4 error mapping、§17.3 Issue Tracker Adapter，NEST-56 / #20）。
 *
 * 走**真实 HTTP**：被测 transport 用注入的 fetch 打到一个本地
 * `http.createServer` 起的 GitHub REST stub（`github-rest-fixture.ts`），不 mock
 * 自己的 adapter（docs/testing.md 哲学 2）。断言面是"世界的变化"：请求的
 * method / path / query / headers，与返回的 payload 序列、抛出的 `TrackerError`
 * category——不是内部调用计数。
 *
 * import 面按 docs/testing.md 哲学 3：被测行为经包公共出口 `../index`。
 */
import { afterEach, describe, expect, it } from "vitest";

import { TrackerError, GitHubTrackerAdapter, createGitHubIssueTransport } from "../index";
import type { GitHubIssueTransport, GitHubMalformedRecord } from "../index";
import type { GitHubProviderConfig } from "./config";
import { startGitHubRestFixture } from "./github-rest-fixture";
import type { GitHubRestFixture, StubResponse } from "./github-rest-fixture";

const TOKEN = "ghp_S3cretValue";

function issue(number: number, state = "open"): unknown {
  return { id: 1000 + number, node_id: `I_${number}`, number, title: `t${number}`, state };
}

function providerConfig(overrides: Partial<GitHubProviderConfig> = {}): GitHubProviderConfig {
  return { repo: "acme/widget", token: TOKEN, apiUrl: "https://api.github.com", ...overrides };
}

const openServers: GitHubRestFixture[] = [];

/** 起一个 stub server，返回指向它的 transport、provider 配置与 server 本体。 */
async function withFixture(
  handler: (request: { url: string; server: GitHubRestFixture }) => StubResponse,
  config: Partial<GitHubProviderConfig> & { apiUrlSuffix?: string } = {},
): Promise<{
  transport: GitHubIssueTransport;
  provider: GitHubProviderConfig;
  server: GitHubRestFixture;
}> {
  // handler 在 server 启动后才第一次被调用，因此可以安全回指 server 本身
  // （Link header 里的分页 URL 需要它的 baseUrl）。
  const holder: { server: GitHubRestFixture } = { server: undefined as unknown as GitHubRestFixture };
  const server = await startGitHubRestFixture((request) =>
    handler({ url: request.url, server: holder.server }),
  );
  holder.server = server;
  openServers.push(server);
  const { apiUrlSuffix, ...providerOverrides } = config;
  const provider = providerConfig({
    ...providerOverrides,
    apiUrl: server.baseUrl + (apiUrlSuffix ?? ""),
  });
  const transport = createGitHubIssueTransport(provider, {
    fetchImpl: (input, init) => server.fetch(input, init),
  });
  return { transport, provider, server };
}

afterEach(async () => {
  const servers = openServers.splice(0);
  for (const server of servers) {
    await server.close();
  }
});

async function rejectionOf(run: () => Promise<unknown>): Promise<TrackerError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(TrackerError);
    return error as TrackerError;
  }
  throw new Error("unreachable: expected the transport to fail");
}

/** 按 URL 前缀路由的响应表。 */
function routing(
  entries: ReadonlyArray<[string, StubResponse]>,
  fallback: StubResponse = { status: 404, body: "{}" },
): (request: { url: string; server: GitHubRestFixture }) => StubResponse {
  return (request) => {
    for (const [pattern, response] of entries) {
      if (request.url.startsWith(pattern)) {
        return response;
      }
    }
    return fallback;
  };
}

/** 带 `rel="next"` 的第一页响应（next 指向本 fixture 的第 page 页）。 */
function firstPageWithNext(items: readonly unknown[], page: number) {
  return ({ server }: { server: GitHubRestFixture }): StubResponse => ({
    status: 200,
    body: JSON.stringify(items),
    headers: { Link: `<${server.baseUrl}/repos/acme/widget/issues?page=${page}>; rel="next"` },
  });
}

describe("fetchPayloadsByStates — endpoint / auth / scope（§11.2 / §17.3）", () => {
  it("单一 state 的完整请求面：GET + scoped repo path + state/sort/direction/per_page + 四个头", async () => {
    const { transport, server } = await withFixture(
      routing([["/repos/acme/widget/issues", { status: 200, body: JSON.stringify([issue(1)]) }]]),
    );

    await expect(transport.fetchPayloadsByStates(["open"])).resolves.toEqual([issue(1)]);

    const request = server.requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.url).toBe(
      "/repos/acme/widget/issues?state=open&sort=created&direction=asc&per_page=100",
    );
    expect(request?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers["accept"]).toBe("application/vnd.github+json");
    expect(request?.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(request?.headers["user-agent"]).toBe("symphony-ts/tracker");
  });

  it("GHES：api_url 的 path 前缀保留在 /repos 之前", async () => {
    const { transport, server } = await withFixture(
      routing([
        ["/api/v3/repos/acme/widget/issues", { status: 200, body: JSON.stringify([issue(1)]) }],
      ]),
      { apiUrlSuffix: "/api/v3" },
    );
    await expect(transport.fetchPayloadsByStates(["open"])).resolves.toEqual([issue(1)]);
    expect(server.requests[0]?.url).toBe(
      "/api/v3/repos/acme/widget/issues?state=open&sort=created&direction=asc&per_page=100",
    );
  });

  it("repo 逐段编码后拼进 path，scope 固定为配置的 owner/repo", async () => {
    const { transport, server } = await withFixture(
      routing([["/repos/acme.dev/my.widget/issues", { status: 200, body: "[]" }]]),
      { repo: "acme.dev/my.widget" },
    );
    await transport.fetchPayloadsByStates(["open"]);
    expect(server.requests[0]?.url).toContain("/repos/acme.dev/my.widget/issues?state=open");
  });

  it("同时请求 open+closed → state=all，且结果仍 ⊆ requested state set", async () => {
    const noState = { number: 3, title: "t3" };
    const items = [issue(1, "open"), issue(2, "closed"), issue(4, "merged"), noState];
    const { transport, server } = await withFixture(
      routing([["/repos/acme/widget/issues", { status: 200, body: JSON.stringify(items) }]]),
    );
    // state=all 只在请求集 == GitHub 值域时发出，所以过滤在真实响应上是 no-op；
    // 这里断言的是"结果 ⊆ 请求集"这条不变量**不依赖请求怎么发**。
    await expect(transport.fetchPayloadsByStates(["open", "closed"])).resolves.toEqual([
      issue(1, "open"),
      issue(2, "closed"),
      noState,
    ]);
    expect(server.requests[0]?.url).toContain("state=all");
  });

  it("requested states trim + lowercase 后映射（大小写 / 空白变体不产生额外请求形状）", async () => {
    const { transport, server } = await withFixture(
      routing([
        ["/repos/acme/widget/issues?state=all", { status: 200, body: JSON.stringify([issue(1), issue(2, "closed")]) }],
        ["/repos/acme/widget/issues?state=open", { status: 200, body: JSON.stringify([issue(1)]) }],
        ["/repos/acme/widget/issues?state=closed", { status: 200, body: JSON.stringify([issue(2, "closed")]) }],
      ]),
    );
    await transport.fetchPayloadsByStates([" Closed ", "OPEN"]);
    expect(server.requests[0]?.url).toContain("state=all");
    await expect(transport.fetchPayloadsByStates(["Open"])).resolves.toEqual([issue(1)]);
    expect(server.requests[1]?.url).toContain("state=open");
    await expect(transport.fetchPayloadsByStates([" closed"])).resolves.toEqual([issue(2, "closed")]);
    expect(server.requests[2]?.url).toContain("state=closed");
  });

  it("PR 记录留在 candidate read 结果里（dispatchable=false 由 normalize 判定，不属 transport）", async () => {
    const pr = { number: 9, title: "pr", state: "open", pull_request: { url: "https://api.github.com/x" } };
    const { transport } = await withFixture(
      routing([["/repos/acme/widget/issues", { status: 200, body: JSON.stringify([pr]) }]]),
    );
    await expect(transport.fetchPayloadsByStates(["open"])).resolves.toEqual([pr]);
  });

  it("无 GitHub-supported state 时直接返回 []，零 provider 请求", async () => {
    const { transport, server } = await withFixture(() => {
      throw new Error("unreachable: a non-mappable state set must not hit the network");
    });
    await expect(transport.fetchPayloadsByStates(["In Progress", ""])).resolves.toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it("单一 state 的结果仍按 requested state set 过滤（provider 混入其他 state 不外溢）", async () => {
    const { transport } = await withFixture(
      routing([
        [
          "/repos/acme/widget/issues",
          {
            status: 200,
            body: JSON.stringify([issue(1, "open"), issue(2, "closed"), issue(3, "open")]),
          },
        ],
      ]),
    );
    await expect(transport.fetchPayloadsByStates(["open"])).resolves.toEqual([
      issue(1, "open"),
      issue(3, "open"),
    ]);
  });

  it("state-list 的 404 不吞掉：unexpected status → tracker_status", async () => {
    const { transport } = await withFixture(() => ({
      status: 404,
      body: JSON.stringify({ message: "Not Found" }),
    }));
    const error = await rejectionOf(() => transport.fetchPayloadsByStates(["open"]));
    expect(error.category).toBe("tracker_status");
    expect(error.providerStatus).toBe(404);
  });

  it("非数组的列表 payload → tracker_response（整个 operation 失败）", async () => {
    const { transport } = await withFixture(() => ({ status: 200, body: JSON.stringify({ message: "oops" }) }));
    const error = await rejectionOf(() => transport.fetchPayloadsByStates(["open"]));
    expect(error.category).toBe("tracker_response");
    expect(error.retryable).toBe(false);
  });
});

describe("fetchPayloadsByStates — pagination（§11.1 / §17.3）", () => {
  it("逐页读取 Link rel=\"next\"，保持 provider 返回顺序", async () => {
    const { transport, server } = await withFixture((request) =>
      request.url.includes("page=2")
        ? { status: 200, body: JSON.stringify([issue(3)]) }
        : firstPageWithNext([issue(1), issue(2)], 2)(request),
    );

    const payloads = await transport.fetchPayloadsByStates(["open"]);
    expect(payloads).toEqual([issue(1), issue(2), issue(3)]);
    expect(server.requests.map((r) => r.url)).toEqual([
      "/repos/acme/widget/issues?state=open&sort=created&direction=asc&per_page=100",
      "/repos/acme/widget/issues?page=2",
    ]);
  });

  it("分页 URL 的 query 含逗号也不影响 Link 解析（不按逗号 split）", async () => {
    const { transport, server } = await withFixture(({ server }) => {
      if (server.requests.length > 1) {
        return { status: 200, body: JSON.stringify([issue(7)]) };
      }
      return {
        status: 200,
        body: "[]",
        headers: { Link: `<${server.baseUrl}/repos/acme/widget/issues?labels=a,b>; rel="next"` },
      };
    });
    await expect(transport.fetchPayloadsByStates(["open"])).resolves.toEqual([issue(7)]);
    expect(server.requests).toHaveLength(2);
  });

  it("中间页失败 → 整个 operation 失败，第一页的成功不产出部分结果", async () => {
    const { transport, server } = await withFixture((request) => {
      if (request.url.includes("page=2")) {
        return { status: 500, body: JSON.stringify({ message: "boom" }) };
      }
      return firstPageWithNext([issue(1)], 2)(request);
    });
    const error = await rejectionOf(() => transport.fetchPayloadsByStates(["open"]));
    expect(error.category).toBe("tracker_status");
    expect(error.providerStatus).toBe(500);
    expect(server.requests).toHaveLength(2);
  });

  it("中间页 payload 语义非法（非数组）同样使整个 operation 失败", async () => {
    const { transport, server } = await withFixture((request) =>
      request.url.includes("page=2")
        ? { status: 200, body: JSON.stringify({ message: "not a list" }) }
        : firstPageWithNext([issue(1)], 2)(request),
    );
    const error = await rejectionOf(() => transport.fetchPayloadsByStates(["open"]));
    expect(error.category).toBe("tracker_response");
    expect(server.requests).toHaveLength(2);
  });

  it("Link header 读不懂 → tracker_pagination（分页完整性失败）", async () => {
    const { transport } = await withFixture(() => ({
      status: 200,
      body: "[]",
      headers: { Link: "garbage-rel=" },
    }));
    const error = await rejectionOf(() => transport.fetchPayloadsByStates(["open"]));
    expect(error.category).toBe("tracker_pagination");
  });

  it("next 指向配置 origin 之外 → tracker_pagination，且绝不向该 URL 发请求", async () => {
    const { transport, server } = await withFixture(() => ({
      status: 200,
      body: "[]",
      headers: { Link: `<https://evil.example.com/repos/acme/widget/issues?page=2>; rel="next"` },
    }));
    const error = await rejectionOf(() => transport.fetchPayloadsByStates(["open"]));
    expect(error.category).toBe("tracker_pagination");
    expect(server.requests).toHaveLength(1);
  });
});

describe("fetchPayloadsByIds — ID refresh（§11.1.2 / §17.3）", () => {
  it("repository-scoped issue endpoint 刷新完整 snapshot", async () => {
    const snapshot = issue(12, "closed");
    const { transport, server } = await withFixture(
      routing([["/repos/acme/widget/issues/12", { status: 200, body: JSON.stringify(snapshot) }]]),
    );

    await expect(transport.fetchPayloadsByIds(["12"])).resolves.toEqual([snapshot]);
    expect(server.requests[0]?.url).toBe("/repos/acme/widget/issues/12");
    expect(server.requests[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("PR 的 ID refresh 同样返回 snapshot（pull_request 字段保留，供 normalize 判 dispatchable=false）", async () => {
    const pr = { number: 44, title: "pr", state: "open", pull_request: { merged_at: null } };
    const { transport } = await withFixture(
      routing([["/repos/acme/widget/issues/44", { status: 200, body: JSON.stringify(pr) }]]),
    );
    await expect(transport.fetchPayloadsByIds(["44"])).resolves.toEqual([pr]);
  });

  it("多条 ID 按入参顺序逐条请求", async () => {
    const { transport, server } = await withFixture((request) => {
      const number = Number(request.url.split("/").pop());
      return { status: 200, body: JSON.stringify({ number, title: "t", state: "open" }) };
    });
    const payloads = await transport.fetchPayloadsByIds(["3", "1", "2"]);
    expect(payloads.map((p) => (p as { number: number }).number)).toEqual([3, 1, 2]);
    expect(server.requests.map((r) => r.url)).toEqual([
      "/repos/acme/widget/issues/3",
      "/repos/acme/widget/issues/1",
      "/repos/acme/widget/issues/2",
    ]);
  });

  it("404（hidden / deleted / out-of-scope）直接 omit，不构造 synthetic state", async () => {
    const { transport, server } = await withFixture((request) =>
      request.url.endsWith("/1")
        ? { status: 200, body: JSON.stringify(issue(1)) }
        : { status: 404, body: JSON.stringify({ message: "Not Found" }) },
    );
    const payloads = await transport.fetchPayloadsByIds(["1", "999"]);
    expect(payloads).toEqual([issue(1)]);
    // 两条都真实发了请求——omit 是响应语义，不是跳过请求。
    expect(server.requests).toHaveLength(2);
  });

  it("非 404 的失败 status 使整个 refresh 失败，已读成功的第一条不产出部分结果", async () => {
    const { transport, server } = await withFixture((request) =>
      request.url.endsWith("/2")
        ? { status: 403, body: JSON.stringify({ message: "Forbidden" }) }
        : { status: 200, body: JSON.stringify(issue(1)) },
    );
    const error = await rejectionOf(() => transport.fetchPayloadsByIds(["1", "2", "3"]));
    expect(error.category).toBe("tracker_status");
    expect(error.providerStatus).toBe(403);
    expect(error.retryable).toBe(false);
    expect(server.requests.map((r) => r.url)).toEqual([
      "/repos/acme/widget/issues/1",
      "/repos/acme/widget/issues/2",
    ]);
  });

  it("空 ID 列表零 provider 请求（transport 侧的 fast path）", async () => {
    const { transport, server } = await withFixture(() => {
      throw new Error("unreachable: an empty ID list must not hit the network");
    });
    await expect(transport.fetchPayloadsByIds([])).resolves.toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it("malformed dispatch ID（非正整数字符串）→ 整个 refresh call 失败，不静默 omit、不发请求", async () => {
    const { transport, server } = await withFixture(() => ({ status: 200, body: "{}" }));
    for (const id of ["0", "-3", "abc", "1.5", "", " 7"]) {
      const error = await rejectionOf(() => transport.fetchPayloadsByIds([id]));
      expect(error.category).toBe("tracker_response");
      expect(error.message).toContain(JSON.stringify(id));
    }
    // 列表里混进一个坏 ID 也是整调用失败。
    await rejectionOf(() => transport.fetchPayloadsByIds(["7", "nope"]));
    expect(server.requests).toEqual([]);
  });

  it("ID endpoint 返回数组 → tracker_response", async () => {
    const { transport } = await withFixture(() => ({ status: 200, body: "[]" }));
    const error = await rejectionOf(() => transport.fetchPayloadsByIds(["5"]));
    expect(error.category).toBe("tracker_response");
  });
});

describe("§11.4 portable error mapping", () => {
  it("transport failure → tracker_request（retryable=true + cause 保留底层异常），message 不含 token", async () => {
    // fetchImpl 直接抛异常：这条测的是 fetch reject 的映射，不需要真 server
    // （且 providerConfig() 的 api.github.com 因此永不被访问）。
    const broken = createGitHubIssueTransport(providerConfig(), {
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const error = await rejectionOf(() => broken.fetchPayloadsByStates(["open"]));
    expect(error.category).toBe("tracker_request");
    expect(error.retryable).toBe(true);
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(error.message).not.toContain(TOKEN);
  });

  it("5xx → tracker_status（providerStatus + GitHub message + retryable=true）", async () => {
    const { transport } = await withFixture(() => ({
      status: 500,
      body: JSON.stringify({ message: "Internal Server Error" }),
    }));
    const error = await rejectionOf(() => transport.fetchPayloadsByStates(["open"]));
    expect(error.category).toBe("tracker_status");
    expect(error.providerStatus).toBe(500);
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("500");
    expect((error.providerDetail as { message: string }).message).toBe("Internal Server Error");
  });

  it("401 → tracker_status 且 retryable=false（鉴权失败重试无益）", async () => {
    const { transport } = await withFixture(() => ({
      status: 401,
      body: JSON.stringify({ message: "Bad credentials" }),
    }));
    const error = await rejectionOf(() => transport.fetchPayloadsByStates(["open"]));
    expect(error.category).toBe("tracker_status");
    expect(error.retryable).toBe(false);
  });

  it("429 + Retry-After → tracker_rate_limited（retryAfterMs 取 retry-after 秒数）", async () => {
    const { transport } = await withFixture(() => ({
      status: 429,
      body: JSON.stringify({ message: "Too Many Requests" }),
      headers: { "retry-after": "30", "x-ratelimit-remaining": "0" },
    }));
    const error = await rejectionOf(() => transport.fetchPayloadsByStates(["open"]));
    expect(error.category).toBe("tracker_rate_limited");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.providerStatus).toBe(429);
  });

  it("403 + x-ratelimit-remaining: 0（secondary limit）→ tracker_rate_limited，retryAfterMs 从 x-ratelimit-reset 推算", async () => {
    const resetEpochSeconds = Math.floor(Date.now() / 1000) + 60;
    const { transport } = await withFixture(() => ({
      status: 403,
      body: JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetEpochSeconds) },
    }));
    const error = await rejectionOf(() => transport.fetchPayloadsByStates(["open"]));
    expect(error.category).toBe("tracker_rate_limited");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBeGreaterThan(58_000);
    expect(error.retryAfterMs!).toBeLessThanOrEqual(60_000);
    expect(error.providerStatus).toBe(403);
  });

  it("403 + Retry-After（secondary limit 的常见形状，不带 x-ratelimit-remaining）→ tracker_rate_limited", async () => {
    const { transport } = await withFixture(() => ({
      status: 403,
      body: JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
      headers: { "retry-after": "120", "x-ratelimit-remaining": "42" },
    }));
    const error = await rejectionOf(() => transport.fetchPayloadsByStates(["open"]));
    expect(error.category).toBe("tracker_rate_limited");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(120_000);
    expect(error.providerStatus).toBe(403);
  });

  it("Retry-After 写成 HTTP-date（RFC 9110 允许）也能解出等待时长", async () => {
    const at = new Date(Date.now() + 90_000).toUTCString();
    const { transport } = await withFixture(() => ({
      status: 429,
      body: JSON.stringify({ message: "Too Many Requests" }),
      headers: { "retry-after": at },
    }));
    const error = await rejectionOf(() => transport.fetchPayloadsByStates(["open"]));
    expect(error.category).toBe("tracker_rate_limited");
    expect(error.retryAfterMs!).toBeGreaterThan(60_000);
    expect(error.retryAfterMs!).toBeLessThanOrEqual(90_000);
  });

  it("Retry-After 读不懂时回落 x-ratelimit-reset，两者都读不出则不带 retryAfterMs", async () => {
    const unparseable = await withFixture(() => ({
      status: 429,
      body: "{}",
      headers: { "retry-after": "someday", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 30) },
    }));
    expect((await rejectionOf(() => unparseable.transport.fetchPayloadsByStates(["open"]))).retryAfterMs).toBeGreaterThan(0);

    const unreadable = await withFixture(() => ({
      status: 429,
      body: "{}",
      headers: { "retry-after": "someday" },
    }));
    expect(
      (await rejectionOf(() => unreadable.transport.fetchPayloadsByStates(["open"]))).retryAfterMs,
    ).toBeUndefined();
  });

  it("成功响应不受限流头影响（rate-limit 分支只覆盖非成功 status）", async () => {
    const { transport } = await withFixture(() => ({
      status: 200,
      body: JSON.stringify([issue(1)]),
      headers: { "x-ratelimit-remaining": "0" },
    }));
    await expect(transport.fetchPayloadsByStates(["open"])).resolves.toEqual([issue(1)]);
  });

  it("无效 JSON → tracker_response（retryable=false + cause）", async () => {
    const { transport } = await withFixture(() => ({ status: 200, body: "{not-json" }));
    const error = await rejectionOf(() => transport.fetchPayloadsByStates(["open"]));
    expect(error.category).toBe("tracker_response");
    expect(error.retryable).toBe(false);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("ID refresh 的 transport failure 同为 tracker_request", async () => {
    const broken = createGitHubIssueTransport(providerConfig(), {
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    const error = await rejectionOf(() => broken.fetchPayloadsByIds(["1"]));
    expect(error.category).toBe("tracker_request");
    expect(error.message).not.toContain(TOKEN);
  });
});

describe("§17.3 端到端：真实 HTTP → transport → adapter 归一化", () => {
  /** 把 REST transport 接上真实 adapter，验证两层合起来对世界的输出。 */
  async function adapterReading(
    handler: (request: { url: string; server: GitHubRestFixture }) => StubResponse,
    onMalformedRecord?: (record: GitHubMalformedRecord) => void,
  ) {
    const { server, provider, transport } = await withFixture(handler);
    const adapter = new GitHubTrackerAdapter({
      provider,
      transport,
      onMalformedRecord,
    });
    return { adapter, server };
  }

  it("candidate read 保留 scoped PR 记录但标 dispatchable=false，普通 issue 为 true", async () => {
    const { adapter, server } = await adapterReading(
      routing([
        [
          "/repos/acme/widget/issues",
          {
            status: 200,
            body: JSON.stringify([
              { id: 1001, node_id: "I_1", number: 1, title: "issue", state: "open" },
              { number: 2, title: "pr", state: "open", pull_request: { url: "x" } },
            ]),
          },
        ],
      ]),
    );

    const issues = await adapter.fetchIssuesByStates(["open"]);
    expect(issues.map((i) => [i.identifier, i.dispatchable])).toEqual([
      ["GH-1", true],
      ["GH-2", false],
    ]);
    // native_ref 保留 provider 侧的 REST id / node_id（§17.3 distinct ID 一条）。
    expect(issues[0]?.nativeRef).toMatchObject({ repo: "acme/widget", number: 1, id: 1001, node_id: "I_1" });
    expect(server.requests).toHaveLength(1);
  });

  it("state-list 省略单条 malformed 记录并回调 omission 事件；ID refresh 对同一条以 tracker_response 失败", async () => {
    const omitted: { operation: string; reason: string }[] = [];
    const { adapter } = await adapterReading(
      () => ({
        status: 200,
        // 第二条缺 title → malformed（§11.1 required 面）。
        body: JSON.stringify([{ number: 1, title: "ok", state: "open" }, { number: 2, state: "open" }]),
      }),
      (record) => omitted.push({ operation: record.operation, reason: record.reason }),
    );

    const issues = await adapter.fetchIssuesByStates(["open"]);
    expect(issues.map((i) => i.identifier)).toEqual(["GH-1"]);
    expect(omitted).toHaveLength(1);
    expect(omitted[0]?.operation).toBe("fetchIssuesByStates");
    expect(omitted[0]?.reason).toContain("title");

    const error = await rejectionOf(() => adapter.fetchIssuesByIds(["2"]));
    expect(error.category).toBe("tracker_response");
  });

  it("ID refresh 对 404 的 ID 走 omission，其余返回完整 snapshot", async () => {
    const { adapter } = await adapterReading((request) =>
      request.url.endsWith("/1")
        ? {
            status: 200,
            body: JSON.stringify({
              number: 1,
              title: "still here",
              state: "closed",
              labels: [{ name: "Bug " }],
              pull_request: undefined,
            }),
          }
        : { status: 404, body: JSON.stringify({ message: "Not Found" }) },
    );

    const issues = await adapter.fetchIssuesByIds(["1", "999"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      id: "1",
      identifier: "GH-1",
      title: "still here",
      state: "closed",
      labels: ["bug"],
      dispatchable: true,
    });
  });
});
