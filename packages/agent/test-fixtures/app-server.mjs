// M4.3 / M4.4 Codex app-server 测试 fixture：真实 NDJSON/JSON-RPC 子进程
// （SPEC §10.2 / §10.3 / §10.4 / §10.5 / §10.6 / §17.5，#39 / #40）。
//
// 模拟 pinned rust-v0.159.2 的 app-server 行为：
// initialize -> initialized -> thread/start -> turn/start -> turn/completed。
//
// 场景支持：
//   --invalid-init             initialize 返回缺失 userAgent 的响应
//   --missing-thread-id        thread/start 返回缺失 thread.id 的响应
//   --error-on-turn-start      turn/start 返回 JSON-RPC error
//   --invalid-turn-response    turn/start 返回非 inProgress 的非法状态
//   --turn-status <status>     turn/completed 携带的 status（completed / failed / interrupted / inProgress / unknown）
//   --turn-error-message <msg> turn/completed 携带的 turn.error.message
//   --silent-turn              turn/start 后保持静默（用于 turn_timeout 测试）
//   --exit-on-turn-start       turn/start 收到时立即退出
//   --exit-during-turn         turn/start 响应后子进程退出
//   --stderr-spam              turn 等待期间向 stderr 刷日志（验证 stderr 不重置 silence timer）
//   --periodic-notifications N turn 等待期间发送 N 次 notification（验证 notification 重置 silence timer）
//   --unmatched-completed-first 发送不匹配的 turn/completed 再发匹配的
//   --malformed-completed      发送畸形 turn/completed（缺少 turn.id）
//   --delay-completed-ms <ms>  延迟发送 turn/completed 的毫秒数
//
// M4.4 新增场景：
//   --server-request <type>    在 turn 期间向 client 发起 server request
//                              (command-approval / file-approval / legacy-command-approval /
//                               legacy-file-approval / user-input / mcp-elicitation /
//                               permissions-approval / unsupported-tool / auth-refresh /
//                               attestation / unknown-request / invalid-approval-params)
//   --server-request-id-type <string|number> server request id 的类型（默认 string）
//   --server-request-timing <before-start-response|during-turn> 发起时机（默认 during-turn）
//   --early-completed          在回复 turn/start 之前先发送 turn/completed
//   --interleaved-other-completed 发送异 thread/turn completion 夹入
//   --send-usage               发送合法的 thread/tokenUsage/updated
//   --send-invalid-usage       发送非法字段值的 thread/tokenUsage/updated
//   --send-rate-limits         发送 account/rateLimits/updated
//   --send-malformed-line      发送非 JSON 文本行
//   --send-unknown-response    发送未知的 response id
//   --multi-turn-tool          turn 1 触发 unsupported tool，client 回复后完成 turn 1；turn 2 正常完成

import fs from "node:fs";
import readline from "node:readline";
import process from "node:process";
import { clearInterval, setInterval, setTimeout } from "node:timers";

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== "string" || !arg.startsWith("--")) {
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || (typeof next === "string" && next.startsWith("--"))) {
      options[name] = true;
    } else {
      options[name] = next;
      i += 1;
    }
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));

if (args["exit-before-handshake"]) {
  const code =
    args["exit-before-handshake"] === true
      ? 127
      : Number.parseInt(args["exit-before-handshake"], 10) || 127;
  process.exit(code);
}

