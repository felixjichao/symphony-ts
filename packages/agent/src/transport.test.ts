import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { AgentError } from "../src/errors";
import type {
  Transport,
  TransportExitInfo,
  TransportNotification,
  TransportProtocolIssue,
  TransportServerRequest,
} from "../src/transport";

import {
  createWorkspaceFixture,
  fixtureCommand,
  isProcessAlive,
  launchFixtureTransport,
  resultObject,
  waitFor,
  type WorkspaceFixture,
} from "../test-fixtures/harness";

/**
 * NDJSON / JSON-RPC transport kernel 测试（SPEC §10.1 framing、§10.3 transport
 * handling、§10.6 read timeout 与错误映射、§17.5，M4.2 / #38）。
 *
 * 全部走**真实子进程**（`bash -lc` 启动的 `test-fixtures/echo-server.mjs`）。
 * method 一律是 `test/*` 虚构名 —— transport 不理解任何 Codex 业务 method，
 * 这个文件里出现真实协议 method 反而说明边界被写穿了（#38「边界」小节）。
 *
 * 覆盖 #38 验收矩阵：4 framing、5 request id 关联与超时清理、6 stderr 隔离、
 * 7 oversized / malformed 不导致无界内存或 hang、8 process exit / shutdown。
 */

interface Collector {
  readonly notifications: TransportNotification[];
  readonly stderrLines: string[];
  readonly issues: TransportProtocolIssue[];
  readonly serverRequests: TransportServerRequest[];
  exit: TransportExitInfo | null;
}

function createCollector(): Collector {
  return { notifications: [], stderrLines: [], issues: [], serverRequests: [], exit: null };
}

function listenerOf(collector: Collector) {
  return {
    onNotification: (notification: TransportNotification): void => {
      collector.notifications.push(notification);
    },
    onStderr: (line: string): void => {
      collector.stderrLines.push(line);
    },
    onProtocolIssue: (issue: TransportProtocolIssue): void => {
      collector.issues.push(issue);
    },
    onServerRequest: (request: TransportServerRequest): void => {
      collector.serverRequests.push(request);
    },
    onExit: (info: TransportExitInfo): void => {
      collector.exit = info;
    },
  };
}

const openTransports: Transport[] = [];
const openFixtures: WorkspaceFixture[] = [];

/** 真实 launch 一个 fixture transport，并登记以便 afterEach 无条件收尸。 */
async function openFixture(
  overrides: Parameters<typeof launchFixtureTransport>[1] = {},
): Promise<{ transport: Transport; collector: Collector; fixture: WorkspaceFixture }> {
  const collector = createCollector();
  const fixture = await createWorkspaceFixture();
  openFixtures.push(fixture);
  const transport = await launchFixtureTransport(fixture, {
    readTimeoutMs: 4_000,
    ...overrides,
    listener: listenerOf(collector),
  });
  openTransports.push(transport);
  return { transport, collector, fixture };
}

afterEach(async () => {
  for (;;) {
    const transport = openTransports.shift();
    if (transport === undefined) {
      break;
    }
    await transport.stop().catch(() => undefined);
  }
  for (;;) {
    const fixture = openFixtures.shift();
    if (fixture === undefined) {
      break;
    }
    await fixture.dispose();
  }
});

