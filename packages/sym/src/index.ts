/**
 * @symphony/sym — Symphony 协议（sym/0）消息模型骨架。
 *
 * 对齐上游单一消息模型：Message { Route, Header, Payload }。
 * wire 级编解码（protobuf 语义）在 M1 落地；此处先固化类型与常量。
 */
import { randomUUID } from "node:crypto";

/** 协议版本串。 */
export const PROTO_VERSION = "sym/0" as const;
/** 传输版本，附加在地址上（如 `host:port:symphony`）。 */
export const TRANSPORT_VERSION = "1.0" as const;
/** 服务名，地址后缀的一部分。 */
export const SERVICE_NAME = "symphony" as const;

export interface Route {
  /** 发送方公钥（Ed25519）。 */
  src: string;
  /** 接收方公钥（Ed25519）。 */
  dst: string;
}

export interface HeaderOption {
  key: string;
  value: Uint8Array;
}

export interface Header {
  /** 消息 id（UUID）。 */
  id: string;
  /** 父消息 id，用于全链路追踪。 */
  parent?: string;
  /** 对端可达地址，如 `gateway:4589:symphony`。 */
  gateway?: string;
  protoVersion: string;
  opts: HeaderOption[];
}

export enum PayloadKind {
  Message = 0,
  CreateDataConnection = 1,
  DataMessage = 2,
}

export interface Payload {
  kind: PayloadKind;
  slotId?: number;
  data: Uint8Array;
}

export interface Message {
  route: Route;
  header: Header;
  payload: Payload;
}

export function createMessage(route: Route, data: Uint8Array): Message {
  return {
    route,
    header: { id: randomUUID(), protoVersion: PROTO_VERSION, opts: [] },
    payload: { kind: PayloadKind.Message, data },
  };
}

/** 待 M1 实现：wire 编解码（长度前缀 + protobuf 语义字段）。 */
export function encode(_message: Message): Uint8Array {
  throw new Error("encode: 将于 M1 实现（wire 编解码）");
}

export function decode(_bytes: Uint8Array): Message {
  throw new Error("decode: 将于 M1 实现（wire 编解码）");
}