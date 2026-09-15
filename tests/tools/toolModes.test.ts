/**
 * The access-mode contract: which tools exist in which mode, and what they
 * claim about themselves.
 *
 * The expectations below are written out by hand on purpose. Deriving them from
 * `TOOL_POLICIES` would make this suite agree with whatever the table happens
 * to say; as written, moving `delete_tag` to the `write` class — or forgetting
 * the gate on `bulk_edit_documents` — turns these tests red.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolAccessMode } from "../../src/config/toolAccess";
import {
  BULK_EDIT_DESTRUCTIVE_METHODS,
  BULK_EDIT_WRITE_METHODS,
  gateBulkEditDocuments,
  policyFor,
  resolveEffectiveToolPolicy,
} from "../../src/mcp/toolPolicy";
import { jsonResponse, mockFetch } from "../helpers/fetchMock";
import {
  BASE_URL,
  MODES,
  collectEnumValues,
  collectPropertyNames,
  connectInMode,
  connectWithPolicy,
  fullPolicyInMode,
  toolNamesInMode,
  toolNamesWithPolicy,
} from "./modeHarness";

/** Available in every mode, including the default. */
const READ_TOOLS = [
  "download_document",
  "get_correspondent",
  "get_document",
  "get_document_download_link",
  "get_document_type",
  "get_tag",
  "list_correspondents",
  "list_document_types",
  "list_tags",
  "search_documents",
];

/** Added by the writes opt-in. */
const WRITE_TOOLS = [
  "bulk_edit_documents",
  "create_correspondent",
  "create_document_type",
  "create_public_document_share_link",
  "create_tag",
  "post_document",
  "update_document",
  "update_tag",
];

/** Added by the separate destructive opt-in. */
const DESTRUCTIVE_TOOLS = [
  "bulk_edit_correspondents",
  "bulk_edit_document_types",
  "bulk_edit_tags",
  "delete_tag",
];

const sorted = (names: string[]) => [...names].sort();

const READ_ONLY_SURFACE = sorted(READ_TOOLS);
const WRITE_SURFACE = sorted([...READ_TOOLS, ...WRITE_TOOLS]);
const DESTRUCTIVE_SURFACE = sorted([
  ...READ_TOOLS,
  ...WRITE_TOOLS,
  ...DESTRUCTIVE_TOOLS,
]);

const reads: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const creates: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const replaces: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};
const mutates: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/** The annotations every tool must advertise, spelled out per tool. */
const EXPECTED_ANNOTATIONS: Record<string, ToolAnnotations> = {
  get_document: reads,
  search_documents: reads,
  download_document: reads,
  get_document_download_link: reads,
  list_tags: reads,
  get_tag: reads,
  list_correspondents: reads,
  get_correspondent: reads,
  list_document_types: reads,
  get_document_type: reads,

  post_document: creates,
  create_public_document_share_link: creates,
  create_tag: creates,
  create_correspondent: creates,
  create_document_type: creates,
  update_document: replaces,
  update_tag: replaces,
  bulk_edit_documents: mutates,

  delete_tag: replaces,
  bulk_edit_tags: replaces,
  bulk_edit_correspondents: replaces,
  bulk_edit_document_types: replaces,
};

/** Enum values that must never be reachable without the destructive opt-in. */
const DESTRUCTIVE_ENUM_VALUES = ["delete", "delete_pages", "set_permissions"];

/**
 * Arguments that must never be advertised without the destructive opt-in.
 *
 * `pages` is not one of them: Paperless also takes it as the required `split`
 * specification, so write mode must keep it. It is inert on its own — the
 * method that would delete pages is not reachable.
 */
const DESTRUCTIVE_ARGUMENTS = ["permissions", "delete_originals"];

