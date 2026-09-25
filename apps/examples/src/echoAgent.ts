/**
 * @symphony/examples — echo Agent（骨架）。
 *
 * 目标（对齐上游 helloworld/echo 示例）：Agent 收到消息后原样回给发送方。
 * M3 网关具备路由与投递后，这里接入 Gateway 完成闭环；M0 先固化纯逻辑。
 */
import type { Message } from "@symphony/sym";

/** 纯函数式的 echo 核心逻辑：返回回给 src 的消息。 */
export function echoHandler(request: Message): Message {
  return {
    route: { src: request.route.dst, dst: request.route.src },
    header: {
      id: request.header.id,
      parent: request.header.id,
      protoVersion: request.header.protoVersion,
      opts: [],
      ...(request.header.gateway !== undefined ? { gateway: request.header.gateway } : {}),
    },
    payload: { kind: request.payload.kind, data: request.payload.data },
  };
}

/** M3 将启动真实网关并注册本处理器；M0 仅打印地址便于调试。 */
export async function startEchoAgent(): Promise<string> {
  return "echo-agent: M3 时在此启动网关并注册 echoHandler";
}

// 直接运行：tsx src/echoAgent.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  startEchoAgent().then((s) => console.log(s));
}