/**
 * 测试用的本地 GitHub REST stub server（NEST-56 / #20）。
 *
 * 存在理由见 docs/testing.md 哲学 2："prefer the real implementation over a
 * mock"——transport 测试走真实的 `fetch` + 真实的 HTTP server，只把 GitHub API
 * 本身换成录制好的响应；本文件不是被测行为的一部分，只是故障与响应注入的边界。
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** 一次被记录下来的请求。 */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

/** handler 返回的响应指令。 */
export interface StubResponse {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

export interface GitHubRestFixture {
  /** stub server 的 base URL（无尾斜杠），喂给 `tracker.provider.api_url`。 */
  readonly baseUrl: string;
  readonly requests: readonly RecordedRequest[];
  /** 与 `GitHubFetchImpl` 同签名的 fetch（URL 已含本 fixture 的 origin）。 */
  fetch(input: string, init: { method: "GET"; headers: Record<string, string> }): Promise<StubFetchResponse>;
  close(): Promise<void>;
}

interface StubFetchResponse {
  readonly status: number;
  ok: boolean;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

/**
 * 启动一个绑定 127.0.0.1 随机端口的 HTTP server，按 `handler` 产出的响应回答
 * 每一次请求，并把请求原样记录下来。
 */
export async function startGitHubRestFixture(
  handler: (request: RecordedRequest) => StubResponse,
): Promise<GitHubRestFixture> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const recorded: RecordedRequest = {
      method: request.method ?? "GET",
      // URL 解码回原始形态：断言面是 query 的可读形状（与 provider 语义一致），
      // 而不是 wire 上的 %2C。
      url: decodeURIComponent(request.url ?? ""),
      headers: { ...request.headers },
    };
    requests.push(recorded);
    const stub = handler(recorded);
    response.writeHead(stub.status, {
      "content-type": "application/json",
      ...stub.headers,
    });
    response.end(stub.body ?? "");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    requests,
    async fetch(input, init) {
      const response = await fetch(input, init);
      const text = await response.text();
      return {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        async json() {
          return JSON.parse(text) as unknown;
        },
      };
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}
