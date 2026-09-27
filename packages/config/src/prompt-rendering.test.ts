/**
 * SPEC §5.4 严格 prompt 模板渲染测试（对齐 §17.1 Core Conformance 的
 * "Prompt template renders `issue` and `attempt`" 与 "Prompt rendering fails on
 * unknown variables (strict mode)" 两项 + issue 验收口径）。
 *
 * 全部经包公共入口 `./index` import（docs/testing.md 哲学 3：走真实入口）。
 * 渲染是纯函数，输入用真实 `Issue` 形状（§4.1.1），不 mock 渲染层。
 */
import { describe, expect, it } from "vitest";

import type { Issue } from "@symphony/domain";

import { DEFAULT_PROMPT_TEMPLATE, renderPrompt, SymphonyConfigError } from "./index";

/** 构造一个字段齐备的归一化 {@link Issue}（§4.1.1），可局部覆盖。 */
function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    nativeRef: { provider: "linear", uuid: "abc" },
    identifier: "ABC-123",
    title: "Fix the widget",
    description: "Widgets are broken.",
    priority: 2,
    state: "In Progress",
    branchName: "feature/abc-123",
    url: "https://tracker.example/ABC-123",
    assigneeId: "user-9",
    labels: ["backend", "urgent"],
    blockedBy: [
      { id: "issue-0", identifier: "ABC-100", state: "Todo" },
      { id: null, identifier: null, state: null },
    ],
    dispatchable: true,
    createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    updatedAt: Date.UTC(2026, 0, 3, 4, 5, 6),
    ...overrides,
  };
}

/** 执行 `fn`，返回其抛出的异常（未抛出则返回 undefined）。 */
function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** 断言 `fn` 抛出 code 为 `code` 的 {@link SymphonyConfigError}，返回该错误。 */
function expectConfigError(fn: () => unknown, code: string): SymphonyConfigError {
  const error = capture(fn);
  expect(error).toBeInstanceOf(SymphonyConfigError);
  const configError = error as SymphonyConfigError;
  expect(configError.code).toBe(code);
  expect(configError.name).toBe("SymphonyConfigError");
  return configError;
}

describe("renderPrompt — successful rendering (SPEC §5.4 / §12.2)", () => {
  it("renders snake_case issue fields and an integer attempt", () => {
    const prompt = renderPrompt(
      "Issue {{ issue.identifier }} ({{ issue.state }}): {{ issue.title }} [attempt {{ attempt }}]",
      { issue: makeIssue(), attempt: 2 },
    );
    expect(prompt).toBe("Issue ABC-123 (In Progress): Fix the widget [attempt 2]");
  });

  it("renders null attempt as empty and behaves as falsey on the first attempt", () => {
    const issue = makeIssue();
    expect(renderPrompt("[{{ attempt }}]", { issue, attempt: null })).toBe("[]");
    // 缺席 attempt 与显式 null 同语义（§12.3 "null or absent"）。
    expect(renderPrompt("[{{ attempt }}]", { issue })).toBe("[]");
    expect(
      renderPrompt("{% if attempt %}retry {{ attempt }}{% else %}first{% endif %}", {
        issue,
        attempt: null,
      }),
    ).toBe("first");
  });

  it("maps every normalized field to its SPEC §4.1.1 snake_case name", () => {
    const prompt = renderPrompt(
      [
        "id={{ issue.id }}",
        "native={{ issue.native_ref.provider }}",
        "branch={{ issue.branch_name }}",
        "url={{ issue.url }}",
        "assignee={{ issue.assignee_id }}",
        "priority={{ issue.priority }}",
        "dispatchable={{ issue.dispatchable }}",
        "created={{ issue.created_at }}",
        "updated={{ issue.updated_at }}",
      ].join("\n"),
      { issue: makeIssue(), attempt: null },
    );
    expect(prompt).toBe(
      [
        "id=issue-1",
        "native=linear",
        "branch=feature/abc-123",
        "url=https://tracker.example/ABC-123",
        "assignee=user-9",
        "priority=2",
        "dispatchable=true",
        `created=${new Date(Date.UTC(2026, 0, 2, 3, 4, 5)).toISOString()}`,
        `updated=${new Date(Date.UTC(2026, 0, 3, 4, 5, 6)).toISOString()}`,
      ].join("\n"),
    );
  });

  it("preserves nested labels / blocked_by for iteration (SPEC §12.2)", () => {
    const prompt = renderPrompt(
      "{% for label in issue.labels %}[{{ label }}]{% endfor %}" +
        "{% for blocker in issue.blocked_by %}({{ blocker.identifier }}:{{ blocker.state }}){% endfor %}",
      { issue: makeIssue(), attempt: null },
    );
    expect(prompt).toBe("[backend][urgent](ABC-100:Todo)(:)");
  });

  it("renders null-able fields as empty strings without failing", () => {
    const issue = makeIssue({
      description: null,
      priority: null,
      branchName: null,
      url: null,
      assigneeId: null,
      nativeRef: null,
      createdAt: null,
      updatedAt: null,
      labels: [],
      blockedBy: [],
    });
    const prompt = renderPrompt(
      "<{{ issue.description }}|{{ issue.priority }}|{{ issue.branch_name }}|{{ issue.native_ref }}|" +
        "{{ issue.created_at }}|{% for l in issue.labels %}{{ l }}{% endfor %}>",
      { issue, attempt: null },
    );
    expect(prompt).toBe("<|||||>");
  });

  it("applies a registered filter normally", () => {
    const prompt = renderPrompt("{{ issue.title | upcase }}", {
      issue: makeIssue({ title: "hello" }),
      attempt: null,
    });
    expect(prompt).toBe("HELLO");
  });
});

