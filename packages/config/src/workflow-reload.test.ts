/**
 * SPEC §6.2 动态热重载 + §6.3 防御性再校验测试（对齐 §17.1 Core Conformance 的
 * "Workflow file changes are detected and trigger re-read/re-apply without restart"
 * 与 "Invalid workflow reload keeps last known good effective configuration and emits
 * an operator-visible error" 两项 + issue 验收口径）。
 *
 * 全部经包公共入口 `./index` import，并在**真实临时目录 / 真实文件变化**上运行
 * （docs/testing.md 三条哲学：验外部世界、用真实现、走真实入口）；不 mock loader。
 * 每个用例在 `afterEach` 强制 `close()`，不遗留 timer handle。
 *
 * 轮询间隔注入 10ms 以保证确定性复跑；`vi.waitFor` 给足超时。写入内容长度恒变化，
 * 避免仅靠 mtime 的精度 / 同毫秒重写漏检。
 */
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Issue } from "@symphony/domain";

import {
  renderPrompt,
  SymphonyConfigError,
  watchWorkflow,
  type WorkflowReloadEvent,
  type WorkflowWatchHandle,
} from "./index";

/** 渲染用的归一化 {@link Issue}（§4.1.1）；本文件的断言不依赖其字段值。 */
const ISSUE: Issue = {
  id: "issue-1",
  nativeRef: null,
  identifier: "ABC-123",
  title: "Fix the widget",
  description: null,
  priority: null,
  state: "In Progress",
  branchName: null,
  url: null,
  assigneeId: null,
  labels: [],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
};

let dir: string;
let handle: WorkflowWatchHandle | undefined;
let events: WorkflowReloadEvent[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "symphony-reload-"));
  events = [];
});

afterEach(() => {
  handle?.close();
  handle = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** 写入 workflow 文件（内容长度需调用方保证变化，以稳定触发 stamp 变化）。 */
function write(content: string): string {
  const file = join(dir, "WORKFLOW.md");
  writeFileSync(file, content, "utf8");
  return file;
}

/** 一个带 config 与 prompt 正文的合法 WORKFLOW.md 内容。 */
function workflowBody(options: { intervalMs: number; body: string }): string {
  return `---\npolling:\n  interval_ms: ${options.intervalMs}\n---\n${options.body}`;
}

/** 启动 watcher（注入临时目录、空 env、固定 home、短轮询间隔）。 */
function watch(
  intervalMs = 10,
  onEvent?: (event: WorkflowReloadEvent) => void,
): WorkflowWatchHandle {
  handle = watchWorkflow({
    cwd: dir,
    env: {},
    home: "/home/test-user",
    intervalMs,
    onEvent: (event) => {
      events.push(event);
      onEvent?.(event);
    },
  });
  return handle;
}

describe("watchWorkflow — valid reload (SPEC §6.2)", () => {
  it("re-applies a valid change to config and prompt without restart", async () => {
    write(workflowBody({ intervalMs: 5000, body: "old body" }));
    const watcher = watch();
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(5000);
    expect(watcher.current().definition.promptTemplate).toBe("old body");

    write(workflowBody({ intervalMs: 7000, body: "brand new body" }));

    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0]?.kind).toBe("reloaded");
    // 验外部世界：handle.current() 反映新 effective，而不是只看事件被调用过。
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(7000);
    expect(watcher.current().definition.promptTemplate).toBe("brand new body");
  });

  it("does not emit events while the file is unchanged", async () => {
    write(workflowBody({ intervalMs: 5000, body: "steady" }));
    watch();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events).toEqual([]);
  });
});

