/**
 * Rate and body-size limits on the `--http` transport (issue #11).
 *
 * The body-size half is not only a limit: `express.json()`'s 100 kB default
 * was actively wrong here, because `post_document` carries the uploaded file
 * base64-encoded *inside* the JSON-RPC body. The first test in
 * "body-size limit" is the regression for that.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMcpHttpApp } from "../../src/http/app";
import {
  DEFAULT_MAX_BODY,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  HttpLimitsConfig,
  MAX_BODY_ENV,
  RATE_LIMIT_MAX_ENV,
  RATE_LIMIT_WINDOW_ENV,
  resolveHttpLimits,
} from "../../src/http/limits";
import {
  initializeBody,
  NO_AUTH,
  rawRequest,
  RunningApp,
  SECURITY,
  startApp,
} from "./harness";

const jsonHeaders = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

const DEFAULTS: HttpLimitsConfig = {
  maxBody: DEFAULT_MAX_BODY,
  rateLimitMax: DEFAULT_RATE_LIMIT_MAX,
  rateLimitWindowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
};

let running: RunningApp | undefined;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (running) await running.close();
  running = undefined;
  vi.restoreAllMocks();
});

async function serve(limits: HttpLimitsConfig): Promise<RunningApp> {
  running = await startApp(
    createMcpHttpApp({
      auth: NO_AUTH,
      createServer: () => {
        const server = new McpServer({ name: "limits-test", version: "1.0.0" });
        server.registerTool(
          "sink",
          { description: "sink", inputSchema: { blob: z.string() } },
          async ({ blob }: { blob: string }) => ({
            content: [{ type: "text" as const, text: String(blob.length) }],
          })
        );
        return server;
      },
      security: SECURITY,
      limits,
    })
  );
  return running;
}

/** A `tools/call` whose base64 payload is roughly `bytes` long. */
function uploadBody(bytes: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "sink", arguments: { blob: "A".repeat(bytes) } },
  });
}

describe("body-size limit", () => {
  it("accepts an upload-sized body that express's 100 kB default rejected", async () => {
    // 400 kB of base64 in the body: comfortably over the old default, and a
    // perfectly ordinary `post_document` call.
    const app = await serve(DEFAULTS);
    const body = uploadBody(400_000);
    expect(Buffer.byteLength(body)).toBeGreaterThan(100 * 1024);

    const response = await rawRequest({
      port: app.port,
      path: "/mcp",
      headers: { ...jsonHeaders, host: `127.0.0.1:${app.port}` },
      body,
    });

    expect(response.status).toBe(200);
    expect(response.body).toContain("400000");
  });

  it("rejects a body over the configured limit with 413 and a JSON-RPC error", async () => {
    const app = await serve({ ...DEFAULTS, maxBody: "50kb" });
    const response = await rawRequest({
      port: app.port,
      path: "/mcp",
      headers: { ...jsonHeaders, host: `127.0.0.1:${app.port}` },
      body: uploadBody(200_000),
    });

    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Request body too large" },
      id: null,
    });
    // Express's default handler would have sent an HTML page with a stack.
    expect(response.body).not.toContain("<html");
  });

  it("answers unparseable JSON with a JSON-RPC parse error, not an HTML page", async () => {
    const app = await serve(DEFAULTS);
    const response = await rawRequest({
      port: app.port,
      path: "/mcp",
      headers: { ...jsonHeaders, host: `127.0.0.1:${app.port}` },
      body: '{"jsonrpc": "2.0", broken',
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe(-32700);
    expect(response.body).not.toContain("broken");
  });
});