describe("renderPrompt — strict failures (SPEC §5.4 / §5.5)", () => {
  it("fails on an unknown variable with template_render_error", () => {
    const error = expectConfigError(
      () => renderPrompt("{{ issue.nope }}", { issue: makeIssue(), attempt: null }),
      "template_render_error",
    );
    expect(error.message).toContain("Failed to render prompt template");
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.path).toBe("<inline>");
  });

  it("fails on a top-level unknown variable with template_render_error", () => {
    expectConfigError(
      () => renderPrompt("{{ retry_kind }}", { issue: makeIssue(), attempt: null }),
      "template_render_error",
    );
  });

  it("fails on an unknown filter with template_render_error", () => {
    const error = expectConfigError(
      () => renderPrompt("{{ issue.title | nope }}", { issue: makeIssue(), attempt: null }),
      "template_render_error",
    );
    expect(error.message).toContain("Failed to parse prompt template");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("fails on a syntax error with template_parse_error", () => {
    const error = expectConfigError(
      () => renderPrompt("{{ unclosed ", { issue: makeIssue(), attempt: null }),
      "template_parse_error",
    );
    expect(error.message).toContain("Failed to parse prompt template");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("reports the injected workflow path on render errors", () => {
    const error = expectConfigError(
      () => renderPrompt("{{ nope }}", {
        issue: makeIssue(),
        attempt: null,
        workflowPath: "/repo/WORKFLOW.md",
      }),
      "template_render_error",
    );
    expect(error.path).toBe("/repo/WORKFLOW.md");
  });
});

describe("renderPrompt — empty prompt fallback (SPEC §5.4)", () => {
  it("returns the default prompt for an empty body", () => {
    const prompt = renderPrompt("", { issue: makeIssue(), attempt: null });
    expect(prompt).toBe(DEFAULT_PROMPT_TEMPLATE);
    expect(DEFAULT_PROMPT_TEMPLATE).toBe(
      "You are working on an issue from the configured tracker.",
    );
  });

  it("treats whitespace-only bodies as empty", () => {
    expect(renderPrompt("\n  \t\n", { issue: makeIssue(), attempt: null })).toBe(
      DEFAULT_PROMPT_TEMPLATE,
    );
  });
});