beforeEach(() => {
  // Registration logs the active mode to stderr; keep the suite output clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tool surface per mode", () => {
  it("advertises only read-only tools by default", async () => {
    expect(await toolNamesInMode(MODES["read-only"])).toEqual(
      READ_ONLY_SURFACE
    );
  });

  it("adds the write tools, and nothing destructive, when writes are enabled", async () => {
    const names = await toolNamesInMode(MODES.write);

    expect(names).toEqual(WRITE_SURFACE);
    for (const destructive of DESTRUCTIVE_TOOLS) {
      expect(names, `write mode must not expose ${destructive}`).not.toContain(
        destructive
      );
    }
  });

  it("adds the destructive tools only with the separate opt-in", async () => {
    expect(await toolNamesInMode(MODES.destructive)).toEqual(
      DESTRUCTIVE_SURFACE
    );
  });

  it("treats the destructive switch on its own as writes plus destructive", async () => {
    // `PAPERLESS_ALLOW_DESTRUCTIVE` without `PAPERLESS_ALLOW_WRITES`: every
    // destructive operation is a write, so the write tools come along.
    expect(await toolNamesInMode(toolAccessMode(false, true))).toEqual(
      DESTRUCTIVE_SURFACE
    );
  });

  it("keeps every mode's surface a subset of the next", async () => {
    const readOnly = await toolNamesInMode(MODES["read-only"]);
    const write = await toolNamesInMode(MODES.write);
    const destructive = await toolNamesInMode(MODES.destructive);

    expect(write).toEqual(expect.arrayContaining(readOnly));
    expect(destructive).toEqual(expect.arrayContaining(write));
    expect(readOnly.length).toBeLessThan(write.length);
    expect(write.length).toBeLessThan(destructive.length);
  });
});

describe("exact tool allowlist", () => {
  it("can select the browser download link as a read-only tool", async () => {
    const policy = resolveEffectiveToolPolicy(MODES["read-only"], {
      enabledTools: ["get_document_download_link"],
      bulkEditMethods: undefined,
    });

    expect(await toolNamesWithPolicy(policy)).toEqual([
      "get_document_download_link",
    ]);
  });

  it("advertises only selected names that the mode permits", async () => {
    const policy = resolveEffectiveToolPolicy(MODES.write, {
      enabledTools: ["get_document", "update_document", "delete_tag"],
      bulkEditMethods: [],
    });

    expect(await toolNamesWithPolicy(policy)).toEqual([
      "get_document",
      "update_document",
    ]);
  });

  it("requires write mode and an exact allowlist entry for public shares", async () => {
    const disabled = resolveEffectiveToolPolicy(MODES["read-only"], {
      enabledTools: ["create_public_document_share_link"],
      bulkEditMethods: undefined,
    });
    expect(await toolNamesWithPolicy(disabled)).toEqual([]);

    const enabled = resolveEffectiveToolPolicy(MODES.write, {
      enabledTools: ["create_public_document_share_link"],
      bulkEditMethods: undefined,
    });
    expect(await toolNamesWithPolicy(enabled)).toEqual([
      "create_public_document_share_link",
    ]);
  });

  it("can advertise no tools at all", async () => {
    const policy = resolveEffectiveToolPolicy(MODES.destructive, {
      enabledTools: [],
      bulkEditMethods: [],
    });
    const client = await connectWithPolicy(policy);

    expect((await client.listTools()).tools).toEqual([]);
    const hidden: any = await client.callTool({
      name: "paperless_mcp_empty_surface",
      arguments: {},
    });
    await client.close();
    expect(hidden.isError).toBe(true);
  });
});

describe("MCP annotations", () => {
  for (const [label, mode] of Object.entries(MODES)) {
    it(`annotates every tool advertised in ${label} mode`, async () => {
      const client = await connectInMode(mode);
      const { tools } = await client.listTools();
      await client.close();

      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.annotations, tool.name).toEqual(
          EXPECTED_ANNOTATIONS[tool.name]
        );
      }
    });
  }

  it("marks every tool available by default as read-only", async () => {
    const client = await connectInMode(MODES["read-only"]);
    const { tools } = await client.listTools();
    await client.close();

    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
    }
  });

  it("marks no tool read-only once it can change Paperless", async () => {
    const client = await connectInMode(MODES.destructive);
    const { tools } = await client.listTools();
    await client.close();

    for (const tool of tools) {
      const readOnly = tool.annotations?.readOnlyHint === true;
      expect(readOnly, tool.name).toBe(policyFor(tool.name).access === "read");
    }
  });
});

describe("structural guards", () => {
  it("advertises no destructive argument or enum value below destructive mode", async () => {
    for (const label of ["read-only", "write"] as const) {
      const client = await connectInMode(MODES[label]);
      const { tools } = await client.listTools();
      await client.close();

      for (const tool of tools) {
        const values = collectEnumValues(tool.inputSchema);
        for (const forbidden of DESTRUCTIVE_ENUM_VALUES) {
          expect(values, `${label}: ${tool.name}`).not.toContain(forbidden);
        }
        const properties = collectPropertyNames(tool.inputSchema);
        for (const forbidden of DESTRUCTIVE_ARGUMENTS) {
          expect(properties, `${label}: ${tool.name}`).not.toContain(forbidden);
        }
      }
    }
  });

  it("advertises no tool that names a deletion below destructive mode", async () => {
    for (const label of ["read-only", "write"] as const) {
      for (const name of await toolNamesInMode(MODES[label])) {
        expect(name, label).not.toMatch(/delete/);
      }
    }
  });

  it("advertises nothing that writes in the default mode", async () => {
    for (const name of await toolNamesInMode(MODES["read-only"])) {
      expect(name).not.toMatch(/^(create|update|post|delete|bulk_edit)/);
    }
  });
});