describe("watchWorkflow — invalid reload keeps last-known-good (SPEC §6.2 / §17.1)", () => {
  it("keeps the previous effective config and emits an operator-visible typed error", async () => {
    write(workflowBody({ intervalMs: 5000, body: "good body" }));
    const watcher = watch();
    const before = watcher.current();

    // 非法 typed 值：`polling.interval_ms` 非正整数 → invalid_config。
    write(workflowBody({ intervalMs: 0, body: "bad body" }));

    await vi.waitFor(() => expect(events.length).toBe(1));
    const event = events[0];
    expect(event?.kind).toBe("error");
    if (event?.kind === "error") {
      expect(event.error.code).toBe("invalid_config");
    }
    // last-known-good 逐字段未被污染。
    expect(watcher.current()).toBe(before);
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(5000);
    expect(watcher.current().definition.promptTemplate).toBe("good body");
  });

  it("recovers on a subsequent valid write (self-heal)", async () => {
    write(workflowBody({ intervalMs: 5000, body: "good body" }));
    const watcher = watch();

    write("---\npolling:\n  interval_ms: not-a-number\n---\nbad body");
    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0]?.kind).toBe("error");

    write(workflowBody({ intervalMs: 9000, body: "recovered body" }));
    await vi.waitFor(() => expect(events.length).toBe(2));
    expect(events[1]?.kind).toBe("reloaded");
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(9000);
  });

  it("reports a malformed YAML reload as workflow_parse_error without crashing", async () => {
    write(workflowBody({ intervalMs: 5000, body: "good body" }));
    const watcher = watch();

    write("---\npolling: [unclosed\n---\nbad body");
    await vi.waitFor(() => expect(events.length).toBe(1));
    const event = events[0];
    expect(event?.kind).toBe("error");
    if (event?.kind === "error") {
      expect(event.error.code).toBe("workflow_parse_error");
    }
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(5000);
  });

  it("keeps last-known-good and reports missing_workflow_file when the file is deleted", async () => {
    const file = write(workflowBody({ intervalMs: 5000, body: "good body" }));
    const watcher = watch();

    unlinkSync(file);
    await vi.waitFor(() => expect(events.length).toBe(1));
    const event = events[0];
    expect(event?.kind).toBe("error");
    if (event?.kind === "error") {
      expect(event.error.code).toBe("missing_workflow_file");
    }
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(5000);

    write(workflowBody({ intervalMs: 6000, body: "restored body" }));
    await vi.waitFor(() => expect(events.length).toBe(2));
    expect(events[1]?.kind).toBe("reloaded");
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(6000);
  });

  it("reports a non-map front matter reload as workflow_front_matter_not_a_map, keeping last-known-good", async () => {
    write(workflowBody({ intervalMs: 5000, body: "good body" }));
    const watcher = watch();
    const before = watcher.current();

    // front matter 解析成功但根是 list（§5.2 MUST decode to a map/object）。
    write("---\n- just\n- a\n- list\n- here\n---\nbody");
    await vi.waitFor(() => expect(events.length).toBe(1));
    const event = events[0];
    expect(event?.kind).toBe("error");
    if (event?.kind === "error") {
      expect(event.error.code).toBe("workflow_front_matter_not_a_map");
    }
    expect(watcher.current()).toBe(before);
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(5000);
  });
});

describe("watchWorkflow — prompt template failures stay out of reload (SPEC §5.5 gating)", () => {
  const BROKEN_BODY = "Hello {{ unclosed ";

  it("reloads a workflow whose prompt body is a broken template, and fails only on render", async () => {
    write(workflowBody({ intervalMs: 5000, body: "good body" }));
    const watcher = watch();

    // 合法 front matter + 语法坏模板正文：reload 不做模板 parse（§5.5 只把文件
    // read/YAML 错误列为 gating），故这是一次 valid reload。
    write(`---\npolling:\n  interval_ms: 7000\n---\n${BROKEN_BODY}`);

    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0]?.kind).toBe("reloaded");
    // effective config 完好：模板正文只是文本，未被 reload 路径解析。
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(7000);
    expect(watcher.current().definition.promptTemplate).toBe("Hello {{ unclosed");

    // 模板错误只 fail 当次 attempt（§5.5），不构成 config 错误。
    const effective = watcher.current();
    let renderError: unknown;
    try {
      renderPrompt(effective.definition.promptTemplate, { issue: ISSUE, attempt: 2 });
    } catch (error) {
      renderError = error;
    }
    expect(renderError).toBeInstanceOf(SymphonyConfigError);
    expect((renderError as SymphonyConfigError).code).toBe("template_parse_error");

    // 模板失败不污染 last-known-good：current() 仍是同一对象、逐字段不变。
    expect(watcher.current()).toBe(effective);

    // 防御性 reload() 同样不把模板错误升级为 config 错误（重新 load 会产生结构
    // 相等的新 effective 对象，故此处断言值相等）。
    watcher.reload();
    expect(events.length).toBe(2);
    expect(events[1]?.kind).toBe("reloaded");
    expect(watcher.current()).toEqual(effective);
  });
});