describe("§10.3 transport framing：stdio 上的 newline-delimited JSON", () => {
  it("partial line 跨 chunk：换行前不成帧，也不误报 malformed", async () => {
    const { transport, collector } = await openFixture();
    const note = JSON.stringify({ jsonrpc: "2.0", method: "test/split", params: { ok: true } });

    const startedAt = Date.now();
    await transport.sendRequest({
      method: "test/raw",
      params: {
        // 同一条 notification 拆成两次 write，中间留 250ms 让分块真实落地。
        chunks: [note.slice(0, 18), `${note.slice(18)}\n`],
        chunkDelayMs: 250,
        thenRespond: true,
      },
    });

    expect(collector.issues, `framing issues: ${JSON.stringify(collector.issues)}`).toEqual([]);
    expect(collector.notifications).toEqual([{ method: "test/split", params: { ok: true } }]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
  }, 15_000);

  it("一次 write 多条 NDJSON：每行独立成帧且顺序保持", async () => {
    const { transport, collector } = await openFixture();
    const lineA = JSON.stringify({ jsonrpc: "2.0", method: "test/note-a", params: { n: 1 } });
    const lineB = JSON.stringify({ jsonrpc: "2.0", method: "test/note-b", params: { n: 2 } });

    await transport.sendRequest({
      method: "test/raw",
      params: { chunks: [`${lineA}\n${lineB}\n`], thenRespond: true },
    });

    expect(collector.issues).toEqual([]);
    expect(collector.notifications).toEqual([
      { method: "test/note-a", params: { n: 1 } },
      { method: "test/note-b", params: { n: 2 } },
    ]);
  }, 15_000);

  it("本地写出也是 `JSON.stringify` + 单个换行", async () => {
    const { transport } = await openFixture();
    const response = await transport.sendRequest({
      method: "test/echo",
      params: { text: "第一行\n含换行" },
    });
    // params 里的裸换行经 JSON 转义后仍是**一行**（否则 fixture 会解析失败）。
    expect(resultObject(response.result)).toEqual({
      id: response.id,
      echo: { text: "第一行\n含换行" },
    });
  }, 15_000);
});

describe("§10.6 request id 关联与 pending request 生命周期", () => {
  it("并发请求乱序返回：每个 response 只结算它自己的请求", async () => {
    const { transport } = await openFixture();
    const requests = [0, 1, 2, 3].map((index) => ({
      delayMs: 320 - index * 80,
      marker: `req-${String(index)}`,
    }));

    const responses = await Promise.all(
      requests.map(async (request) => {
        const response = await transport.sendRequest({
          method: "test/delay",
          params: { delayMs: request.delayMs, marker: request.marker },
        });
        return { request, response };
      }),
    );

    expect(responses).toHaveLength(4);
    for (const { request, response } of responses) {
      const result = resultObject(response.result);
      expect(result.id, "fixture 回显的 id 必须就是本请求的 id").toBe(response.id);
      expect(result.delayMs).toBe(request.delayMs);
      expect((resultObject(result.echo) as Record<string, unknown>).marker).toBe(request.marker);
    }
    // 乱序确实发生（否则这条测试没有区分力）：最快的那个不是第一个被 await 的。
    expect(Math.min(...requests.map((r) => r.delayMs))).toBeLessThan(
      Math.max(...requests.map((r) => r.delayMs)),
    );
  }, 15_000);

  it("readTimeoutMs 到期报 response_timeout 并清理 pending；transport 仍可用", async () => {
    const { transport, collector } = await openFixture({ readTimeoutMs: 200 });

    const startedAt = Date.now();
    const error = await transport
      .sendRequest({ method: "test/silent", params: { reason: "timeout probe" } })
      .then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe("response_timeout");
    expect((error as AgentError).protocolMethod).toBe("test/silent");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180);

    // pending 已清理：后续请求照常完成，且没有残留 response 打到新请求上。
    const followUp = await transport.sendRequest({ method: "test/echo", params: { n: 1 } });
    expect(resultObject(followUp.result).echo).toEqual({ n: 1 });
    expect(collector.issues).toEqual([]);
  }, 15_000);

  it("迟到的 response 命中已清理的 id：报告 protocol issue，不误结算、不 crash", async () => {
    const { transport, collector } = await openFixture({ readTimeoutMs: 150 });

    await expect(
      transport.sendRequest({ method: "test/delay", params: { delayMs: 400, marker: "late" } }),
    ).rejects.toMatchObject({ code: "response_timeout" });

    await waitFor(() => collector.issues.length > 0);
    expect(collector.issues.map((issue) => issue.reason)).toEqual(["malformed_line"]);
    expect(collector.issues[0]?.message).toMatch(/unknown or already-settled/);

    const next = await transport.sendRequest({ method: "test/echo", params: { ok: true } });
    expect(resultObject(next.result).echo).toEqual({ ok: true });
  }, 15_000);

  it("JSON-RPC error response 映射为 typed response_error（不 resolve 成半成品）", async () => {
    const { transport } = await openFixture();
    const error = await transport
      .sendRequest({ method: "test/error", params: { code: -32603, message: "boom" } })
      .then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe("response_error");
    expect((error as AgentError).message).toContain("-32603");
    expect((error as AgentError).message).toContain("boom");
    expect((error as AgentError).protocolMethod).toBe("test/error");

    // response_error 同样要结算并清理 pending。
    const next = await transport.sendRequest({ method: "test/echo", params: { after: true } });
    expect(resultObject(next.result).echo).toEqual({ after: true });
  }, 15_000);
});

