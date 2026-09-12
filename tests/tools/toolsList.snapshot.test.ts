/**
 * Byte-level guard on the advertised tool contract, per access mode.
 *
 * `tools/list` is the only thing a client ever sees of this server's argument
 * surface, and it is generated indirectly — zod shape -> MCP SDK -> JSON
 * Schema. An SDK or zod upgrade can move it (the zod 3 -> 4 upgrade silently
 * dropped `additionalProperties` from 33 objects) without any test noticing.
 *
 * There is one snapshot per mode, so a gating change shows up as a diff in the
 * mode it affects: a destructive tool leaking into `tools-list.write.json` is a
 * reviewable line in a pull request, not a silent regression.
 *
 * If a snapshot fails after a dependency bump, read the diff before updating
 * it: it is the published contract changing, not a flaky test.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../helpers/fetchMock";
import { MODES, connectInMode } from "./modeHarness";

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

/** Paths of every object in `schema` that is not advertised as closed. */
function openObjects(schema: unknown, path: string): string[] {
  const found: string[] = [];
  const visit = (node: any, at: string) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, `${at}[${index}]`));
      return;
    }
    if (node.type === "object" && node.additionalProperties !== false) {
      found.push(at);
    }
    for (const [key, child] of Object.entries(node))
      visit(child, `${at}.${key}`);
  };
  visit(schema, path);
  return found;
}

beforeEach(() => {
  // Registration logs the active mode to stderr; keep the suite output clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("advertised tool contract", () => {
  for (const [label, mode] of Object.entries(MODES)) {
    it(`matches the committed ${label} tools/list snapshot`, async () => {
      const client = await connectInMode(mode);
      const { tools } = await client.listTools();
      await client.close();

      const normalized = [...tools].sort((a, b) =>
        a.name.localeCompare(b.name)
      );

      await expect(
        `${JSON.stringify(sortKeys(normalized), null, 2)}\n`
      ).toMatchFileSnapshot(`./__snapshots__/tools-list.${label}.json`);
    });

    it(`advertises every ${label} object as closed, at every nesting level`, async () => {
      const client = await connectInMode(mode);
      const { tools } = await client.listTools();
      await client.close();

      expect(tools.length).toBeGreaterThan(0);
      const open = tools.flatMap((tool) =>
        openObjects(tool.inputSchema, tool.name)
      );
      expect(open).toEqual([]);
    });
  }

  it("keeps the deepest permission tree closed in destructive mode", async () => {
    // The nested permission trees are the ones most easily missed, and they
    // only exist once destructive operations are enabled.
    const client = await connectInMode(MODES.destructive);
    const { tools } = await client.listTools();
    await client.close();

    expect(
      (
        tools.find((tool) => tool.name === "bulk_edit_documents")!
          .inputSchema as any
      ).properties.permissions.properties.set_permissions.properties.view
        .additionalProperties
    ).toBe(false);
  });

  it("still strips unknown arguments at runtime instead of rejecting them", async () => {
    // `additionalProperties: false` is what we advertise; parsing stays `strip`,
    // exactly as it did before the zod 4 upgrade.
    const fetchMock = mockFetch(() => jsonResponse({ id: 1, title: "x" }));
    const client: Client = await connectInMode(MODES["read-only"]);

    const result: any = await client.callTool({
      name: "get_document",
      arguments: { id: 1, unexpected: "ignored" },
    });
    await client.close();

    // The call reaches the handler: it is dispatched, not rejected.
    expect(result.isError).toBeFalsy();
    expect(fetchMock.only().url).toContain("/api/documents/1/");
    expect(JSON.stringify(result)).not.toContain("unexpected");
    expect(JSON.stringify(result)).not.toContain("Unrecognized key");
  });
});
