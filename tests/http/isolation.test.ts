/**
 * Client isolation for the `--http` transport (issue #14).
 *
 * The bug these tests exist for: one `McpServer` was built in `main()` and
 * `server.connect(transport)` was called on a *new* transport for every
 * `POST /mcp`. `Protocol.connect()` stores the transport on the instance, so
 * unrelated clients shared one mutable server and one transport pointer.
 *
 * Every test here drives two real MCP clients over real sockets against a real
 * Express app, and every concurrent test uses a barrier so both calls are
 * provably in flight at the same moment — a "concurrent" test that happens to
 * run sequentially would not see the bug.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMcpHttpApp } from "../../src/http/app";
import { DEFAULT_ALLOWED_HOSTS } from "../../src/http/security";
import { connectClient, createBarrier, RunningApp, startApp } from "./harness";

const SECURITY = {
  allowedHosts: DEFAULT_ALLOWED_HOSTS,
  allowedOrigins: [] as string[],
};

interface Factory {
  createServer: () => McpServer;
  /** How many server instances were built. */
  instances: () => number;
}

/**
 * A server factory whose tools expose exactly what must not leak: the identity
 * of the server instance that handled the call, a counter private to that
 * instance, and the caller's own marker.
 */
function testServerFactory(
  barrier?: { arrive(marker: string): Promise<void> }
): Factory {
  let built = 0;
  return {
    instances: () => built,
    createServer(): McpServer {
      const instanceId = `srv-${++built}`;
      let callsOnThisInstance = 0;
      const server = new McpServer({ name: "isolation-test", version: "1.0.0" });
      server.registerTool(
        "echo",
        {
          description: "Echo the caller's marker back",
          inputSchema: { marker: z.string() },
        },
        async ({ marker }: { marker: string }) => {
          callsOnThisInstance += 1;
          if (barrier) await barrier.arrive(marker);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  marker,
                  instanceId,
                  callsOnThisInstance,
                }),
              },
            ],
          };
        }
      );
      return server;
    },
  };
}

function parseEcho(result: unknown): {
  marker: string;
  instanceId: string;
  callsOnThisInstance: number;
} {
  const content = (result as { content: { type: string; text: string }[] })
    .content;
  expect(content).toHaveLength(1);
  return JSON.parse(content[0].text);
}

let running: RunningApp | undefined;
const clients: Client[] = [];

beforeEach(() => {
  // The app logs to stderr through log(); keep the suite output readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close().catch(() => {})));
  clients.length = 0;
  if (running) await running.close();
  running = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function twoClients(factory: Factory): Promise<[Client, Client]> {
  running = await startApp(
    createMcpHttpApp({ createServer: factory.createServer, security: SECURITY })
  );
  const [a, b] = await Promise.all([
    connectClient(running.url, "client-a"),
    connectClient(running.url, "client-b"),
  ]);
  clients.push(a, b);
  return [a, b];
}

describe("concurrent Streamable HTTP clients", () => {
  it("never returns one client's response to the other", async () => {
    const barrier = createBarrier(2);
    const factory = testServerFactory(barrier);
    const [a, b] = await twoClients(factory);

    // Both handlers block inside the barrier until both have arrived, so the
    // two calls overlap in time.
    const [resultA, resultB] = await Promise.all([
      a.callTool({ name: "echo", arguments: { marker: "alpha" } }),
      b.callTool({ name: "echo", arguments: { marker: "beta" } }),
    ]);

    expect(barrier.arrivals.sort()).toEqual(["alpha", "beta"]);
    expect(parseEcho(resultA).marker).toBe("alpha");
    expect(parseEcho(resultB).marker).toBe("beta");
  });

  it("gives each in-flight request its own server instance", async () => {
    const barrier = createBarrier(2);
    const factory = testServerFactory(barrier);
    const [a, b] = await twoClients(factory);

    const [resultA, resultB] = await Promise.all([
      a.callTool({ name: "echo", arguments: { marker: "alpha" } }),
      b.callTool({ name: "echo", arguments: { marker: "beta" } }),
    ]);

    expect(parseEcho(resultA).instanceId).not.toBe(
      parseEcho(resultB).instanceId
    );
  });

  it("does not let tool state accumulate across clients", async () => {
    const factory = testServerFactory();
    const [a, b] = await twoClients(factory);

    const first = parseEcho(
      await a.callTool({ name: "echo", arguments: { marker: "alpha" } })
    );
    const second = parseEcho(
      await a.callTool({ name: "echo", arguments: { marker: "alpha" } })
    );
    const other = parseEcho(
      await b.callTool({ name: "echo", arguments: { marker: "beta" } })
    );

    // Stateless: every request starts from a fresh instance, so a counter can
    // never be carried from one client's call into another's.
    expect(first.callsOnThisInstance).toBe(1);
    expect(second.callsOnThisInstance).toBe(1);
    expect(other.callsOnThisInstance).toBe(1);
    expect(new Set([first.instanceId, second.instanceId, other.instanceId]).size)
      .toBe(3);
  });

  it("survives many overlapping calls from two clients", async () => {
    const pairs = 8;
    const barrier = createBarrier(pairs * 2);
    const factory = testServerFactory(barrier);
    const [a, b] = await twoClients(factory);

    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < pairs; i++) {
      calls.push(a.callTool({ name: "echo", arguments: { marker: `a-${i}` } }));
      calls.push(b.callTool({ name: "echo", arguments: { marker: `b-${i}` } }));
    }
    const results = await Promise.all(calls);

    const instanceIds = new Set<string>();
    results.forEach((result, index) => {
      const echoed = parseEcho(result);
      const expected = index % 2 === 0 ? "a" : "b";
      expect(echoed.marker).toBe(`${expected}-${Math.floor(index / 2)}`);
      instanceIds.add(echoed.instanceId);
    });
    // No instance handled two of the overlapping calls.
    expect(instanceIds.size).toBe(pairs * 2);
  });

  it("advertises no session id, so there is no session state to cross", async () => {
    const factory = testServerFactory();
    running = await startApp(
      createMcpHttpApp({
        createServer: factory.createServer,
        security: SECURITY,
      })
    );

    const response = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "raw", version: "1.0.0" },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    await response.text();
  });

  it("rejects session-oriented verbs on /mcp with 405", async () => {
    const factory = testServerFactory();
    running = await startApp(
      createMcpHttpApp({
        createServer: factory.createServer,
        security: SECURITY,
      })
    );

    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(`${running.url}/mcp`, { method });
      expect(response.status, method).toBe(405);
      await response.text();
    }
  });
});
