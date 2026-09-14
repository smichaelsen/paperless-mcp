/**
 * End-to-end check of the MCP surface over an in-memory transport: a real
 * `McpServer` with the real tool registrations, driven by a real MCP `Client`.
 *
 * This is what catches an incompatible zod/MCP-SDK pairing — the zod shapes are
 * only converted to JSON Schema when a client actually lists the tools.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperlessAPI } from "../../src/api/PaperlessAPI";
import { toolAccessMode } from "../../src/config/toolAccess";
import { registerAllTools } from "../../src/mcp/registerTools";
import { fullPolicyInMode } from "./modeHarness";
import { jsonResponse, mockFetch } from "../helpers/fetchMock";

const BASE_URL = "https://paperless.example.invalid";

let client: Client;

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});

  const api = new PaperlessAPI(BASE_URL, "s3cr3t-token-value");
  const server = new McpServer({ name: "paperless-ngx", version: "1.0.0" });
  // The same registration path src/index.ts uses. This suite is about the
  // transport and the schemas, so it asks for the widest mode; which tools each
  // mode exposes is tests/tools/toolModes.test.ts.
  registerAllTools(server, api, fullPolicyInMode(toolAccessMode(true, true)));

  client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});

afterEach(async () => {
  await client.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MCP surface", () => {
  it("advertises all 20 tools with usable JSON Schemas", async () => {
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(20);
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema.type, tool.name).toBe("object");
    }

    const listTags = tools.find((tool) => tool.name === "list_tags")!;
    expect(listTags.inputSchema.properties).toHaveProperty("page");
    expect(listTags.inputSchema.properties).toHaveProperty("page_size");
  });

  it("calls a tool and returns Paperless data as a text content block", async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse({ count: 1, results: [{ id: 1, name: "synthetic" }] })
    );

    const result: any = await client.callTool({
      name: "list_tags",
      arguments: { page: 2, page_size: 10 },
    });

    expect(fetchMock.only().url).toBe(
      `${BASE_URL}/api/tags/?page=2&page_size=10`
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text).results[0].name).toBe(
      "synthetic"
    );
  });

  it("rejects invalid arguments before any request is made", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));

    const result: any = await client
      .callTool({ name: "create_tag", arguments: { name: "x", color: "red" } })
      .catch((error: Error) => ({ isError: true, message: error.message }));

    expect(result.isError).toBe(true);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("surfaces an unsupported API version as a tool error, without upstream data", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            detail: 'Invalid version in "Accept" header.',
            host: "paperless-internal.example.invalid",
          }),
          {
            status: 406,
            headers: {
              "content-type": "application/json",
              "X-Api-Version": "12",
              "X-Version": "4.0.0",
            },
          }
        )
    );

    const result: any = await client.callTool({
      name: "list_tags",
      arguments: {},
    });

    const text = JSON.stringify(result);
    expect(result.isError).toBe(true);
    expect(text).toContain("refused API version 9");
    expect(text).not.toContain("paperless-internal.example.invalid");
  });
});
