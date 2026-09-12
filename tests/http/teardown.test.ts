/**
 * The other half of the isolation guarantee: a per-connection server must not
 * *outlive* its connection.
 *
 * Creation is covered by `isolation.test.ts`; disposal was not, and a review
 * mutation proved it — deleting `res.on("close", dispose)` from `app.ts` and
 * the `server.close()` from the legacy SSE close handler left the whole suite
 * green. These tests close that hole: they assert, for the normal path, for a
 * client abort mid-request and for an ended SSE stream, that every server built
 * for a connection was closed and detached from its transport.
 *
 * `server.server.transport` is the SDK's own signal: `Protocol._onclose()` sets
 * `_transport = undefined`, so it only becomes undefined if the transport was
 * genuinely torn down — a spy alone could be satisfied by a no-op.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMcpHttpApp } from "../../src/http/app";
import { DEFAULT_ALLOWED_HOSTS } from "../../src/http/security";
import { connectClient, rawRequest, RunningApp, startApp } from "./harness";

const SECURITY = {
  allowedHosts: DEFAULT_ALLOWED_HOSTS,
  allowedOrigins: [] as string[],
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Open `GET /sse` at the socket level and read the `endpoint` event the
 * transport emits first, which carries the session id the server minted.
 */
function openSseStream(
  port: number
): Promise<{ sessionId: string; end: () => void }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/sse",
        method: "GET",
        headers: { accept: "text/event-stream" },
      },
      (response) => {
        let buffer = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffer += chunk;
          const match = buffer.match(/sessionId=([A-Za-z0-9-]+)/);
          if (match) {
            resolve({ sessionId: match[1], end: () => request.destroy() });
          }
        });
        response.on("error", reject);
      }
    );
    request.on("error", reject);
    request.end();
    setTimeout(() => reject(new Error("no SSE endpoint event")), 3000);
  });
}

interface TrackingFactory {
  createServer: () => McpServer;
  created: McpServer[];
  closeCalls: number;
  /** Servers still holding a transport, i.e. not torn down. */
  undisposed: () => McpServer[];
}

function trackingFactory(options: {
  /** Optional gate a tool call blocks on, to hold a request open. */
  gate?: Promise<void>;
  onToolEntered?: () => void;
}): TrackingFactory {
  const tracker: TrackingFactory = {
    created: [],
    closeCalls: 0,
    undisposed: () =>
      tracker.created.filter((server) => server.server.transport !== undefined),
    createServer(): McpServer {
      const server = new McpServer({ name: "teardown", version: "1.0.0" });
      server.registerTool(
        "work",
        { description: "Do work", inputSchema: { marker: z.string() } },
        async ({ marker }: { marker: string }) => {
          options.onToolEntered?.();
          if (options.gate) await options.gate;
          return { content: [{ type: "text" as const, text: marker }] };
        }
      );
      const close = server.close.bind(server);
      server.close = async () => {
        tracker.closeCalls += 1;
        return close();
      };
      tracker.created.push(server);
      return server;
    },
  };
  return tracker;
}

let running: RunningApp | undefined;
const clients: Client[] = [];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close().catch(() => {})));
  clients.length = 0;
  if (running) await running.close();
  running = undefined;
  vi.restoreAllMocks();
});

describe("per-request teardown on /mcp", () => {
  it("closes and detaches every server once its request completes", async () => {
    const factory = trackingFactory({});
    running = await startApp(
      createMcpHttpApp({
        createServer: factory.createServer,
        security: SECURITY,
      })
    );

    const client = await connectClient(running.url, "client-a");
    clients.push(client);
    await client.callTool({ name: "work", arguments: { marker: "alpha" } });
    await client.close();
    clients.length = 0;

    // Several requests happened (initialize, initialized, tools/call), each
    // with its own server. Not one of them may still be alive.
    expect(factory.created.length).toBeGreaterThanOrEqual(3);
    await waitFor(
      () => factory.closeCalls === factory.created.length,
      "every per-request server to be closed"
    );
    await waitFor(
      () => factory.undisposed().length === 0,
      "every per-request server to be detached from its transport"
    );
  });

  it("closes the server when the client aborts mid-request", async () => {
    const gate = deferred();
    let entered = 0;
    const factory = trackingFactory({
      gate: gate.promise,
      onToolEntered: () => {
        entered += 1;
      },
    });
    running = await startApp(
      createMcpHttpApp({
        createServer: factory.createServer,
        security: SECURITY,
      })
    );

    const controller = new AbortController();
    const pending = fetch(`${running.url}/mcp`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "work", arguments: { marker: "abandoned" } },
      }),
    }).catch(() => undefined);

    await waitFor(() => entered === 1, "the tool handler to start");
    controller.abort();
    await pending;

    await waitFor(
      () => factory.closeCalls === factory.created.length,
      "the abandoned request's server to be closed"
    );
    await waitFor(
      () => factory.undisposed().length === 0,
      "the abandoned request's server to be detached"
    );

    gate.resolve();
  });
});

describe("per-stream teardown on the legacy SSE route", () => {
  it("closes the server and forgets the session when the stream ends", async () => {
    const factory = trackingFactory({});
    running = await startApp(
      createMcpHttpApp({
        createServer: factory.createServer,
        security: SECURITY,
      })
    );

    // Driven at the socket level so the stream can be cut deliberately, and so
    // the session id the server minted is observable.
    const stream = await openSseStream(running.port);
    const sessionId = stream.sessionId;
    expect(sessionId).toBeTruthy();

    // The session routes while the stream is open — which is what makes the
    // assertions after the cut meaningful rather than trivially true.
    const accepted = await rawRequest({
      port: running.port,
      path: `/messages?sessionId=${sessionId}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "work", arguments: { marker: "alpha" } },
      }),
    });
    expect(accepted.status).toBe(202);
    expect(factory.created).toHaveLength(1);
    expect(factory.closeCalls).toBe(0);
    expect(factory.undisposed()).toHaveLength(1);

    stream.end();

    await waitFor(
      () => factory.closeCalls === 1,
      "the stream's server to be closed"
    );
    await waitFor(
      () => factory.undisposed().length === 0,
      "the stream's server to be detached"
    );

    // ...and the session map no longer routes the dead session.
    const response = await rawRequest({
      port: running.port,
      path: `/messages?sessionId=${sessionId}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(response.status).toBe(400);
  });
});
