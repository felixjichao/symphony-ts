/**
 * @symphony/gateway — 消息服务器骨架。
 *
 * 职责（对齐上游 gateway/core）：
 * - 连接管理：每连接 (transport, AgentKey, 可达地址, 上线时间)；
 * - 认证与路由：握手换公钥、每消息验签、路由表 dstKey → 可达地址；
 * - 控制器模块分发：控制面消息按模块分发给已装载插件；
 * - 上游/下游树：本地未命中时向上游转发（M6）。
 *
 * M0 只固化：网关可启动/停止、插件注册表接线、收到消息先走控制器分发。
 */
import { jsonTranscoder } from "@symphony/proto";
import type { Message } from "@symphony/sym";
import { PluginRegistry } from "@symphony/plugins";
import { UdpTransport, type Address, type Transport, type TransportHandler } from "@symphony/transport";

export interface GatewayConfig {
  listen?: { host: string; port: number };
  /** 上游网关地址（M6 使用）。 */
  upstream?: Address;
  name?: string;
}

export interface Gateway extends TransportHandler {
  readonly address: Address;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class GatewayServer implements Gateway {
  private readonly transport: Transport;
  private readonly registry: PluginRegistry;
  private _address: Address | undefined;

  constructor(registry: PluginRegistry, config: GatewayConfig = {}) {
    this.registry = registry;
    this.transport = new UdpTransport(this, config.listen);
  }

  get address(): Address {
    if (!this._address) throw new Error("网关未就绪：先 await start()");
    return this._address;
  }

  /** 控制器模块分发入口：先交插件处理，未消费的交给内部路由（M3）。 */
  onMessage(raw: Uint8Array, from: Address): void {
    let msg: Message;
    try {
      const root = jsonTranscoder.decode(raw);
      if (root.proto !== "sym/0") throw new Error(`未知协议版本: ${String(root.proto)}`);
      msg = root.payload as Message;
    } catch (err) {
      this.onError?.(err as Error);
      return;
    }
    const consumed = this.registry.dispatch({ msg, from });
    if (!consumed) {
      this.registry.dispatchTo("core", { msg, from }); // 内部路由留待 M3
    }
  }

  onError?(error: Error): void;

  async start(): Promise<void> {
    this._address = await this.transport.ready;
  }

  async stop(): Promise<void> {
    await this.transport.close();
  }
}