/**
 * §11.1 read kernel 测试（Core Conformance，SPEC §17.3 前两条 MUST：
 * "Empty `fetch_issues_by_states([])` returns empty without a provider call" /
 * "Empty `fetch_issues_by_ids([])` returns empty without a provider call"）。
 *
 * 这里的 fake adapter 模拟 provider 端口：它记录自己被要求发起的 provider 请求，
 * 于是"零 provider 请求"是**外部可观察**的事实（docs/testing.md 哲学 1），而不是
 * 内核自我声明。非空输入则断言 normalized `Issue` 原样透出、provider payload
 * 不越界（§11.2 / §11.3）。
 */
import { describe, expect, it } from "vitest";

import type { Issue } from "@symphony/domain";

import { createTrackerReadKernel, TrackerError } from "./index";
import type { TrackerAdapter } from "./index";

/** provider payload：故意带上不该越过 adapter 边界的字段。 */
interface FakePayload {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly body_html: string;
  readonly internal_etag: string;
}

const PAYLOADS: readonly FakePayload[] = [
  {
    number: 7,
    title: "Support empty state lists",
    status: "In Progress",
    body_html: "<p>secret-ish html</p>",
    internal_etag: "W/abc",
  },
  {
    number: 8,
    title: "Refresh by dispatch id",
    status: "Need Review",
    body_html: "<p>more html</p>",
    internal_etag: "W/def",
  },
];

/** §11.3 的 normalized 记录：字段全部在场，nullable 用 null、collection 用空数组。 */
function normalize(payload: FakePayload): Issue {
  return {
    id: `fake:${payload.number}`,
    nativeRef: { issue_number: payload.number },
    identifier: `FAKE-${payload.number}`,
    title: payload.title,
    description: null,
    priority: null,
    state: payload.status,
    branchName: null,
    url: null,
    assigneeId: null,
    labels: [],
    blockedBy: [],
    dispatchable: true,
    createdAt: null,
    updatedAt: null,
  };
}

/** 记录 provider 请求的 fake adapter（真实 provider 的 scope / 分页归 #19）。 */
function createFakeAdapter(): TrackerAdapter & { readonly requests: readonly string[] } {
  const requests: string[] = [];
  const adapter: TrackerAdapter & { readonly requests: readonly string[] } = {
    kind: "fake",
    requests,
    fetchIssuesByStates: async (stateNames) => {
      requests.push(`states:${stateNames.join("|")}`);
      return PAYLOADS.filter((payload) =>
        stateNames.some((name) => name.toLowerCase() === payload.status.toLowerCase()),
      ).map(normalize);
    },
    fetchIssuesByIds: async (issueIds) => {
      requests.push(`ids:${issueIds.join("|")}`);
      return PAYLOADS.filter((payload) =>
        issueIds.includes(`fake:${payload.number}`),
      ).map(normalize);
    },
  };
  return adapter;
}

describe("createTrackerReadKernel — 空输入零 provider 请求（§11.1 MUST）", () => {
  it("fetchIssuesByStates([]) 返回空结果且完全不请求 provider", async () => {
    const fake = createFakeAdapter();
    const kernel = createTrackerReadKernel(fake);

    await expect(kernel.fetchIssuesByStates([])).resolves.toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  it("fetchIssuesByIds([]) 返回空结果且完全不请求 provider", async () => {
    const fake = createFakeAdapter();
    const kernel = createTrackerReadKernel(fake);

    await expect(kernel.fetchIssuesByIds([])).resolves.toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  it("空输入的结果是共享的冻结实例，调用方误改不会污染下次调用", async () => {
    const kernel = createTrackerReadKernel(createFakeAdapter());
    const first = await kernel.fetchIssuesByStates([]);
    expect(Object.isFrozen(first)).toBe(true);
    await expect(kernel.fetchIssuesByIds([])).resolves.toBe(first);
  });

  it("两个 operation 恒返回 Promise（§11.1 的实现是网络 transport）", () => {
    const kernel = createTrackerReadKernel(createFakeAdapter());
    expect(kernel.fetchIssuesByStates([])).toBeInstanceOf(Promise);
    expect(kernel.fetchIssuesByIds([])).toBeInstanceOf(Promise);
  });
});

describe("createTrackerReadKernel — 非空输入透传 normalized Issue", () => {
  it("按 state 取候选：请求一次 provider，返回 provider 拼写保留的 Issue", async () => {
    const fake = createFakeAdapter();
    const kernel = createTrackerReadKernel(fake);

    const issues = await kernel.fetchIssuesByStates(["in progress"]);

    expect(fake.requests).toEqual(["states:in progress"]);
    expect(issues.map((issue) => issue.identifier)).toEqual(["FAKE-7"]);
    // §11.3：state 保留 provider 拼写，归一化只发生在比较侧。
    expect(issues[0]?.state).toBe("In Progress");
  });

  it("按 dispatch ID 刷新：返回完整 snapshot，scope 外的 ID 被省略而非伪造", async () => {
    const fake = createFakeAdapter();
    const kernel = createTrackerReadKernel(fake);

    const issues = await kernel.fetchIssuesByIds(["fake:8", "fake:gone"]);

    expect(fake.requests).toEqual(["ids:fake:8|fake:gone"]);
    expect(issues.map((issue) => issue.identifier)).toEqual(["FAKE-8"]);
    expect(issues[0]).toMatchObject({
      id: "fake:8",
      title: "Refresh by dispatch id",
      dispatchable: true,
    });
  });

  it("结果只含 §4.1.1 的 Issue 字段，provider payload 不越界（§11.2）", async () => {
    const kernel = createTrackerReadKernel(createFakeAdapter());

    const issues = await kernel.fetchIssuesByStates(["In Progress", "Need Review"]);

    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      expect(Object.keys(issue).sort()).toEqual(
        [
          "assigneeId",
          "blockedBy",
          "branchName",
          "createdAt",
          "description",
          "dispatchable",
          "id",
          "identifier",
          "labels",
          "nativeRef",
          "priority",
          "state",
          "title",
          "updatedAt",
          "url",
        ].sort(),
      );
      // provider 原生 payload 的字段名不得出现在 normalized 记录上。
      expect(issue).not.toHaveProperty("body_html");
      expect(issue).not.toHaveProperty("internal_etag");
      expect(issue).not.toHaveProperty("number");
    }
  });

  it("kernel 保留 kind 供诊断与 observability 使用", () => {
    expect(createTrackerReadKernel(createFakeAdapter()).kind).toBe("fake");
  });

  it("adapter 抛出的 TrackerError 原样透传（内核不吞错、不改类别）", async () => {
    const failure = new TrackerError("tracker_status", "provider returned 503", {
      retryable: true,
      providerStatus: 503,
    });
    const kernel = createTrackerReadKernel({
      kind: "fake",
      fetchIssuesByStates: async () => {
        throw failure;
      },
      fetchIssuesByIds: async () => [],
    });

    await expect(kernel.fetchIssuesByStates(["Any"])).rejects.toBe(failure);
  });
});
