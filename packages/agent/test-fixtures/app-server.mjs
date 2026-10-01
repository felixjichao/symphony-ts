// M4.3 Codex app-server 测试 fixture：真实 NDJSON/JSON-RPC 子进程
// （SPEC §10.2 / §10.3 / §10.6 / §17.5，#39）。
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

function writeLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
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

  // Client notification（如 initialized）
  if (message.id === undefined && message.method) {
    notify("test/wireInspector", {
      step: message.method,
      params: message.params,
    });
    return;
  }

  const { id, method, params } = message;

  switch (method) {
    case "initialize": {
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

      if (args["silent-turn"]) {
        return;
      }

      const delayMs = args["delay-completed-ms"]
        ? Number.parseInt(args["delay-completed-ms"], 10)
        : 20;

      if (args["periodic-notifications"]) {
        const count = Number.parseInt(args["periodic-notifications"], 10);
        let sent = 0;
        const interval = setInterval(() => {
          sent += 1;
          notify("thread/tokenUsage/updated", {
            threadId: params.threadId,
            turnId,
            tokens: sent * 10,
          });
          if (sent >= count) {
            clearInterval(interval);
            setTimeout(() => {
              sendCompletedNotification(params.threadId, turnId);
            }, delayMs);
          }
        }, 25);
        return;
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
  notify("turn/completed", {
    threadId,
    turn: {
      id: turnId,
      status,
      error: errorMessage ? { message: errorMessage } : null,
    },
  });
}
