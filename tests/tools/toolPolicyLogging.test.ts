import { afterEach, describe, expect, it, vi } from "vitest";
import { logEffectiveToolPolicy } from "../../src/config/toolPolicyLog";
import { toolAccessMode } from "../../src/config/toolAccess";
import { resolveEffectiveToolPolicy } from "../../src/mcp/toolPolicy";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("effective tool policy logging", () => {
  it("logs the effective tool and method names without invocation data", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const policy = resolveEffectiveToolPolicy(toolAccessMode(true, false), {
      enabledTools: ["get_document", "bulk_edit_documents", "delete_tag"],
      bulkEditMethods: ["add_tag", "delete"],
    });

    logEffectiveToolPolicy(policy);

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stderr.mock.calls[0][0]))).toEqual({
      level: "info",
      event: "tool_access_mode",
      mode: "write",
      writes: true,
      destructive: false,
      tools: 2,
      tool_names: "bulk_edit_documents,get_document",
      bulk_edit_methods: "add_tag",
    });
  });

  it("names an explicitly empty surface without logging arrays or arguments", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const policy = resolveEffectiveToolPolicy(toolAccessMode(true, true), {
      enabledTools: [],
      bulkEditMethods: [],
    });

    logEffectiveToolPolicy(policy);

    const record = JSON.parse(String(stderr.mock.calls[0][0]));
    expect(record.tool_names).toBe("(none)");
    expect(record.bulk_edit_methods).toBe("(none)");
    expect(record).not.toHaveProperty("argv");
    expect(record).not.toHaveProperty("arguments");
  });
});