describe("§10.3 / §17.5 stderr 与协议流物理隔离", () => {
  it("stderr 上伪造本请求的合法 response：不得结算 pending", async () => {
    const { transport, collector } = await openFixture();

    const response = await transport.sendRequest({
      method: "test/stderr",
      params: { forgeSameId: true, lines: ["stack trace line 1", "stack trace line 2"] },
    });

    // 若 stderr 进了 parser，这里会是 { forged: true } 而不是 fixture 的 stdout 回信。
    expect(resultObject(response.result)).toEqual({ id: response.id, stderrWritten: true });
    expect(collector.stderrLines).toContain("fixture: plain diagnostic noise");
    expect(collector.stderrLines).toContain("stack trace line 1");
    expect(collector.stderrLines).toContain("stack trace line 2");
    expect(collector.stderrLines.some((line) => line.includes("\"forged\":true"))).toBe(true);
    expect(collector.issues).toEqual([]);
    expect(collector.notifications).toEqual([]);
  }, 15_000);

  it("stderr 持续刷屏 + 超长诊断行：有界缓冲，协议往返不受影响", async () => {
    const { transport, collector } = await openFixture({ maxProtocolLineBytes: 8_192 });
    const noise = Array.from({ length: 200 }, (_unused, index) => `noise ${String(index)}`);

    await transport.sendRequest({
      method: "test/stderr",
      params: { lines: noise, bigLineBytes: 40_000 },
    });
    const echo = await transport.sendRequest({ method: "test/echo", params: { survived: true } });

    expect(resultObject(echo.result).echo).toEqual({ survived: true });
    expect(collector.stderrLines.filter((line) => line.startsWith("noise "))).toHaveLength(200);
    // 超长 stderr 行被丢弃（有界），且只报告一次，不影响 stdout 上的成帧。
    expect(collector.issues.filter((issue) => issue.reason === "oversized_line")).toHaveLength(1);
    expect(collector.issues[0]?.message).toMatch(/stderr line exceeded/);
    expect(collector.stderrLines.some((line) => line.length > 8_192)).toBe(false);
  }, 15_000);
});