describe("rate limiting", () => {
  it("lets a burst under the ceiling through", async () => {
    const app = await serve({ ...DEFAULTS, rateLimitMax: 5 });
    for (let i = 0; i < 5; i += 1) {
      const response = await rawRequest({
        port: app.port,
        path: "/mcp",
        headers: { ...jsonHeaders, host: `127.0.0.1:${app.port}` },
        body: initializeBody(i + 1),
      });
      expect(response.status).toBe(200);
    }
  });

  it("answers 429 with Retry-After once the ceiling is passed", async () => {
    const app = await serve({ ...DEFAULTS, rateLimitMax: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const response = await rawRequest({
        port: app.port,
        path: "/mcp",
        headers: { ...jsonHeaders, host: `127.0.0.1:${app.port}` },
        body: initializeBody(i + 1),
      });
      statuses.push(response.status);
      if (response.status === 429) {
        expect(JSON.parse(response.body)).toEqual({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Too many requests" },
          id: null,
        });
        expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
      }
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it("recovers when the window rolls over", async () => {
    // A 50 ms window rather than a fake clock: the middleware is mounted
    // inside the real app, so the real timing path is what gets exercised.
    const app = await serve({
      ...DEFAULTS,
      rateLimitMax: 1,
      rateLimitWindowMs: 50,
    });
    const send = () =>
      rawRequest({
        port: app.port,
        path: "/mcp",
        headers: { ...jsonHeaders, host: `127.0.0.1:${app.port}` },
        body: initializeBody(),
      });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await send()).status).toBe(200);
  });

  it("also covers the legacy routes", async () => {
    const app = await serve({ ...DEFAULTS, rateLimitMax: 1 });
    const first = await rawRequest({
      port: app.port,
      path: "/mcp",
      headers: { ...jsonHeaders, host: `127.0.0.1:${app.port}` },
      body: initializeBody(),
    });
    expect(first.status).toBe(200);

    const second = await rawRequest({
      port: app.port,
      path: "/messages?sessionId=x",
      headers: { ...jsonHeaders, host: `127.0.0.1:${app.port}` },
      body: "{}",
    });
    expect(second.status).toBe(429);
  });

  it("runs before authentication, so the secret cannot be brute-forced", async () => {
    // The ordering claim made in src/http/app.ts, asserted: once the ceiling
    // is reached the answer is 429, not the 401 an unauthenticated caller
    // would otherwise get — so each guess costs a slot in the window.
    running = await startApp(
      createMcpHttpApp({
        auth: { mode: "bearer", secret: "the-real-secret-value", source: "test" },
        createServer: () =>
          new McpServer({ name: "limits-test", version: "1.0.0" }),
        security: SECURITY,
        limits: { ...DEFAULTS, rateLimitMax: 2 },
      })
    );

    const guess = (n: number) =>
      rawRequest({
        port: running!.port,
        path: "/mcp",
        headers: {
          ...jsonHeaders,
          host: `127.0.0.1:${running!.port}`,
          authorization: `Bearer guess-${n}`,
        },
        body: initializeBody(n),
      });

    expect((await guess(1)).status).toBe(401);
    expect((await guess(2)).status).toBe(401);
    expect((await guess(3)).status).toBe(429);
  });

  it("can be disabled with 0", async () => {
    const app = await serve({ ...DEFAULTS, rateLimitMax: 0 });
    for (let i = 0; i < 20; i += 1) {
      const response = await rawRequest({
        port: app.port,
        path: "/mcp",
        headers: { ...jsonHeaders, host: `127.0.0.1:${app.port}` },
        body: initializeBody(i + 1),
      });
      expect(response.status).toBe(200);
    }
  });

  it("logs a rate-limit rejection without the client address", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await serve({ ...DEFAULTS, rateLimitMax: 1 });
    for (let i = 0; i < 2; i += 1) {
      await rawRequest({
        port: app.port,
        path: "/mcp",
        headers: { ...jsonHeaders, host: `127.0.0.1:${app.port}` },
        body: initializeBody(i + 1),
      });
    }

    const rejection = stderr.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.indexOf("rate_limited") !== -1);
    expect(rejection).toBeDefined();
    expect(JSON.parse(rejection!)).toEqual({
      level: "warn",
      event: "http_request_rejected",
      reason: "rate_limited",
    });
  });
});

describe("resolveHttpLimits", () => {
  it("defaults to a body large enough for an upload", () => {
    expect(resolveHttpLimits({})).toEqual(DEFAULTS);
    // The regression guard: anything at or under express's own default would
    // silently truncate post_document again.
    expect(DEFAULT_MAX_BODY).toBe("10mb");
  });

  it("reads all three settings from the environment", () => {
    expect(
      resolveHttpLimits({
        [MAX_BODY_ENV]: " 512kb ",
        [RATE_LIMIT_MAX_ENV]: "42",
        [RATE_LIMIT_WINDOW_ENV]: "5000",
      })
    ).toEqual({
      maxBody: "512kb",
      rateLimitMax: 42,
      rateLimitWindowMs: 5000,
    });
  });

  it("falls back on the default for an unusable value", () => {
    expect(
      resolveHttpLimits({
        [MAX_BODY_ENV]: "enormous",
        [RATE_LIMIT_MAX_ENV]: "-1",
        [RATE_LIMIT_WINDOW_ENV]: "soon",
      })
    ).toEqual(DEFAULTS);
  });

  it("keeps 0 as a meaningful value for the rate limit", () => {
    expect(resolveHttpLimits({ [RATE_LIMIT_MAX_ENV]: "0" }).rateLimitMax).toBe(
      0
    );
  });
});
