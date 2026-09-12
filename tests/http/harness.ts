/**
 * Test harness for the `--http` app: a *real* Node HTTP server on an ephemeral
 * port, driven by *real* MCP clients over real sockets. Nothing here mocks the
 * transport — a leak between clients has to be observable end to end.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Express } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { HttpAuthConfig } from "../../src/config/httpAuth";
import { DEFAULT_ALLOWED_HOSTS } from "../../src/http/security";

/**
 * For the tests that are about something other than authentication. Auth is a
 * required option on `createMcpHttpApp`, so every one of them has to say out
 * loud that it is running without it; `auth.test.ts` is where the real
 * configurations are exercised.
 */
export const NO_AUTH: HttpAuthConfig = { mode: "disabled" };

/** The default Host/Origin policy, which most tests do not vary. */
export const SECURITY = {
  allowedHosts: DEFAULT_ALLOWED_HOSTS,
  allowedOrigins: [] as string[],
};

export interface RunningApp {
  port: number;
  url: string;
  server: Server;
  close(): Promise<void>;
}

export async function startApp(app: Express): Promise<RunningApp> {
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // An SSE stream left open would keep `close()` pending forever.
        server.closeAllConnections();
      }),
  };
}

/**
 * Connect one MCP client over Streamable HTTP and run `initialize`. With
 * `secret`, the client presents it as a bearer token on every request — the
 * end-to-end path a real authenticated client takes.
 */
export async function connectClient(
  baseUrl: string,
  name: string,
  secret?: string
): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: secret
        ? { headers: { authorization: `Bearer ${secret}` } }
        : undefined,
    })
  );
  return client;
}

/**
 * A raw HTTP request. `fetch` refuses to set some of the headers these tests
 * need to forge (Host in particular), so this goes through `node:http`.
 */
export function rawRequest(options: {
  port: number;
  path: string;
  method?: string;
  /** An array value writes the header twice, as two lines on the wire. */
  headers?: Record<string, string | string[]>;
  body?: string;
}): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http = require("node:http") as typeof import("node:http");
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: options.port,
        path: options.path,
        method: options.method ?? "POST",
        headers: options.headers ?? {},
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers as Record<string, unknown>,
            body,
          })
        );
      }
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

/** A minimal, valid `initialize` request body. */
export function initializeBody(id = 1): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "raw", version: "1.0.0" },
    },
  });
}

/**
 * A rendezvous point: `arrive()` blocks until `size` callers have arrived, so
 * two tool calls are provably in flight at the same moment. Without this, a
 * "concurrent" test can pass by running strictly sequentially.
 */
export function createBarrier(size: number) {
  const arrivals: string[] = [];
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    arrivals,
    async arrive(marker: string): Promise<void> {
      arrivals.push(marker);
      if (arrivals.length >= size) release();
      await opened;
    },
  };
}