describe("bulk_edit_documents, whose destructiveness is an argument", () => {
  it("advertises and accepts only the selected methods", async () => {
    const policy = resolveEffectiveToolPolicy(MODES.write, {
      enabledTools: ["bulk_edit_documents"],
      bulkEditMethods: ["add_tag", "remove_tag"],
    });
    const fetchMock = mockFetch(() => jsonResponse({ result: "OK" }));
    const client = await connectWithPolicy(policy);

    const { tools } = await client.listTools();
    const schema = tools.find((tool) => tool.name === "bulk_edit_documents")!
      .inputSchema as any;
    expect(schema.properties.method.enum).toEqual(["add_tag", "remove_tag"]);

    const result: any = await client.callTool({
      name: "bulk_edit_documents",
      arguments: { documents: [1], method: "add_tag", tag: 5 },
    });
    await client.close();

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(String(fetchMock.only().init.body)).method).toBe(
      "add_tag"
    );
  });

  it("describes only the selected methods in destructive mode", async () => {
    const policy = resolveEffectiveToolPolicy(MODES.destructive, {
      enabledTools: ["bulk_edit_documents"],
      bulkEditMethods: ["set_permissions"],
    });
    const client = await connectWithPolicy(policy);

    const { tools } = await client.listTools();
    await client.close();
    const tool = tools.find((item) => item.name === "bulk_edit_documents")!;

    expect(tool.description).toContain("Enabled methods: set_permissions.");
    expect(tool.description).not.toMatch(/delete|merge|split|rotate/);
    expect((tool.inputSchema as any).properties.method.enum).toEqual([
      "set_permissions",
    ]);
  });

  it("offers only the non-destructive methods in write mode", async () => {
    const client = await connectInMode(MODES.write);
    const { tools } = await client.listTools();
    await client.close();

    const schema = tools.find((tool) => tool.name === "bulk_edit_documents")!
      .inputSchema as any;

    expect(schema.properties.method.enum).toEqual([
      "set_correspondent",
      "set_document_type",
      "set_storage_path",
      "add_tag",
      "remove_tag",
      "modify_tags",
      "reprocess",
      "merge",
      "split",
      "rotate",
    ]);
    expect(Object.keys(schema.properties)).not.toContain("delete_originals");
    expect(Object.keys(schema.properties)).not.toContain("permissions");
    // The non-destructive arguments survive the narrowing — including `pages`,
    // which `split` cannot do without.
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining([
        "documents",
        "tag",
        "add_tags",
        "degrees",
        "pages",
      ])
    );
    expect(schema.properties.pages.description).toMatch(/split/);
  });

  it("keeps split usable in write mode: the page ranges reach Paperless", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ result: "OK" }));
    const client = await connectInMode(MODES.write);

    const result: any = await client.callTool({
      name: "bulk_edit_documents",
      arguments: { documents: [1], method: "split", pages: "1-2,3-4" },
    });
    await client.close();

    expect(result.isError).toBeFalsy();
    // Without `pages` Paperless answers 400 ("pages not specified"), so a
    // stripped argument would advertise a split that can never succeed.
    expect(JSON.parse(String(fetchMock.only().init.body))).toEqual({
      documents: [1],
      method: "split",
      parameters: { pages: "1-2,3-4", delete_originals: false },
    });
  });

  it("offers the full method enum once destructive operations are enabled", async () => {
    const client = await connectInMode(MODES.destructive);
    const { tools } = await client.listTools();
    await client.close();

    const schema = tools.find((tool) => tool.name === "bulk_edit_documents")!
      .inputSchema as any;

    expect(schema.properties.method.enum).toEqual(
      expect.arrayContaining(["delete", "delete_pages", "set_permissions"])
    );
    expect(Object.keys(schema.properties)).toContain("delete_originals");
  });

  it("classifies every declared method exactly once", async () => {
    // The two lists must partition the enum the tool module declares. A method
    // added upstream and left out of both would otherwise vanish silently in
    // write mode; one added to both would be a contradiction.
    const client = await connectInMode(MODES.destructive);
    const { tools } = await client.listTools();
    await client.close();

    const declared = (
      tools.find((tool) => tool.name === "bulk_edit_documents")!
        .inputSchema as any
    ).properties.method.enum as string[];

    expect(
      [...BULK_EDIT_WRITE_METHODS, ...BULK_EDIT_DESTRUCTIVE_METHODS].sort()
    ).toEqual([...declared].sort());
    expect(
      BULK_EDIT_WRITE_METHODS.filter((method) =>
        (BULK_EDIT_DESTRUCTIVE_METHODS as readonly string[]).includes(method)
      )
    ).toEqual([]);
  });

  it("refuses a destructive method in write mode without reaching Paperless", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));
    const client = await connectInMode(MODES.write);

    const result: any = await client
      .callTool({
        name: "bulk_edit_documents",
        arguments: { documents: [1], method: "delete" },
      })
      .catch((error: Error) => ({ isError: true, message: error.message }));
    await client.close();

    expect(result.isError).toBe(true);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("performs an allowed bulk edit in write mode", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ result: "OK" }));
    const client = await connectInMode(MODES.write);

    const result: any = await client.callTool({
      name: "bulk_edit_documents",
      arguments: { documents: [1, 2], method: "add_tag", tag: 5 },
    });
    await client.close();

    expect(result.isError).toBeFalsy();
    expect(fetchMock.only().url).toBe(`${BASE_URL}/api/documents/bulk_edit/`);
    expect(JSON.parse(String(fetchMock.only().init.body))).toEqual({
      documents: [1, 2],
      method: "add_tag",
      parameters: { tag: 5 },
    });
  });

  it("deletes documents in destructive mode", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ result: "OK" }));
    const client = await connectInMode(MODES.destructive);

    const result: any = await client.callTool({
      name: "bulk_edit_documents",
      arguments: { documents: [1], method: "delete" },
    });
    await client.close();

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(String(fetchMock.only().init.body)).method).toBe(
      "delete"
    );
  });
});

