/**
 * Tampermonkey / Greasemonkey ambient type declarations.
 */

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;
declare function GM_deleteValue(key: string): void;
declare function GM_registerMenuCommand(caption: string, onClick: () => void, accessKey?: string): number;

interface GMXmlHttpRequestResponse {
  readonly status: number;
  readonly statusText: string;
  readonly responseHeaders: string;
  readonly responseText: string;
  readonly response: unknown;
}

interface GMXmlHttpRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  timeout?: number;
  onload?: (response: GMXmlHttpRequestResponse) => void;
  onerror?: (response: GMXmlHttpRequestResponse | Error) => void;
  ontimeout?: (response: GMXmlHttpRequestResponse | Error) => void;
  onabort?: (response: GMXmlHttpRequestResponse | Error) => void;
}

declare function GM_xmlhttpRequest(options: GMXmlHttpRequestOptions): { abort: () => void };
