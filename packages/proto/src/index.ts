/**
 * @symphony/proto — 载荷转码器骨架（proto-transcoder 对应物）。
 *
 * M0 先用零依赖的 JSON 转码打通端到端；protobuf/CBOR 语义在 M1 对齐上游后接入。
 */

export interface Transcoder<T> {
  readonly format: string;
  encode(value: T): Uint8Array;
  decode(bytes: Uint8Array): T;
}

/** 通用信封：带上协议版本便于解码侧路由。 */
export interface JsonRoot {
  proto: string;
  payload: unknown;
}

export const jsonTranscoder: Transcoder<JsonRoot> = {
  format: "json",
  encode(value) {
    return new TextEncoder().encode(JSON.stringify(value));
  },
  decode(bytes) {
    const root = JSON.parse(new TextDecoder().decode(bytes)) as JsonRoot;
    if (typeof root !== "object" || root === null || typeof root.proto !== "string") {
      throw new Error("jsonTranscoder.decode: 非法信封（缺少 proto 字段）");
    }
    return root;
  },
};

export class UnsupportedFormatError extends Error {
  constructor(format: string) {
    super(`不支持的转码格式: ${format}`);
    this.name = "UnsupportedFormatError";
  }
}

/** 转码器注册表；M1 接入 protobuf 后在此登记。 */
const transcoders = new Map<string, Transcoder<unknown>>();

export function registerTranscoder(transcoder: Transcoder<unknown>): void {
  transcoders.set(transcoder.format, transcoder);
}

export function getTranscoder<T>(format: string): Transcoder<T> {
  const t = transcoders.get(format);
  if (!t) throw new UnsupportedFormatError(format);
  return t as Transcoder<T>;
}

// 默认注册 JSON 实现。
registerTranscoder(jsonTranscoder as Transcoder<unknown>);