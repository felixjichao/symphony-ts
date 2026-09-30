/**
 * @symphony/agent 契约层测试（SPEC §10.4 / §10.6 / §10.2–§10.3 continuation，M4.1 / #37）。
 *
 * 覆盖两类断言：
 * 1. **行为面**：`AgentError` / `AgentEvent` / continuation 类型作为稳定 Symphony
 *    契约可用——按 `code` 判别、缺席 ≠ 空值、`cause` 保留底层异常、事件可 JSON 往返、
 *    decision 是只有 stop / continue 两分支的判别式联合。
 * 2. **结构面**（issue 验收 #3 / #4）：公共类型没有复制 pinned Codex generated
 *    schema，`agent` 的依赖方向没有越过 `domain + config + workspace`。
 *
 * 全部经包公共入口 `./index` import（docs/testing.md：测公共面，不测内部）。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { composeSessionId, type Issue } from "@symphony/domain";

import {
  AgentError,
  AGENT_ERROR_CODES,
  AGENT_EVENT_NAMES,
  type AgentErrorCode,
  type AgentEvent,
  type ContinuationDecision,
  type ContinuationDecider,
  type TurnCompletedContext,
} from "./index";

/** 最小可用 issue 夹具（§4.1.1 要求所有字段在场）。 */
const ISSUE: Issue = {
  id: "issue-1",
  nativeRef: { number: 7 },
  identifier: "SYM-7",
  title: "Contract test issue",
  description: null,
  priority: null,
  state: "In Progress",
  branchName: null,
  url: null,
  assigneeId: null,
  labels: ["bug"],
  blockedBy: [],
  dispatchable: true,
  createdAt: 1_700_000_000_000,
  updatedAt: null,
};

describe("AgentError — SPEC §10.6 稳定错误面", () => {
  it("覆盖 §10.6 全部推荐 category，名字逐字一致", () => {
    const specRecommended: readonly AgentErrorCode[] = [
      "codex_not_found",
      "invalid_workspace_cwd",
      "response_timeout",
      "turn_timeout",
      "port_exit",
      "response_error",
      "turn_failed",
      "turn_cancelled",
      "turn_input_required",
    ];
    for (const code of specRecommended) {
      expect(AGENT_ERROR_CODES, code).toContain(code);
    }
    // implementation-defined 追加项（§10.5 headless policy + protocol 完整性）。
    expect(AGENT_ERROR_CODES).toContain("approval_required");
    expect(AGENT_ERROR_CODES).toContain("protocol_error");
    expect(AGENT_ERROR_CODES).toContain("launch_failed");
    expect(AGENT_ERROR_CODES).toHaveLength(12);
  });

  it("message 原样保留，code 是唯一判别式，Error 语义不变", () => {
    const error = new AgentError("turn_timeout", "turn stream silent for 3600000 ms");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AgentError");
    expect(error.code).toBe("turn_timeout");
    expect(error.message).toBe("turn stream silent for 3600000 ms");
  });

  it("底层异常经 cause 保留，但不成为公共契约（第三方类型不外露）", () => {
    const rootCause = new TypeError("JSON.parse: unexpected end of input");
    const error = new AgentError("protocol_error", "stdout line is not a JSON-RPC message", {
      cause: rootCause,
      protocolMethod: "turn/start",
      threadId: "thread-1",
      turnId: "turn-1",
      sessionId: composeSessionId("thread-1", "turn-1"),
      codexAppServerPid: "4242",
    });
    expect(error.cause).toBe(rootCause);
    expect(error.protocolMethod).toBe("turn/start");
    expect(error.sessionId).toBe("thread-1-turn-1");
    // 消费方按 code 分支即可，不需要 narrow cause 的具体类型。
    expect((error as Error).constructor.name).toBe("AgentError");
  });

  it("未提供的诊断字段是缺席，不是 null / 空串", () => {
    const error = new AgentError("codex_not_found", "command not found: codex");
    for (const field of ["threadId", "turnId", "sessionId", "codexAppServerPid", "protocolMethod", "path"] as const) {
      expect(field in error, field).toBe(false);
    }
    expect("cause" in error).toBe(false);
  });
});

