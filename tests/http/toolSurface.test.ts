/**
 * The same isolation guarantee, on the *real* Paperless tool surface: two
 * clients call two different tools concurrently against one shared
 * `PaperlessAPI`, with the upstream responses held open until both calls are in
 * flight. Each client must get the payload for the tool *it* asked for.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperlessAPI } from "../../src/api/PaperlessAPI";
import { toolAccessMode } from "../../src/config/toolAccess";
import { createMcpHttpApp } from "../../src/http/app";
import { DEFAULT_ALLOWED_HOSTS } from "../../src/http/security";
import { registerAllTools } from "../../src/mcp/registerTools";
import { fullPolicyInMode } from "../tools/modeHarness";
import { connectClient, createBarrier, NO_AUTH, RunningApp, startApp } from "./harness";

const PAPERLESS_URL = "https://paperless.example.invalid";
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] })
    .content;
  expect(content).toHaveLength(1);
  return content[0].text;
}

describe("concurrent clients on the real tool surface", () => {
  it("routes each Paperless response to the client that asked for it", async () => {
    // The clients talk to the app over real sockets, so the loopback fetch has
    // to keep working while Paperless itself is mocked.
    const realFetch = globalThis.fetch;
    const barrier = createBarrier(2);

    vi.stubGlobal(
      "fetch",
      async (input: any, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);

        // Hold both upstream calls open until both are in flight.
        const isTags = url.indexOf("/api/tags/") !== -1;
        await barrier.arrive(isTags ? "tags" : "correspondents");
        const body = isTags
          ? { count: 1, results: [{ id: 11, name: "TAG-ALPHA" }] }
          : { count: 1, results: [{ id: 22, name: "CORRESPONDENT-BETA" }] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    );

    const api = new PaperlessAPI(PAPERLESS_URL, "s3cr3t-token-value");
    running = await startApp(
      createMcpHttpApp({
        auth: NO_AUTH,
        createServer: () => {
          const server = new McpServer({
            name: "paperless-ngx",
            version: "1.0.0",
          });
          registerAllTools(
            server,
            api,
            fullPolicyInMode(toolAccessMode(true, true))
          );
          return server;
        },
        security: SECURITY,
      })
    );

    const [a, b] = await Promise.all([
      connectClient(running.url, "client-a"),
      connectClient(running.url, "client-b"),
    ]);
    clients.push(a, b);

    const [tags, correspondents] = await Promise.all([
      a.callTool({ name: "list_tags", arguments: {} }),
      b.callTool({ name: "list_correspondents", arguments: {} }),
    ]);

    expect(barrier.arrivals.sort()).toEqual(["correspondents", "tags"]);
    expect(textOf(tags)).toContain("TAG-ALPHA");
    expect(textOf(tags)).not.toContain("CORRESPONDENT-BETA");
    expect(textOf(correspondents)).toContain("CORRESPONDENT-BETA");
    expect(textOf(correspondents)).not.toContain("TAG-ALPHA");
  });

  it.each([
    ["read-only", toolAccessMode(false, false)],
    ["write", toolAccessMode(true, false)],
    ["destructive", toolAccessMode(true, true)],
  ])(
    "advertises the same %s tool surface over HTTP as in-process",
    async (_label, mode) => {
      const api = new PaperlessAPI(PAPERLESS_URL, "s3cr3t-token-value");
      const build = (): McpServer => {
        const server = new McpServer({
          name: "paperless-ngx",
          version: "1.0.0",
        });
        registerAllTools(server, api, fullPolicyInMode(mode));
        return server;
      };

      // The reference: the same registration over an in-memory transport, the
      // way stdio runs it. Compared by name list rather than a hard-coded
      // count, so gating changes in #9's table cannot silently drift this.
      const reference = new Client({ name: "reference", version: "1.0.0" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await Promise.all([
        build().connect(serverTransport),
        reference.connect(clientTransport),
      ]);
      clients.push(reference);
      const expected = (await reference.listTools()).tools
        .map((tool) => tool.name)
        .sort();

      running = await startApp(
        createMcpHttpApp({ auth: NO_AUTH, createServer: build, security: SECURITY })
      );
      const client = await connectClient(running.url, "client-a");
      clients.push(client);
      const actual = (await client.listTools()).tools
        .map((tool) => tool.name)
        .sort();

      expect(actual).toEqual(expected);
      expect(actual).toContain("list_tags");
    }
  );
});
