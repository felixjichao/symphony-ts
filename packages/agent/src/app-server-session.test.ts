import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeSessionId } from "@symphony/domain";
import {
  appServerFixtureCommand,
  createWorkspaceFixture,
  isProcessAlive,
  waitFor,
  type WorkspaceFixture,
} from "../test-fixtures/harness";
import {
  AgentError,
  startAppServerSession,
  type AppServerSession,
  type TransportNotification,
} from "./index";

interface WireInspectorItem {
  readonly step: string;
  readonly received?: Record<string, unknown>;
  readonly cwd?: string;
  readonly params?: unknown;
}

describe("Codex App-Server Session Lifecycle (SPEC §10.2 / §10.3 / §10.6 / §17.5, M4.3)", () => {
  let fixture: WorkspaceFixture;
  let session: AppServerSession | null = null;

  beforeEach(async () => {
    fixture = await createWorkspaceFixture();
  });

  afterEach(async () => {
    if (session !== null) {
      try {
        await session.stop();
      } catch {
        /* ignore */
      }
      session = null;
    }
    await fixture.dispose();
  });

  describe("验收 #1, #2, #3: 正常启动流与身份 / cwd 校验", () => {
    it("完整走通 initialize → initialized → thread/start → turn/start 并提取正确身份与 cwd", async () => {
      const notifications: TransportNotification[] = [];
      const inspected: WireInspectorItem[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        turnTimeoutMs: 5_000,
        onNotification(notification) {
          notifications.push(notification);
          if (notification.method === "test/wireInspector") {
            inspected.push(notification.params as WireInspectorItem);
          }
        },
      });

      // 验收 #2: threadId 正确提取，pid 正确透出
      expect(session.threadId).toBe("thread-test-uuid-1");
      expect(session.codexAppServerPid).not.toBeNull();
      const pidNum = Number.parseInt(session.codexAppServerPid!, 10);
      expect(Number.isFinite(pidNum)).toBe(true);
      expect(isProcessAlive(pidNum)).toBe(true);

      // 验证 initialized notification 已发出且无 params
      const initializedWire = inspected.find((item) => item.step === "initialized");
      expect(initializedWire).toBeDefined();
      expect(initializedWire?.params).toBeUndefined();

      // 执行 turn/start
      const outcome = await session.startTurn({ text: "implement feature x" });

      // 验收 #2: turn ID / session ID 提取正确
      expect(outcome.turnId).toBe("turn-test-uuid-1");
      expect(outcome.sessionId).toBe(
        composeSessionId("thread-test-uuid-1", "turn-test-uuid-1"),
      );

      // 验收 #3: thread/start 与 turn/start 的 cwd 都等于 workspacePath，且 fixture 的 pwd 等于 workspacePath
      const threadStartWire = inspected.find((item) => item.step === "thread/start");
      expect(threadStartWire).toBeDefined();
      expect(threadStartWire?.received?.cwd).toBe(fixture.workspacePath);
      expect(threadStartWire?.cwd).toBe(fixture.workspacePath);

      const turnStartWire = inspected.find((item) => item.step === "turn/start");
      expect(turnStartWire).toBeDefined();
      expect(turnStartWire?.received?.cwd).toBe(fixture.workspacePath);
      expect(turnStartWire?.cwd).toBe(fixture.workspacePath);

      // 验收 turn/start input 格式包含 text_elements: []
      const receivedInput = turnStartWire?.received?.input as unknown[];
      expect(Array.isArray(receivedInput)).toBe(true);
      expect(receivedInput[0]).toEqual({
        type: "text",
        text: "implement feature x",
        text_elements: [],
      });
    });

    it("pass-through policy 映射正确：非 null 原样写出，null / undefined 缺席", async () => {
      const inspected: WireInspectorItem[] = [];

      // 1. 提供 policy
      session = await startAppServerSession({
        command: appServerFixtureCommand(),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        approvalPolicy: "never",
        threadSandbox: "custom-sandbox-mode",
        turnSandboxPolicy: { type: "customPolicy", test: 123 },
        onNotification(notification) {
          if (notification.method === "test/wireInspector") {
            inspected.push(notification.params as WireInspectorItem);
          }
        },
      });

      await session.startTurn({ text: "test policies" });

      const threadStartWire = inspected.find((item) => item.step === "thread/start");
      expect(threadStartWire?.received?.approvalPolicy).toBe("never");
      expect(threadStartWire?.received?.sandbox).toBe("custom-sandbox-mode");

      const turnStartWire = inspected.find((item) => item.step === "turn/start");
      expect(turnStartWire?.received?.approvalPolicy).toBe("never");
      expect(turnStartWire?.received?.sandboxPolicy).toEqual({
        type: "customPolicy",
        test: 123,
      });

      await session.stop();
      session = null;
      inspected.length = 0;

      // 2. null / undefined 时键缺席
      session = await startAppServerSession({
        command: appServerFixtureCommand(),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        approvalPolicy: null,
        threadSandbox: null,
        turnSandboxPolicy: null,
        onNotification(notification) {
          if (notification.method === "test/wireInspector") {
            inspected.push(notification.params as WireInspectorItem);
          }
        },
      });

      await session.startTurn({ text: "test null policies" });

      const threadWireNull = inspected.find((item) => item.step === "thread/start");
      expect(threadWireNull?.received && "approvalPolicy" in threadWireNull.received).toBe(false);
      expect(threadWireNull?.received && "sandbox" in threadWireNull.received).toBe(false);

      const turnWireNull = inspected.find((item) => item.step === "turn/start");
      expect(turnWireNull?.received && "approvalPolicy" in turnWireNull.received).toBe(false);
      expect(turnWireNull?.received && "sandboxPolicy" in turnWireNull.received).toBe(false);
    });
  });

  describe("验收 #4: completion 必须以 turn.status 判定，不能只看 method", () => {
    it("turn.status === 'completed' 时正常 resolve", async () => {
      session = await startAppServerSession({
        command: appServerFixtureCommand(["--turn-status", "completed"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
      });

      const outcome = await session.startTurn({ text: "do work" });
      expect(outcome.turnId).toBe("turn-test-uuid-1");
    });

    it("turn.status === 'failed' 时 reject 为 turn_failed 且携带诊断消息与详情", async () => {
      session = await startAppServerSession({
        command: appServerFixtureCommand([
          "--turn-status",
          "failed",
          "--turn-error-message",
          "Rate limit exceeded or prompt syntax error",
        ]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
      });

      let caught: unknown = null;
      try {
        await session.startTurn({ text: "do work" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AgentError);
      const agentError = caught as AgentError;
      expect(agentError.code).toBe("turn_failed");
      expect(agentError.message).toBe("Rate limit exceeded or prompt syntax error");
      expect(agentError.threadId).toBe("thread-test-uuid-1");
      expect(agentError.turnId).toBe("turn-test-uuid-1");
      expect(agentError.sessionId).toBe(
        composeSessionId("thread-test-uuid-1", "turn-test-uuid-1"),
      );
      expect(agentError.protocolMethod).toBe("turn/completed");
    });

    it("turn.status === 'interrupted' 时 reject 为 turn_cancelled 且携带诊断", async () => {
      session = await startAppServerSession({
        command: appServerFixtureCommand([
          "--turn-status",
          "interrupted",
          "--turn-error-message",
          "Turn interrupted by user cancellation",
        ]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
      });

      let caught: unknown = null;
      try {
        await session.startTurn({ text: "do work" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AgentError);
      const agentError = caught as AgentError;
      expect(agentError.code).toBe("turn_cancelled");
      expect(agentError.message).toBe("Turn interrupted by user cancellation");
      expect(agentError.turnId).toBe("turn-test-uuid-1");
      expect(agentError.protocolMethod).toBe("turn/completed");
    });

    it("turn.status === 'inProgress'（非终态）时 reject 为 protocol_error", async () => {
      session = await startAppServerSession({
        command: appServerFixtureCommand(["--turn-status", "inProgress"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
      });

      let caught: unknown = null;
      try {
        await session.startTurn({ text: "do work" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AgentError);
      const agentError = caught as AgentError;
      expect(agentError.code).toBe("protocol_error");
      expect(agentError.message).toContain("invalid turn status: inProgress");
    });

    it("payload 形状非法（缺少 turn.id）时 reject 为 protocol_error", async () => {
      session = await startAppServerSession({
        command: appServerFixtureCommand(["--malformed-completed"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
      });

      let caught: unknown = null;
      try {
        await session.startTurn({ text: "do work" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AgentError);
      const agentError = caught as AgentError;
      expect(agentError.code).toBe("protocol_error");
      expect(agentError.message).toContain("turn/completed payload");
    });

    it("忽略不匹配当前 turnId 的迟到/异常通知，继续等待正确 turnId 结算", async () => {
      session = await startAppServerSession({
        command: appServerFixtureCommand(["--unmatched-completed-first"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
      });

      // fixture 会先发 unmatched-turn-id，随后发当前 turn-test-uuid-1 的 completed
      const outcome = await session.startTurn({ text: "do work" });
      expect(outcome.turnId).toBe("turn-test-uuid-1");
    });
  });

  describe("验收 #5: silent turn timeout 与 output 重置 timer", () => {
    it("turn stream 持续静默时在 turnTimeoutMs 到期后报 turn_timeout，且不主动 kill 进程", async () => {
      session = await startAppServerSession({
        command: appServerFixtureCommand(["--silent-turn"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        turnTimeoutMs: 150,
      });

      const pidNum = parseInt(session.codexAppServerPid!, 10);
      expect(isProcessAlive(pidNum)).toBe(true);

      let caught: unknown = null;
      try {
        await session.startTurn({ text: "silent turn test" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AgentError);
      const agentError = caught as AgentError;
      expect(agentError.code).toBe("turn_timeout");
      expect(agentError.message).toContain("silent for 150 ms");
      expect(agentError.turnId).toBe("turn-test-uuid-1");

      // 验证不主动 kill 进程：子进程依然存活
      expect(isProcessAlive(pidNum)).toBe(true);
    });

    it("持续 notification 输出会重置 silence timer，turn 正常完成不超时", async () => {
      // turnTimeoutMs 设为 80ms，fixture 每 25ms 发一次 notification（共 4 次），总耗时 > 100ms
      session = await startAppServerSession({
        command: appServerFixtureCommand([
          "--periodic-notifications",
          "4",
          "--delay-completed-ms",
          "20",
        ]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        turnTimeoutMs: 80,
      });

      const outcome = await session.startTurn({ text: "periodic notification test" });
      expect(outcome.turnId).toBe("turn-test-uuid-1");
    });

    it("stderr 诊断流刷屏不重置 silence timer，依然发生 turn_timeout", async () => {
      const stderrLines: string[] = [];
      session = await startAppServerSession({
        command: appServerFixtureCommand(["--stderr-spam", "--silent-turn"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        turnTimeoutMs: 150,
        onStderr(line) {
          stderrLines.push(line);
        },
      });

      let caught: unknown = null;
      try {
        await session.startTurn({ text: "stderr spam test" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AgentError);
      expect((caught as AgentError).code).toBe("turn_timeout");
      expect(stderrLines.length).toBeGreaterThan(0);
    });
  });

  describe("验收 #6: early process exit / response error / invalid response shape", () => {
    it("turn 运行中子进程非预期早退时 reject 为 port_exit", async () => {
      session = await startAppServerSession({
        command: appServerFixtureCommand(["--exit-during-turn"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
      });

      let caught: unknown = null;
      try {
        await session.startTurn({ text: "trigger exit" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AgentError);
      const agentError = caught as AgentError;
      expect(agentError.code).toBe("port_exit");
      expect(agentError.turnId).toBe("turn-test-uuid-1");
    });

    it("turn/start 收到 JSON-RPC error 响应时 reject 为 response_error", async () => {
      session = await startAppServerSession({
        command: appServerFixtureCommand(["--error-on-turn-start"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
      });

      let caught: unknown = null;
      try {
        await session.startTurn({ text: "trigger jsonrpc error" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AgentError);
      const agentError = caught as AgentError;
      expect(agentError.code).toBe("response_error");
      expect(agentError.message).toContain("Turn start failed on purpose");
    });

    it("thread/start 缺少 thread.id 时 startup 失败，reject 为 protocol_error 且不遗留子进程", async () => {
      let caught: unknown = null;
      try {
        await startAppServerSession({
          command: appServerFixtureCommand(["--missing-thread-id"]),
          workspacePath: fixture.workspacePath,
          workspacePathSafety: fixture.manager,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AgentError);
      const agentError = caught as AgentError;
      expect(agentError.code).toBe("protocol_error");
      expect(agentError.message).toContain("thread/start response missing valid thread.id");

      // 验证未遗留孤儿子进程
      if (agentError.codexAppServerPid) {
        const pidNum = parseInt(agentError.codexAppServerPid, 10);
        const dead = await waitFor(() => !isProcessAlive(pidNum), 3_000);
        expect(dead).toBe(true);
      }
    });

    it("initialize 缺少 userAgent 时 startup 失败，reject 为 protocol_error 且清理子进程", async () => {
      let caught: unknown = null;
      try {
        await startAppServerSession({
          command: appServerFixtureCommand(["--invalid-init"]),
          workspacePath: fixture.workspacePath,
          workspacePathSafety: fixture.manager,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AgentError);
      const agentError = caught as AgentError;
      expect(agentError.code).toBe("protocol_error");
      expect(agentError.message).toContain("initialize response missing userAgent");

      if (agentError.codexAppServerPid) {
        const pidNum = parseInt(agentError.codexAppServerPid, 10);
        const dead = await waitFor(() => !isProcessAlive(pidNum), 3_000);
        expect(dead).toBe(true);
      }
    });

    it("turn/start 响应状态非 inProgress 时 reject 为 protocol_error", async () => {
      session = await startAppServerSession({
        command: appServerFixtureCommand(["--invalid-turn-response"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
      });

      let caught: unknown = null;
      try {
        await session.startTurn({ text: "trigger invalid turn response" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AgentError);
      const agentError = caught as AgentError;
      expect(agentError.code).toBe("protocol_error");
      expect(agentError.message).toContain("turn/start response invalid");
    });
  });

  describe("验收 #7: 同 thread 连续两个 turn 与单活跃 turn 不变量", () => {
    it("同一个 session 连续执行两个 turn：thread ID 不变，turn ID 改变，sessionId 正确合成", async () => {
      session = await startAppServerSession({
        command: appServerFixtureCommand(),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
      });

      const initialThreadId = session.threadId;

      // Turn 1
      const turn1 = await session.startTurn({ text: "first turn" });
      expect(session.threadId).toBe(initialThreadId);
      expect(turn1.turnId).toBe("turn-test-uuid-1");
      expect(turn1.sessionId).toBe(
        composeSessionId(initialThreadId, "turn-test-uuid-1"),
      );

      // Turn 2
      const turn2 = await session.startTurn({ text: "second turn" });
      expect(session.threadId).toBe(initialThreadId);
      expect(turn2.turnId).toBe("turn-test-uuid-2");
      expect(turn2.sessionId).toBe(
        composeSessionId(initialThreadId, "turn-test-uuid-2"),
      );

      expect(turn1.turnId).not.toBe(turn2.turnId);
      expect(turn1.sessionId).not.toBe(turn2.sessionId);
    });

    it("并发调用 startTurn 时违反单活跃 turn 不变量，第二次调用立即拒绝为 protocol_error", async () => {
      session = await startAppServerSession({
        command: appServerFixtureCommand(["--delay-completed-ms", "100"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
      });

      // 启动第一个 turn（需要 100ms 完成）
      const turn1Promise = session.startTurn({ text: "first in flight" });

      // 立即尝试启动第二个 turn
      let concurrentError: unknown = null;
      try {
        await session.startTurn({ text: "second concurrent" });
      } catch (err) {
        concurrentError = err;
      }

      expect(concurrentError).toBeInstanceOf(AgentError);
      expect((concurrentError as AgentError).code).toBe("protocol_error");
      expect((concurrentError as AgentError).message).toContain("single active turn invariant");

      // 第一个 turn 依然能正常完成
      const outcome1 = await turn1Promise;
      expect(outcome1.turnId).toBe("turn-test-uuid-1");
    });

    it("session 停止后调用 startTurn 立即拒绝为 port_exit", async () => {
      session = await startAppServerSession({
        command: appServerFixtureCommand(),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
      });

      await session.stop();

      let caught: unknown = null;
      try {
        await session.startTurn({ text: "after stop" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AgentError);
      expect((caught as AgentError).code).toBe("port_exit");
      expect((caught as AgentError).message).toContain("stopped");
    });
  });

  describe("stop() 幂等与进程有界关停", () => {
    it("连续多次 stop() 幂等成功，子进程确定性退出", async () => {
      session = await startAppServerSession({
        command: appServerFixtureCommand(),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
      });

      const pidNum = parseInt(session.codexAppServerPid!, 10);
      expect(isProcessAlive(pidNum)).toBe(true);

      await session.stop();
      await session.stop(); // 连续调用不抛错

      const dead = await waitFor(() => !isProcessAlive(pidNum), 5_000);
      expect(dead).toBe(true);
    });
  });
});