describe("§10.1 bounded buffering：oversized / malformed 不成灾", () => {
  it("永不换行的超长行：丢弃 + 报 oversized_line + 之后仍能正常成帧", async () => {
    const { transport, collector } = await openFixture({ maxProtocolLineBytes: 4_096 });

    const response = await transport.sendRequest({
      method: "test/raw",
      params: { oversizedBytes: 500_000, chunkDelayMs: 10, thenRespond: true },
    });

    const oversized = collector.issues.filter((issue) => issue.reason === "oversized_line");
    expect(oversized).toHaveLength(1);
    expect(oversized[0]?.byteLength).toBeGreaterThan(4_096);
    expect(oversized[0]?.message).toMatch(/discarded/);
    // 超限后的恢复行照常解析 → 证明既没有 OOM 也没有 hang。
    expect(resultObject(response.result)).toEqual({ id: response.id, recovered: true });
  }, 20_000);

  it("非 JSON 行与不可判别 envelope：逐条报 malformed_line 后继续服务", async () => {
    const { transport, collector } = await openFixture();

    await transport.sendRequest({
      method: "test/raw",
      params: {
        chunks: ["this is not json\n", "{ broken\n", "[1,2,3]\n", '{"no":"id and no method"}\n'],
        thenRespond: true,
      },
    });

    expect(collector.issues.map((issue) => issue.reason)).toEqual([
      "malformed_line",
      "malformed_line",
      "malformed_line",
      "malformed_line",
    ]);
    const echo = await transport.sendRequest({ method: "test/echo", params: { afterNoise: 1 } });
    expect(resultObject(echo.result).echo).toEqual({ afterNoise: 1 });
  }, 15_000);

  it("stdout 上的通知原样转发，未知 method 不被 transport 解释", async () => {
    const { transport, collector } = await openFixture();
    const note = JSON.stringify({
      jsonrpc: "2.0",
      method: "someFutureProviderMethod/v9",
      params: { nested: { deep: [1, 2, 3] } },
    });

    await transport.sendRequest({
      method: "test/raw",
      params: { chunks: [`${note}\n`], thenRespond: true },
    });

    expect(collector.notifications).toEqual([
      { method: "someFutureProviderMethod/v9", params: { nested: { deep: [1, 2, 3] } } },
    ]);
  }, 15_000);
});

describe("§10.3 / §17.5 进程退出与有界 shutdown", () => {
  it("子进程带非零码退出：pending 报 port_exit（含 exitCode 诊断），onExit 恰好一次", async () => {
    const { transport, collector } = await openFixture();

    const error = await transport
      .sendRequest({ method: "test/exit", params: { code: 3, stderrLine: "fatal from fixture" } })
      .then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe("port_exit");
    expect((error as AgentError).message).toContain("exitCode=3");

    await waitFor(() => collector.exit !== null);
    expect(collector.exit).toEqual({ exitCode: 3, signal: null, stopped: false });
    expect(transport.closed).toBe(true);

    // 退出后的新请求立即失败，不再挂到 read timeout。
    await expect(transport.sendRequest({ method: "test/echo" })).rejects.toMatchObject({
      code: "port_exit",
    });
    expect(() => transport.sendNotification({ method: "test/after-exit" })).toThrow(AgentError);
    await transport.stop();
  }, 15_000);

  it("shutdown 窗口内的 pending 由 port_exit 结算，而不是等 read timeout", async () => {
    const { transport } = await openFixture({
      readTimeoutMs: 30_000,
      shutdownTimeoutMs: 5_000,
    });

    const pending = transport.sendRequest({ method: "test/silent" });
    await transport.stop();

    await expect(pending).rejects.toMatchObject({ code: "port_exit" });
    expect(transport.closed).toBe(true);
    // stop() 幂等。
    await transport.stop();
  }, 15_000);

  it("忽略 SIGTERM 的子进程：stop() 在窗口后升级 SIGKILL 并等它真的消失", async () => {
    const { transport, collector } = await openFixture({ shutdownTimeoutMs: 300 });
    const pid = transport.pid;
    expect(pid).toBeTypeOf("string");

    await transport.sendRequest({ method: "test/block-term" });

    const startedAt = Date.now();
    await transport.stop();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(5_000);
    expect(collector.exit?.signal).toBe("SIGKILL");
    expect(collector.exit?.stopped).toBe(true);
    // 进程真的没了（不只是收到 close 事件）：直接子进程与其进程组都不留。
    expect(await waitFor(() => !isProcessAlive(Number(pid)))).toBe(true);
  }, 20_000);

  it("bash 未 exec 的孙进程随进程组一起终止，不遗留 subprocess", async () => {
    const fixture = await createWorkspaceFixture();
    openFixtures.push(fixture);
    const collector = createCollector();
    const marker = `${fixture.workspacePath}/sibling.pid`;

    // command 里有两条命令 → bash 不会 exec 掉自己，孙进程与 bash 同属一个进程组。
    const transport = await launchFixtureTransport(fixture, {
      command: siblingCommand(marker),
      readTimeoutMs: 4_000,
      shutdownTimeoutMs: 1_000,
      listener: listenerOf(collector),
    });
    openTransports.push(transport);

    const siblingPid = await waitForPidFile(marker);
    expect(siblingPid).toBeTypeOf("number");
    expect(isProcessAlive(siblingPid)).toBe(true);

    const echo = await transport.sendRequest({ method: "test/echo", params: { ok: 1 } });
    expect(resultObject(echo.result).echo).toEqual({ ok: 1 });

    await transport.stop();
    expect(await waitFor(() => !isProcessAlive(siblingPid), 5_000)).toBe(true);
  }, 20_000);
});

