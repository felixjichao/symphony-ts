/**
 * GitHub payload → normalized `Issue` 测试（Core Conformance，SPEC §4.1.1 /
 * §11.1 malformed-record / §11.3，NEST-55 验收"归一化测试覆盖
 * required/nullables/nativeRef/labels/timestamps/PR dispatchability"）。
 *
 * fixture 是 GitHub REST `GET /repos/{owner}/{repo}/issues` 返回值的真实形状
 * （下划线键名、`assignee` 对象、`labels` 对象数组、RFC 3339 时间戳）。
 * docs/testing.md 哲学 1：断言归一化后的**外部结果**，不检查中间函数是否被调用。
 */
import { describe, expect, it } from "vitest";

import { TrackerError, normalizeGitHubIssue } from "../index";

/** 一条普通 issue 的完整 payload（`pull_request` 缺席 = 可派发）。 */
function issuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 2300100200,
    node_id: "I_kwDOxxxxx5v7kQ",
    number: 812,
    title: "Add GitHub Issues adapter",
    body: "Implement §11.2 profile and §11.3 normalization.",
    state: "open",
    html_url: "https://github.com/acme/widget/issues/812",
    assignee: { login: "octocat", id: 583231 },
    labels: [{ name: "agent" }, { name: "  Need Review " }, { name: "agent" }],
    created_at: "2026-09-27T14:09:15Z",
    updated_at: "2026-09-27T15:07:35Z",
    ...overrides,
  };
}

/** 取出归一化失败的 TrackerError（§11.4 判别式 = category）。 */
function normalizeError(payload: unknown): TrackerError {
  try {
    normalizeGitHubIssue(payload, "acme/widget");
  } catch (error) {
    expect(error).toBeInstanceOf(TrackerError);
    return error as TrackerError;
  }
  throw new Error("unreachable: expected normalization to fail");
}

describe("normalizeGitHubIssue — required 字段（§11.3）", () => {
  it("完整 payload → §4.1.1 全部字段在场", () => {
    const issue = normalizeGitHubIssue(issuePayload(), "acme/widget");

    expect(issue).toEqual({
      id: "812",
      nativeRef: { repo: "acme/widget", number: 812, id: 2300100200, node_id: "I_kwDOxxxxx5v7kQ" },
      identifier: "GH-812",
      title: "Add GitHub Issues adapter",
      description: "Implement §11.2 profile and §11.3 normalization.",
      priority: null,
      state: "open",
      branchName: null,
      url: "https://github.com/acme/widget/issues/812",
      assigneeId: "octocat",
      labels: ["agent", "need review"],
      blockedBy: [],
      dispatchable: true,
      createdAt: Date.parse("2026-09-27T14:09:15Z"),
      updatedAt: Date.parse("2026-09-27T15:07:35Z"),
    });
  });

  it("number 0 是合法编号，不是缺失哨兵", () => {
    const issue = normalizeGitHubIssue(issuePayload({ number: 0 }), "acme/widget");
    expect(issue.id).toBe("0");
    expect(issue.identifier).toBe("GH-0");
  });

  it("state 保留 provider 拼写（不 trim、不 lowercase）", () => {
    const issue = normalizeGitHubIssue(issuePayload({ state: "Open" }), "acme/widget");
    expect(issue.state).toBe("Open");
  });

  // §11.1：required 面缺到"无法产出合法 Issue"才算 malformed；可空字段的坏值
  // 走 fallback，不会到这里。
  it.each([
    ["payload 不是对象", "not an object"],
    ["number 缺失", { title: "t", state: "open" }],
    ["number 非整数", issuePayload({ number: 1.5 })],
    ["number 为负", issuePayload({ number: -1 })],
    ["number 是字符串", issuePayload({ number: "812" })],
    ["title 缺失", issuePayload({ title: undefined })],
    ["title 为空串", issuePayload({ title: "" })],
    ["title 非字符串", issuePayload({ title: 42 })],
    ["state 缺失", issuePayload({ state: undefined })],
    ["state 为空串", issuePayload({ state: "" })],
  ])("malformed：%s → tracker_response", (_name, payload) => {
    const error = normalizeError(payload);
    expect(error.category).toBe("tracker_response");
    expect(error.retryable).toBe(false);
  });

  it("malformed 的 providerDetail 只带原因，不带 payload（避免 provider 内容外泄）", () => {
    const error = normalizeError(issuePayload({ title: "" }));
    expect(error.providerDetail).toEqual({ reason: expect.stringContaining("`title`") });
  });
});