describe("watchWorkflow — listener isolation (SPEC §6.2 crash resistance)", () => {
  it("survives a throwing onEvent and keeps detecting further changes", async () => {
    write(workflowBody({ intervalMs: 5000, body: "good body" }));
    let calls = 0;
    const watcher = watch(10, () => {
      calls += 1;
      throw new TypeError("listener bug");
    });

    write(workflowBody({ intervalMs: 7000, body: "new body" }));
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(7000);

    // watcher 未被监听器异常终结：后续变化照常检出。
    write(workflowBody({ intervalMs: 8000, body: "newer body!" }));
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(8000);
  });

  it("does not misreport a throwing listener as an invalid reload", async () => {
    write(workflowBody({ intervalMs: 5000, body: "good body" }));
    const watcher = watch(10, (event) => {
      if (event.kind === "reloaded") {
        // 监听器抛出的 SymphonyConfigError 属于监听器自身缺陷，不得被 reload 的
        // 失败域捕获后误报成一次 config error。
        throw new SymphonyConfigError("invalid_config", "listener bug", { path: dir });
      }
    });

    write(workflowBody({ intervalMs: 7000, body: "new body" }));
    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0]?.kind).toBe("reloaded");

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events.map((event) => event.kind)).toEqual(["reloaded"]);
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(7000);
  });
});

describe("watchWorkflow — lifecycle contract (SPEC §6.2 / §6.3)", () => {
  it("throws a typed error and creates no handle when the initial load fails", () => {
    const error = (() => {
      try {
        watchWorkflow({ cwd: dir, env: {}, home: "/home/test-user", intervalMs: 10 });
      } catch (thrown) {
        return thrown;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe("missing_workflow_file");
  });

  it("revalidates synchronously via reload() and applies a valid change", () => {
    write(workflowBody({ intervalMs: 5000, body: "good body" }));
    // 长轮询间隔：reload() 是同步入口，必须与定时器解耦、可确定性断言。
    const watcher = watch(60_000);

    write(workflowBody({ intervalMs: 8000, body: "reloaded body" }));
    watcher.reload();

    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("reloaded");
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(8000);
  });

  it("keeps last-known-good when reload() hits an invalid config", () => {
    write(workflowBody({ intervalMs: 5000, body: "good body" }));
    const watcher = watch(60_000);

    write("---\nagent:\n  max_turns: 0\n---\nbad body");
    watcher.reload();

    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("error");
    expect(watcher.current().serviceConfig.agent.maxTurns).toBe(20);
  });

  it("stops emitting events after close() and close() is idempotent", async () => {
    write(workflowBody({ intervalMs: 5000, body: "good body" }));
    const watcher = watch();
    const snapshot = watcher.current();

    watcher.close();
    watcher.close();

    write(workflowBody({ intervalMs: 4000, body: "changed after close" }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(events).toEqual([]);
    expect(watcher.current()).toBe(snapshot);
  });

  it("is a no-op for reload() after close()", () => {
    write(workflowBody({ intervalMs: 5000, body: "good body" }));
    const watcher = watch(60_000);
    watcher.close();

    write(workflowBody({ intervalMs: 8000, body: "after close" }));
    watcher.reload();

    expect(events).toEqual([]);
    expect(watcher.current().serviceConfig.polling.intervalMs).toBe(5000);
  });
});