describe("AgentEvent — SPEC §10.4 稳定事件面", () => {
  it("§10.4 示例事件名全部在契约清单内", () => {
    const specExamples: readonly string[] = [
      "session_started",
      "startup_failed",
      "turn_completed",
      "turn_failed",
      "turn_cancelled",
      "turn_ended_with_error",
      "turn_input_required",
      "approval_auto_approved",
      "unsupported_tool_call",
      "notification",
      "other_message",
      "malformed",
    ];
    for (const name of specExamples) {
      expect(AGENT_EVENT_NAMES, name).toContain(name);
    }
    expect(AGENT_EVENT_NAMES).toHaveLength(specExamples.length);
  });

  it("必填三件套 + 可选上下文齐备时，事件可 JSON 往返且信息不丢", () => {
    const event: AgentEvent = {
      event: "turn_completed",
      timestamp: 1_700_000_000_000,
      codexAppServerPid: "4242",
      threadId: "thread-1",
      turnId: "turn-1",
      sessionId: composeSessionId("thread-1", "turn-1"),
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      // rate-limit payload 是 opaque pass-through（§4.1.8 口径）。
      rateLimits: { primary: { usedPercent: 12, windowMinutes: 60 } },
      protocolMethod: "thread/tokenUsage/updated",
      summary: "turn 1 completed with 150 tokens",
    };
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  it("launch 前的事件只有三件套；session 上下文缺席而不是空串", () => {
    const event: AgentEvent = {
      event: "startup_failed",
      timestamp: 1_700_000_000_000,
      codexAppServerPid: null,
    };
    for (const field of ["threadId", "turnId", "sessionId", "usage", "rateLimits", "protocolMethod", "summary"] as const) {
      expect(field in event, field).toBe(false);
    }
    expect(event.codexAppServerPid).toBeNull();
  });

  it("event 是开放 string：未知事件名仍是合法事件（不冻结为 enum）", () => {
    const future: AgentEvent = {
      event: "turn_replayed_by_a_future_codex_baseline",
      timestamp: 1_700_000_000_000,
      codexAppServerPid: "4242",
    };
    expect(AGENT_EVENT_NAMES).not.toContain(future.event);
    expect(future.event).toBeTypeOf("string");
  });
});

describe("Continuation decision — §10.2 / §10.3 注入契约", () => {
  it("decision 只有 stop / continue 两个可判别分支", () => {
    const stop: ContinuationDecision = { kind: "stop" };
    const proceed: ContinuationDecision = { kind: "continue", issue: ISSUE };
    expect(stop.kind).toBe("stop");
    expect(proceed.kind).toBe("continue");
    if (proceed.kind === "continue") {
      // continue 分支携带 decider 自己的 issue 快照（可能是 refresh 后的）。
      expect(proceed.issue.identifier).toBe("SYM-7");
    }
    expect("issue" in stop).toBe(false);
  });

  it("decider 只依赖 Symphony 侧上下文，不接触 raw Codex payload", async () => {
    const seen: TurnCompletedContext[] = [];
    const decider: ContinuationDecider = async (context) => {
      seen.push(context);
      // M5 的真实实现会先 refresh tracker；这里只证明契约形状可注入。
      return context.event.event === "turn_completed" && context.turnCount < 2
        ? { kind: "continue", issue: context.issue }
        : { kind: "stop" };
    };
    const context: TurnCompletedContext = {
      issue: ISSUE,
      threadId: "thread-1",
      turnId: "turn-1",
      turnCount: 1,
      event: {
        event: "turn_completed",
        timestamp: 1_700_000_000_000,
        codexAppServerPid: "4242",
        threadId: "thread-1",
        turnId: "turn-1",
        sessionId: composeSessionId("thread-1", "turn-1"),
      },
    };

    expect(await decider(context)).toEqual({ kind: "continue", issue: ISSUE });
    expect(await decider({ ...context, turnCount: 2 })).toEqual({ kind: "stop" });
    expect(seen).toHaveLength(2);
    // 同一个 thread 复用、turn 递增的语义由 M4.5 执行；契约面只提供分量。
    expect(seen[0]?.threadId).toBe("thread-1");
  });
});

describe("结构边界：不复制 Codex generated schema、依赖方向不越界（issue 验收 #3）", () => {
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(srcDir, "..", "..", "..");

  /** 包内运行期源码（排除 `*.test.ts`）。 */
  function runtimeSources(pkg: "agent" | "config" | "domain"): { file: string; label: string }[] {
    const dir = path.join(repoRoot, "packages", pkg, "src");
    return readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => ({ file: path.join(dir, name), label: `${pkg}/src/${name}` }));
  }

  /** 去掉块注释与行注释：断言只看代码，不看散文里对 Codex 类型的引用。 */
  function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  }

  // pinned Codex schema 的**成员名**与**生成类型名**：出现在公共类型里就意味着
  // Symphony 抄了一份会漂移的 schema（SPEC §5.3.6 SHOULD 明确反对）。
  const COPIED_SCHEMA_TOKENS = [
    /"untrusted"/,
    /"on-request"/,
    /"workspace-write"/,
    /"read-only"/,
    /"danger-full-access"/,
    /"dangerFullAccess"/,
    /"workspaceWrite"/,
    /"externalSandbox"/,
    /"granular"/,
    /"sandbox_approval"/,
    /"skill_approval"/,
    /"request_permissions"/,
    /"mcp_elicitations"/,
    /"excludeTmpdirEnvVar"/,
    /"excludeSlashTmp"/,
    /"writableRoots"/,
    /"writable_roots"/,
    /\bAskForApproval\b/,
    /\bSandboxPolicy\b/,
    /\bSandboxMode\b/,
    /\bThreadStartParams\b/,
    /\bTurnStartParams\b/,
    /\bServerNotification\b/,
    /\bServerRequest\b/,
  ];

  it("domain / config / agent 公共源码不出现 Codex schema 成员或生成类型名", () => {
    const packages = ["agent", "config", "domain"] as const;
    const scanned = packages.flatMap((pkg) => runtimeSources(pkg));
    expect(scanned.length).toBeGreaterThan(0);

    for (const { file, label } of scanned) {
      const code = withoutComments(readFileSync(file, "utf8"));
      for (const pattern of COPIED_SCHEMA_TOKENS) {
        expect(code, `${label} 含 ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("agent 运行期不 import tracker / orchestrator / observability，也不 import Codex SDK", () => {
    for (const { file, label } of runtimeSources("agent")) {
      const code = withoutComments(readFileSync(file, "utf8"));
      expect(code, label).not.toMatch(
        /from\s*["']@symphony\/(?:tracker|orchestrator|observability)["']/,
      );
      expect(code, label).not.toMatch(/from\s*["'][^"']*codex[^"']*["']/i);
      expect(code, label).not.toMatch(/require\(\s*["'][^"']*codex/i);
    }
  });

  it("agent 的 package 依赖只有 domain / config / workspace，测试脚本不再 passWithNoTests", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, "packages", "agent", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; scripts?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@symphony/config",
      "@symphony/domain",
      "@symphony/workspace",
    ]);
    expect(manifest.scripts?.test).not.toContain("--passWithNoTests");
  });
});