describe("normalizeGitHubIssue — nullable 与 best-effort fallback（§11.3）", () => {
  it("body / html_url / assignee 缺失或类型不对 → null，不使记录 malformed", () => {
    const issue = normalizeGitHubIssue(
      issuePayload({
        body: null,
        html_url: null,
        assignee: { id: 1 },
        created_at: null,
        updated_at: 0,
      }),
      "acme/widget",
    );

    expect(issue.description).toBeNull();
    expect(issue.url).toBeNull();
    expect(issue.assigneeId).toBeNull();
    expect(issue.createdAt).toBeNull();
    expect(issue.updatedAt).toBeNull();
    expect(issue.dispatchable).toBe(true);
  });

  it("assignee 为 null（未指派）→ assigneeId null", () => {
    expect(normalizeGitHubIssue(issuePayload({ assignee: null }), "acme/widget").assigneeId).toBeNull();
  });

  it("priority 恒为 null：GitHub core payload 没有规范化 priority", () => {
    expect(normalizeGitHubIssue(issuePayload({ priority: 1 }), "acme/widget").priority).toBeNull();
  });

  it("blockedBy 恒为空数组：不从正文 / task list 推断 blocker", () => {
    const issue = normalizeGitHubIssue(
      issuePayload({ body: "Depends on #811.\n- [ ] blocked by #810" }),
      "acme/widget",
    );
    expect(issue.blockedBy).toEqual([]);
  });

  it("native_ref 只留 JSON-safe 的身份字段，其余 provider 元数据不进", () => {
    const issue = normalizeGitHubIssue(
      issuePayload({
        user: { login: "octocat", node_id: "U_x" },
        milestone: { title: "M2" },
        comments_url: "https://api.github.com/repos/acme/widget/issues/812/comments",
      }),
      "acme/widget",
    );

    expect(issue.nativeRef).toEqual({ repo: "acme/widget", number: 812, id: 2300100200, node_id: "I_kwDOxxxxx5v7kQ" });
    // §11.3：native_ref 要能安全进 prompt / tool context —— 整条记录可 JSON 往返。
    expect(JSON.parse(JSON.stringify(issue))).toEqual(issue);
  });

  it("REST id / node_id 缺席时 native_ref 仍可寻址（number + repo）", () => {
    const issue = normalizeGitHubIssue(issuePayload({ id: undefined, node_id: "" }), "acme/widget");
    expect(issue.nativeRef).toEqual({ repo: "acme/widget", number: 812 });
  });
});

describe("normalizeGitHubIssue — labels（§11.3 trim + lowercase + 去空白 + 去重）", () => {
  it("对象与字符串两种形状混用，坏条目丢弃", () => {
    const issue = normalizeGitHubIssue(
      issuePayload({
        labels: ["  Agent ", { name: "agent" }, { name: "  " }, { color: "ff0000" }, null, 7, { name: 42 }],
      }),
      "acme/widget",
    );
    expect(issue.labels).toEqual(["agent"]);
  });

  it("labels 缺失 / 非数组 / 空数组 → 空数组", () => {
    for (const value of [undefined, "agent", { name: "agent" }, []]) {
      expect(normalizeGitHubIssue(issuePayload({ labels: value }), "acme/widget").labels).toEqual([]);
    }
  });
});

describe("normalizeGitHubIssue — timestamps（§11.3 RFC 3339）", () => {
  it.each([
    ["UTC Z", "2026-09-27T14:09:15Z", Date.parse("2026-09-27T14:09:15Z")],
    ["带偏移量", "2026-09-27T22:09:15+08:00", Date.parse("2026-09-27T14:09:15Z")],
    ["带小数秒", "2026-09-27T14:09:15.123Z", Date.parse("2026-09-27T14:09:15.123Z")],
  ])("可解析：%s", (_name, raw, expected) => {
    expect(normalizeGitHubIssue(issuePayload({ created_at: raw }), "acme/widget").createdAt).toBe(expected);
  });

  it.each([
    ["非 RFC 3339 的日期串", "2026-09-27"],
    ["缺时区", "2026-09-27T14:09:15"],
    ["秒位越界", "2026-13-45T99:99:99Z"],
    ["epoch 秒数", 1790000000],
  ])("不可解析 → null：%s", (_name, raw) => {
    const issue = normalizeGitHubIssue(issuePayload({ created_at: raw, updated_at: raw }), "acme/widget");
    expect(issue.createdAt).toBeNull();
    expect(issue.updatedAt).toBeNull();
  });
});

describe("normalizeGitHubIssue — PR 的 dispatchable（§11.2 / §11.3）", () => {
  it("payload 带 pull_request → 记录仍可归一化，但 dispatchable=false", () => {
    const issue = normalizeGitHubIssue(
      issuePayload({ pull_request: { url: "https://api.github.com/repos/acme/widget/pulls/812" } }),
      "acme/widget",
    );

    expect(issue.dispatchable).toBe(false);
    expect(issue.id).toBe("812");
    expect(issue.identifier).toBe("GH-812");
  });

  it("pull_request 为 null 或缺席 → 普通 issue 可派发", () => {
    for (const value of [undefined, null]) {
      expect(
        normalizeGitHubIssue(issuePayload({ pull_request: value }), "acme/widget").dispatchable,
      ).toBe(true);
    }
  });
});
