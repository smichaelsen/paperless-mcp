import { vi } from "vitest";

export interface RecordedCall {
  url: string;
  init: RequestInit;
}

export type Responder = (
  url: string,
  init: RequestInit
) => Response | Promise<Response>;

export interface FetchMock {
  calls: RecordedCall[];
  /** The single recorded call — fails loudly when there was not exactly one. */
  only(): RecordedCall;
  headerOf(call: RecordedCall, name: string): string | undefined;
}

/**
 * Replace the global `fetch` with a recorder. Restored by `vi.unstubAllGlobals()`
 * (see tests/setup usage in each suite's `afterEach`).
 */
export function mockFetch(responder: Responder): FetchMock {
  const calls: RecordedCall[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return responder(String(input), init);
    })
  );

  return {
    calls,
    only() {
      if (calls.length !== 1) {
        throw new Error(`expected exactly one fetch call, got ${calls.length}`);
      }
      return calls[0];
    },
    headerOf(call, name) {
      const headers = (call.init.headers ?? {}) as Record<string, string>;
      const key = Object.keys(headers).find(
        (candidate) => candidate.toLowerCase() === name.toLowerCase()
      );
      return key === undefined ? undefined : headers[key];
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function textResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain", ...headers },
  });
}

export function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}
