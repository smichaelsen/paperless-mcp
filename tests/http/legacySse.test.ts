/**
 * The legacy HTTP+SSE routes are session-oriented, so they are exactly where a
 * shared server object leaks hardest: one instance connected to two live event
 * streams writes both clients' responses to whichever stream connected last.
 *
 * Issue #11 settled their fate: **off unless explicitly enabled**. When they
 * are enabled they carry the same one-server-per-connection guarantee as
 * `/mcp`, and the same authentication (see `auth.test.ts`).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMcpHttpApp } from "../../src/http/app";
import {
  ENABLE_LEGACY_SSE_ENV,
  legacySseEnabled,
} from "../../src/http/legacyFlag";
import { DEFAULT_ALLOWED_HOSTS } from "../../src/http/security";
import { createBarrier, NO_AUTH, rawRequest, RunningApp, startApp } from "./harness";

const SECURITY = {
  allowedHosts: DEFAULT_ALLOWED_HOSTS,
  allowedOrigins: [] as string[],
};

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

function factory(barrier?: { arrive(marker: string): Promise<void> }) {
  let built = 0;
  return () => {
    const instanceId = `srv-${++built}`;
    let seen = 0;
    const server = new McpServer({ name: "sse-test", version: "1.0.0" });
    server.registerTool(
      "whoami",
      {
        description: "Report the handling server instance",
        inputSchema: { marker: z.string() },
      },
      async ({ marker }: { marker: string }) => {
        seen += 1;
        if (barrier) await barrier.arrive(marker);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ marker, instanceId, seen }),
            },
          ],
        };
      }
    );
    return server;
  };
}

function parse(result: unknown) {
  const content = (result as { content: { text: string }[] }).content;
  return JSON.parse(content[0].text) as {
    marker: string;
    instanceId: string;
    seen: number;
  };
}

async function connectSse(url: string, name: string): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new SSEClientTransport(new URL(`${url}/sse`)));
  clients.push(client);
  return client;
}

describe("legacy SSE routes", () => {
  it("gives each event stream its own server instance and its own state", async () => {
    const barrier = createBarrier(2);
    running = await startApp(
      createMcpHttpApp({
        auth: NO_AUTH,
        createServer: factory(barrier),
        security: SECURITY,
        enableLegacySse: true,
      })
    );

    const [a, b] = await Promise.all([
      connectSse(running.url, "sse-a"),
      connectSse(running.url, "sse-b"),
    ]);

    const [first, second] = await Promise.all([
      a.callTool({ name: "whoami", arguments: { marker: "alpha" } }),
      b.callTool({ name: "whoami", arguments: { marker: "beta" } }),
    ]);

    const alpha = parse(first);
    const beta = parse(second);
    expect(barrier.arrivals.sort()).toEqual(["alpha", "beta"]);
    expect(alpha.marker).toBe("alpha");
    expect(beta.marker).toBe("beta");
    expect(alpha.instanceId).not.toBe(beta.instanceId);
  });

  it("keeps per-session state private to its own session", async () => {
    running = await startApp(
      createMcpHttpApp({
        auth: NO_AUTH,
        createServer: factory(),
        security: SECURITY,
        enableLegacySse: true,
      })
    );

    const a = await connectSse(running.url, "sse-a");
    const b = await connectSse(running.url, "sse-b");

    const a1 = parse(
      await a.callTool({ name: "whoami", arguments: { marker: "alpha" } })
    );
    const a2 = parse(
      await a.callTool({ name: "whoami", arguments: { marker: "alpha" } })
    );
    const b1 = parse(
      await b.callTool({ name: "whoami", arguments: { marker: "beta" } })
    );

    // A session keeps its own counter across calls...
    expect(a1.instanceId).toBe(a2.instanceId);
    expect([a1.seen, a2.seen]).toEqual([1, 2]);
    // ...and the other session never sees it.
    expect(b1.instanceId).not.toBe(a1.instanceId);
    expect(b1.seen).toBe(1);
  });

  it("refuses a message for an unknown session without echoing the id", async () => {
    running = await startApp(
      createMcpHttpApp({
        auth: NO_AUTH,
        createServer: factory(),
        security: SECURITY,
        enableLegacySse: true,
      })
    );

    const response = await rawRequest({
      port: running.port,
      path: "/messages?sessionId=forged-session-id",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(response.status).toBe(400);
    expect(response.body).not.toContain("forged-session-id");
  });

  it("is absent unless explicitly enabled", async () => {
    // The default. `enableLegacySse` is not passed at all, which is how
    // `createMcpHttpApp` is called everywhere except an explicit opt-in.
    running = await startApp(
      createMcpHttpApp({
        auth: NO_AUTH,
        createServer: factory(),
        security: SECURITY,
      })
    );

    const sse = await rawRequest({
      port: running.port,
      path: "/sse",
      method: "GET",
      headers: { accept: "text/event-stream" },
    });
    expect(sse.status).toBe(404);

    // Both halves of the transport, not just the stream.
    const messages = await rawRequest({
      port: running.port,
      path: "/messages?sessionId=x",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(messages.status).toBe(404);
  });

  it("stays off for an unset, blank or misspelled flag", () => {
    expect(legacySseEnabled({})).toBe(false);
    expect(legacySseEnabled({ [ENABLE_LEGACY_SSE_ENV]: "" })).toBe(false);
    expect(legacySseEnabled({ [ENABLE_LEGACY_SSE_ENV]: "ture" })).toBe(false);
    expect(legacySseEnabled({ [ENABLE_LEGACY_SSE_ENV]: "false" })).toBe(false);
    expect(legacySseEnabled({ [ENABLE_LEGACY_SSE_ENV]: " True " })).toBe(true);
    expect(legacySseEnabled({ [ENABLE_LEGACY_SSE_ENV]: "1" })).toBe(true);
  });
});