describe("the bulk_edit_documents gate itself", () => {
  const registration = {
    name: "bulk_edit_documents",
    description: "original",
    shape: {},
    handler: vi.fn(async (args: any) => ({ args })),
  };

  it("removes the tool entirely when writes are disabled", () => {
    expect(
      gateBulkEditDocuments(
        registration,
        fullPolicyInMode(toolAccessMode(false, false))
      )
    ).toBeNull();
  });

  it("passes the declaration through untouched in destructive mode", () => {
    expect(
      gateBulkEditDocuments(
        registration,
        fullPolicyInMode(toolAccessMode(true, true))
      )
    ).toBe(registration);
  });

  it("refuses destructive arguments even when schema validation is bypassed", async () => {
    // Defence in depth: the narrowed schema already rejects these, but a gate
    // that only narrowed the schema would be one refactor away from useless.
    const gated = gateBulkEditDocuments(
      registration,
      fullPolicyInMode(toolAccessMode(true, false))
    )!;

    await expect(
      gated.handler({ documents: [1], method: "delete" }, {})
    ).rejects.toThrow(/destructive operation/);
    await expect(
      gated.handler({ documents: [1], method: "delete_pages", pages: "1" }, {})
    ).rejects.toThrow(/destructive operation/);
    await expect(
      gated.handler(
        { documents: [1], method: "merge", delete_originals: true },
        {}
      )
    ).rejects.toThrow(/cannot delete the original documents/);
    expect(registration.handler).not.toHaveBeenCalled();
  });

  it("forwards merge with delete_originals explicitly disabled", async () => {
    const inner = vi.fn(async (args: any) => args);
    const gated = gateBulkEditDocuments(
      { ...registration, handler: inner },
      fullPolicyInMode(toolAccessMode(true, false))
    )!;

    await gated.handler({ documents: [1, 2], method: "merge" }, {});

    expect(inner).toHaveBeenCalledWith(
      { documents: [1, 2], method: "merge", delete_originals: false },
      {}
    );
  });

  it("refuses an excluded method when schema validation is bypassed", async () => {
    const inner = vi.fn(async (args: any) => args);
    const policy = resolveEffectiveToolPolicy(toolAccessMode(true, true), {
      enabledTools: ["bulk_edit_documents"],
      bulkEditMethods: ["add_tag"],
    });
    const gated = gateBulkEditDocuments(
      { ...registration, handler: inner },
      policy
    )!;

    await expect(
      gated.handler({ documents: [1], method: "delete" }, {})
    ).rejects.toThrow(/not enabled/);
    expect(inner).not.toHaveBeenCalled();
  });
});

describe("policy coverage", () => {
  it("refuses to register a tool nobody classified", () => {
    expect(() => policyFor("summon_paperclip")).toThrow(/TOOL_POLICIES/);
  });
});
