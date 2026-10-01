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
  type AgentEvent,
  type AppServerSession,
  type TransportNotification,
} from "./index";

interface WireInspectorItem {
  readonly step: string;
  readonly received?: Record<string, unknown>;
  readonly cwd?: string;
  readonly params?: unknown;
  readonly response?: {
    readonly id?: unknown;
    readonly result?: unknown;
    readonly error?: {
      readonly code?: number;
      readonly message?: string;
      readonly data?: unknown;
    };
  };
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

describe("Codex App-Server Headless Requests & Runtime Event Mapping (SPEC §10.4 / §10.5 / §10.6 / §17.5, M4.4)", () => {
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

  describe("验收 1: approval never 路径参数化与完成 turn", () => {
    it("v2 command approval 在 never policy 下自动批准并完成 turn", async () => {
      const events: AgentEvent[] = [];
      const inspected: WireInspectorItem[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(["--server-request", "command-approval"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        approvalPolicy: "never",
        onEvent: (event) => events.push(event),
        onNotification: (notification) => {
          if (notification.method === "test/wireInspector") {
            inspected.push(notification.params as WireInspectorItem);
          }
        },
      });

      const outcome = await session.startTurn({ text: "execute command" });
      expect(outcome.turnId).toBe("turn-test-uuid-1");

      const wireResp = inspected.find((item) => item.step === "server_response");
      expect(wireResp).toBeDefined();
      expect(wireResp?.response?.id).toBe("srv-req-1");
      expect(wireResp?.response?.result).toEqual({ decision: "accept" });

      const autoApproved = events.find((e) => e.event === "approval_auto_approved");
      expect(autoApproved).toBeDefined();
      expect(autoApproved?.protocolMethod).toBe("item/commandExecution/requestApproval");
      expect(autoApproved?.threadId).toBe("thread-test-uuid-1");
      expect(autoApproved?.turnId).toBe("turn-test-uuid-1");
      expect(autoApproved?.sessionId).toBe(
        composeSessionId("thread-test-uuid-1", "turn-test-uuid-1"),
      );

      const completed = events.find((e) => e.event === "turn_completed");
      expect(completed).toBeDefined();
    });

    it("v2 file change approval 在 never policy 下自动批准并完成 turn", async () => {
      const events: AgentEvent[] = [];
      const inspected: WireInspectorItem[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(["--server-request", "file-approval"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        approvalPolicy: "never",
        onEvent: (event) => events.push(event),
        onNotification: (notification) => {
          if (notification.method === "test/wireInspector") {
            inspected.push(notification.params as WireInspectorItem);
          }
        },
      });

      const outcome = await session.startTurn({ text: "modify file" });
      expect(outcome.turnId).toBe("turn-test-uuid-1");

      const wireResp = inspected.find((item) => item.step === "server_response");
      expect(wireResp?.response?.result).toEqual({ decision: "accept" });

      expect(
        events.some(
          (e) =>
            e.event === "approval_auto_approved" &&
            e.protocolMethod === "item/fileChange/requestApproval",
        ),
      ).toBe(true);
    });

    it("legacy command approval (execCommandApproval) 在 never policy 下返回 approved", async () => {
      const events: AgentEvent[] = [];
      const inspected: WireInspectorItem[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(["--server-request", "legacy-command-approval"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        approvalPolicy: "never",
        onEvent: (event) => events.push(event),
        onNotification: (notification) => {
          if (notification.method === "test/wireInspector") {
            inspected.push(notification.params as WireInspectorItem);
          }
        },
      });

      const outcome = await session.startTurn({ text: "legacy command" });
      expect(outcome.turnId).toBe("turn-test-uuid-1");

      const wireResp = inspected.find((item) => item.step === "server_response");
      expect(wireResp?.response?.result).toEqual({ decision: "approved" });

      expect(
        events.some(
          (e) =>
            e.event === "approval_auto_approved" &&
            e.protocolMethod === "execCommandApproval",
        ),
      ).toBe(true);
    });

    it("legacy file change approval (applyPatchApproval) 在 never policy 下返回 approved", async () => {
      const events: AgentEvent[] = [];
      const inspected: WireInspectorItem[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(["--server-request", "legacy-file-approval"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        approvalPolicy: "never",
        onEvent: (event) => events.push(event),
        onNotification: (notification) => {
          if (notification.method === "test/wireInspector") {
            inspected.push(notification.params as WireInspectorItem);
          }
        },
      });

      const outcome = await session.startTurn({ text: "legacy patch" });
      expect(outcome.turnId).toBe("turn-test-uuid-1");

      const wireResp = inspected.find((item) => item.step === "server_response");
      expect(wireResp?.response?.result).toEqual({ decision: "approved" });

      expect(
        events.some(
          (e) =>
            e.event === "approval_auto_approved" &&
            e.protocolMethod === "applyPatchApproval",
        ),
      ).toBe(true);
    });

    it("数字类型 request ID 原样回复，不被类型转换破坏", async () => {
      const inspected: WireInspectorItem[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand([
          "--server-request",
          "command-approval",
          "--server-request-id-type",
          "number",
        ]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        approvalPolicy: "never",
        onNotification: (notification) => {
          if (notification.method === "test/wireInspector") {
            inspected.push(notification.params as WireInspectorItem);
          }
        },
      });

      const outcome = await session.startTurn({ text: "numeric id approval" });
      expect(outcome.turnId).toBe("turn-test-uuid-1");

      const wireResp = inspected.find((item) => item.step === "server_response");
      expect(wireResp?.response?.id).toBe(101);
      expect(wireResp?.response?.result).toEqual({ decision: "accept" });
    });
  });

  describe("验收 2: 非 never 审批请求拒绝并不 hang，稳定失败", () => {
    it("string 策略 (on-request) 拒绝请求并以 approval_required 终结", async () => {
      const events: AgentEvent[] = [];
      const inspected: WireInspectorItem[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(["--server-request", "command-approval"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        approvalPolicy: "on-request",
        onEvent: (event) => events.push(event),
        onNotification: (notification) => {
          if (notification.method === "test/wireInspector") {
            inspected.push(notification.params as WireInspectorItem);
          }
        },
      });

      let caught: unknown = null;
      try {
        await session.startTurn({ text: "command under on-request" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AgentError);
      expect((caught as AgentError).code).toBe("approval_required");

      await waitFor(() => inspected.some((item) => item.step === "server_response"));
      const wireResp = inspected.find((item) => item.step === "server_response");
      expect(wireResp?.response?.result).toEqual({ decision: "decline" });

      expect(
        events.some(
          (e) =>
            e.event === "turn_ended_with_error" &&
            e.protocolMethod === "item/commandExecution/requestApproval",
        ),
      ).toBe(true);

      // 验证后续不能再开启新 turn
      await expect(session.startTurn({ text: "turn after fatal" })).rejects.toThrow(
        /Cannot start a new turn/,
      );
    });

    it("object / null / 缺省 policy 绝不推断为 never", async () => {
      // 1. object policy
      session = await startAppServerSession({
        command: appServerFixtureCommand(["--server-request", "command-approval"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        approvalPolicy: { granular: { command: "never" } },
      });
      await expect(session.startTurn({ text: "object policy" })).rejects.toMatchObject({
        code: "approval_required",
      });
      await session.stop();
      session = null;

      // 2. null policy
      session = await startAppServerSession({
        command: appServerFixtureCommand(["--server-request", "command-approval"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        approvalPolicy: null,
      });
      await expect(session.startTurn({ text: "null policy" })).rejects.toMatchObject({
        code: "approval_required",
      });
      await session.stop();
      session = null;

      // 3. 缺省 (undefined) policy
      session = await startAppServerSession({
        command: appServerFixtureCommand(["--server-request", "command-approval"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
      });
      await expect(session.startTurn({ text: "undefined policy" })).rejects.toMatchObject({
        code: "approval_required",
      });
    });

    it("legacy command approval 在非 never 下回复 abort 并报告 approval_required", async () => {
      const inspected: WireInspectorItem[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(["--server-request", "legacy-command-approval"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        approvalPolicy: "on-request",
        onNotification: (notification) => {
          if (notification.method === "test/wireInspector") {
            inspected.push(notification.params as WireInspectorItem);
          }
        },
      });

      await expect(session.startTurn({ text: "legacy abort" })).rejects.toMatchObject({
        code: "approval_required",
      });

      await waitFor(() => inspected.some((item) => item.step === "server_response"));
      const wireResp = inspected.find((item) => item.step === "server_response");
      expect(wireResp?.response?.result).toEqual({ decision: "abort" });
    });

    it("item/permissions/requestApproval 即便在 never 下也不自动同意，返回 error 并失败", async () => {
      const inspected: WireInspectorItem[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(["--server-request", "permissions-approval"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        approvalPolicy: "never",
        onNotification: (notification) => {
          if (notification.method === "test/wireInspector") {
            inspected.push(notification.params as WireInspectorItem);
          }
        },
      });

      await expect(session.startTurn({ text: "permissions req" })).rejects.toMatchObject({
        code: "approval_required",
      });

      await waitFor(() => inspected.some((item) => item.step === "server_response"));
      const wireResp = inspected.find((item) => item.step === "server_response");
      expect(wireResp?.response?.error?.code).toBe(-32000);
    });
  });

  describe("验收 3: 人工输入请求不 hang，稳定失败", () => {
    it("item/tool/requestUserInput 返回 error 并在本地失败为 turn_input_required", async () => {
      const events: AgentEvent[] = [];
      const inspected: WireInspectorItem[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(["--server-request", "user-input"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        onEvent: (event) => events.push(event),
        onNotification: (notification) => {
          if (notification.method === "test/wireInspector") {
            inspected.push(notification.params as WireInspectorItem);
          }
        },
      });

      let caught: unknown = null;
      try {
        await session.startTurn({ text: "ask input" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AgentError);
      expect((caught as AgentError).code).toBe("turn_input_required");

      await waitFor(() => inspected.some((item) => item.step === "server_response"));
      const wireResp = inspected.find((item) => item.step === "server_response");
      expect(wireResp?.response?.error?.code).toBe(-32000);

      expect(
        events.some(
          (e) =>
            e.event === "turn_input_required" &&
            e.protocolMethod === "item/tool/requestUserInput",
        ),
      ).toBe(true);
    });

    it("mcpServer/elicitation/request 返回 cancel 响应并在本地失败为 turn_input_required", async () => {
      const events: AgentEvent[] = [];
      const inspected: WireInspectorItem[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(["--server-request", "mcp-elicitation"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        onEvent: (event) => events.push(event),
        onNotification: (notification) => {
          if (notification.method === "test/wireInspector") {
            inspected.push(notification.params as WireInspectorItem);
          }
        },
      });

      await expect(session.startTurn({ text: "mcp form" })).rejects.toMatchObject({
        code: "turn_input_required",
      });

      await waitFor(() => inspected.some((item) => item.step === "server_response"));
      const wireResp = inspected.find((item) => item.step === "server_response");
      expect(wireResp?.response?.result).toEqual({
        action: "cancel",
        content: null,
        _meta: null,
      });

      expect(
        events.some(
          (e) =>
            e.event === "turn_input_required" &&
            e.protocolMethod === "mcpServer/elicitation/request",
        ),
      ).toBe(true);
    });
  });

  describe("验收 4: unsupported dynamic tool call 返回 structured failure 并继续 session", () => {
    it("item/tool/call 返回 success: false 与 contentItems，turn 顺利完成且后续 turn 可执行", async () => {
      const events: AgentEvent[] = [];
      const inspected: WireInspectorItem[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(["--multi-turn-tool"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        onEvent: (event) => events.push(event),
        onNotification: (notification) => {
          if (notification.method === "test/wireInspector") {
            inspected.push(notification.params as WireInspectorItem);
          }
        },
      });

      // Turn 1 收到 dynamic tool call
      const outcome1 = await session.startTurn({ text: "run dynamic tool" });
      expect(outcome1.turnId).toBe("turn-test-uuid-1");

      await waitFor(() => inspected.some((item) => item.step === "server_response"));
      const wireResp = inspected.find((item) => item.step === "server_response");
      expect(wireResp?.response?.result).toEqual({
        success: false,
        contentItems: [{ type: "inputText", text: "Unsupported tool" }],
      });

      expect(
        events.some(
          (e) =>
            e.event === "unsupported_tool_call" &&
            e.protocolMethod === "item/tool/call",
        ),
      ).toBe(true);

      // 验证 turn 1 成功完成了
      expect(events.some((e) => e.event === "turn_completed" && e.turnId === "turn-test-uuid-1")).toBe(
        true,
      );

      // Turn 2 依然能正常执行并在同一个 session 上完成
      const outcome2 = await session.startTurn({ text: "second normal turn" });
      expect(outcome2.turnId).toBe("turn-test-uuid-2");
      expect(events.some((e) => e.event === "turn_completed" && e.turnId === "turn-test-uuid-2")).toBe(
        true,
      );
    });
  });

  describe("验收 5: usage 与 rate-limit 遥测提取", () => {
    it("thread/tokenUsage/updated 提取 total 快照，不累加、不填零", async () => {
      const events: AgentEvent[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(["--send-usage"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        onEvent: (event) => events.push(event),
      });

      await session.startTurn({ text: "run with usage" });

      const usageEvent = events.find(
        (e) => e.event === "notification" && e.protocolMethod === "thread/tokenUsage/updated",
      );
      expect(usageEvent).toBeDefined();
      expect(usageEvent?.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
      // 验证未把 last 混入 total
      expect(usageEvent?.usage?.inputTokens).not.toBe(20);
    });

    it("非法 usage 字段记录 malformed 事件，不填零且不破坏正常 turn", async () => {
      const events: AgentEvent[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(["--send-invalid-usage"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        onEvent: (event) => events.push(event),
      });

      const outcome = await session.startTurn({ text: "run with bad usage" });
      expect(outcome.turnId).toBe("turn-test-uuid-1");

      const malformed = events.find(
        (e) => e.event === "malformed" && e.protocolMethod === "thread/tokenUsage/updated",
      );
      expect(malformed).toBeDefined();

      // turn 依然成功完成
      expect(events.some((e) => e.event === "turn_completed")).toBe(true);
    });

    it("account/rateLimits/updated 提取 opaque 快照，account 级不强加 turn 身份", async () => {
      const events: AgentEvent[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(["--send-rate-limits"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        onEvent: (event) => events.push(event),
      });

      await session.startTurn({ text: "run with rate limits" });

      const rateLimitEvent = events.find(
        (e) => e.event === "notification" && e.protocolMethod === "account/rateLimits/updated",
      );
      expect(rateLimitEvent).toBeDefined();
      expect(rateLimitEvent?.rateLimits).toBeDefined();
      expect((rateLimitEvent?.rateLimits as Record<string, unknown>).limitId).toBe("lim-1");

      // account 级限流不强加 turnId 与 sessionId
      expect("turnId" in (rateLimitEvent ?? {})).toBe(false);
      expect("sessionId" in (rateLimitEvent ?? {})).toBe(false);
    });
  });

  describe("验收 6: malformed / notification / other-message 不污染正常关联", () => {
    it("坏 JSON 行被记录为 malformed，协议恢复后 turn 仍正常完成", async () => {
      const events: AgentEvent[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(["--send-malformed-line"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        onEvent: (event) => events.push(event),
      });

      const outcome = await session.startTurn({ text: "turn with bad json line" });
      expect(outcome.turnId).toBe("turn-test-uuid-1");

      expect(events.some((e) => e.event === "malformed")).toBe(true);
      expect(events.some((e) => e.event === "turn_completed")).toBe(true);
    });

    it("未知 response ID 报告为 other_message，不影响正常 pending 关联", async () => {
      const events: AgentEvent[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(["--send-unknown-response"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        onEvent: (event) => events.push(event),
      });

      const outcome = await session.startTurn({ text: "turn with unexpected response" });
      expect(outcome.turnId).toBe("turn-test-uuid-1");

      expect(events.some((e) => e.event === "other_message")).toBe(true);
      expect(events.some((e) => e.event === "turn_completed")).toBe(true);
    });

    it("approval request 参数非法时返回 invalid-params (-32602) 并以 protocol_error 终结", async () => {
      const inspected: WireInspectorItem[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(["--server-request", "invalid-approval-params"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        approvalPolicy: "never",
        onNotification: (notification) => {
          if (notification.method === "test/wireInspector") {
            inspected.push(notification.params as WireInspectorItem);
          }
        },
      });

      await expect(session.startTurn({ text: "bad approval params" })).rejects.toMatchObject({
        code: "protocol_error",
      });

      await waitFor(() => inspected.some((item) => item.step === "server_response"));
      const wireResp = inspected.find((item) => item.step === "server_response");
      expect(wireResp?.response?.error?.code).toBe(-32602);
    });
  });

  describe("验收 7: 时序、早到请求与生命周期收敛", () => {
    it("completion 早于 start response：有界暂存并在取得身份后先发 session_started 再发终态事件", async () => {
      const events: AgentEvent[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(["--early-completed"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        onEvent: (event) => events.push(event),
      });

      const outcome = await session.startTurn({ text: "early completed turn" });
      expect(outcome.turnId).toBe("turn-test-uuid-1");

      const turnStartedIdx = events.findIndex(
        (e) => e.event === "session_started" && e.turnId === "turn-test-uuid-1",
      );
      const turnCompletedIdx = events.findIndex(
        (e) => e.event === "turn_completed" && e.turnId === "turn-test-uuid-1",
      );

      expect(turnStartedIdx).toBeGreaterThanOrEqual(0);
      expect(turnCompletedIdx).toBeGreaterThan(turnStartedIdx);
    });

    it("异 thread / 异 turn completion 夹入不影响当前 turn 结算", async () => {
      const events: AgentEvent[] = [];

      session = await startAppServerSession({
        command: appServerFixtureCommand(["--interleaved-other-completed"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        onEvent: (event) => events.push(event),
      });

      const outcome = await session.startTurn({ text: "interleaved completion" });
      expect(outcome.turnId).toBe("turn-test-uuid-1");

      // 异 thread / 异 turn 的 completion 发送了 other_message
      expect(
        events.some(
          (e) =>
            e.event === "other_message" &&
            e.protocolMethod === "turn/completed",
        ),
      ).toBe(true);

      // 当前匹配的 turn 仍正常 completed
      expect(events.some((e) => e.event === "turn_completed" && e.turnId === "turn-test-uuid-1")).toBe(
        true,
      );
    });

    it("在等待 turn/start 响应期间发生 fatal request：外部 Promise 立即失败不挂起", async () => {
      session = await startAppServerSession({
        command: appServerFixtureCommand([
          "--server-request",
          "user-input",
          "--server-request-timing",
          "before-start-response",
        ]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
      });

      // startTurn 会在等待 turn/start response 期间收到 user-input，必须立即失败
      await expect(session.startTurn({ text: "early fatal request" })).rejects.toMatchObject({
        code: "turn_input_required",
      });
    });

    it("listener 抛出异常不破坏 session 执行与回复", async () => {
      session = await startAppServerSession({
        command: appServerFixtureCommand(["--server-request", "command-approval"]),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        approvalPolicy: "never",
        onEvent: () => {
          throw new Error("listener crashed");
        },
      });

      const outcome = await session.startTurn({ text: "throwing listener" });
      expect(outcome.turnId).toBe("turn-test-uuid-1");
    });

    it("thread 启动阶段只发射 session_started (不带 turnId)，启动失败发射 startup_failed", async () => {
      const events: AgentEvent[] = [];

      // 1. 成功启动
      session = await startAppServerSession({
        command: appServerFixtureCommand(),
        workspacePath: fixture.workspacePath,
        workspacePathSafety: fixture.manager,
        onEvent: (event) => events.push(event),
      });

      const threadStarted = events.find(
        (e) => e.event === "session_started" && e.threadId === "thread-test-uuid-1",
      );
      expect(threadStarted).toBeDefined();
      expect("turnId" in (threadStarted ?? {})).toBe(false);
      expect("sessionId" in (threadStarted ?? {})).toBe(false);

      await session.stop();
      session = null;
      events.length = 0;

      // 2. 失败启动
      await expect(
        startAppServerSession({
          command: "node nonexistent-test-binary-12345.mjs",
          workspacePath: fixture.workspacePath,
          workspacePathSafety: fixture.manager,
          onEvent: (event) => events.push(event),
        }),
      ).rejects.toThrow();

      expect(events.some((e) => e.event === "startup_failed")).toBe(true);
    });
  });
});