if (args["record-startup"]) {
  try {
    fs.writeFileSync(args["record-startup"], `${process.pid}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

if (args["record-world"]) {
  try {
    fs.writeFileSync(
      args["record-world"],
      JSON.stringify({
        pid: process.pid,
        cwd: process.cwd(),
        argv: process.argv.slice(2),
        args,
      }),
      "utf8",
    );
  } catch {
    /* ignore */
  }
}

if (args["record-exit"]) {
  process.on("exit", () => {
    try {
      fs.writeFileSync(args["record-exit"], `${process.pid}\n`, "utf8");
    } catch {
      /* ignore */
    }
  });
}

function writeLine(value) {
  if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  }
}

function respond(id, result) {
  writeLine({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  writeLine({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method, params) {
  writeLine({ jsonrpc: "2.0", method, params });
}

let turnCount = 0;
const pendingServerRequests = new Map();

function sendServerRequest(type, threadId, turnId, onDone) {
  const reqId = args["server-request-id-type"] === "number" ? 101 : "srv-req-1";
  let method = "";
  let params = {};

  switch (type) {
    case "command-approval":
      method = "item/commandExecution/requestApproval";
      params = {
        threadId,
        turnId,
        itemId: "item-cmd-1",
        command: "rm -rf /",
        cwd: process.cwd(),
      };
      break;
    case "file-approval":
      method = "item/fileChange/requestApproval";
      params = {
        threadId,
        turnId,
        itemId: "item-file-1",
        reason: "Write file",
      };
      break;
    case "invalid-approval-params":
      method = "item/commandExecution/requestApproval";
      params = {
        threadId,
        // missing turnId and itemId!
      };
      break;
    case "invalid-legacy-command-params":
      method = "execCommandApproval";
      params = {
        conversationId: threadId,
        callId: "call-1",
        command: 42,
        cwd: false,
      };
      break;
    case "invalid-legacy-file-params":
      method = "applyPatchApproval";
      params = {
        conversationId: threadId,
        callId: "call-1",
        fileChanges: "not-an-object",
      };
      break;
    case "invalid-permissions-params":
      method = "item/permissions/requestApproval";
      params = {
        threadId,
        turnId,
        itemId: "item-perm-1",
        permissions: "not-an-object",
      };
      break;
    case "legacy-command-approval":
      method = "execCommandApproval";
      params = {
        conversationId: threadId,
        callId: "call-1",
        command: ["echo", "hi"],
        cwd: process.cwd(),
      };
      break;
    case "legacy-file-approval":
      method = "applyPatchApproval";
      params = {
        conversationId: threadId,
        callId: "call-1",
        fileChanges: {},
      };
      break;
    case "user-input":
      method = "item/tool/requestUserInput";
      params = {
        threadId,
        turnId,
        itemId: "item-input-1",
        questions: [{ question: "Do you confirm?" }],
        isBlocking: true,
      };
      break;
    case "mcp-elicitation":
      method = "mcpServer/elicitation/request";
      params = {
        threadId,
        turnId,
        serverName: "test-mcp-server",
        mode: "form",
        message: "Please input api key",
        requestedSchema: {},
      };
      break;
    case "permissions-approval":
      method = "item/permissions/requestApproval";
      params = {
        threadId,
        turnId,
        itemId: "item-perm-1",
        permissions: {},
      };
      break;
    case "unsupported-tool":
      method = "item/tool/call";
      params = {
        threadId,
        turnId,
        callId: "call-tool-1",
        tool: "custom_dynamic_tool",
        arguments: { foo: "bar" },
      };
      break;
    case "auth-refresh":
      method = "account/chatgptAuthTokens/refresh";
      params = {};
      break;
    case "attestation":
      method = "attestation/generate";
      params = {};
      break;
    case "unknown-request":
      method = "custom/unknownServerRequest";
      params = {};
      break;
    default:
      method = type;
      params = {};
      break;
  }

  pendingServerRequests.set(reqId, {
    method,
    onResponse: (response) => {
      onDone(response);
    },
  });

  writeLine({ jsonrpc: "2.0", id: reqId, method, params });
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (args["record-transcript"]) {
    try {
      fs.appendFileSync(args["record-transcript"], `${JSON.stringify(message)}\n`, "utf8");
    } catch {
      /* ignore */
    }
  }

  // Client notification（如 initialized）
  if (message.id === undefined && message.method) {
    notify("test/wireInspector", {
      step: message.method,
      params: message.params,
    });
    return;
  }

  // Client response to server request (has id, but no method)
  if (message.id !== undefined && message.method === undefined) {
    notify("test/wireInspector", {
      step: "server_response",
      response: message,
    });
    const pending = pendingServerRequests.get(message.id);
    if (pending) {
      pendingServerRequests.delete(message.id);
      pending.onResponse(message);
    }
    return;
  }

  const { id, method, params } = message;

  switch (method) {
    case "initialize": {
      if (args["silent-init"]) {
        return;
      }
      if (args["delay-init-ms"]) {
        setTimeout(() => {
          respond(id, {
            userAgent: "codex-app-server/0.159.2 (test-fixture)",
            codexHome: "/tmp/codex",
            platformFamily: "unix",
            platformOs: "linux",
          });
        }, Number.parseInt(args["delay-init-ms"], 10) || 0);
        return;
      }
      if (args["invalid-init"]) {
        respond(id, {});
        return;
      }
      respond(id, {
        userAgent: "codex-app-server/0.159.2 (test-fixture)",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "linux",
      });
      return;
    }

    case "thread/start": {
      notify("test/wireInspector", {
        step: "thread/start",
        received: params,
        cwd: process.cwd(),
      });
      if (args["missing-thread-id"]) {
        respond(id, { thread: {} });
        return;
      }
      respond(id, {
        thread: {
          id: "thread-test-uuid-1",
        },
      });
      return;
    }

    case "turn/start": {
      notify("test/wireInspector", {
        step: "turn/start",
        received: params,
        cwd: process.cwd(),
      });

      if (args["exit-on-turn-start"]) {
        process.exit(1);
        return;
      }

      if (args["error-on-turn-start"]) {
        respondError(id, -32000, "Turn start failed on purpose");
        return;
      }

      turnCount += 1;
      const turnId = `turn-test-uuid-${turnCount}`;

      if (args["invalid-turn-response"]) {
        respond(id, {
          turn: {
            id: turnId,
            status: "completed",
          },
        });
        return;
      }

      const delayMs = args["delay-completed-ms"]
        ? Number.parseInt(args["delay-completed-ms"], 10)
        : 20;

      // 场景：在回复 turn/start 之前先发送 server request
      if (
        args["server-request"] &&
        args["server-request-timing"] === "before-start-response"
      ) {
        sendServerRequest(args["server-request"], params.threadId, turnId, (response) => {
          // 收到 client 对早到 server request 的回包
          notify("test/wireInspector", {
            step: "server_request_resolved_early",
            response,
          });
          // 如果是 auto-approved，则继续发送 turn/start response 和完成通知
          if (
            response.result?.decision === "accept" ||
            response.result?.decision === "approved"
          ) {
            respond(id, {
              turn: {
                id: turnId,
                status: "inProgress",
              },
            });
            setTimeout(() => {
              sendCompletedNotification(params.threadId, turnId);
            }, delayMs);
          }
          // 若不是 auto-approved（如 decline 或 error），client 应立即失败；此处不继续发 start 响应
        });
        return;
      }

      // 场景：early-completed（在 turn/start 响应之前先发送 turn/completed）
      if (args["early-completed"]) {
        sendCompletedNotification(params.threadId, turnId);
        setTimeout(() => {
          respond(id, {
            turn: {
              id: turnId,
              status: "inProgress",
            },
          });
        }, delayMs);
        return;
      }

      // 正常先回复 turn/start
      respond(id, {
        turn: {
          id: turnId,
          status: "inProgress",
        },
      });

      if (args["exit-during-turn"]) {
        setTimeout(() => {
          process.exit(2);
        }, 50);
        return;
      }

      if (args["stderr-spam"]) {
        const interval = setInterval(() => {
          process.stderr.write("diagnostic stderr line\n");
        }, 15);
        setTimeout(() => clearInterval(interval), 2000);
        return;
      }

      if (args["send-malformed-line"]) {
        writeLine("{ not a valid json object");
      }

      if (args["send-unknown-response"]) {
        writeLine({
          jsonrpc: "2.0",
          id: "unprompted-late-response-id-999",
          result: { late: true },
        });
      }

      if (args["send-usage"]) {
        const turnMultiplier = turnCount || 1;
        notify("thread/tokenUsage/updated", {
          threadId: params.threadId,
          turnId,
          tokenUsage: {
            total: {
              inputTokens: 100 * turnMultiplier,
              outputTokens: 50 * turnMultiplier,
              totalTokens: 150 * turnMultiplier,
              cachedInputTokens: 10,
              cacheWriteInputTokens: 0,
              reasoningOutputTokens: 5,
            },
            last: {
              inputTokens: 20,
              outputTokens: 10,
              totalTokens: 30,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 128000,
          },
        });
      }

      if (args["send-invalid-usage"]) {
        notify("thread/tokenUsage/updated", {
          threadId: params.threadId,
          turnId,
          tokenUsage: {
            total: {
              inputTokens: -1,
              outputTokens: "invalid",
              totalTokens: 150,
            },
            last: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            },
          },
        });
      }

      if (args["send-rate-limits"]) {
        notify("account/rateLimits/updated", {
          rateLimits: {
            limitId: "lim-1",
            limitName: "standard",
            normalModelSlug: "gpt-4",
            primary: { usedPercent: 42, windowMinutes: 60 },
            secondary: null,
            credits: null,
            individualLimit: null,
            spendControlReached: false,
            planType: "team",
            rateLimitReachedType: null,
          },
        });
      }

      if (args["silent-turn"]) {
        return;
      }

      if (args["periodic-notifications"]) {
        const count = Number.parseInt(args["periodic-notifications"], 10);
        let sent = 0;
        const interval = setInterval(() => {
          sent += 1;
          notify("thread/tokenUsage/updated", {
            threadId: params.threadId,
            turnId,
            tokenUsage: {
              total: {
                inputTokens: sent * 10,
                outputTokens: sent * 5,
                totalTokens: sent * 15,
              },
            },
          });
          if (sent >= count) {
            clearInterval(interval);
            if (args["periodic-hang-after"]) {
              // 停止发送通知后保持静默挂起，用于验证停止输出后的 silence timeout
              return;
            }
            setTimeout(() => {
              sendCompletedNotification(params.threadId, turnId);
            }, delayMs);
          }
        }, 25);
        return;
      }

      if (args["interleaved-other-completed"]) {
        // 先发送异 thread 或异 turn 的 completion
        notify("turn/completed", {
          threadId: "different-thread-id",
          turn: {
            id: turnId,
            status: "completed",
          },
        });
        notify("turn/completed", {
          threadId: params.threadId,
          turn: {
            id: "different-turn-id",
            status: "completed",
          },
        });
      }

      if (args["unmatched-completed-first"]) {
        setTimeout(() => {
          notify("turn/completed", {
            threadId: params.threadId,
            turn: {
              id: "unmatched-turn-id",
              status: "completed",
            },
          });
          setTimeout(() => {
            sendCompletedNotification(params.threadId, turnId);
          }, delayMs);
        }, 10);
        return;
      }

      if (args["malformed-completed"]) {
        setTimeout(() => {
          notify("turn/completed", {
            threadId: params.threadId,
            turn: {
              status: "completed",
            },
          });
        }, delayMs);
        return;
      }

      // 场景：turn 期间发送 server request
      if (
        args["server-request"] &&
        args["server-request-timing"] !== "before-start-response"
      ) {
        setTimeout(() => {
          sendServerRequest(args["server-request"], params.threadId, turnId, (response) => {
            notify("test/wireInspector", {
              step: "server_request_resolved",
              response,
            });
            // 只有当是 unsupported-tool 或者 approval 被 accept 时才发送 completion
            if (args["server-request"] === "unsupported-tool") {
              setTimeout(() => {
                sendCompletedNotification(params.threadId, turnId);
              }, delayMs);
            } else if (
              response.result?.decision === "accept" ||
              response.result?.decision === "approved"
            ) {
              setTimeout(() => {
                sendCompletedNotification(params.threadId, turnId);
              }, delayMs);
            }
            // 拒绝 / error 分支不发送 completion
          });
        }, 10);
        return;
      }

      // 场景：multi-turn-tool
      if (args["multi-turn-tool"] && turnCount === 1) {
        setTimeout(() => {
          sendServerRequest("unsupported-tool", params.threadId, turnId, (_response) => {
            setTimeout(() => {
              sendCompletedNotification(params.threadId, turnId);
            }, delayMs);
          });
        }, 10);
        return;
      }

      setTimeout(() => {
        sendCompletedNotification(params.threadId, turnId);
      }, delayMs);
      return;
    }

    default: {
      respondError(id, -32601, `Method not found: ${method}`);
    }
  }
});

function sendCompletedNotification(threadId, turnId) {
  const status = args["turn-status"] || "completed";
  const errorMessage = args["turn-error-message"];
  const payload = {
    turn: {
      id: turnId,
      status,
      error: errorMessage ? { message: errorMessage } : null,
    },
  };
  if (args["null-thread-in-completed"]) {
    payload.threadId = null;
  } else if (!args["missing-thread-in-completed"]) {
    payload.threadId = threadId;
  }
  notify("turn/completed", payload);
}
