// M4.2 transport 测试 fixture：一个**真实**的 NDJSON/JSON-RPC 子进程
// （SPEC §10.1 / §10.3 / §10.6 / §17.2 / §17.5，#38）。
//
// 它刻意使用 `test/*` 虚构 method，而不是 `initialize` / `thread/start` /
// `turn/*`：transport kernel 必须与 Codex 业务语义无关，fixture 也不能引入
// 任何协议词汇，否则「transport 读不懂 method」这条边界就测不出来了。
//
// 由 `bash -lc 'node <this file> …'` 启动（即被测的 launch 形态），行为全部由
// stdin 上收到的 request 驱动：
//
//   test/info            → result: { cwd, argv, pid, ppid, env }（launch 边界实证）
//   test/echo            → result: { id, echo }（id 关联）
//   test/delay           → 延迟 params.delayMs 后回显
//   test/silent          → 永不回复（read timeout）
//   test/error           → JSON-RPC error response
//   test/stderr          → 先写若干 stderr 行（可伪造本请求的 response、可含超长行），再正常回复
//   test/raw             → 原样写 params.chunks（可分块 / 可多条 / 可超长），再按需回复
//   test/exit            → 可选写 stderr 后 process.exit(params.code)
//   test/server-request  → 主动向本地发 request，等待本地回信后据此回复
//   test/block-term      → 忽略 SIGTERM 后正常回复（验证 stop() 升级到 SIGKILL）
//
// 另有两种启动期模式（由 argv 决定，不需要协议往返）：
//   --background-marker <file>  写入自身 pid 后长驻（验证有界 shutdown 不留孤儿）
//
// 不做的事：不解释 method 语义以外的协议、不校验 JSON-RPC 版本、不模拟真实 Codex。

import { appendFileSync } from "node:fs";
import process from "node:process";

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

function asNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function handleRequest(message) {
  const { id, method, params } = message;
  const options = typeof params === "object" && params !== null ? params : {};

  switch (method) {
    case "test/info": {
      const names = Array.isArray(options.names) ? options.names : [];
      const env = {};
      for (const name of names) {
        if (typeof name === "string") {
          env[name] = process.env[name] ?? null;
        }
      }
      respond(id, {
        cwd: process.cwd(),
        argv: process.argv.slice(2),
        pid: process.pid,
        ppid: process.ppid,
        // launch 边界实证：这两个值是 shell 展开的结果。若 launch 没走 `bash -lc`，
        // 它们要么是字面量 `$(pwd)` / `$BASH_VERSION`，要么整个 flag 后面没有值。
        shellCwd: typeof args.cwd === "string" ? args.cwd : null,
        bashVersion: typeof args.bash === "string" ? args.bash : null,
        env,
      });
      return;
    }
    case "test/echo": {
      respond(id, { id, echo: options });
      return;
    }
    case "test/delay": {
      const delayMs = asNumber(options.delayMs, 50);
      setTimeout(() => {
        respond(id, { id, delayMs, echo: options });
      }, delayMs);
      return;
    }
    case "test/silent": {
      // 故意不回：由 transport 的 readTimeoutMs 结算。
      return;
    }
    case "test/error": {
      respondError(
        id,
        asNumber(options.code, -32000),
        typeof options.message === "string" ? options.message : "fixture rejection",
      );
      return;
    }
    case "test/stderr": {
      process.stderr.write("fixture: plain diagnostic noise\n");
      if (options.forgeSameId === true) {
        // 在 stderr 上伪造**本次请求**的合法 response：若 transport 读了 stderr，
        // 这个 Promise 会以 forged=true 结算（或双结算），测试即可判别。
        process.stderr.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { forged: true } })}\n`);
      }
      if (typeof options.forgedResponseLine === "string") {
        // 一整行**合法**的 JSON-RPC response 出现在 stderr：transport 绝不得消费它。
        process.stderr.write(`${options.forgedResponseLine}\n`);
      }
      for (const line of Array.isArray(options.lines) ? options.lines : []) {
        process.stderr.write(`${String(line)}\n`);
      }
      if (asNumber(options.bigLineBytes, 0) > 0) {
        // 超长 stderr 诊断行：transport 的 stderr 缓冲同样必须有界。
        process.stderr.write(`${"x".repeat(asNumber(options.bigLineBytes, 0))}\n`);
      }
      respond(id, { id, stderrWritten: true });
      return;
    }
    case "test/raw": {
      const chunks = Array.isArray(options.chunks) ? options.chunks.map(String) : [];
      const oversizedBytes = asNumber(options.oversizedBytes, 0);
      const chunkDelayMs = asNumber(options.chunkDelayMs, 0);
      const schedule = (index) => {
        if (index < chunks.length) {
          process.stdout.write(chunks[index]);
          setTimeout(() => schedule(index + 1), chunkDelayMs);
          return;
        }
        if (oversizedBytes > 0) {
          // 无换行的超长字节流：transport 必须丢弃它、报告 oversized_line、且不 OOM / 不 hang。
          const payload = "a".repeat(oversizedBytes);
          process.stdout.write(payload);
          setTimeout(() => {
            process.stdout.write("\n");
            if (options.thenRespond) {
              respond(id, { id, recovered: true });
            }
          }, chunkDelayMs);
          return;
        }
        if (options.thenRespond) {
          respond(id, { id, rawChunks: chunks.length });
        }
      };
      schedule(0);
      return;
    }
    case "test/exit": {
      if (typeof options.stderrLine === "string") {
        process.stderr.write(`${options.stderrLine}\n`);
      }
      process.exit(asNumber(options.code, 0));
      return;
    }
    case "test/server-request": {
      const serverRequestId = `fixture-${String(id)}`;
      writeLine({
        jsonrpc: "2.0",
        id: serverRequestId,
        method: typeof options.method === "string" ? options.method : "test/ping",
        params: { originId: id },
      });
      // 等本地回信；超时则回一个 error，避免 fixture 自己悬挂（policy 归 M4.4，这里只是观测）。
      pendingServerRequests.set(serverRequestId, id);
      setTimeout(() => {
        if (pendingServerRequests.delete(serverRequestId)) {
          respondError(id, -32001, "fixture received no local response");
        }
      }, asNumber(options.timeoutMs, 2_000));
      return;
    }
    case "test/block-term": {
      process.on("SIGTERM", () => {
        // 故意忽略 SIGTERM：stop() 必须升级到 SIGKILL。
      });
      respond(id, { id, blockingTerm: true });
      return;
    }
    default: {
      respondError(id, -32601, `fixture has no handler for method ${String(method)}`);
    }
  }
}

const pendingServerRequests = new Map();

function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write("fixture: discarded non-JSON stdin line\n");
    return;
  }
  if (typeof message !== "object" || message === null) {
    return;
  }
  if (typeof message.method === "string" && message.id !== undefined) {
    handleRequest(message);
    return;
  }
  if (typeof message.method === "string") {
    // notification：fixture 不回应。
    return;
  }
  if (message.id !== undefined && pendingServerRequests.has(String(message.id))) {
    const originId = pendingServerRequests.get(String(message.id));
    pendingServerRequests.delete(String(message.id));
    respond(originId, { id: originId, localReply: message.result ?? null });
  }
}

if (typeof args["background-marker"] === "string") {
  // 孤儿检测模式：登记 pid 后长驻，只随进程组一起被终止。
  appendFileSync(args["background-marker"], `${process.pid}\n`, "utf8");
  setTimeout(() => {
    process.exit(0);
  }, 60_000).unref?.();
  setInterval(() => {
    /* 保持事件循环存活（继承 stdio，用于证明进程组内无残留） */
  }, 1_000);
} else {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        handleLine(line);
      }
    }
  });
  process.stdin.on("end", () => {
    process.exit(0);
  });
}