describe("transport 的双向面（M4.4 的 policy 由上层注入）", () => {
  it("对端发起的 request 被转发，回信后对端据此完成原请求", async () => {
    const { transport, collector } = await openFixture();

    const pending = transport.sendRequest({
      method: "test/server-request",
      params: { method: "test/ping", timeoutMs: 5_000 },
    });
    expect(await waitFor(() => collector.serverRequests.length === 1)).toBe(true);

    const serverRequest = collector.serverRequests[0];
    expect(serverRequest?.method).toBe("test/ping");
    expect(resultObject(serverRequest?.params ?? {}).originId).toBeDefined();

    transport.respondToServerRequest({ id: serverRequest?.id as string, result: { verdict: "denied" } });

    const response = await pending;
    expect(resultObject(response.result).localReply).toEqual({ verdict: "denied" });
  }, 15_000);

  it("sendNotification 不带 id、不等回信；对端也不会为它回信", async () => {
    const { transport, collector } = await openFixture();
    transport.sendNotification({ method: "test/fire-and-forget", params: { n: 1 } });

    const echo = await transport.sendRequest({ method: "test/echo", params: { after: true } });
    expect(resultObject(echo.result).echo).toEqual({ after: true });
    expect(collector.notifications).toEqual([]);
    expect(collector.issues).toEqual([]);
  }, 15_000);

  it("listener 自己抛异常不得破坏 transport 或冒泡给调用方", async () => {
    const fixture = await createWorkspaceFixture();
    openFixtures.push(fixture);
    const transport = await launchFixtureTransport(fixture, {
      readTimeoutMs: 4_000,
      listener: {
        onNotification: () => {
          throw new Error("listener blew up");
        },
        onStderr: () => {
          throw new Error("stderr listener blew up");
        },
      },
    });
    openTransports.push(transport);

    const note = JSON.stringify({ jsonrpc: "2.0", method: "test/boom" });
    await transport.sendRequest({
      method: "test/raw",
      params: { chunks: [`${note}\n`], thenRespond: true },
    });
    const echo = await transport.sendRequest({ method: "test/echo", params: { ok: true } });
    expect(resultObject(echo.result).echo).toEqual({ ok: true });
  }, 15_000);
});

/**
 * `bash -lc` 下让 bash 自己 fork 一个后台孙进程（`A & B` 形态：bash 不会把自己
 * exec 掉，因此 A 不是 transport 的直接子进程，只有**进程组**信号能带走它）。
 */
function siblingCommand(marker: string): string {
  return `${fixtureCommand(["--background-marker", marker])} & ${fixtureCommand()}`;
}

/** 等 fixture 的后台兄弟进程写下自己的 pid。 */
async function waitForPidFile(file: string, timeoutMs = 8_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = (await readFile(file, "utf8")).trim();
      const pid = Number(text.split("\n")[0]);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    } catch {
      /* 文件还没出现 */
    }
    if (Date.now() >= deadline) {
      throw new Error(`background sibling never registered its pid at ${file}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
