/**
 * Loopback HTTP transport implementations for localhost Web Agent Bridge.
 * Supports both Tampermonkey GM_xmlhttpRequest and standard Fetch API.
 */

export class BridgeHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "BridgeHttpError";
    this.status = status;
    this.code = code;
  }
}

export interface BridgeTransport {
  readonly baseUrl: string;
  readonly authToken: string | undefined;

  request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { allow204?: boolean; signal?: AbortSignal }
  ): Promise<T>;
}

export interface GmBridgeTransportOptions {
  readonly baseUrl?: string | undefined;
  readonly authToken?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export class GmBridgeTransport implements BridgeTransport {
  readonly baseUrl: string;
  readonly authToken: string | undefined;
  readonly timeoutMs: number;

  constructor(options: GmBridgeTransportOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:4040").replace(/\/+$/, "");
    this.authToken = options.authToken;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { allow204?: boolean; signal?: AbortSignal } = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    let data: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      data = JSON.stringify(body);
    }

    if (typeof GM_xmlhttpRequest !== "function") {
      throw new Error("GM_xmlhttpRequest is not available in current environment");
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const gmOptions: GMXmlHttpRequestOptions = {
        method,
        url,
        headers,
        timeout: this.timeoutMs,
        onload: (res) => {
          if (settled) return;
          settled = true;

          if (options.allow204 && res.status === 204) {
            resolve(null as T);
            return;
          }

          if (res.status >= 200 && res.status < 300) {
            try {
              const parsed = JSON.parse(res.responseText);
              resolve(parsed as T);
            } catch {
              resolve(res.responseText as unknown as T);
            }
            return;
          }

          let code = "http_error";
          let message = `HTTP ${res.status}: ${res.statusText || "Request failed"}`;
          try {
            const errJson = JSON.parse(res.responseText) as { error?: { code?: string; message?: string } };
            if (errJson?.error) {
              code = errJson.error.code ?? code;
              message = errJson.error.message ?? message;
            }
          } catch {
            // ignore JSON parse failure on error body
          }
          reject(new BridgeHttpError(message, code, res.status));
        },
        onerror: (_err) => {
          if (settled) return;
          settled = true;
          reject(new BridgeHttpError("Bridge network error", "network_error", 0));
        },
        ontimeout: () => {
          if (settled) return;
          settled = true;
          reject(new BridgeHttpError("Bridge request timed out", "timeout", 408));
        },
        onabort: () => {
          if (settled) return;
          settled = true;
          reject(new BridgeHttpError("Bridge request was aborted", "aborted", 0));
        },
      };

      if (data !== undefined) {
        gmOptions.data = data;
      }

      const gmHandle = GM_xmlhttpRequest(gmOptions);

      if (options.signal) {
        if (options.signal.aborted) {
          settled = true;
          gmHandle.abort();
          reject(new BridgeHttpError("Request aborted", "aborted", 0));
          return;
        }
        options.signal.addEventListener(
          "abort",
          () => {
            if (!settled) {
              settled = true;
              gmHandle.abort();
              reject(new BridgeHttpError("Request aborted", "aborted", 0));
            }
          },
          { once: true }
        );
      }
    });
  }
}

export interface FetchBridgeTransportOptions {
  readonly baseUrl?: string | undefined;
  readonly authToken?: string | undefined;
}

export class FetchBridgeTransport implements BridgeTransport {
  readonly baseUrl: string;
  readonly authToken: string | undefined;

  constructor(options: FetchBridgeTransportOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:4040").replace(/\/+$/, "");
    this.authToken = options.authToken;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { allow204?: boolean; signal?: AbortSignal } = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    let serializedBody: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      serializedBody = JSON.stringify(body);
    }

    const init: RequestInit = {
      method,
      headers,
      ...(serializedBody !== undefined ? { body: serializedBody } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };

    const res = await fetch(url, init);

    if (options.allow204 && res.status === 204) {
      return null as T;
    }

    if (!res.ok) {
      let code = "http_error";
      let message = `HTTP ${res.status}: ${res.statusText}`;
      try {
        const errorJson = (await res.json()) as { error?: { code?: string; message?: string } };
        if (errorJson?.error) {
          code = errorJson.error.code ?? code;
          message = errorJson.error.message ?? message;
        }
      } catch {
        // Failed to parse error json
      }
      throw new BridgeHttpError(message, code, res.status);
    }

    return (await res.json()) as T;
  }
}
