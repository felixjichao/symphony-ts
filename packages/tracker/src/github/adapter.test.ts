/**
 * GitHub adapter 的 §11.1 malformed-record 策略测试（NEST-55 验收"malformed
 * required record 返回可判别 normalization failure" + SPEC §11.1 两副面孔）。
 *
 * 只测 profile → adapter 的公共路径：注入的假 transport 就是 #20 的替身，因此这里
 * 断言的行为在 transport 落地后不需要重写。
 */
import { describe, expect, it } from "vitest";

import { TrackerError, createGitHubAdapterProfile } from "../index";
import type { GitHubMalformedRecord } from "../index";

const PROVIDER = { repo: "acme/widget", token: "t", api_url: "https://api.github.com" };

function build(payloads: readonly unknown[], onMalformedRecord?: (r: GitHubMalformedRecord) => void) {
  return createGitHubAdapterProfile({
    transport: {
      fetchPayloadsByStates: async () => payloads,
      fetchPayloadsByIds: async () => payloads,
    },
    onMalformedRecord,
  }).createAdapter({
    kind: "github",
    provider: PROVIDER,
    requiredLabels: [],
    activeStates: ["open"],
    terminalStates: ["closed"],
    env: {},
  });
}

const GOOD = { id: 1, number: 12, title: "t", state: "open" };
const BAD = { number: 13, title: "", state: "open" };

describe("GitHubTrackerAdapter — state-list（§11.1.1）", () => {
  it("单条 malformed 记录被省略，其余照常返回", async () => {
    const issues = await build([GOOD, BAD, { ...GOOD, number: 14 }]).fetchIssuesByStates(["open"]);
    expect(issues.map((issue) => issue.identifier)).toEqual(["GH-12", "GH-14"]);
  });

  it("省略时回调拿到 operation 与原因（§11.1 SHOULD log）", async () => {
    const omitted: GitHubMalformedRecord[] = [];
    await build([GOOD, BAD], (record) => omitted.push(record)).fetchIssuesByStates(["open"]);

    expect(omitted).toHaveLength(1);
    expect(omitted[0]?.operation).toBe("fetchIssuesByStates");
    expect(omitted[0]?.error.category).toBe("tracker_response");
    expect(omitted[0]?.reason).toContain("`title`");
  });

  it("throwing omission observer cannot fail candidate fetch; ID refresh still MUST fail", async () => {
    const adapter = build([GOOD, BAD], () => { throw new Error("sink failed"); });
    expect((await adapter.fetchIssuesByStates(["open"])).map((issue) => issue.identifier)).toEqual(["GH-12"]);
    await expect(adapter.fetchIssuesByIds(["acme/widget#12"])).rejects.toBeInstanceOf(TrackerError);
  });

  it("未接回调时静默省略，不让整次 poll 失败", async () => {
    await expect(build([BAD]).fetchIssuesByStates(["open"])).resolves.toEqual([]);
  });

  it("transport 自身的失败原样抛出，不被当作 malformed 记录吞掉", async () => {
    const adapter = createGitHubAdapterProfile({
      transport: {
        fetchPayloadsByStates: async () => {
          throw new TrackerError("tracker_status", "403 Forbidden", { providerStatus: 403 });
        },
        fetchPayloadsByIds: async () => [],
      },
    }).createAdapter({
      kind: "github",
      provider: PROVIDER,
      requiredLabels: [],
      activeStates: ["open"],
      terminalStates: ["closed"],
      env: {},
    });

    await expect(adapter.fetchIssuesByStates(["open"])).rejects.toThrowError(TrackerError);
  });
});

describe("GitHubTrackerAdapter — ID-refresh（§11.1.2）", () => {
  it("被请求的 ID 记录 malformed → MUST 失败，不静默省略", async () => {
    await expect(build([GOOD, BAD]).fetchIssuesByIds(["12", "13"])).rejects.toThrowError(
      /Malformed GitHub issue payload/,
    );
  });

  it("失败是 tracker_response（可判别），不是被包装成配置错误", async () => {
    try {
      await build([BAD]).fetchIssuesByIds(["13"]);
      throw new Error("unreachable: refresh must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TrackerError);
      expect((error as TrackerError).category).toBe("tracker_response");
    }
  });

  it("refresh 返回完整 normalized snapshot（不只是 state 字符串）", async () => {
    const [issue] = await build([
      { ...GOOD, labels: [{ name: " Agent " }], updated_at: "2026-09-28T06:02:35Z" },
    ]).fetchIssuesByIds(["12"]);

    expect(issue?.labels).toEqual(["agent"]);
    expect(issue?.updatedAt).toBe(Date.parse("2026-09-28T06:02:35Z"));
  });

  it("省略的 ID 不伪造记录：transport 少回一条即被视为「不再可见」", async () => {
    const issues = await build([GOOD]).fetchIssuesByIds(["12", "999"]);
    expect(issues.map((issue) => issue.id)).toEqual(["12"]);
  });

  it("入参按集合处理：transport 只看到去重后的 ID（§11.1 \"treated as a set\"）", async () => {
    const seen: string[][] = [];
    const adapter = createGitHubAdapterProfile({
      transport: {
        fetchPayloadsByStates: async () => [],
        fetchPayloadsByIds: async (issueIds) => {
          seen.push([...issueIds]);
          return [GOOD];
        },
      },
    }).createAdapter({
      kind: "github",
      provider: PROVIDER,
      requiredLabels: [],
      activeStates: ["open"],
      terminalStates: ["closed"],
      env: {},
    });

    await adapter.fetchIssuesByIds(["12", "12", "8"]);
    expect(seen).toEqual([["12", "8"]]);
  });

  it("每个 dispatch ID 至多出现一次：重复 payload 折叠成首次那条", async () => {
    const issues = await build([
      { ...GOOD, updated_at: "2026-09-28T06:02:35Z" },
      { ...GOOD, title: "later", updated_at: "2026-09-01T00:00:00Z" },
    ]).fetchIssuesByIds(["12"]);

    expect(issues.map((issue) => issue.id)).toEqual(["12"]);
    expect(issues[0]?.title).toBe("t");
  });
});

describe("GitHubTrackerAdapter — repo 只用于 native_ref", () => {
  it("GHES 配置的 repo 原样进 native_ref", async () => {
    const adapter = createGitHubAdapterProfile({
      transport: {
        fetchPayloadsByStates: async () => [GOOD],
        fetchPayloadsByIds: async () => [],
      },
    }).createAdapter({
      kind: "github",
      provider: { ...PROVIDER, repo: "acme-enterprise/widget.internal", api_url: "https://ghes.example.com/api/v3" },
      requiredLabels: [],
      activeStates: ["open"],
      terminalStates: ["closed"],
      env: {},
    });

    const [issue] = await adapter.fetchIssuesByStates(["open"]);
    expect(issue?.nativeRef).toEqual({ repo: "acme-enterprise/widget.internal", number: 12, id: 1 });
  });
});
