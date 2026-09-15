import { describe, expect, it } from "vitest";
import {
  BULK_EDIT_METHODS_ENV,
  BULK_EDIT_METHODS_FLAG,
  ENABLED_TOOLS_ENV,
  ENABLED_TOOLS_FLAG,
  resolveConfiguredToolAllowlists,
} from "../../src/config/toolAllowlist";
import { toolAccessMode } from "../../src/config/toolAccess";
import { resolveEffectiveToolPolicy } from "../../src/mcp/toolPolicy";

describe("allowlist configuration", () => {
  it("distinguishes an absent allowlist from an explicitly empty one", () => {
    expect(resolveConfiguredToolAllowlists({}, [])).toEqual({
      enabledTools: undefined,
      bulkEditMethods: undefined,
    });
    expect(
      resolveConfiguredToolAllowlists(
        { [ENABLED_TOOLS_ENV]: "", [BULK_EDIT_METHODS_ENV]: "   " },
        []
      )
    ).toEqual({ enabledTools: [], bulkEditMethods: [] });
  });

  it("parses comma-separated environment values and trims their entries", () => {
    expect(
      resolveConfiguredToolAllowlists(
        {
          [ENABLED_TOOLS_ENV]: "get_document, search_documents",
          [BULK_EDIT_METHODS_ENV]: "add_tag, remove_tag",
        },
        []
      )
    ).toEqual({
      enabledTools: ["get_document", "search_documents"],
      bulkEditMethods: ["add_tag", "remove_tag"],
    });
  });

  it("supports value and equals CLI forms, with CLI taking precedence", () => {
    expect(
      resolveConfiguredToolAllowlists(
        {
          [ENABLED_TOOLS_ENV]: "get_tag",
          [BULK_EDIT_METHODS_ENV]: "remove_tag",
        },
        [
          ENABLED_TOOLS_FLAG,
          "get_document,bulk_edit_documents",
          `${BULK_EDIT_METHODS_FLAG}=add_tag`,
        ]
      )
    ).toEqual({
      enabledTools: ["get_document", "bulk_edit_documents"],
      bulkEditMethods: ["add_tag"],
    });
  });

  it.each([
    ["duplicate tool", { [ENABLED_TOOLS_ENV]: "get_tag,get_tag" }, []],
    [
      "duplicate method",
      { [BULK_EDIT_METHODS_ENV]: "add_tag,add_tag" },
      [],
    ],
    ["empty tool entry", { [ENABLED_TOOLS_ENV]: "get_tag,,get_document" }, []],
    [
      "empty method entry",
      { [BULK_EDIT_METHODS_ENV]: "add_tag," },
      [],
    ],
    ["malformed tool", { [ENABLED_TOOLS_ENV]: "get-tag" }, []],
    ["malformed method", { [BULK_EDIT_METHODS_ENV]: "add-tag" }, []],
    [
      "repeated flag",
      {},
      [ENABLED_TOOLS_FLAG, "get_tag", `${ENABLED_TOOLS_FLAG}=get_document`],
    ],
    ["missing flag value", {}, [ENABLED_TOOLS_FLAG, "--allow-writes"]],
  ])("rejects a %s", (_label, env, argv) => {
    expect(() => resolveConfiguredToolAllowlists(env, argv)).toThrow();
  });
});

describe("effective tool policy", () => {
  it("keeps the existing read-only surface when no allowlist is configured", () => {
    const policy = resolveEffectiveToolPolicy(toolAccessMode(false, false), {
      enabledTools: undefined,
      bulkEditMethods: undefined,
    });

    expect(policy.enabledTools).toEqual([
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
    ]);
    expect(policy.bulkEditMethods).toEqual([]);
  });

  it.each([
    ["write", toolAccessMode(true, false)],
    ["destructive", toolAccessMode(true, true)],
  ])(
    "fails closed when %s mode has no explicit tool allowlist",
    (_label, mode) => {
      expect(() =>
        resolveEffectiveToolPolicy(mode, {
          enabledTools: undefined,
          bulkEditMethods: undefined,
        })
      ).toThrow(/requires an explicit PAPERLESS_MCP_ENABLED_TOOLS/);
    }
  );

  it("allows an explicitly empty surface", () => {
    const policy = resolveEffectiveToolPolicy(toolAccessMode(true, true), {
      enabledTools: [],
      bulkEditMethods: [],
    });

    expect(policy.enabledTools).toEqual([]);
    expect(policy.bulkEditMethods).toEqual([]);
  });

  it("cannot widen write mode with destructive tool or method names", () => {
    const policy = resolveEffectiveToolPolicy(toolAccessMode(true, false), {
      enabledTools: [
        "get_document",
        "update_document",
        "delete_tag",
        "bulk_edit_documents",
      ],
      bulkEditMethods: ["add_tag", "delete", "set_permissions"],
    });

    expect(policy.enabledTools).toEqual([
      "bulk_edit_documents",
      "get_document",
      "update_document",
    ]);
    expect(policy.bulkEditMethods).toEqual(["add_tag"]);
  });

  it("permits selected destructive operations only in destructive mode", () => {
    const policy = resolveEffectiveToolPolicy(toolAccessMode(true, true), {
      enabledTools: ["delete_tag", "bulk_edit_documents"],
      bulkEditMethods: ["delete_pages", "add_tag"],
    });

    expect(policy.enabledTools).toEqual([
      "bulk_edit_documents",
      "delete_tag",
    ]);
    expect(policy.bulkEditMethods).toEqual(["delete_pages", "add_tag"]);
  });

  it("requires a method allowlist when bulk_edit_documents is effective", () => {
    expect(() =>
      resolveEffectiveToolPolicy(toolAccessMode(true, false), {
        enabledTools: ["bulk_edit_documents"],
        bulkEditMethods: undefined,
      })
    ).toThrow(/requires an explicit PAPERLESS_MCP_BULK_EDIT_METHODS/);
  });

  it("omits bulk_edit_documents when no configured method survives the mode", () => {
    const policy = resolveEffectiveToolPolicy(toolAccessMode(true, false), {
      enabledTools: ["get_document", "bulk_edit_documents"],
      bulkEditMethods: ["delete", "delete_pages"],
    });

    expect(policy.enabledTools).toEqual(["get_document"]);
    expect(policy.bulkEditMethods).toEqual([]);
  });

  it.each([
    [
      "tool",
      { enabledTools: ["summon_paperclip"], bulkEditMethods: [] },
    ],
    [
      "method",
      { enabledTools: [], bulkEditMethods: ["shred"] },
    ],
  ])("rejects an unknown %s name", (_label, configured) => {
    expect(() =>
      resolveEffectiveToolPolicy(toolAccessMode(false, false), configured)
    ).toThrow(/unknown name/);
  });
});
