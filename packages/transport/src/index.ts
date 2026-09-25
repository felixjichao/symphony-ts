/**
 * @symphony/transport — 传输层抽象与骨架。
 *
 * 设计（对齐上游 symphony-transport）：
 * - Transport 接口是核心抽象，UDP 可靠流（模式 A）与 WebSocket 适配器（模式 B）
 *   可互换、可同时监听；
 * - M0 先提供一个可用的最小 UDP 绑定（无可靠语义，仅 bind/send/close），
 *   可靠性（M2：握手、序号、ACK、重传、分片）在其上叠加；
 * - `ready` 承诺在 bind 完成后给出本端可达地址。
 */
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { SERVICE_NAME } from "@symphony/sym";

export interface Address {
  host: string;
  port: number;
  /** 服务名后缀，如 `symphony`。 */
  service: string;
}

export function formatAddress(addr: Address): string {
  return `${addr.host}:${addr.port}:${addr.service}`;
}

export function parseAddress(text: string): Address {
  const m = /^([^:]+):(\d+):([^:]+)$/.exec(text);
  if (!m) throw new Error(`非法 Symphony 地址: ${text}`);
  return { host: m[1]!, port: Number(m[2]), service: m[3]! };
}

export interface TransportHandler {
  /** 收到完整数据报（未解封装为 Message，那是协议层职责）。 */
  onMessage(data: Uint8Array, from: Address): void;
  onError?(error: Error): void;
}

export interface Transport {
  /** bind 完成后解析为本端可达地址。 */
  readonly ready: Promise<Address>;
  send(to: Address, data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/**
 * 最小 UDP 传输（M0：bind + send + close，无可靠语义）。
 * M2 将在此之上实现握手与重传；数据报长度上限 65507 字节。
 */
export class UdpTransport implements Transport {
  private readonly socket: Socket;
  readonly ready: Promise<Address>;

  constructor(handler: TransportHandler, opts: { host: string; port: number } = { host: "0.0.0.0", port: 0 }) {
    this.socket = createSocket("udp4");
    this.socket.on("message", (buf, rinfo: RemoteInfo) => {
      try {
        handler.onMessage(new Uint8Array(buf), { host: rinfo.address, port: rinfo.port, service: SERVICE_NAME });
      } catch (err) {
        handler.onError?.(err as Error);
      }
    });
    this.ready = new Promise<Address>((resolve, reject) => {
      this.socket.once("error", (err) => reject(err));
      this.socket.once("listening", () => {
        const info = this.socket.address();
        resolve({
          host: opts.host === "0.0.0.0" ? "127.0.0.1" : opts.host,
          port: info.port,
          service: SERVICE_NAME,
        });
      });
    });
    this.socket.bind(opts.port, opts.host);
  }

  async send(to: Address, data: Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.send(Buffer.from(data), to.port, to.host, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.socket.close(() => resolve()));
  }
}

/** WebSocket 适配器骨架；M2 提供传输抽象的第二实现。 */
export class WsTransport implements Transport {
  readonly ready: Promise<Address> = Promise.resolve({ host: "127.0.0.1", port: 0, service: SERVICE_NAME });

  constructor(_handler: TransportHandler) {
    throw new Error("WsTransport: 将于 M2 实现（传输抽象的第二实现）");
  }

  async send(_to: Address, _data: Uint8Array): Promise<void> {
    throw new Error("未实现");
  }

  async close(): Promise<void> {}
}