/**
 * Byte-level guard on the advertised tool contract.
 *
 * `tools/list` is the only thing a client ever sees of this server's argument
 * surface, and it is generated indirectly — zod shape -> MCP SDK -> JSON
 * Schema. An SDK or zod upgrade can move it (the zod 3 -> 4 upgrade silently
 * dropped `additionalProperties` from 33 objects) without any test noticing.
 *
 * The committed snapshot turns that into a reviewable diff. If it fails after a
 * dependency bump, read the diff before updating it: it is the published
 * contract changing, not a flaky test.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperlessAPI } from "../../src/api/PaperlessAPI";
import { registerAllTools } from "../../src/mcp/registerTools";
import { jsonResponse, mockFetch } from "../helpers/fetchMock";

let client: Client;

/** Deep key sort, so a reordering in the emitter is not a snapshot diff. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

beforeEach(async () => {
  const server = new McpServer({ name: "paperless-ngx", version: "1.0.0" });
  registerAllTools(server, new PaperlessAPI("https://example.invalid", "t"));

  client = new Client({ name: "snapshot-client", version: "1.0.0" });
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
});

describe("advertised tool contract", () => {
  it("matches the committed tools/list snapshot", async () => {
    const { tools } = await client.listTools();
    const normalized = [...tools].sort((a, b) => a.name.localeCompare(b.name));

    await expect(
      `${JSON.stringify(sortKeys(normalized), null, 2)}\n`
    ).toMatchFileSnapshot("./__snapshots__/tools-list.json");
  });

  it("advertises every object as closed, at every nesting level", async () => {
    const { tools } = await client.listTools();

    const openObjects: string[] = [];
    const visit = (node: any, path: string) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach((child, index) => visit(child, `${path}[${index}]`));
        return;
      }
      if (node.type === "object" && node.additionalProperties !== false) {
        openObjects.push(path);
      }
      for (const [key, child] of Object.entries(node)) {
        visit(child, `${path}.${key}`);
      }
    };

    for (const tool of tools) visit(tool.inputSchema, tool.name);

    expect(openObjects).toEqual([]);
    // The nested permission trees are the ones most easily missed.
    expect(
      (tools.find((tool) => tool.name === "bulk_edit_documents")!
        .inputSchema as any).properties.permissions.properties.set_permissions
        .properties.view.additionalProperties
    ).toBe(false);
  });

  it("still strips unknown arguments at runtime instead of rejecting them", async () => {
    // `additionalProperties: false` is what we advertise; parsing stays `strip`,
    // exactly as it did before the zod 4 upgrade.
    const fetchMock = mockFetch(() => jsonResponse({ id: 1, title: "x" }));

    const result: any = await client.callTool({
      name: "get_document",
      arguments: { id: 1, unexpected: "ignored" },
    });

    // The call reaches the handler: it is dispatched, not rejected.
    expect(result.isError).toBeFalsy();
    expect(fetchMock.only().url).toContain("/api/documents/1/");
    expect(JSON.stringify(result)).not.toContain("unexpected");
    expect(JSON.stringify(result)).not.toContain("Unrecognized key");
  });
});
